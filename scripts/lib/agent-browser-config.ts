/**
 * agent-browser config pin. agent-browser, left unconfigured, launches its OWN
 * bundled "Chrome for Testing" on a random port instead of attaching to our
 * isolated CDP Chrome — so social logins land in a throwaway profile and the
 * user can never stay signed in. Pinning `cdp` makes EVERY agent-browser
 * command (even a bare `open`) attach to the CDP port, and if that port is
 * down it fails fast with a clear error instead of silently spawning Chrome
 * for Testing.
 *
 * TWO config locations are synced with the same `cdp` value:
 *   1. ~/.agent-browser/config.json — the TRUSTED user-level store. Project
 *      files are DISCARDED outright by agent-browser >= 0.43 ("automatic
 *      project config is untrusted"), so this is the pin that actually bites
 *      for a bare `agent-browser open` from any cwd.
 *   2. <project>/agent-browser.json — belt-and-braces for callers that select
 *      it explicitly (--config / AGENT_BROWSER_CONFIG).
 *
 * Search order when trusted-discovery kicks in:
 *   ~/.agent-browser/config.json < ./agent-browser.json (cwd) < env < flags —
 *   with both files carrying the same value, every path leads to the same port.
 *
 * NOTE: agent-browser's `cdp` key is a STRING ("9222"), not an integer — an
 * integer is rejected as "invalid type: integer".
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Absolute path to the project-level agent-browser.json pin. */
export function agentBrowserConfigPath(projectRoot: string): string {
  return join(projectRoot, 'agent-browser.json')
}

/** Absolute path to the user-level (trusted) agent-browser config. */
export function agentBrowserUserConfigPath(): string {
  return join(homedir(), '.agent-browser', 'config.json')
}

function readJsonObject(path: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    /* malformed/missing → rewrite from scratch below */
  }
  return {}
}

/** Render + write only when content changes (idempotent re-runs). */
function writeIfChanged(path: string, obj: Record<string, unknown>): void {
  const rendered = JSON.stringify(obj, null, 2) + '\n'
  if (!existsSync(path) || readFileSync(path, 'utf-8') !== rendered) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, rendered)
  }
}

/**
 * Merge `cdp: "<port>"` into BOTH the user-level trusted config and the
 * project-level pin, preserving any other keys. `opts.userConfigPath`
 * substitutes the home-relative path (tests). Returns the paths written.
 */
export function syncAgentBrowserConfig(
  projectRoot: string,
  port: number,
  opts: { userConfigPath?: string } = {},
): string[] {
  const paths = [opts.userConfigPath ?? agentBrowserUserConfigPath(), agentBrowserConfigPath(projectRoot)]
  for (const path of paths) {
    const current = readJsonObject(path)
    writeIfChanged(path, { ...current, cdp: String(port) })
  }
  return paths
}
