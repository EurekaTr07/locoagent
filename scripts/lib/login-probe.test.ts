import { describe, expect, test } from 'bun:test'
import { classifyProbe, looksLoggedOutUrl } from './login-probe'

describe('classifyProbe', () => {
  test('logged-in marker only → yes', () => {
    const v = classifyProbe('x', 9222, true, false)
    expect(v.state).toBe('yes')
  })
  test('logged-out marker only → no', () => {
    const v = classifyProbe('x', 9222, false, true)
    expect(v.state).toBe('no')
  })
  test('both markers → unknown (ambiguous page)', () => {
    expect(classifyProbe('x', 9222, true, true).state).toBe('unknown')
  })
  test('neither marker → unknown', () => {
    expect(classifyProbe('x', 9222, false, false, 'loading').state).toBe('unknown')
  })
  test('null markers → unknown with note', () => {
    const v = classifyProbe('instagram', 9226, null, null, 'timed out')
    expect(v.state).toBe('unknown')
    expect(v.detail).toContain('timed out')
  })
})

describe('looksLoggedOutUrl', () => {
  test('x login flow url → true', () => {
    expect(looksLoggedOutUrl('https://x.com/i/flow/signin')).toBe(true)
  })
  test('instagram accounts/login → true', () => {
    expect(looksLoggedOutUrl('https://www.instagram.com/accounts/login/?next=%2F')).toBe(true)
  })
  test('plain home feed → false', () => {
    expect(looksLoggedOutUrl('https://x.com/home')).toBe(false)
    expect(looksLoggedOutUrl('https://www.instagram.com/')).toBe(false)
  })
})
