import { agentPlugin } from '@jozo-harness/agent'
import { agentLoopPlugin } from '@jozo-harness/agent-loop'
import { loadBundledProfile } from '@jozo-harness/bundle-base'
import { hooksJsonPlugin } from '@jozo-harness/hooks-json'
import { kernelPlugin, type Plugin } from '@jozo-harness/kernel'
import { llmOpenAiPlugin } from '@jozo-harness/llm-openai'
import { askPlugin, safetyPlugin } from '@jozo-harness/safety'
import { sessionPlugin } from '@jozo-harness/session'
import { sessionJsonlPlugin } from '@jozo-harness/session-jsonl'
import { systemPromptPlugin } from '@jozo-harness/system-prompt'
import { toolsPlugin } from '@jozo-harness/tools'
import { tier0Plugin } from '@jozo-harness/tools-tier0'
import { tier1Plugin } from '@jozo-harness/tools-tier1'
import { Effect } from 'effect'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, test } from 'vitest'
import { runCommand } from '../src/index.ts'

/** The key the shipped profile names; without it this lane asks nobody. */
const KEY = process.env.OLLAMA_API_KEY ?? ''
/** The route to ask; the recorded run used this one. */
const ROUTE = process.env.JZH_REAL_ROUTE ?? 'ollama-cloud/deepseek-v4.1-flash'

/**
 * The real-API lane: no stub stands in for the provider, so this is the only
 * suite that can prove the shipped profile reaches a model at all. It skips
 * without a key, and it judges the outside world (a file the task asked for),
 * never the model's own words.
 */
describe('the real provider', () => {
  test.skipIf(KEY === '')(
    'a turn writes the file the task asked for',
    async () => {
      const logs = await mkdtemp(join(tmpdir(), 'jozo-harness-real-logs-'))
      const home = await mkdtemp(join(tmpdir(), 'jozo-harness-real-home-'))
      const workspace = await mkdtemp(join(tmpdir(), 'jozo-harness-real-work-'))

      const code = await Effect.runPromise(
        runCommand({
          profiles: [await loadBundledProfile()],
          extraRows: [
            { id: 'session-jsonl', name: '@jozo-harness/session-jsonl', config: { root: logs } },
          ],
          plugins: [
            kernelPlugin,
            sessionJsonlPlugin,
            sessionPlugin,
            toolsPlugin,
            systemPromptPlugin,
            safetyPlugin,
            hooksJsonPlugin,
            askPlugin,
            tier0Plugin,
            tier1Plugin,
            llmOpenAiPlugin,
            agentPlugin,
            agentLoopPlugin,
          ] as ReadonlyArray<Plugin<any, any, any>>,
          cwd: workspace,
          route: ROUTE,
          task: 'Create a file named real.txt in the working directory whose whole content is the line real-api-ok. Then answer done.',
          jzhHome: home,
          stdout: () => undefined,
          stderr: () => undefined,
        }),
      )

      expect(code).toBe(0)
      expect((await readFile(join(workspace, 'real.txt'), 'utf8')).trim()).toBe('real-api-ok')

      await rm(logs, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
      await rm(workspace, { recursive: true, force: true })
    },
    180_000,
  )
})
