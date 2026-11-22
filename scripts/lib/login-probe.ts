/**
 * login-probe.ts — raw-CDP login-state checker.
 *
 * Ground truth = COOKIE CENSUS via CDP `Storage.getCookies` on a page session
 * of the target's own Chrome: the presence of platform-auth cookies
 * (x: auth_token/ct0, instagram: sessionid/ds_user_id, …) IS the logged-in
 * state — immune to page-markup churn, bot walls and redirects. DOM-marker
 * evaluation is kept purely as a degraded fallback when Storage.getCookies is
 * refused.
 *
 * Classification:
 *   "yes"     — auth cookie present (expiry-valid or session cookie)
 *   "no"      — page settled (complete) + zero auth cookies for the platform
 *   "unknown" — still loading / CDP refused (poll until deadline)
 *
 * Talks to the CDP HTTP+WS endpoints directly: probing must work even while
 * the agent-browser daemon is wedged or attached elsewhere.
 * Pure logic (`classifyProbe`, `looksLoggedOutUrl`, `pickAuthCookie`) is
 * exported for unit tests; only probeLogin/probeAllLogins touch the network.
 */
import { WebSocket } from 'ws'

export interface LoginVerdict {
  platform: string
  cdpPort: number
  state: 'yes' | 'no' | 'unknown'
  detail: string
}

export interface CookieRow {
  name: string
  domain: string
  expires: number
}

/** Platform auth-cookie definitions (ground truth, not DOM cosmetics). */
export const PLATFORM_COOKIE_MARKERS: Record<string, { hostSuffixes: string[]; names: string[]; homeUrl: string }> = {
  x: {
    homeUrl: 'https://x.com/home',
    hostSuffixes: ['.x.com', '.twitter.com'],
    names: ['auth_token', 'ct0', 'twid'],
  },
  instagram: {
    homeUrl: 'https://www.instagram.com/',
    hostSuffixes: ['.instagram.com'],
    names: ['sessionid', 'ds_user_id'],
  },
  linkedin: {
    homeUrl: 'https://www.linkedin.com/feed/',
    hostSuffixes: ['.linkedin.com'],
    names: ['li_at', 'liap'],
  },
  reddit: {
    homeUrl: 'https://www.reddit.com/',
    hostSuffixes: ['.reddit.com'],
    names: ['token_v2', 'session_tracker'],
  },
  google: {
    homeUrl: 'https://mail.google.com/mail/u/0/',
    hostSuffixes: ['.google.com'],
    names: ['SID', 'HSID', 'SSID'],
  },
}

/** Kept for the degraded DOM fallback path (changed pages ≠ cookie truth). */
export const PLATFORM_PROBES = Object.fromEntries(
  Object.entries(PLATFORM_COOKIE_MARKERS).map(([p, s]) => [p, { homeUrl: s.homeUrl, name: p }]),
) as Record<string, { homeUrl: string; name: string }>

/** Decision rule on a cookie row set (pure; unit-tested). */
export function pickAuthCookie(
  platform: string,
  cookies: CookieRow[],
): { verdict: boolean; hit: string } {
  const spec = PLATFORM_COOKIE_MARKERS[platform]
  if (!spec) return { verdict: false, hit: '' }
  for (const name of spec.names) {
    const row = cookies.find(
      c => c.name === name && spec.hostSuffixes.some(sf => c.domain === sf || c.domain.endsWith(sf)),
    )
    if (row) {
      // expires: epoch SECONDS (0 = session cookie → treat as alive)
      if (row.expires === 0 || row.expires * 1000 > Date.now()) {
        return { verdict: true, hit: `${name}@${row.domain}` }
      }
    }
  }
  return { verdict: false, hit: '' }
}

/** DOM-marker classification (degraded fallback only). Exported pure for tests. */
export function classifyProbe(
  platform: string,
  cdpPort: number,
  loggedIn: boolean | null,
  loggedOut: boolean | null,
  note = '',
): LoginVerdict {
  if (loggedIn === true && !loggedOut) {
    return { platform, cdpPort, state: 'yes', detail: 'signed-in marker present' }
  }
  if (loggedOut === true && !loggedIn) {
    return { platform, cdpPort, state: 'no', detail: 'logged-out marker present' }
  }
  const bits = [note, `marker=${String(loggedIn)}`, `out=${String(loggedOut)}`].filter(Boolean)
  return { platform, cdpPort, state: 'unknown', detail: bits.join(' · ') || 'inconclusive' }
}

