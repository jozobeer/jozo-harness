import { afterAll, describe, expect, test } from 'vitest'
import { kernelPlugin, loadProfile, parseProfile } from '@jozo-harness/kernel'
import { Sessions, sessionPlugin } from '@jozo-harness/session'
import { sessionJsonlPlugin } from '@jozo-harness/session-jsonl'
import { sessionTelemetryPlugin } from '@jozo-harness/session-telemetry-otlp'
import { SystemPrompt, systemPromptPlugin } from '@jozo-harness/system-prompt'
import { Tools, toolsPlugin } from '@jozo-harness/tools'
import { Policy, askPlugin, safetyPlugin } from '@jozo-harness/safety'
import { tier0Plugin } from '@jozo-harness/tools-tier0'
import { tier1Plugin } from '@jozo-harness/tools-tier1'
import { Llm } from '@jozo-harness/llm'
import { llmOpenAiPlugin } from '@jozo-harness/llm-openai'
import { Agents, agentPlugin } from '@jozo-harness/agent'
import { agentLoopPlugin } from '@jozo-harness/agent-loop'
import { Context, Effect, Layer } from 'effect'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadBundledProfile } from '../src/index.ts'

/** A root this test process owns; one under the repo is shared with every other process. */
const tempRoot = await mkdtemp(join(tmpdir(), 'jozo-harness-assembly-'))
const plugins = [
  kernelPlugin,
  sessionJsonlPlugin,
  sessionTelemetryPlugin,
  sessionPlugin,
  toolsPlugin,
  systemPromptPlugin,
  llmOpenAiPlugin,
  agentPlugin,
  agentLoopPlugin,
  safetyPlugin,
  tier0Plugin,
  askPlugin,
  tier1Plugin,
]

afterAll(async () => {
  await rm(tempRoot, { recursive: true, force: true })
})

describe('bundled profile assembly', () => {
  test('resolves every S1 row into one layer and starts an agent', async () => {
    const profile = await Effect.runPromise(parseProfile(await loadBundledProfile()))
    const root = join(tempRoot, crypto.randomUUID())
    const rows = profile.plugins.map((row) =>
      row.id === 'session-jsonl' ? { ...row, config: { root } } : row,
    )

    const built = await Effect.runPromise(
      Effect.gen(function* () {
        const layer = yield* loadProfile({ plugins, layers: [rows] })
        const context = yield* Layer.build(layer)
        const agents = Context.get(context, Agents)
        const agent = yield* agents.create({
          cwd: '/work',
          options: { route: 'ollama-cloud/deepseek-v4.1-flash' },
        })
        return {
          rows: rows.length,
          listed: agents.list().length,
          status: agent.status,
          sessions: Context.get(context, Sessions) !== undefined,
          tools: Context.get(context, Tools).schemas().length,
          prompt: Context.get(context, SystemPrompt)
            .sections()
            .map((section) => section.name),
          llm: Context.get(context, Llm).capabilities.toolChoice,
          preset: Context.get(context, Policy).preset,
        }
      }).pipe(Effect.scoped),
    )

    expect(built).toEqual({
      rows: 13,
      listed: 1,
      status: 'idle',
      sessions: true,
      tools: 0,
      // The prompt layer opens with the identity, tool guidance, and the visible signatures.
      prompt: ['jzh:identity', 'jzh:tool-guidance', 'jzh:tool-signatures'],
      llm: false,
      preset: 'workspace-write',
    })
  })
})
