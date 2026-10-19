import type { UiEvent, UiSessionEvent } from '@jozo-harness/ui-protocol'
import type { SessionSummary } from '../../src/shared/rpc.ts'

/**
 * Sessions made up for the preview, in the shape the log writes: a long turn of
 * many tool calls, a turn that waits on an approval, a session asking a
 * question, one still running, one done. Nothing here is read from a real log.
 */

/** Writes events with rising seq and time, the way a session log does. */
const makeLog = (start: number) => {
  const events: Array<UiSessionEvent> = []
  let time = start
  const push = (type: string, data: unknown, after = 400): void => {
    time += after
    events.push({ seq: events.length + 1, time, type, data })
  }
  return { events, push, now: () => time }
}

type Log = ReturnType<typeof makeLog>

const ask = (log: Log, text: string): void => {
  log.push('agent/inbox/queued', { target: 'next-turn', message: { text, source: 'user' } })
  log.push('user/message', { text, source: 'user' }, 5)
  log.push('agent/inbox/claimed', { target: 'next-turn', message: { text, source: 'user' } }, 5)
}

interface Call {
  readonly name: string
  readonly args: Record<string, unknown>
  readonly summary: string
  readonly result: string
  readonly output?: string
  readonly error?: boolean
  readonly took?: number
}

let callCount = 0

/** One step: the model thinks, says something or nothing, and asks for tools. */
const step = (
  log: Log,
  number: number,
  reasoning: string,
  text: string,
  calls: ReadonlyArray<Call>,
): void => {
  log.push('step/start', { step: number }, 30)
  const ids = calls.map(() => 'call_' + String((callCount += 1)).padStart(4, '0'))
  log.push(
    'assistant/message',
    {
      provider: 'ollama-cloud',
      model: 'qwen3-coder:480b',
      content: [
        { type: 'reasoning', text: reasoning },
        ...(text === '' ? [] : [{ type: 'text', text }]),
      ],
    },
    1800,
  )
  calls.forEach((call, index) => {
    log.push(
      'tool/call',
      {
        callId: ids[index],
        name: call.name,
        arguments: JSON.stringify(call.args),
        summary: call.summary,
      },
      20,
    )
    log.push(
      'tool/result',
      {
        callId: ids[index],
        isError: call.error === true,
        summary: call.result,
        content: [{ type: 'text', text: call.output ?? call.result }],
      },
      call.took ?? 250,
    )
  })
  log.push('step/end', { step: number }, 10)
}

const read = (path: string, lines: number): Call => ({
  name: 'read',
  args: { path },
  summary: path,
  result: String(lines) + ' lines',
  output: Array.from({ length: Math.min(lines, 12) }, (_, n) => String(n + 1) + '  // …').join(
    '\n',
  ),
})

const grep = (pattern: string, hits: number): Call => ({
  name: 'grep',
  args: { pattern },
  summary: 'grep ' + pattern,
  result: String(hits) + ' matches',
})

const edit = (path: string, before: number, after: number, from = '', to = ''): Call => ({
  name: 'edit',
  args: { path, oldString: from, newString: to },
  summary: path,
  result: 'lines: ' + String(before) + ' → ' + String(after),
})

const bash = (
  command: string,
  result: string,
  output: string,
  error = false,
  took = 4200,
): Call => ({
  name: 'bash',
  args: { command },
  summary: command,
  result,
  output,
  error,
  took,
})

const FILES = [
  'apps/web/src/ui/trajectory.ts',
  'apps/web/src/ui/state.ts',
  'packages/ui/view/src/conversation.ts',
  'packages/ui/protocol/src/index.ts',
  'apps/web/src/server/sessions.ts',
  'apps/web/client-solid/store.ts',
  'packages/core/session/src/index.ts',
  'apps/tui/src/render.ts',
]

const FAIL_OUTPUT = [
  ' FAIL  apps/web/tests/trajectory.test.ts > counts a turn once after a reconnect',
  'AssertionError: expected [ …(3) ] to have a length of 2 but got 3',
  '',
  ' Test Files  1 failed | 11 passed (12)',
  '      Tests  1 failed | 64 passed (65)',
].join('\n')

const PASS_OUTPUT = ' Test Files  12 passed (12)\n      Tests  65 passed (65)\n   Duration  1.21s'

