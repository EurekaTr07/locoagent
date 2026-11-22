#!/usr/bin/env bun
/**
 * adopt-real-profile.ts — give an isolated work profile the login DNA of the
 * user's REAL daily Chrome, so platforms see an established browser instead of
 * a suspicious newborn (the "captcha on every login attempt" failure mode).
 *
 * Why this exists: an earlier "copy real profile while Chrome runs" attempt
 * produced EMPTY clones — cookie DBs are exclusively locked while Chrome lives.
 * The fix is procedural discipline:
 *
 *   1. stop the target's isolated Chrome (killChromeForProfile — targeted)
 *   2. GRACEFULLY close the user's daily Chrome (taskkill WM_CLOSE, no /F;
 *      tabs are recoverable via "reopen closed tab"/continue-where-left-off)
 *   3. robocopy the SMALL AUTH-STATE SUBSET (never the multi-GB caches)
 *   4. relaunch the user's daily Chrome normally, untangled from CDP
 *   5. relaunch the work profile with CDP (via ensure-chrome)
 *
 *   bun run adopt-real-profile --target instagram [--target x] [--source "..."]
 *
 * Dry insight mode: `--peek` reports which platform cookies the real profile
 * holds without touching anything.
 */
import { existsSync, mkdirSync, writeFileSync, rmSync, statSync, readdirSync, copyFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from './lib/config'
import { launchChromeDetached, killChromeForProfile } from './lib/host'
import { cdpUp, loadTargets, type ResolvedTarget } from './lib/browser-targets'
import { peekAllBrowsers, peekLines } from './lib/peek-cookies'

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Top-level "User Data" files to carry over (crypto lives here). */
const ROOT_FILES = ['Local State']
/**
 * Subpaths under User Data\<profile-dir> worth carrying. Chosen for: login
 * state, saved credentials (autologin leverage), extensions (fingerprint
 * realism), sync tokens. Caches/service-worker blobs are deliberately NOT
 * copied — gigabytes of noise that slow adoption for zero login value.
 */
export const PROFILE_SUBPATHS = [
  'Network',
  'Login Data',
  'Login Data-journal',
  'Web Data',
  'Web Data-journal',
  'Preferences',
  'Secure Preferences',
  'Extensions',
  'Extension State',
  'Extension Rules',
  'Extension Scripts',
  'Extension Cookies',
  'Sync Data',
  'Favicons',
  'Favicons-journal',
  'History',
  'History-journal',
]

/** Immutable copy plan for one adoption (pure; unit-tested). */
export function planAdoptionCopy(
  sourceUserData: string,
  destProfile: string,
  sourceSubdir = 'Default',
): Array<{ src: string; dst: string }> {
  const plan: Array<{ src: string; dst: string }> = []
  for (const f of ROOT_FILES) {
    const src = join(sourceUserData, f)
    if (existsSync(src)) plan.push({ src, dst: join(destProfile, f) })
  }
  for (const sub of PROFILE_SUBPATHS) {
    const src = join(sourceUserData, sourceSubdir, sub)
    if (existsSync(src)) plan.push({ src, dst: join(destProfile, 'Default', sub) })
  }
  return plan
}

/**
 * Pick the busiest source profile subdir by summed live-cookie census (the
 * user's actual daily profile is not always 'Default' — here it is
 * 'Profile 1'). Falls back to 'Default'.
 */
export function sniffBusiestSubdir(userDataRoot: string): string {
  try {
    const subs = readdirSync(userDataRoot, { withFileTypes: true })
      .filter(e => e.isDirectory() && /^(Default|Profile \d+)$/.test(e.name))
      .map(e => e.name)
    let best = 'Default'
    let bestScore = -1
    const scores: string[] = []
    for (const s of subs) {
      const lines = peekLines(userDataRoot, { subdir: s })
      let score = 0
      for (const l of lines) {
        const m = l.match(/: (\d+) live/)
        if (m) score += Number(m[1])
        if (l.includes('[')) score += 50 // marker bonus: real session cookies beat consent crumbs
      }
      scores.push(`${s}=${score}`)
      if (score > bestScore) { bestScore = score; best = s }
    }
    console.error(`   (subdir sniff scores: ${scores.join(', ')})`)
    return best
  } catch {
    return 'Default'
  }
}

/** robocopy /E copy with machine-friendly output swallowing; rc<=7 is success. */
function robocopyTree(src: string, dst: string): boolean {
  const rc = Bun.spawnSync(
    ['robocopy', src, dst, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:1', '/W:1'],
    { stdout: 'ignore', stderr: 'ignore' },
  ).exitCode ?? 16
  return rc >= 0 && rc <= 7
}
function copySingle(src: string, dst: string): boolean {
  try {
    mkdirSync(dirname(dst), { recursive: true })
    copyFileSync(src, dst)
    return existsSync(dst) && statSync(dst).size === statSync(src).size
  } catch { return false }
}

/** Gracefully close the user's daily Chrome; escalate to force only on stragglers. */
async function closeDailyChrome(timeoutSec = 12): Promise<'closed' | 'forced' | 'not-running'> {
  const count = () => {
    const r = Bun.spawnSync(
      ['powershell', '-NoProfile', '-Command',
        '@(Get-Process chrome -ErrorAction SilentlyContinue).Count'],
      { stdout: 'pipe', stderr: 'ignore' },
    )
    return Number(new TextDecoder().decode(r.stdout).trim()) || 0
  }
  const initial = count()
  if (initial === 0) return 'not-running'
  // WM_CLOSE broadcast — lets Chrome persist session state cleanly.
  Bun.spawnSync(['taskkill', '/IM', 'chrome.exe'], { stdout: 'ignore', stderr: 'ignore' })
  const deadline = Date.now() + timeoutSec * 1000
  while (Date.now() < deadline) {
    if (count() === 0) return 'closed'
    await Bun.sleep(750)
  }
  Bun.spawnSync(['taskkill', '/IM', 'chrome.exe', '/F'], { stdout: 'ignore', stderr: 'ignore' })
  await Bun.sleep(1500)
  return count() === 0 ? 'forced' : 'closed'
}

interface AdoptArgs { targets: string[]; peek: boolean; sourceOverride?: string }

function parseAdoptArgs(argv: string[]): AdoptArgs {
  const out: AdoptArgs = { targets: [], peek: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--target' && argv[i + 1] && !argv[i + 1]!.startsWith('--')) out.targets.push(argv[++i]!)
    else if (a === '--peek') out.peek = true
    else if (a === '--source') out.sourceOverride = argv[++i]
  }
  if (!out.targets.length) out.targets = ['instagram']
  return out
}

// --- main -------------------------------------------------------------------
const { targets: wanted, peek, sourceOverride } = parseAdoptArgs(process.argv.slice(2))
const cfg = loadConfig()
const sourceUserData = sourceOverride
  ? resolve(sourceOverride)
  : resolve(join(cfg.host === 'windows'
      ? (process.env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local'))
      : join(homedir(), '.config'), 'Google', 'Chrome', 'User Data'))

if (!existsSync(sourceUserData)) {
  console.error(`x real Chrome profile not found: ${sourceUserData}`)
  process.exit(1)
}

if (peek) {
  console.error(`-> sweeping candidate browsers for live login cookies ...`)
  for (const line of peekAllBrowsers()) console.error('   ' + line)
  process.exit(0)
}

console.error('== ADOPT REAL PROFILE ==')
console.error(`   source : ${sourceUserData}`)
console.error(`   targets: ${wanted.join(', ')}`)

// 1. Graceful daily-Chrome close FIRST (also releases the isolated targets we
//    are about to refill, and guarantees unlocked cookie DBs during copy).
console.error('-> closing daily Chrome gracefully (tabs recoverable via Ctrl+Shift+T) ...')
const closeMode = await closeDailyChrome()
console.error(`   daily chrome: ${closeMode}`)

let failures = 0
for (const name of wanted) {
  let t: ResolvedTarget
  try { t = loadTargets()[name]! } catch (e) {
    console.error(`x ${(e as Error).message}`); failures++; continue
  }
  if (!t) { console.error(`x unknown target ${name}`); failures++; continue }

  // 2. Stop THIS target's isolated Chrome, wipe, adopt.
  if (await cdpUp(t.cdpPort)) {
    console.error(`-> [${name}] stopping isolated instance on ${t.cdpPort} ...`)
    await killChromeForProfile(t.profile)
    await Bun.sleep(1500)
  }
  console.error(`-> [${name}] clearing destination ${t.profile} ...`)
  rmSync(t.profile, { recursive: true, force: true })
  mkdirSync(t.profile, { recursive: true })

  const srcSub = sniffBusiestSubdir(sourceUserData)
  const plan = planAdoptionCopy(sourceUserData, t.profile, srcSub)
  console.error(`   (source profile subdir: ${srcSub})`)
  console.error(`-> [${name}] adopting ${plan.length} item(s) ...`)
  let okItems = 0
  for (const item of plan) {
    const isDir = statSync(item.src).isDirectory()
    const ok = isDir ? robocopyTree(item.src, item.dst) : copySingle(item.src, item.dst)
    if (ok) okItems++
    else console.error(`   ! failed: ${item.src}`)
  }
  writeFileSync(join(t.profile, 'adopted-from-real-chrome.json'), JSON.stringify({
    source: sourceUserData, adoptedAt: new Date().toISOString(),
    items: plan.length, ok: okItems,
  }, null, 2) + '\n')
  console.error(`   [${name}] adopted ${okItems}/${plan.length}`)
  if (okItems === 0) failures++

  // 3. Bring this target straight back up.
  console.error(`-> [${name}] launching Chrome on ${t.cdpPort} ...`)
  launchChromeDetached(cfg.chromeBin, [
    `--remote-debugging-port=${t.cdpPort}`,
    `--user-data-dir=${t.profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-default-apps',
  ], cfg.host)
  let up = false
  for (let i = 0; i < 20; i++) {
    if (await cdpUp(t.cdpPort)) { up = true; break }
    await Bun.sleep(500)
  }
  console.error(`   [${name}] CDP ${up ? 'ready' : 'TIMEOUT'}`)
  if (!up) failures++
}

// 4. Restore the user's daily Chrome, CDP-free.
console.error('-> relaunching your daily Chrome ...')
launchChromeDetached(cfg.chromeBin, [], cfg.host)

process.exit(failures ? 1 : 0)
