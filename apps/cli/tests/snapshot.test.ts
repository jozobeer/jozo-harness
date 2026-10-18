import { agentPlugin } from '@jozo-harness/agent'
import { agentLoopPlugin } from '@jozo-harness/agent-loop'
import { loadBundledProfile } from '@jozo-harness/bundle-base'
import { kernelPlugin, type Plugin } from '@jozo-harness/kernel'
import { Llm, type LlmAdapter, type StreamChunk } from '@jozo-harness/llm'
import { askPlugin, safetyPlugin } from '@jozo-harness/safety'
import { sessionPlugin } from '@jozo-harness/session'
import { jsonlSessions, sessionJsonlPlugin } from '@jozo-harness/session-jsonl'
import { systemPromptPlugin } from '@jozo-harness/system-prompt'
import { toolsPlugin } from '@jozo-harness/tools'
import { tier0Plugin } from '@jozo-harness/tools-tier0'
import { tier1Plugin } from '@jozo-harness/tools-tier1'
import {
  replayAdapter,
  runScenario,
  firstDifference,
  type Scenario,
  type ScenarioRow,
  type ScenarioSession,
} from '@jozo-harness/test-support-replay'
import { Effect, Layer, Schema, Stream } from 'effect'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { describe, expect, test } from 'vitest'
import { runCommand } from '../src/index.ts'

/** Where the recorded outcomes live, one file per scenario. */
const SNAPSHOTS = new URL('./snapshots/', import.meta.url)

const textTurn = (text: string): ReadonlyArray<StreamChunk> => [
  { type: 'text-delta', index: 0, text },
  { type: 'block-end', index: 0, block: { type: 'text', text } },
  { type: 'finish', kind: 'stop' },
]

const toolTurn = (name: string, args: unknown, id: string): ReadonlyArray<StreamChunk> => [
  {
    type: 'block-end',
    index: 0,
    block: { type: 'tool-call', id, name, arguments: JSON.stringify(args) },
  },
  { type: 'finish', kind: 'tool-calls' },
]

/** The recorded stream of a real tool-calling turn, replayed as it was decoded. */
const recorded = async (): Promise<string> =>
  readFile(
    new URL(
      '../../../packages/llm/llm-openai/fixtures/ollama-cloud-tool-call.sse',
      import.meta.url,
    ),
    'utf8',
  )

/** A stream of chunks, written as the SSE a provider would have sent. */
const sseOf = (turn: ReadonlyArray<StreamChunk>): string =>
  turn
    .map(
      (chunk, index) =>
        'data: ' +
        JSON.stringify({
          id: 'chatcmpl-scenario',
          object: 'chat.completion.chunk',
          created: 0,
          model: 'replay',
          choices: [
            {
              index: 0,
              delta: index === 0 ? { role: 'assistant', ...deltaOf(chunk) } : deltaOf(chunk),
              finish_reason: chunk.type === 'finish' ? finishWordOf(chunk.kind) : null,
            },
          ],
        }) +
        (index === 0 ? '' : ''),
    )
    .join('\n') + '\ndata: [DONE]\n'

/** The words a provider uses to say why it stopped. */
const finishWordOf = (kind: string): string => (kind === 'tool-calls' ? 'tool_calls' : kind)

const deltaOf = (chunk: StreamChunk): Record<string, unknown> => {
  if (chunk.type === 'text-delta') return { content: chunk.text }
  if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
    return {
      tool_calls: [
        {
          index: 0,
          id: chunk.block.id,
          type: 'function',
          function: { name: chunk.block.name, arguments: chunk.block.arguments },
        },
      ],
    }
  }
  return {}
}

/** Runs one scenario through the shipping composition and answers with every log. */
const runner = async (run: {
  readonly workspace: string
  readonly logs: string
  readonly streams: ReadonlyArray<string>
  readonly approve: boolean | undefined
  readonly task: string | undefined
  readonly resumeTask: string | undefined
  readonly lines: ReadonlyArray<string> | undefined
  readonly extraRows: ReadonlyArray<ScenarioRow> | undefined
  readonly subagents: boolean | undefined
}): Promise<{ readonly code: number; readonly sessions: ReadonlyArray<ScenarioSession> }> => {
  // One counter for every run: a resumed turn and a child turn both draw the
  // next recorded stream, in the order the model reached for it.
  const adapters = run.streams.map((sse) => replayAdapter(sse))
  let step = 0
  const llm: Plugin<{}, Llm, never> = {
    name: 'replay-llm',
    config: Schema.Struct({}),
    provides: [Llm],
    requires: [],
    layer: () =>
      Layer.succeed(Llm, {
        name: 'replay',
        capabilities: {
          toolChoice: false,
          reasoningEffort: null,
          images: 'none',
          promptCacheControl: false,
        },
        stream: () => {
          const adapter = adapters[step] ?? replayAdapter(sseOf(textTurn('done')))
          step += 1
          return adapter.stream({
            provider: 'replay',
            model: 'model',
            messages: [],
            tools: undefined,
            params: {},
          }) as Stream.Stream<StreamChunk, never>
        },
      } satisfies LlmAdapter),
  }
  const rows = [
    { id: 'session-jsonl', name: '@jozo-harness/session-jsonl', config: { root: run.logs } },
    // The recording stands in for the provider the profile names.
    { id: 'llm', name: 'replay-llm', config: {} },
    ...(run.extraRows ?? []),
  ]
  const runOnce = async (extra: {
    readonly task?: string
    readonly lines?: ReadonlyArray<string>
    readonly resume?: string
  }): Promise<number> =>
    Effect.runPromise(
      runCommand({
        profiles: [await loadBundledProfile()],
        extraRows: rows,
        plugins: [
          kernelPlugin,
          sessionJsonlPlugin,
          sessionPlugin,
          toolsPlugin,
          systemPromptPlugin,
          safetyPlugin,
          askPlugin,
          tier0Plugin,
          tier1Plugin,
          llm,
          agentPlugin,
          agentLoopPlugin,
        ] as ReadonlyArray<Plugin<any, any, any>>,
        cwd: run.workspace,
        route: 'replay/model',
        ...(extra.task === undefined ? {} : { task: extra.task }),
        ...(extra.lines === undefined ? {} : { lines: Stream.fromIterable(extra.lines) }),
        ...(extra.resume === undefined ? {} : { resume: extra.resume }),
        ...(run.subagents === true ? { subagents: true } : {}),
        approve: () => Effect.succeed(run.approve === true),
        stdout: () => undefined,
        stderr: () => undefined,
      }),
    )

  let code = 0
  if (run.task !== undefined) code = await runOnce({ task: run.task })
  else if (run.lines !== undefined) code = await runOnce({ lines: run.lines })
  if (run.resumeTask !== undefined) {
    const listed = await Effect.runPromise(jsonlSessions({ root: run.logs }).list())
    code = await runOnce({ task: run.resumeTask, resume: listed[0]?.id ?? '' })
  }

  const store = jsonlSessions({ root: run.logs })
  const sessions: Array<ScenarioSession> = []
  for (const summary of await Effect.runPromise(store.list())) {
    const opened = await Effect.runPromise(store.open(summary.id))
    sessions.push({ id: summary.id, events: opened.events })
  }
  // A run that wrote no log still has a code to record, and that code is the finding.
  return { code, sessions }
}

