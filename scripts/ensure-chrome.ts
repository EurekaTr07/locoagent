#!/usr/bin/env bun
/**
 * ensure-chrome.ts — the keep-alive keeper for every login-bearing Chrome.
 *
 * Contract:
 *   - CDP already up  →  LEAVE THE INSTANCE COMPLETELY ALONE. A running,
 *     logged-in Chrome must never be touched, restarted or "refreshed" here.
 *   - CDP down        →  launch a detached Chrome on that target's port +
 *     profile (EMPTY profile when missing — deliberately NOT a copy of the
 *     user's live real-Chrome User Data, whose locked cookie DBs never copy
 *     correctly; that dead-cookie clone is precisely the bug this project's
 *     history sprang from) and wait until CDP serves.
 *
 * No `agent-browser close`, no `connect`, no daemon interference: this script
 * only ever brings Chrome itself up. agent-browser attaches via its config pin
 * (~/.agent-browser/config.json cdp=9222) or per-command --cdp.
 *
 *   bun run ensure-chrome                     # default set: x + instagram
 *   bun run ensure-chrome --target linkedin   # any registry target
 *   bun run ensure-chrome --all               # every registry target
 *   bun run ensure-chrome --install-task      # logon keep-alive (Startup cmd)
 *   bun run ensure-chrome --remove-task
 *
 * Heartbeat: each completed run appends one line to
 * %LOCALAPPDATA%\locoagent\ensure-heartbeat.log so "did the keeper actually
 * run?" is always answerable.
 */
import { existsSync, mkdirSync, appendFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from './lib/config'
import { launchChromeDetached } from './lib/host'
import { cdpUp, loadTargets, type ResolvedTarget } from './lib/browser-targets'
import { parseEnsureArgs, taskPaths, type EnsureArgs } from './lib/ensure-args'

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const HEARTBEAT_DIR = join(process.env['LOCALAPPDATA'] ?? PROJECT_ROOT, 'locoagent')
const HEARTBEAT_LOG = join(HEARTBEAT_DIR, 'ensure-heartbeat.log')
const STARTUP_TASK_FILE = 'LocoAgentEnsureChrome.cmd'
export type { EnsureArgs }
export { parseEnsureArgs }

function heart(line: string): void {
  try {
    mkdirSync(HEARTBEAT_DIR, { recursive: true })
    appendFileSync(HEARTBEAT_LOG, `[${new Date().toISOString()}] ${line}\n`)
  } catch { /* heartbeat must never crash the keeper */ }
}

function log(quiet: boolean, msg: string): void {
  if (!quiet) console.error(msg)
}

function installTask(bunBin: string, quiet: boolean): number {
  const startup = join(homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
  const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), 'ensure-chrome.ts')
  const { shim, line } = taskPaths(bunBin, scriptPath, startup)
  try {
    mkdirSync(startup, { recursive: true })
    writeFileSync(shim, line)
    log(quiet, `-> keep-alive task installed: ${shim}`)
    heart(`task installed -> ${shim}`)
    return 0
  } catch (e) {
    console.error(`x task install failed: ${(e as Error).message}`)
    return 1
  }
}

function removeTask(quiet: boolean): number {
  const shim = join(homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', STARTUP_TASK_FILE)
  try {
    rmSync(shim, { force: true })
    log(quiet, `-> keep-alive task removed: ${shim}`)
    heart('task removed')
    return 0
  } catch (e) {
    console.error(`x task removal failed: ${(e as Error).message}`)
    return 1
  }
}

/** Bring one target up if (and only if) its CDP is down. */
async function ensureTarget(t: ResolvedTarget, cfg: ReturnType<typeof loadConfig>, quiet: boolean, timeoutSec: number): Promise<boolean> {
  if (await cdpUp(t.cdpPort)) {
    log(quiet, `   [${t.platform}] CDP ${t.cdpPort} already up — untouched`)
    return true
  }
  if (!existsSync(t.profile)) {
    // Empty by design — login happens ONCE inside this fresh profile and
    // then persists (plus we snapshot it — see scripts/session-snapshot.ts).
    mkdirSync(t.profile, { recursive: true })
    log(quiet, `   [${t.platform}] created empty profile ${t.profile}`)
  }
  log(quiet, `   [${t.platform}] CDP down — launching Chrome on ${t.cdpPort} ...`)
  launchChromeDetached(
    cfg.chromeBin,
    [
      `--remote-debugging-port=${t.cdpPort}`,
      `--user-data-dir=${t.profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-default-apps',
    ],
    cfg.host,
  )
  const deadline = Date.now() + timeoutSec * 1000
  while (Date.now() < deadline) {
    if (await cdpUp(t.cdpPort)) {
      log(quiet, `   [${t.platform}] CDP ${t.cdpPort} ready`)
      return true
    }
    await Bun.sleep(500)
  }
  console.error(`x [${t.platform}] CDP ${t.cdpPort} not ready after ${timeoutSec}s`)
  return false
}

// --- main -----------------------------------------------------------------
const { args, unknown } = parseEnsureArgs(process.argv.slice(2))
if (unknown.length) console.error(`   note: unrecognized args ignored: ${unknown.join(' ')}`)
const cfg = loadConfig()

if (args.list) {
  const targets = loadTargets()
  for (const t of Object.values(targets)) {
    const up = await cdpUp(t.cdpPort)
    console.error(`   ${t.platform.padEnd(10)} port=${t.cdpPort}  ${up ? 'UP' : 'down'}  profile ${t.profile}`)
  }
  process.exit(0)
}

if (args.removeTask) process.exit(removeTask(args.quiet))

if (args.installTask) process.exit(installTask(process.execPath, args.quiet))

let targets: Record<string, ResolvedTarget>
try {
  targets = loadTargets()
} catch (e) {
  console.error(`x ${(e as Error).message}`)
  process.exit(1)
}

const names = args.targets === 'all' ? Object.keys(targets) : args.targets
const selected: ResolvedTarget[] = []
const unknownNames: string[] = []
for (const n of names) {
  const t = targets[n]
  if (t) selected.push(t)
  else unknownNames.push(n)
}
if (unknownNames.length) {
  console.error(`x unknown target(s): ${unknownNames.join(', ')} — known: ${Object.keys(targets).join(', ')}`)
  process.exit(1)
}
if (!selected.length) {
  console.error('x nothing to ensure — check --target/--all')
  process.exit(1)
}

const started = Date.now()
const outcomes = await Promise.all(
  selected.map(async t => [t.platform, await ensureTarget(t, cfg, args.quiet, args.timeoutSec)] as const),
)
const failed = outcomes.filter(([, ok]) => !ok).map(([p]) => p)
const allOk = failed.length === 0

heart(`ensure: ${outcomes.map(([p, ok]) => `${p}=${ok ? 'up' : 'FAIL'}`).join(' ')} (${Date.now() - started}ms)`)
if (!args.quiet || !allOk) {
  console.error(`\n${allOk ? 'OK' : 'PARTIAL'} ensure-chrome: ${outcomes.map(([p, ok]) => `${p}[${ok ? 'up' : 'FAIL'}]`).join('  ')}`)
}
process.exit(allOk ? 0 : 1)
