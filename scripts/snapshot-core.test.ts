import { describe, expect, test } from 'bun:test'
import {
  AUTH_FILES,
  STAMP_RE,
  listStamps,
  nowStamp,
  restoreSlot,
  selectPrunable,
} from './lib/snapshot-core'
import { mkdirSync, rmSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('stamps', () => {
  test('nowStamp matches contract regex', () => {
    expect(nowStamp()).toMatch(STAMP_RE)
  })
  test('AUTH_FILES covers crypto key + cookies + prefs trio', () => {
    const slots = AUTH_FILES.flatMap(a => a.slots)
    expect(slots).toContain('Local State')
    expect(slots.some(s => s.includes('Cookies'))).toBe(true)
    expect(slots).toContain('Default/Preferences')
    expect(slots).toContain('Default/Secure Preferences')
  })
})

describe('listStamps', () => {
  test('descending sort, ignores non-stamp entries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'snapst-'))
    try {
      mkdirSync(join(dir, '20261120-100000'))
      mkdirSync(join(dir, '20261122-090000'))
      mkdirSync(join(dir, '20261121-100000'))
      mkdirSync(join(dir, 'not-a-stamp'))
      const f = join(dir, 'plainfile.txt')
      writeFileSync(f, 'x')
      expect(listStamps(dir)).toEqual([
        '20261122-090000',
        '20261121-100000',
        '20261120-100000',
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  test('missing dir → empty list', () => {
    expect(listStamps(join(tmpdir(), 'definitely-missing-dir-xyz'))).toEqual([])
  })
})

describe('selectPrunable', () => {
  // Contract input is the DESCENDING (newest-first) list produced by listStamps.
  const stamps = ['20261122-100000', '20261121-100000', '20261120-100000']
  test('keeps newest N, prunes the oldest', () => {
    expect(selectPrunable(stamps, 2)).toEqual(['20261120-100000'])
  })
  test('under retention → prune nothing', () => {
    expect(selectPrunable(stamps, 5)).toEqual([])
    expect(selectPrunable([], 5)).toEqual([])
  })
})

describe('restoreSlot', () => {
  test('non-cookie files keep their original slot', () => {
    expect(restoreSlot('/p', 'Local State', 'Local State')).toBe('Local State')
    expect(restoreSlot('/p', 'Default/Preferences', 'Preferences')).toBe('Default/Preferences')
  })
  test('legacy Cookies source slot → modern profile gets Default/Network path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'restslot-'))
    try {
      mkdirSync(join(dir, 'Default', 'Network'), { recursive: true })
      expect(restoreSlot(dir, 'Default/Cookies', 'Cookies')).toBe('Default/Network/Cookies')
      expect(restoreSlot(dir, 'Default/Network/Cookies', 'Cookies')).toBe('Default/Network/Cookies')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  test('destination layout governs: legacy profile (no Default/Network) ← modern slot → Default/', () => {
    const dir = mkdtempSync(join(tmpdir(), 'restslot2-'))
    try {
      mkdirSync(join(dir, 'Default'), { recursive: true })
      expect(restoreSlot(dir, 'Default/Network/Cookies', 'Cookies')).toBe('Default/Cookies')
      expect(restoreSlot(dir, 'Default/Network/Cookies', 'Cookies-journal')).toBe('Default/Cookies-journal')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
