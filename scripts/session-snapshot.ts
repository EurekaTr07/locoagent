#!/usr/bin/env bun
/**
 * session-snapshot.ts — backup / restore of what actually constitutes a social
 * login: the per-profile cookie + auth-related files. Belt and braces: if a
 * platform ever force-logs-out or a profile is damaged, restore snaps the last
 * known-good login state back in seconds.
 *
 *   bun run session-snapshot save x              [--note "..."]
 *   bun run session-snapshot save --all
 *   bun run session-snapshot list [x|instagram]
 *   bun run session-snapshot restore x [stamp]   # stamp = dir name (omit = latest)
 *
 * Safety rails:
 *   - save  REFUSES while that target's Chrome is running (cookie DBs would be
 *     mid-write) unless --kill-first (then only that profile's Chrome stops).
 *   - restore REFUSES while Chrome is running unless --kill-first.
 *   - retention: keeps the newest --keep (default 5) stamps per platform.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, rmSync, cpSync } from 'node:fs'
import { basename, join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from './lib/config'
import { killChromeForProfile } from './lib/host'
import { cdpUp, loadTargets, type ResolvedTarget } from './lib/browser-targets'
import { AUTH_FILES, STAMP_RE, listStamps, nowStamp, restoreSlot, selectPrunable } from './lib/snapshot-core'

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BACKUP_ROOT = join(process.env['LOCALAPPDATA'] ?? PROJECT_ROOT, 'locoagent-session-backups')

interface Args { cmd: string; platforms: string[]; note?: string; keep: number; killFirst: boolean; all: boolean }

function parseArgs(argv: string[]): { args: Args | null; error?: string } {
  const [cmd] = argv
  if (!cmd || !['save', 'restore', 'list'].includes(cmd)) return { args: null, error: 'usage: session-snapshot <save|restore|list> [platform|platform ...|--all] [--note "..." ] [--keep N] [--kill-first]' }
  const platforms: string[] = []
  let note: string | undefined
  let keep = 5
  let killFirst = false
  let all = false
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--note') { note = argv[++i]; continue }
    if (a === '--keep') { keep = Number(argv[++i] ?? 5) || 5; continue }
    if (a === '--kill-first') { killFirst = true; continue }
    if (a === '--all') { all = true; continue }
    platforms.push(a)
  }
  return { args: { cmd, platforms, note, keep, killFirst, all } }
}

async function resolvePlats(names: string[], all: boolean): Promise<ResolvedTarget[]> {
  const targets = loadTargets()
  if (all) return Object.values(targets)
  if (!names.length) return [targets['x']!]
  const out: ResolvedTarget[] = []
  for (const n of names) {
    const t = targets[n]
    if (!t) throw new Error(`unknown platform "${n}" — known: ${Object.keys(targets).join(', ')}`)
    out.push(t)
  }
  return out
}

async function snapshotSave(t: ResolvedTarget, note: string | undefined, killFirst: boolean, keep: number): Promise<void> {
  if (!existsSync(t.profile)) { console.error(`x [${t.platform}] profile missing — nothing to snapshot: ${t.profile}`); return }
  if (await cdpUp(t.cdpPort)) {
    if (!killFirst) {
      console.error(`x [${t.platform}] Chrome is RUNNING on ${t.cdpPort} — cookies may be mid-write.`)
      console.error('  Stop that Chrome (close the window) or rerun with --kill-first.')
      process.exitCode = 1
      return
    }
    await killChromeForProfile(t.profile)
    await Bun.sleep(1200)
  }
  const stamp = nowStamp()
  const dest = join(BACKUP_ROOT, t.platform, stamp)
  mkdirSync(dest, { recursive: true })
  const copied: Array<{ slot: string; file: string; bytes: number }> = []
  for (const entry of AUTH_FILES) {
    const srcRel = entry.slots.find(s => existsSync(join(t.profile, s)))
    if (!srcRel) continue
    cpSync(join(t.profile, srcRel), join(dest, basename(srcRel)))
    copied.push({ slot: srcRel, file: basename(srcRel), bytes: statSync(join(t.profile, srcRel)).size })
  }
  writeFileSync(join(dest, 'manifest.json'), JSON.stringify({
    platform: t.platform, profile: t.profile, cdpPort: t.cdpPort,
    createdAt: new Date().toISOString(), note: note ?? null, files: copied,
  }, null, 2) + '\n')
  console.error(`✓ [${t.platform}] saved ${copied.length} file(s) -> ${dest}`)

  // Retention prune.
  const platformDir = join(BACKUP_ROOT, t.platform)
  const prunable = selectPrunable(listStamps(platformDir), keep)
  for (const s of prunable) rmSync(join(platformDir, s), { recursive: true, force: true })
  if (prunable.length) console.error(`  pruned ${prunable.length} old stamp(s)`)
}

async function snapshotRestore(t: ResolvedTarget, stampWanted: string | undefined, killFirst: boolean): Promise<void> {
  const platformDir = join(BACKUP_ROOT, t.platform)
  const stamps = listStamps(platformDir)
  if (!stamps.length) { console.error(`x [${t.platform}] no snapshots exist under ${platformDir}`); process.exitCode = 1; return }
  let stamp = stampWanted
  if (!stamp) {
    stamp = stamps[0]!
    console.error(`   [${t.platform}] no stamp given — using latest: ${stamp}`)
  } else if (!STAMP_RE.test(stamp) || !existsSync(join(platformDir, stamp))) {
    console.error(`x [${t.platform}] stamp not found: ${stamp} (have: ${stamps.join(', ')})`)
    process.exitCode = 1
    return
  }
  const src = join(platformDir, stamp)
  if (await cdpUp(t.cdpPort)) {
    if (!killFirst) {
      console.error(`x [${t.platform}] Chrome is RUNNING on ${t.cdpPort} — refusing restore (would clobber live session files).`)
      console.error('  Rerun with --kill-first to stop it automatically.')
      process.exitCode = 1
      return
    }
    await killChromeForProfile(t.profile)
    await Bun.sleep(1200)
  }
  const manifest = JSON.parse(readFileSync(join(src, 'manifest.json'), 'utf-8')) as { files?: Array<{ slot: string; file: string }> }
  for (const f of manifest.files ?? []) {
    const dstSlot = restoreSlot(t.profile, f.slot, f.file)
    const dst = join(t.profile, dstSlot)
    mkdirSync(dirname(dst), { recursive: true })
    cpSync(join(src, f.file), dst, { force: true })
  }
  console.error(`✓ [${t.platform}] restored ${stamp} -> ${t.profile}`)
  console.error('  Launch again with: bun run ensure-chrome --target ' + t.platform)
}

async function main(): Promise<void> {
  const { args, error } = parseArgs(process.argv.slice(2))
  if (!args) { console.error(error); process.exit(1) }
  void loadConfig // config kept for parity with sibling scripts (host/device env)
  if (args.cmd === 'list') {
    const plats = args.platforms.length ? args.platforms : existsSync(BACKUP_ROOT) ? readdirSync(BACKUP_ROOT) : []
    if (!plats.length) { console.error('   (no snapshots yet)'); return }
    for (const p of plats) {
      const dir = join(BACKUP_ROOT, p)
      const stamps = listStamps(dir)
      console.error(`   ${p.padEnd(10)} ${stamps.length} snapshot(s)`)
      for (const s of stamps.slice(0, 8)) {
        let note = ''
        try { note = (JSON.parse(readFileSync(join(dir, s, 'manifest.json'), 'utf-8')).note) ?? '' } catch { /* ignore */ }
        console.error(`     ${s}${note ? `  — ${note}` : ''}`)
      }
    }
    return
  }
  const plats = await resolvePlats(args.platforms, args.all)
  for (const t of plats) {
    if (args.cmd === 'save') await snapshotSave(t, args.note, args.killFirst, args.keep)
    else await snapshotRestore(t, args.platforms.find(p => STAMP_RE.test(p)), args.killFirst)
  }
}

await main().catch(e => { console.error(`x ${(e as Error).message}`); process.exit(1) })