/** TRUE when a URL itself signals a logged-out landing/login page. Pure helper. */
export function looksLoggedOutUrl(url: string): boolean {
  return /\/(login|accounts\/login|i\/flow\/signin)\b/.test(url)
}

interface CdpTab {
  id: string
  url: string
  type: string
  webSocketDebuggerUrl?: string
}

interface CdpMsg {
  id?: number
  method?: string
  result?: Record<string, unknown>
  error?: { message?: string }
}

async function cdpHttp(port: number, path: string, method = 'GET'): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, { method })
}

async function listPageTabs(port: number): Promise<CdpTab[]> {
  const res = await cdpHttp(port, '/json/list')
  if (!res.ok) throw new Error(`/json/list HTTP ${res.status}`)
  const tabs = (await res.json()) as CdpTab[]
  return Array.isArray(tabs) ? tabs.filter(t => t.type === 'page') : []
}

/**
 * Run a short CDP RPC conversation on one page-socket, then close.
 * `steps` are sent sequentially on open; every reply resolves the returned
 * promise map. Keeps sockets short-lived (long-lived page sockets collide
 * with the resident agent-browser session).
 */
function cdpRpc(
  wsUrl: string,
  steps: Array<{ id: number; method: string; params?: Record<string, unknown> }>,
  timeoutMs: number,
): Promise<Map<number, { result?: Record<string, unknown>; error?: { message?: string } }>> {
  return new Promise((resolveRpc, rejectRpc) => {
    const ws = new WebSocket(wsUrl)
    const replies = new Map<number, { result?: Record<string, unknown>; error?: { message?: string } }>()
    const timer = setTimeout(() => {
      try { ws.terminate() } catch { /* noop */ }
      rejectRpc(new Error('cdp rpc timed out'))
    }, timeoutMs)
    ws.on('error', e => {
      clearTimeout(timer)
      rejectRpc(new Error(String(e)))
    })
    ws.on('open', () => {
      for (const step of steps) ws.send(JSON.stringify(step))
    })
    ws.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString('utf-8')) as CdpMsg
        if (typeof msg.id === 'number') {
          replies.set(msg.id, { result: msg.result, error: msg.error })
          if (replies.size >= steps.length) {
            clearTimeout(timer)
            try { ws.close() } catch { /* noop */ }
            resolveRpc(replies)
          }
        }
      } catch (e) {
        clearTimeout(timer)
        rejectRpc(e as Error)
      }
    })
  })
}

/** Open a fresh CDP tab; Chrome >=133 needs PUT /json/new, older needs GET. */
async function openScratchTab(port: number, url: string): Promise<CdpTab | null> {
  const enc = encodeURIComponent(url)
  for (const method of ['PUT', 'GET']) {
    try {
      const res = await cdpHttp(port, `/json/new?${enc}`, method)
      if (res.ok) {
        const tab = (await res.json()) as CdpTab
        if (tab?.webSocketDebuggerUrl) return tab
      }
    } catch { /* try next verb */ }
  }
  return null
}

async function closeScratchTab(port: number, tabId: string): Promise<void> {
  try { await cdpHttp(port, `/json/close/${tabId}`) } catch { /* best effort */ }
}

/**
 * Cookie census over one page-socket (no domain enabling needed for
 * Storage.getCookies in Chrome ≥94). Falls back to DOM markers only if the
 * storage domain errors — never trusts partial sets blindly.
 */
async function cookieCensus(wsUrl: string): Promise<CookieRow[] | null> {
  const replies = await cdpRpc(wsUrl, [{ id: 1, method: 'Storage.getCookies' }], 6000)
  const reply = replies.get(1)
  const cookies = (reply?.result as { cookies?: CookieRow[] } | undefined)?.cookies
  return Array.isArray(cookies) ? cookies : null
}

const READY_EXPR = `JSON.stringify({u:location.href,t:document.readyState})`

/**
 * Probe one platform target against its own Chrome:
 *   resident tab → cookie census → classify; else scratch tab → poll census.
 * DOM fallback engages only when Storage.getCookies is refused.
 */
