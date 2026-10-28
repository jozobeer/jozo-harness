import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PluginRow } from '@jozo-harness/kernel'
import { Effect } from 'effect'
import { describe, expect, test } from 'vitest'
import type { JozoHarnessConfig } from '../src/config-file.ts'
import {
  editRunSettings,
  readEditableSettings,
  runSettingsProblems,
  type EditableInputs,
} from '../src/run-settings.ts'

const baseRows: ReadonlyArray<PluginRow> = [
  {
    id: 'tier0',
    name: '@jozo-harness/tools-tier0',
    config: { timeoutMs: 30_000 },
  },
  { id: 'tier1', name: '@jozo-harness/tools-tier1' },
  { id: 'agent-loop', name: '@jozo-harness/agent-loop' },
  { id: 'llm', name: '@jozo-harness/llm-openai', config: { apiKeyEnv: 'OLLAMA_API_KEY' } },
]

const settings = (plugins?: ReadonlyArray<PluginRow>): JozoHarnessConfig =>
  plugins === undefined ? {} : { plugins }

const inputsOf = (
  rows: ReadonlyArray<PluginRow>,
  config: JozoHarnessConfig = {},
  credentialsPath = '/nonexistent/credentials.json',
  env: Readonly<Record<string, string | undefined>> = {},
): EditableInputs => ({
  rows,
  settings: config,
  settingsPath: '/work/settings.yml',
  env,
  credentialsPath,
})

const input = {
  search: 'exa',
  apiKeyRef: 'openrouter',
  bashTimeoutMs: 45_000,
  maxParallelToolCalls: 4,
  subagentDepth: 2,
  delegateTools: [{ name: 'codex', argv: ['codex', 'exec'] }],
}

