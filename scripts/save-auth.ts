#!/usr/bin/env bun
/**
 * save-auth.ts — capture reusable login credentials for a platform target into
 * agent-browser's encrypted local vault (agent-browser `auth save`), so the
 * auto-relogin lever (social-check --autologin) can act when a platform
 * force-logs-out the session.
 *
 *   bun run save-auth -- --platform x --username mashijiann --password "..."
 *   cat pass.txt | bun run save-auth -- --platform instagram --username myhandle
 *
 * Notes:
 *  - Password never leaves the machine; agent-browser stores it locally.
 *  - Run this while the target's login FORM is reachable: right after a logout,
 *    or before the very first login (guard opens the login URL for you).
 *  - This script talks DIRECTLY to the target Chrome via --cdp <port>; it does
 *    not close or hijack the agent-browser daemon.
 */
import { loadTargets, type ResolvedTarget } from './lib/browser-targets'

interface AuthArgs { platform?: string; username?: string; password?: string; url?: string }

function parseAuthArgs(argv: string[]): AuthArgs {
  const out: AuthArgs = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--platform') out.platform = argv[++i]
    else if (a === '--username') out.username = argv[++i]
    else if (a === '--password') out.password = argv[++i]
    else if (a === '--url') out.url = argv[++i]
  }
  return out
}

async function readStdinPassword(): Promise<string | undefined> {
  try {
    const chunks: Buffer[] = []
    for await (const chunk of Bun.stdin.stream()) chunks.push(chunk as Buffer)
    const txt = Buffer.concat(chunks).toString('utf-8').trim()
    return txt || undefined
  } catch { return undefined }
}

const auth = parseAuthArgs(process.argv.slice(2))
if (!auth.platform || !auth.username) {
  console.error('usage: bun run save-auth -- --platform <x|instagram> --username <handle> [--password ...] [--url ...]')
  console.error('       (or pipe the password via stdin)')
  process.exit(1)
}

let target: ResolvedTarget
try {
  const targets = loadTargets()
  target = targets[auth.platform]
  if (!target) throw new Error(`unknown platform "${auth.platform}" — known: ${Object.keys(targets).join(', ')}`)
} catch (e) {
  console.error(`x ${(e as Error).message}`)
  process.exit(1)
}

const authRef = target.authRef ?? `${auth.platform}-main`

const password = auth.password ?? (await readStdinPassword())
if (!password) {
  console.error('x no password supplied (use --password or pipe via stdin)')
  process.exit(1)
}

const loginUrl = auth.url ?? (auth.platform === 'x'
  ? 'https://x.com/i/flow/login'
  : auth.platform === 'instagram'
    ? 'https://www.instagram.com/accounts/login/'
    : `https://www.${auth.platform}.com/login`)

console.error(`-> saving credentials as "${authRef}" for ${auth.platform} (cdp ${target.cdpPort}) ...`)
const proc = Bun.spawn(
  ['agent-browser', 'auth', 'save', authRef,
    '--url', loginUrl,
    '--username', auth.username!,
    '--password', password,
    '--cdp', String(target.cdpPort)],
  { stdout: 'inherit', stderr: 'inherit', stdin: 'inherit' },
)
const code = await proc.exited
if (code === 0) {
  console.error(`✓ credentials saved. From now on: bun run social-check --target ${auth.platform} --autologin`)
} else {
  console.error('x auth save failed — is a login form reachable in that window?')
}
process.exit(code ?? 1)
