import { describe, expect, test } from 'vitest'
import { Effect } from 'effect'
import { loadBundledProfile } from '../src/index.ts'
import { mergeRows, parseProfile, renderConfig } from '@jozo-harness/kernel'

describe('base profile', () => {
  test('parses into the S1 plugin rows in order', async () => {
    const profile = await Effect.runPromise(parseProfile(await loadBundledProfile()))

    expect(profile.name).toBe('base')
    expect(profile.plugins.map((row) => row.id)).toEqual([
      'kernel',
      'sessions',
      'session-jsonl',
      'tools',
      'system-prompt',
      'safety',
      'tier0',
      'ask',
      'tier1',
      'llm',
      'agent',
      'agent-loop',
    ])
    expect(profile.plugins.map((row) => row.name)).toContain('@jozo-harness/agent-loop')
    expect(renderConfig(profile.plugins)).toContain('id=session-jsonl')
  })

  test('a profile patch overrides one row by id without reordering it', async () => {
    const base = await Effect.runPromise(parseProfile(await loadBundledProfile()))
    const patch = await Effect.runPromise(
      parseProfile(
        'name: patch\nplugins:\n  - id: llm\n    name: "@jozo-harness/llm-openai"\n    config:\n      baseUrl: http://127.0.0.1:11434/v1',
      ),
    )

    const merged = mergeRows([base.plugins, patch.plugins])
    const llm = merged.find((row) => row.id === 'llm')

    expect(llm?.config).toEqual({
      baseUrl: 'http://127.0.0.1:11434/v1',
      apiKeyEnv: 'OLLAMA_API_KEY',
      reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    })
    expect(merged.map((row) => row.id)).toEqual(base.plugins.map((row) => row.id))
  })
})
