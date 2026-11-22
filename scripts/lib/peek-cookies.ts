/**
 * peek-cookies.ts — read-only census of which platform login cookies live in a
 * browser "User Data" root (Chrome/Edge/Brave). Values are never read or
 * decrypted; presence + expiry alone answer "would this profile log in?".
 *
 * Lock-proof + WAL-aware: if the cookie db is file-locked (Chrome running),
 * the db AND its -wal/-shm companions are cloned to temp and read there, so
 * transactions parked in the WAL are counted — an immutable-URI-only read
 * would silently show 0 rows on a WAL-mode db and trigger a wrong diagnosis.
 */
import { Database } from 'bun:sqlite'
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const CENSUS: Array<{ label: string; hostLikes: string[]; markers: string[] }> = [
  { label: 'instagram', hostLikes: ['%.instagram.com'], markers: ['sessionid', 'ds_user_id'] },
  { label: 'x', hostLikes: ['%.x.com', '%.twitter.com'], markers: ['auth_token', 'ct0'] },
  { label: 'linkedin', hostLikes: ['%.linkedin.com'], markers: ['li_at'] },
  { label: 'reddit', hostLikes: ['%.reddit.com'], markers: ['token_v2'] },
  { label: 'google', hostLikes: ['%.google.com'], markers: ['SID', 'SAPISID'] },
]

/** Candidate real-browser roots, most common first (existing ones only). */
export function candidateBrowserRoots(): Array<{ browser: string; userDataDir: string }> {
  const local = process.env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local')
  const candidates = [
    { browser: 'chrome', userDataDir: join(local, 'Google', 'Chrome', 'User Data') },
    { browser: 'edge', userDataDir: join(local, 'Microsoft', 'Edge', 'User Data') },
    { browser: 'brave', userDataDir: join(local, 'BraveSoftware', 'Brave-Browser', 'User Data') },
  ]
  return candidates.filter(c => existsSync(join(c.userDataDir, 'Default')))
}

function cookiePaths(userDataDir: string, subdir = 'Default'): string[] {
  return [
    join(userDataDir, subdir, 'Network', 'Cookies'),
    join(userDataDir, subdir, 'Cookies'),
  ].filter(existsSync)
}

/** Clone db (+WAL/+SHM companions) so committed-but-not-checkpointed rows count. */
function cloneWithWal(dbPath: string, dstBase: string): string {
  copyFileSync(dbPath, dstBase)
  for (const suffix of ['-wal', '-shm']) {
    const comp = dbPath + suffix
    if (existsSync(comp)) {
      try { copyFileSync(comp, dstBase + suffix) } catch { /* racy companion */ }
    }
  }
  return dstBase
}

interface Acc { live: number; found: string[] }

function censusOneDb(srcUri: string, spec: (typeof CENSUS)[number], acc: Acc): void {
  const db = new Database(srcUri, { readonly: true })
  try {
    const clause = spec.hostLikes.map(() => 'host_key LIKE ?').join(' OR ')
    const rows = db
      .prepare(`SELECT name, expires_utc FROM cookies WHERE ${clause}`)
      .all(...spec.hostLikes) as Array<{ name: string; expires_utc: number }>
    const nowUs = BigInt(Date.now()) * 1000n
    for (const r of rows) {
      const exp = BigInt(r.expires_utc)
      // expires_utc=0 → session cookie (alive while the browser lives)
      if (exp === 0n || exp > nowUs) acc.live++
      if (spec.markers.includes(r.name)) acc.found.push(r.name)
    }
  } finally {
    db.close()
  }
}

/** Lines: "<browser>/<label>: N live cookie(s) [markers]" (skips all-zero empties when loud=false). */
export function peekLines(
  userDataDir: string,
  opts: { prefix?: string; skipEmpty?: boolean; subdir?: string } = {},
): string[] {
  const dbs = cookiePaths(userDataDir, opts.subdir)
  if (!dbs.length) return [`${opts.prefix ?? ''}(no cookie db found)`.trim()]
  const tmp = mkdtempSync(join(tmpdir(), 'peek-'))
  const lines: string[] = []
  const prefix = opts.prefix ? `${opts.prefix}/` : ''
  try {
    for (const spec of CENSUS) {
      const acc: Acc = { live: 0, found: [] }
      for (const dbPath of dbs) {
        let src: string | null = null
        try {
          src = cloneWithWal(dbPath, join(tmp, 'census.db'))
          censusOneDb(src, spec, acc)
        } catch {
          // Physical clone raced a write — degrade to immutable in-place read.
          try {
            const uri = 'file:///' + encodeURI(dbPath.replace(/\\/g, '/')) + '?immutable=1'
            censusOneDb(uri, spec, acc)
          } catch { /* db layout variant — skip */ }
        }
      }
      if (opts.skipEmpty && acc.live === 0 && !acc.found.length) continue
      lines.push(`${prefix}${spec.label}: ${acc.live} live cookie(s)${acc.found.length ? ` [${acc.found.join(', ')}]` : ''}`)
    }
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }) } catch { /* tmp GC */ }
  }
  return lines.length ? lines : [`${prefix}no census rows`]
}

/** Full sweep of every existing candidate browser root. */
export function peekAllBrowsers(): string[] {
  const out: string[] = []
  for (const cand of candidateBrowserRoots()) {
    out.push(`# ${cand.browser} — ${cand.userDataDir}`)
    out.push(...peekLines(cand.userDataDir, { prefix: cand.browser, skipEmpty: false }))
    out.push('')
  }
  return out
}

export function peekCookies(userDataDir: string): string[] {
  return peekLines(userDataDir)
}