const SCENARIOS: ReadonlyArray<Scenario> = [
  {
    name: 'tool-call',
    task: 'write the notes and read them back',
    files: { 'notes.txt': 'one\ntwo\n' },
    streams: [
      sseOf(toolTurn('read', { path: 'notes.txt' }, 'c1')),
      sseOf(toolTurn('write', { path: 'notes.txt', content: 'one\ntwo\nthree\n' }, 'c2')),
      sseOf(textTurn('the notes now hold three lines')),
    ],
  },
  {
    name: 'recorded-stream',
    task: 'run the recorded turn',
    streams: [await recorded()],
  },
  {
    name: 'tool-failure',
    task: 'read the notes',
    streams: [
      sseOf(toolTurn('read', { path: 'missing.txt' }, 'c1')),
      sseOf(textTurn('the file is not there')),
    ],
  },
  {
    name: 'bash-run',
    task: 'run the command',
    // The bundled profile confines commands; this scenario watches the tool layer
    // run one, and the sandbox has its own tests.
    extraRows: [
      {
        id: 'safety',
        name: '@jozo-harness/safety',
        config: { preset: 'workspace-write', sandbox: 'none' },
      },
    ],
    streams: [sseOf(toolTurn('bash', { command: 'echo hi' }, 'c1')), sseOf(textTurn('that ran'))],
  },
  {
    name: 'compaction',
    task: 'say done',
    // A window small enough that the first request is already over the line. The
    // resumed turn has older messages to condense; the runtime snapshot is not one.
    resumeTask: 'say done again',
    extraRows: [
      {
        id: 'agent-loop',
        name: '@jozo-harness/agent-loop',
        config: { retainTokens: 1, maxBytes: 10, contextWindow: 100, headroomTokens: 0 },
      },
    ],
    // The first stream answers the first turn, the second the summary call that the
    // resumed turn makes, and the third that turn.
    streams: [
      sseOf(textTurn('done')),
      sseOf(textTurn('the earlier span, condensed')),
      sseOf(textTurn('done again')),
    ],
  },
  {
    name: 'resume',
    task: 'the first question',
    resumeTask: 'the second question',
    streams: [sseOf(textTurn('the first answer')), sseOf(textTurn('the second answer'))],
  },
  {
    name: 'subagent',
    task: 'ask a child to say hi',
    subagents: true,
    streams: [
      sseOf(toolTurn('subagent', { task: 'say hi to the parent' }, 'c1')),
      sseOf(textTurn('hi from the child')),
      sseOf(textTurn('the child said hi')),
    ],
  },
]

/** The snapshot on disk, or nothing when this scenario has never been recorded. */
const snapshotOf = async (name: string): Promise<string | undefined> =>
  readFile(new URL(name + '.txt', SNAPSHOTS), 'utf8').catch(() => undefined)

describe('replaying a recording', () => {
  for (const scenario of SCENARIOS) {
    test('the log a scenario leaves is the one on record: ' + scenario.name, async () => {
      const outcome = await runScenario(scenario, runner)
      const recorded = await snapshotOf(scenario.name)

      if (process.env.UPDATE_SNAPSHOTS === '1') {
        await mkdir(dirname(new URL(scenario.name + '.txt', SNAPSHOTS).pathname), {
          recursive: true,
        })
        await writeFile(new URL(scenario.name + '.txt', SNAPSHOTS), outcome.snapshot)
        return
      }

      expect(recorded).toBeDefined()
      const difference = firstDifference(recorded ?? '', outcome.snapshot)
      expect(
        difference === undefined
          ? undefined
          : difference + '\n(update with UPDATE_SNAPSHOTS=1 pnpm test snapshot)',
      ).toBeUndefined()
    })
  }
})
