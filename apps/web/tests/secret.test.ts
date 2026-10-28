import { describe, expect, test } from 'vitest'
import { maskSecrets } from '../src/ui/secret.ts'

describe('a secret shown in the conversation', () => {
  test('hides an assigned key under the name it was given and keeps four characters', () => {
    expect(maskSecrets('GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123')).toBe(
      'GITHUB_TOKEN=…0123',
    )
    expect(maskSecrets('API_KEY = sk-proj-AbCdEfGhIjKlMnOpQrStUvWx0123')).toBe('API_KEY = …0123')
  })

  test('hides a token behind its scheme', () => {
    expect(maskSecrets('Authorization: Bearer abcdefgh12345678')).toBe(
      'Authorization: Bearer …5678',
    )
  })

  test('keeps the vendor prefix of a key', () => {
    expect(maskSecrets('sk-proj-AbCdEfGhIjKlMnOpQrStUvWx0123')).toBe('sk-…0123')
    expect(maskSecrets('ghp_abcdefghijklmnopqrstuvwxyz0123')).toBe('ghp_…0123')
  })

  test('hides a signed token whole', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5NXgL0n3I9UP0THsR8U'
    expect(maskSecrets('token: ' + jwt)).toBe('token: …sR8U')
  })

  test('hides a long random blob', () => {
    const blob = 'aB3dE5fG7hI9jK1lM3nO5pQ7rS9tU1vW3xY5z'
    const masked = maskSecrets('the value is ' + blob + ' here')
    expect(masked).toBe('the value is …xY5z here')
    expect(masked).not.toContain(blob)
  })

  test('hides an armored private key as a block', () => {
    const key = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----'
    expect(maskSecrets(key)).toBe('-----BEGIN PRIVATE KEY-----…-----END PRIVATE KEY-----')
  })
})

describe('prose with no secret in it', () => {
  test('comes back exactly as it went in', () => {
    const prose = 'Please rename the monkey=banana fixture and say why the quick brown fox jumps.'
    expect(maskSecrets(prose)).toBe(prose)
  })

  test('keeps a long ordinary word that is not random', () => {
    const prose = 'antidisestablishmentarianism antidisestablishmentarianism'
    expect(maskSecrets(prose)).toBe(prose)
  })
})