const ANSWER_2 = [
  '原因は再接続時の **境界イベントの二重配送** でした。transport は購読し直すと最後のイベントをもう一度運ぶことがあり、`turnsAfter` が `turn/start` を 2 回数えていました。',
  '',
  '## 変えたこと',
  '',
  '- `applyUiEvent` が `seq` の新しいイベントだけを台帳に渡す',
  '- `trajectory.test.ts` に境界イベントを二度流すケースを足した',
  '- TUI も同じ `ui-view` を読むので、同じ規則が効く',
  '',
  '```ts',
  "const fresh = event.kind === 'session' && event.event.seq > state.conversation.lastSeq",
  'return fresh ? turnsAfter(state.turns, event.event) : state.turns',
  '```',
  '',
  '`pnpm run check` は 948 pass / 2 skip。再接続を伴う実 Chrome の受け入れも通りました。',
].join('\n')

/** The long session: a question, a long turn of work, and a turn that waits on the human. */
const ledgerSession = (start: number): ReadonlyArray<UiSessionEvent> => {
  const log = makeLog(start)
  log.push('session/header', {
    formatVersion: 1,
    createdAt: start,
    cwd: '/Users/dev/src/jozo-harness',
  })
  log.push('turn/start', { turn: 1 })
  ask(log, 'turns シートの台帳はどこで作っている？')
  log.push('request/header', { provider: 'ollama-cloud', model: 'qwen3-coder:480b' }, 5)
  step(log, 1, 'The user asks where the ledger is built. Search for turnsAfter.', '', [
    grep('turnsAfter', 4),
    read('apps/web/src/ui/trajectory.ts', 75),
  ])
  step(
    log,
    2,
    'Answer with the file and the function.',
    '`apps/web/src/ui/trajectory.ts` の `turnsAfter` です。イベントを 1 つずつ畳み、turn ごとに長さ・step 数・tool 数・終わりの理由を持ちます。',
    [],
  )
  log.push('turn/end', { turn: 1, reason: { kind: 'completed' } }, 10)

  log.push('turn/start', { turn: 2 }, 60_000)
  ask(log, '再接続したあと turns シートに turn 2 が二回出る。原因を調べて直して。')
  let number = 0
  const explore = FILES.flatMap((path, index) => [
    read(path, 60 + index * 23),
    grep('seq', index + 2),
  ])
  for (let index = 0; index < explore.length; index += 2) {
    number += 1
    step(
      log,
      number,
      'Keep reading where the seq is compared.',
      '',
      explore.slice(index, index + 2),
    )
  }
  number += 1
  step(
    log,
    number,
    'Reproduce it first with a test that replays the boundary event.',
    '再現テストを先に書きます。',
    [
      edit('apps/web/tests/trajectory.test.ts', 40, 58),
      bash('pnpm vitest run apps/web/tests/trajectory.test.ts', 'exit 1', FAIL_OUTPUT, true),
    ],
  )
  for (let round = 0; round < 18; round += 1) {
    number += 1
    const path = FILES[round % FILES.length] ?? FILES[0] ?? ''
    step(log, number, 'Check every reader of the ledger before changing it.', '', [
      read(path, 40 + round * 3),
      grep('applyUiEvent', 3 + (round % 4)),
      ...(round % 5 === 0
        ? [
            bash(
              'git grep -n lastSeq',
              String(round + 2) + ' lines',
              'apps/web/src/ui/state.ts:156: …',
            ),
          ]
        : []),
    ])
  }
  number += 1
  step(log, number, 'Only a fresh seq should reach the ledger.', '', [
    edit(
      'apps/web/src/ui/state.ts',
      164,
      166,
      '    turns: turnsAfter(state.turns, event.event),',
      [
        "  const fresh = event.kind === 'session' && event.event.seq > state.conversation.lastSeq",
        '    turns: fresh ? turnsAfter(state.turns, event.event) : state.turns,',
      ].join('\n'),
    ),
    edit(
      'apps/web/src/ui/state.ts',
      166,
      167,
      '  // every event reaches the ledger',
      '  // The transport may replay the boundary event: only a seq the page has not seen counts.',
    ),
    bash('pnpm vitest run apps/web/tests/trajectory.test.ts', 'exit 0', PASS_OUTPUT, false, 3800),
  ])
  number += 1
  step(log, number, 'Run the whole check.', '', [
    bash(
      'pnpm run check',
      'exit 0',
      '948 passed | 2 skipped\ncoverage lines: 94.34% (floor 93%)',
      false,
      48_000,
    ),
  ])
  number += 1
  step(log, number, 'Report.', ANSWER_2, [])
  log.push('turn/end', { turn: 2, reason: { kind: 'completed' } }, 10)

  log.push('turn/start', { turn: 3 }, 90_000)
  ask(log, 'ついでに依存を最新にして、もう一度 check を回して。')
  step(
    log,
    1,
    'Updating needs the network; ask for the wider mode.',
    '依存の更新にはネットワークが要るので、許可を求めます。',
    [],
  )
  log.push('step/start', { step: 2 }, 30)
  log.push(
    'tool/call',
    {
      callId: 'call_wait',
      name: 'bash',
      arguments: '{"command":"pnpm update --latest"}',
      summary: 'pnpm update --latest',
    },
    900,
  )
  log.push(
    'safety/approval/requested',
    {
      callId: 'call_wait',
      tool: 'bash',
      reason: 'pnpm update needs network access outside the workspace',
    },
    20,
  )
  return log.events
}

