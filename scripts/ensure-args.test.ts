import { describe, expect, test } from 'bun:test'
import { parseEnsureArgs, taskPaths, DEFAULT_ENSURE } from './lib/ensure-args'

describe('parseEnsureArgs', () => {
  test('empty argv → default set (x + instagram)', () => {
    const { args, unknown } = parseEnsureArgs([])
    expect(args.targets).toEqual(DEFAULT_ENSURE)
    expect(unknown).toEqual([])
  })
  test('--all overrides to every-registry sentinel', () => {
    const { args } = parseEnsureArgs(['--all'])
    expect(args.targets).toBe('all')
  })
  test('repeated --target accumulates; --quiet honored', () => {
    const { args } = parseEnsureArgs(['--target', 'x', '--target', 'instagram', '--quiet'])
    expect(args.targets).toEqual(['x', 'instagram'])
    expect(args.quiet).toBe(true)
  })
  test('--timeout numeric accepted', () => {
    const { args } = parseEnsureArgs(['--timeout', '45'])
    expect(args.timeoutSec).toBe(45)
  })
  test('unknown flags are surfaced, not swallowed', () => {
    const { unknown } = parseEnsureArgs(['--wat'])
    expect(unknown).toEqual(['--wat'])
  })
})

describe('taskPaths', () => {
  test('shim path joins startup folder; command carries --all --quiet', () => {
    const { shim, line } = taskPaths('C:/bun/bun.exe', 'D:/proj/scripts/ensure-chrome.ts', 'C:/startup')
    expect(shim.endsWith('\\LocoAgentEnsureChrome.cmd')).toBe(true)
    expect(line).toContain('"C:/bun/bun.exe" "D:/proj/scripts/ensure-chrome.ts" --all --quiet')
    expect(line).toContain('@echo off')
  })
  test('paths with spaces survive quoting (this machine\'s user dir has a space)', () => {
    const { line } = taskPaths('C:/Mert Heyecan/bun.exe', 'D:/some path/s.ts', 'C:/st')
    expect(line).toContain('"C:/Mert Heyecan/bun.exe"')
    expect(line).toContain('"D:/some path/s.ts"')
  })
})
