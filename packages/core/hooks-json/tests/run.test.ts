import { describe, expect, test } from 'vitest'
import { Effect } from 'effect'
import { noneSandbox, SandboxError, type SandboxShape } from '@jozo-harness/safety'
import type { ToolExecution } from '@jozo-harness/tools'
import { decodeHookOutcome, hookPayload, runHookCommand } from '../src/run.ts'

const answer = (exitCode: number, stdout = '', stderr = '', timedOut = false) => ({
  exitCode,
  stdout,
  stderr,
  timedOut,
})

const exec: ToolExecution = {
  callId: 'call-1',
  tool: 'bash',
  arguments: '{"command":"ls"}',
  args: { command: 'ls' },
  context: { sessionId: 's-1', cwd: '/work', callId: 'call-1' },
}

describe('hook outcome', () => {
  test('a clean exit with no decision passes', () => {
    expect(decodeHookOutcome('PreToolUse', answer(0, 'noted'))).toEqual({
      kind: 'pass',
      stdout: 'noted',
      stderr: '',
    })
  })

  test('a non-zero exit denies with stderr as the reason', () => {
    expect(decodeHookOutcome('PreToolUse', answer(2, '', 'blocked'))).toEqual({
      kind: 'deny',
      reason: 'blocked',
      stdout: '',
      stderr: 'blocked',
    })
  })

  test('a non-zero exit without stderr names the code', () => {
    const outcome = decodeHookOutcome('PostToolUse', answer(3))

    expect(outcome.kind).toBe('deny')
    if (outcome.kind !== 'deny') return
    expect(outcome.reason).toContain('code 3')
  })

  test('a JSON decision denies with its reason', () => {
    const outcome = decodeHookOutcome(
      'PreToolUse',
      answer(0, '{"decision":"deny","reason":"not on main"}'),
    )

    expect(outcome).toEqual({
      kind: 'deny',
      reason: 'not on main',
      stdout: '{"decision":"deny","reason":"not on main"}',
      stderr: '',
    })
  })

  test('a hook-specific permission decision denies for the matching event', () => {
    const stdout = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'fix it first',
      },
    })

    const outcome = decodeHookOutcome('PostToolUse', answer(0, stdout))

    expect(outcome.kind).toBe('deny')
    if (outcome.kind !== 'deny') return
    expect(outcome.reason).toBe('fix it first')
  })

  test('an answer for another event does not deny this one', () => {
    const stdout = JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' },
    })

    expect(decodeHookOutcome('PostToolUse', answer(0, stdout)).kind).toBe('pass')
  })

  test('malformed JSON on a clean exit passes', () => {
    expect(decodeHookOutcome('PreToolUse', answer(0, '{ nope')).kind).toBe('pass')
  })

  test('a timed out hook denies and says so', () => {
    expect(decodeHookOutcome('PreToolUse', answer(137, '', '', true))).toEqual({
      kind: 'deny',
      reason: 'the PreToolUse hook timed out',
      stdout: '',
      stderr: '',
    })
  })
})

describe('payload', () => {
  test('carries the event, tool, input, and run', () => {
    expect(hookPayload('PreToolUse', exec)).toEqual({
      session_id: 's-1',
      transcript_path: '',
      cwd: '/work',
      hook_event_name: 'PreToolUse',
      tool_name: 'bash',
      tool_input: { command: 'ls' },
      tool_use_id: 'call-1',
    })
  })

  test('adds the tool response after the call', () => {
    const payload = hookPayload('PostToolUse', exec, {
      isError: false,
      content: [{ type: 'text', text: 'done' }],
    })

    expect(payload['tool_response']).toEqual({ is_error: false, content: 'done' })
  })
})

describe('running a command', () => {
  test('a successful command passes and its stdout stays data', async () => {
    const outcome = await Effect.runPromise(
      runHookCommand(
        noneSandbox,
        { event: 'PreToolUse', command: 'printf okay' },
        { tool_name: 'bash' },
        process.cwd(),
        5000,
      ),
    )

    expect(outcome).toEqual({ kind: 'pass', stdout: 'okay', stderr: '' })
  })

  test('a sandbox that refuses the command denies the call', async () => {
    const sandbox: SandboxShape = {
      ...noneSandbox,
      wrap: () => Effect.fail(new SandboxError({ message: 'no sandbox' })),
    }
    const outcome = await Effect.runPromise(
      runHookCommand(sandbox, { event: 'PreToolUse', command: 'true' }, {}, process.cwd(), 5000),
    )

    expect(outcome.kind).toBe('deny')
  })

  test('a command past its deadline is killed and denies', async () => {
    const outcome = await Effect.runPromise(
      runHookCommand(
        noneSandbox,
        { event: 'PreToolUse', command: 'sleep 5' },
        {},
        process.cwd(),
        50,
      ),
    )

    expect(outcome.kind).toBe('deny')
    if (outcome.kind !== 'deny') return
    expect(outcome.reason).toContain('timed out')
  })
})
