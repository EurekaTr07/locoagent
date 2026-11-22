#!/usr/bin/env bun
/**
 * social-check.ts — one command that makes "are my social logins alive?"
 * boring to answer:
 *
 *   1. ensure-chrome: any target Chrome that is down gets relaunched (quiet).
 *   2. probe each platform's REAL login state over raw CDP.
 *   3. (optional) --autologin: for a 'no' verdict whose target defines authRef,
 *      run `agent-browser auth login <ref>` against that port and re-probe.
 *
 *   bun run social-check                       # default: x + instagram
 *   bun run social-check --target x
 *   bun run social-check --target instagram --autologin
 *
 * Exit code 0 iff every checked target is logged in at the end.
 */
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadTargets } from './lib/browser-targets'
import { probeLogin, renderVerdict } from './lib/login-probe'

const HERE = dirname(fileURLToPath(import.meta.url))
const ENSURE_SCRIPT = resolve(HERE, 'ensure-chrome.ts')

interface CheckArgs { targets: string[]; autologin: boolean; timeoutSec: number }

function parseCheckArgs(argv: string[]): CheckArgs {
  const out: CheckArgs = { targets: [], autologin: false, timeoutSec: 25 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--target') { const v = argv[++i]; if (v) out.targets.push(v) }
    else if (a === '--autologin') out.autologin = true
    else if (a === '--timeout') { const v = Number(argv[++i]); if (Number.isFinite(v) && v > 0) out.timeoutSec = v }
  }
  if (!out.targets.length) out.targets = ['x', 'instagram']
  return out
}

async function runEnsure(target: string): Promise<void> {
  const proc = Bun.spawn([process.execPath, 'run', ENSURE_SCRIPT, '--target', target, '--quiet'], {
    stdout: 'ignore', stderr: 'ignore',
  })
  const code = await proc.exited
  if (code !== 0) console.error(`   (warning: ensure-chrome exited ${code} for ${target})`)
}

async function runAutologin(authRef: string, cdpPort: number): Promise<boolean> {
  console.error(`   -> attempting saved-credential login (${authRef}) on CDP ${cdpPort} ...`)
  const proc = spawn('agent-browser', ['auth', 'login', authRef, '--cdp', String(cdpPort)], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  const code = await new Promise<number>(res => proc.once('exit', c => res(c ?? 1)))
  return code === 0
}

const { targets: wanted, autologin, timeoutSec } = parseCheckArgs(process.argv.slice(2))
const registry = loadTargets()
let failures = 0

for (const name of wanted) {
  const t = registry[name]
  if (!t) {
    console.error(`? ${name}: not in registry — skipping`)
    failures++
    continue
  }
  await runEnsure(name)
  // Instagram gets the GENTLE probe by default: passive cookie-read through
  // any tab the human already has open, never an automation-generated page
  // load (Instagram rate-flags repeated machine page hits with captchas).
  const gentle = ['instagram']
  let v = await probeLogin(name, t.cdpPort, {
    timeoutMs: timeoutSec * 1000,
    residentOnly: gentle.includes(name),
  })

  if (v.state !== 'yes' && autologin && t.authRef) {
    const ok = await runAutologin(t.authRef, t.cdpPort)
    if (ok) {
      await Bun.sleep(2500) // let the flow finish redirecting
      v = await probeLogin(name, t.cdpPort, { timeoutMs: timeoutSec * 1000 })
    }
  }

  console.error(renderVerdict(v))
  if (v.state !== 'yes') failures++
}

if (failures) {
  console.error('')
  console.error('FIX PATH:')
  console.error('  1. bun run ensure-chrome --all            # bring Chrome back up')
  console.error('  2. bun run session-snapshot list          # check backups exist')
  console.error('  3. (session lost?) bun run session-snapshot restore <platform> --kill-first')
  console.error('  4. still out? log in manually once in the target window, then:')
  console.error('       bun run session-snapshot save <platform> --note "manual relogin"')
  console.error('       bun run save-auth -- --platform <platform> --username <handle>')
}
process.exit(failures ? 1 : 0)
