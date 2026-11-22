/**
 * snapshot-core.ts — pure fs/array logic for session-snapshot.ts (unit-testable
 * without running the CLI). Defines WHICH files constitute a recoverable social
 * login, how stamps are named/sorted, and retention pruning.
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** Durable auth-state files, relative to the profile root (first existing slot wins). */
export const AUTH_FILES: Array<{ slots: string[]; purpose: string }> = [
  { slots: ['Local State'], purpose: 'crypto bootstrap for encrypted cookie values' },
  { slots: ['Default/Network/Cookies', 'Default/Cookies'], purpose: 'session cookies' },
  { slots: ['Default/Network/Cookies-journal', 'Default/Cookies-journal'], purpose: 'cookie db journal' },
  { slots: ['Default/Login Data', 'Default/Login Data-journal'], purpose: 'saved site passwords (autologin)' },
  { slots: ['Default/Web Data', 'Default/Web Data-journal'], purpose: 'form autofill entries' },
  { slots: ['Default/Preferences'], purpose: 'language/locale prefs (classifier stability)' },
  { slots: ['Default/Secure Preferences'], purpose: 'extension/settings integrity state' },
]

export const STAMP_RE = /^\d{8}-\d{6}$/

export function nowStamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** Descending (newest-first) stamp list of a platform backup dir. */
export function listStamps(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isDirectory() && STAMP_RE.test(e.name))
    .map(e => e.name)
    .sort((a, b) => (a < b ? 1 : -1))
}

/** Stamps exceeding the newest-`keep` retention window (order preserved). */
export function selectPrunable(stamps: string[], keep: number): string[] {
  if (stamps.length <= keep) return []
  return stamps.slice(keep)
}

/**
 * Resolve the RESTORE destination slot for a snapshotted file inside the
 * DESTINATION profile's CURRENT layout: modern Chrome keeps the Cookies family
 * under Default/Network, older layouts under Default/ — a restore must write
 * where the profile will actually read. Everything else keeps its slot.
 */
export function restoreSlot(profileRoot: string, originalSlot: string, fileName: string): string {
  void originalSlot
  if (!fileName.startsWith('Cookies')) return originalSlot
  const modernDest = existsSync(join(profileRoot, 'Default', 'Network'))
  return modernDest ? `Default/Network/${fileName}` : `Default/${fileName}`
}