/** A session in another workspace, still working through its turn. */
const runningSession = (start: number): ReadonlyArray<UiSessionEvent> => {
  const log = makeLog(start)
  log.push('session/header', { formatVersion: 1, createdAt: start, cwd: '/Users/dev/src/fudo' })
  log.push('turn/start', { turn: 1 })
  ask(log, '注文 API の e2e テストを足して')
  for (let number = 1; number <= 9; number += 1) {
    step(log, number, 'Write the next case.', '', [
      read('src/orders/api.ts', 120),
      ...(number % 3 === 0 ? [edit('tests/orders.e2e.ts', number * 10, number * 10 + 14)] : []),
    ])
  }
  log.push('step/start', { step: 10 }, 30)
  log.push(
    'tool/call',
    {
      callId: 'call_run',
      name: 'bash',
      arguments: '{"command":"pnpm test:e2e"}',
      summary: 'pnpm test:e2e',
    },
    900,
  )
  return log.events
}

/** A session that stopped to ask the human which way to go. */
const askingSession = (start: number): ReadonlyArray<UiSessionEvent> => {
  const log = makeLog(start)
  log.push('session/header', { formatVersion: 1, createdAt: start, cwd: '/Users/dev/src/payory' })
  log.push('turn/start', { turn: 1 })
  ask(log, '請求書の PDF 生成を作り直したい')
  step(log, 1, 'There are two ways; ask.', '', [
    read('src/invoice/pdf.ts', 210),
    grep('renderPdf', 6),
  ])
  log.push('interaction/ask/requested', {
    id: 'ask_1',
    question:
      'PDF の生成はどちらで作りますか？\n\n- サーバで headless Chrome\n- ブラウザで pdf-lib',
    options: ['headless Chrome', 'pdf-lib'],
  })
  return log.events
}

/** A session that finished a while ago. */
const doneSession = (start: number): ReadonlyArray<UiSessionEvent> => {
  const log = makeLog(start)
  log.push('session/header', {
    formatVersion: 1,
    createdAt: start,
    cwd: '/Users/dev/src/jozo-harness',
  })
  log.push('turn/start', { turn: 1 })
  ask(log, 'TUI でスクロールすると末尾に戻ってしまう')
  step(log, 1, 'Look at the scroll rule.', '', [
    read('apps/tui/src/scroll.ts', 48),
    edit('apps/tui/src/scroll.ts', 48, 52),
  ])
  step(
    log,
    2,
    'Report.',
    '読み返している間は末尾に寄せないようにしました。`scroll.test.ts` に再現ケースを足しています。',
    [],
  )
  log.push('turn/end', { turn: 1, reason: { kind: 'completed' } }, 10)
  return log.events
}

export interface FixtureSession {
  readonly summary: SessionSummary
  readonly events: ReadonlyArray<UiEvent>
}

const asUi = (events: ReadonlyArray<UiSessionEvent>): ReadonlyArray<UiEvent> =>
  events.map((event) => ({ kind: 'session', event }))

const titled = (
  id: string,
  events: ReadonlyArray<UiSessionEvent>,
  title: string,
): FixtureSession => {
  const header = events[0]
  const cwd = header === undefined ? '' : String((header.data as { cwd?: string }).cwd ?? '')
  const updatedAt = events[events.length - 1]?.time ?? header?.time ?? 0
  return {
    summary: { id, cwd, createdAt: header?.time ?? 0, updatedAt, title },
    events: asUi(events),
  }
}

/** Every made-up session, newest first, as the rail lists them. */
export const fixtureSessions = (now: number): ReadonlyArray<FixtureSession> => {
  callCount = 0
  return [
    titled(
      'a07499db5c1e',
      ledgerSession(now - 14 * 60_000),
      'turns シートの台帳はどこで作っている？',
    ),
    titled('5be0c2aa91d3', runningSession(now - 6 * 60_000), '注文 API の e2e テストを足して'),
    titled('9c1f0a2277e0', askingSession(now - 3 * 60 * 60_000), '請求書の PDF 生成を作り直したい'),
    titled(
      '44aa0b9e01f7',
      doneSession(now - 26 * 60 * 60_000),
      'TUI でスクロールすると末尾に戻ってしまう',
    ),
  ]
}
