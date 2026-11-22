import { test, expect } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  agentBrowserConfigPath,
  agentBrowserUserConfigPath,
  syncAgentBrowserConfig,
} from './agent-browser-config'

test('agentBrowserConfigPath is agent-browser.json under the project root', () => {
  expect(agentBrowserConfigPath('/proj')).toBe(join('/proj', 'agent-browser.json'))
})

test('agentBrowserUserConfigPath lives under ~/.agent-browser', () => {
  expect(agentBrowserUserConfigPath()).toContain('.agent-browser')
  expect(agentBrowserUserConfigPath().endsWith('config.json')).toBe(true)
})

/** Temp-pair harness: user-level (trusted) + project-level files. */
function tmpPair() {
  const userDir = mkdtempSync(join(tmpdir(), 'abc-user-'))
  const projDir = mkdtempSync(join(tmpdir(), 'abc-proj-'))
  return {
    userPath: join(userDir, 'config.json'),
    projDir,
    cleanup() {
      // fine to leave for tmp GC; rm would race on Windows runners
    },
  }
}

test('syncAgentBrowserConfig writes cdp as a STRING in BOTH files', () => {
  const { userPath, projDir, cleanup } = tmpPair()
  void cleanup
  const paths = syncAgentBrowserConfig(projDir, 9222, { userConfigPath: userPath })
  expect(paths).toHaveLength(2)
  for (const path of paths) {
    const parsed = JSON.parse(readFileSync(path!, 'utf-8'))
    expect(parsed.cdp).toBe('9222')
    expect(typeof parsed.cdp).toBe('string')
  }
})

test('preserves other keys and updates the port, both locations', () => {
  const { userPath, projDir } = tmpPair()
  writeFileSync(userPath, JSON.stringify({ headed: true, cdp: '1111' }))
  const paths = syncAgentBrowserConfig(projDir, 9333, { userConfigPath: userPath })
  const [user, proj] = paths as [string, string]
  const u = JSON.parse(readFileSync(user, 'utf-8'))
  expect(u.cdp).toBe('9333')
  expect(u.headed).toBe(true)
  expect(JSON.parse(readFileSync(proj, 'utf-8')).cdp).toBe('9333')
})

test('idempotent — stable formatting, no rewrite churn', () => {
  const { userPath, projDir } = tmpPair()
  const [, proj] = syncAgentBrowserConfig(projDir, 9222, { userConfigPath: userPath }) as [string, string]
  const first = readFileSync(proj, 'utf-8')
  syncAgentBrowserConfig(projDir, 9222, { userConfigPath: userPath })
  expect(readFileSync(proj, 'utf-8')).toBe(first)
  expect(first).toBe('{\n  "cdp": "9222"\n}\n')
})

test('recovers from a malformed file', () => {
  const { userPath, projDir } = tmpPair()
  writeFileSync(join(projDir, 'agent-browser.json'), '{ not json')
  const paths = syncAgentBrowserConfig(projDir, 9222, { userConfigPath: userPath })
  expect(JSON.parse(readFileSync(paths[1]!, 'utf-8')).cdp).toBe('9222')
})