describe('the editable settings', () => {
  test('reads each value and the layer that decided it', () => {
    const view = readEditableSettings(
      inputsOf(
        [
          baseRows[0]!,
          baseRows[1]!,
          {
            id: 'agent-loop',
            name: '@jozo-harness/agent-loop',
            config: { maxParallelToolCalls: 4 },
          },
          baseRows[3]!,
        ],
        settings([
          {
            id: 'agent-loop',
            name: '@jozo-harness/agent-loop',
            config: { maxParallelToolCalls: 4 },
          },
        ]),
      ),
    )

    expect(view.bashTimeoutMs).toEqual({
      value: 30_000,
      source: 'the @jozo-harness/tools-tier0 row',
    })
    expect(view.maxParallelToolCalls).toEqual({ value: 4, source: '/work/settings.yml' })
    expect(view.subagentDepth).toEqual({ value: 1, source: 'the default' })
  })

  test('names the key a chosen provider reads without the value', async () => {
    const view = readEditableSettings(
      inputsOf(baseRows, { search: 'deepseek' }, '/nonexistent/credentials.json', {
        DEEPSEEK_API_KEY: 'sk-secret',
      }),
    )

    expect(view.search).toMatchObject({
      provider: 'deepseek',
      keyName: 'DEEPSEEK_API_KEY',
      keyPresent: true,
      source: '/work/settings.yml',
    })
    expect(JSON.stringify(view)).not.toContain('sk-secret')
  })

  test('says whether a reference has a value, never the value', async () => {
    const store = await mkdtemp(join(tmpdir(), 'jzh-run-settings-'))
    const credentialsPath = join(store, 'credentials.json')
    await writeFile(credentialsPath, JSON.stringify({ openrouter: 'sk-secret' }))

    const view = readEditableSettings(
      inputsOf(
        [
          ...baseRows.slice(0, 3),
          {
            id: 'llm',
            name: '@jozo-harness/llm-openai',
            config: { apiKeyEnv: 'OPENROUTER_API_KEY', apiKeyRef: 'openrouter' },
          },
        ],
        {},
        credentialsPath,
      ),
    )

    expect(view.apiKeyRef).toEqual({
      ref: 'openrouter',
      present: true,
      source: 'the @jozo-harness/llm-openai row',
    })
    expect(JSON.stringify(view)).not.toContain('sk-secret')
  })

  test('writes only the values that differ from the profile and the defaults', async () => {
    const rows: ReadonlyArray<PluginRow> = [
      ...baseRows.slice(0, 3),
      {
        id: 'llm',
        name: '@jozo-harness/llm-openai',
        config: { apiKeyEnv: 'OPENROUTER_API_KEY', apiKeyRef: 'openrouter' },
      },
    ]

    const text = await Effect.runPromise(
      editRunSettings('model: stub/model\n', inputsOf(rows), {
        search: 'exa',
        apiKeyRef: 'openrouter',
        bashTimeoutMs: 30_000,
        maxParallelToolCalls: 10,
        subagentDepth: 1,
        delegateTools: [],
      }),
    )

    expect(text).toContain('search: exa')
    expect(text).not.toContain('timeoutMs')
    expect(text).not.toContain('maxParallelToolCalls')
    expect(text).not.toContain('subagentMaxDepth')
    expect(text).not.toContain('apiKeyRef')
  })

  test('writes the limits, the reference, and a delegate row in one save', async () => {
    const text = await Effect.runPromise(
      editRunSettings('model: stub/model\n', inputsOf(baseRows), input),
    )

    expect(text).toContain('search: exa')
    expect(text).toContain('timeoutMs: 45000')
    expect(text).toContain('maxParallelToolCalls: 4')
    expect(text).toContain('subagentMaxDepth: 2')
    expect(text).toContain('apiKeyRef: openrouter')
    expect(text).toContain("name: '@jozo-harness/delegate'")
    expect(text).toContain('name: codex')
    expect(text).toContain('argv: [ codex, exec ]')
  })

  test('clears the provider and a reference by dropping their keys', async () => {
    const text =
      "search: exa\nplugins:\n  - id: llm\n    name: '@jozo-harness/llm-openai'\n    config:\n      apiKeyRef: openrouter\n"

    const config: JozoHarnessConfig = {
      search: 'exa',
      plugins: [
        {
          id: 'llm',
          name: '@jozo-harness/llm-openai',
          config: { apiKeyRef: 'openrouter' },
        },
      ],
    }
    const rows: ReadonlyArray<PluginRow> = [
      ...baseRows.slice(0, 3),
      {
        id: 'llm',
        name: '@jozo-harness/llm-openai',
        config: { apiKeyRef: 'openrouter' },
      },
    ]

    const next = await Effect.runPromise(
      editRunSettings(text, inputsOf(rows, config), {
        ...input,
        search: '',
        apiKeyRef: '',
        delegateTools: [],
      }),
    )

    expect(next).not.toContain('search: exa')
    expect(next).not.toContain('apiKeyRef')
  })

  test('removes the delegate row when no tools are left', async () => {
    const text =
      "plugins:\n  - id: delegate\n    name: '@jozo-harness/delegate'\n    config:\n      tools: []\n"

    const next = await Effect.runPromise(
      editRunSettings(
        text,
        inputsOf(baseRows, {
          plugins: [
            {
              id: 'delegate',
              name: '@jozo-harness/delegate',
              config: { tools: [] },
            },
          ],
        }),
        {
          ...input,
          search: '',
          apiKeyRef: '',
          delegateTools: [],
        },
      ),
    )

    expect(next).not.toContain('delegate')
  })

  test('refuses out-of-range values and names the field', () => {
    const problems = runSettingsProblems({
      ...input,
      bashTimeoutMs: 0,
      subagentDepth: 9,
      delegateTools: [{ name: 'codex', argv: [] }],
    })

    expect(problems.map((problem) => problem.field)).toEqual([
      'bashTimeoutMs',
      'subagentDepth',
      'delegateTools[0].argv',
    ])
    expect(problems[0]?.message).toContain('bashTimeoutMs')
  })

  test('a refused save leaves the settings text as it was', async () => {
    const failure = await Effect.runPromise(
      Effect.result(
        editRunSettings('model: stub/model\n', inputsOf(baseRows), {
          ...input,
          maxParallelToolCalls: 0,
        }),
      ),
    )

    expect(failure._tag).toBe('Failure')
    if (failure._tag === 'Failure') {
      expect(failure.failure.field).toBe('maxParallelToolCalls')
    }
  })
})