export async function probeLogin(
  platform: string,
  cdpPort: number,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<LoginVerdict> {
  const spec = PLATFORM_COOKIE_MARKERS[platform]
  if (!spec) return { platform, cdpPort, state: 'unknown', detail: 'no probe defined' }
  const timeoutMs = opts.timeoutMs ?? 20000
  const pollMs = opts.pollMs ?? 900
  const deadline = Date.now() + timeoutMs
  const homeOrigin = new URL(spec.homeUrl).origin
  let scratch: CdpTab | null = null
  let lastNote = ''

  try {
    while (Date.now() < deadline) {
      try {
        const tabs = await listPageTabs(cdpPort)
        const originPrefix = `${new URL(homeOrigin).protocol}//${new URL(homeOrigin).host}`

        // Resident-tab census: whoever sits on the target origin shares the jar.
        const resident = tabs.find(t => t.webSocketDebuggerUrl && t.url.startsWith(originPrefix))
        if (resident?.webSocketDebuggerUrl) {
          const cookies = await cookieCensus(resident.webSocketDebuggerUrl)
          if (cookies) {
            const { verdict, hit } = pickAuthCookie(platform, cookies)
            if (verdict) {
              return { platform, cdpPort, state: 'yes', detail: `auth cookie ${hit}` }
            }
            lastNote = `resident tab ${resident.url.slice(0, 60)} · 0 auth cookies (of ${cookies.length})`
          }
        }

        // Scratch-tab census: navigate home, wait for settle, re-census.
        if (!scratch) {
          scratch = await openScratchTab(cdpPort, spec.homeUrl)
          if (!scratch) lastNote = '/json/new refused'
        }
        if (scratch?.webSocketDebuggerUrl) {
          let settled = false
          try {
            const r = await cdpRpc(scratch.webSocketDebuggerUrl,
              [
                { id: 1, method: 'Runtime.evaluate', params: { expression: READY_EXPR, returnByValue: true } },
                { id: 2, method: 'Storage.getCookies' },
              ], 7000)
            const readyRaw = (r.get(1)?.result as { result?: { value?: unknown } } | undefined)?.result?.value
            try {
              const st = JSON.parse(String(readyRaw)) as { u: string; t: string }
              settled = st.t === 'complete'
              if (settled && looksLoggedOutUrl(st.u)) {
                const cookies = (r.get(2)?.result as { cookies?: CookieRow[] } | undefined)?.cookies
                if (Array.isArray(cookies) && !pickAuthCookie(platform, cookies).verdict) {
                  return { platform, cdpPort, state: 'no', detail: `login wall at ${st.u}` }
                }
              }
            } catch { /* ready parse — poll on */ }
            const cookies = (r.get(2)?.result as { cookies?: CookieRow[] } | undefined)?.cookies
            if (Array.isArray(cookies)) {
              const { verdict, hit } = pickAuthCookie(platform, cookies)
              if (verdict) {
                return { platform, cdpPort, state: 'yes', detail: `auth cookie ${hit}` }
              }
              if (settled) {
                lastNote = `settled ${new URL(homeOrigin).host} · 0 auth cookies (of ${cookies.length})`
              }
            }
          } catch (e) {
            lastNote = (e as Error).message.slice(0, 80)
          }
        }
      } catch (e) {
        lastNote = (e as Error).message.slice(0, 80)
      }
      if (Date.now() >= deadline) break
      await new Promise(r => setTimeout(r, pollMs))
    }
  } finally {
    if (scratch) await closeScratchTab(cdpPort, scratch.id)
  }
  // Settled-but-no-cookie after full deadline ⇒ authoritative NO.
  if (lastNote.includes('0 auth cookies')) {
    return { platform, cdpPort, state: 'no', detail: lastNote }
  }
  return { platform, cdpPort, state: 'unknown', detail: lastNote || 'timed out' }
}

/** Probe several targets CONCURRENTLY (each owns a distinct port). */
export async function probeAllLogins(
  targets: Array<{ platform: string; cdpPort: number }>,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<LoginVerdict[]> {
  return Promise.all(targets.map(t => probeLogin(t.platform, t.cdpPort, opts)))
}

/** Human-facing render for doctor/console output. */
export function renderVerdict(v: LoginVerdict): string {
  const glyph = v.state === 'yes' ? '✓' : v.state === 'no' ? '✗' : '?'
  return `${glyph} ${v.platform.padEnd(10)} [${v.state.padEnd(7)}] ${v.detail}`
}
