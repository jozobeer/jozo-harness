import { describe, expect, test } from 'vitest'
import { Effect } from 'effect'
import {
  approveEscalation,
  classifySandboxFailure,
  escalationHintMarker,
  sandboxApplyFailureMarker,
  sandboxDenialMarker,
  validateEscalationArgs,
  type ApprovalRequested,
} from '../src/index.ts'

const asked: Array<ApprovalRequested> = []

/** Answers every escalation with `approved`, recording what was asked. */
const answerer = (approved: boolean) => (request: ApprovalRequested) =>
  Effect.sync(() => {
    asked.push(request)
    return approved
  })

const escalate = (
  requestedMode: string,
  standingMode: 'read-only' | 'workspace-write' | 'danger-full-access',
  approved: boolean,
) =>
  Effect.runPromise(
    approveEscalation(
      {
        requestedMode,
        justification: 'the build writes outside the workspace',
        standingMode,
        subject: 'command',
        callId: 'c1',
        tool: 'bash',
      },
      answerer(approved),
    ).pipe(Effect.result),
  )

describe('validateEscalationArgs', () => {
  test('the mode and its reason travel together, and the reason is a sentence', () => {
    expect(() => validateEscalationArgs('danger-full-access', undefined)).toThrow()
    expect(() => validateEscalationArgs(undefined, 'because')).toThrow()
    expect(() => validateEscalationArgs('danger-full-access', '   ')).toThrow()
    expect(() => validateEscalationArgs(undefined, undefined)).not.toThrow()
    expect(() =>
      validateEscalationArgs('danger-full-access', 'the build writes outside'),
    ).not.toThrow()
  })
})

describe('approveEscalation', () => {
  test('a wider mode runs once the human says yes, and the reason names both modes', async () => {
    asked.length = 0
    const observed = await escalate('danger-full-access', 'workspace-write', true)

    expect(observed._tag).toBe('Success')
    if (observed._tag === 'Success') expect(observed.success).toBe('danger-full-access')
    expect(asked).toHaveLength(1)
    expect(asked[0]?.reason).toContain('danger-full-access')
    expect(asked[0]?.reason).toContain('the build writes outside the workspace')
  })

  test('a refusal keeps the call denied', async () => {
    asked.length = 0
    const observed = await escalate('workspace-write', 'read-only', false)

    expect(observed._tag).toBe('Failure')
    if (observed._tag === 'Failure') expect(String(observed.failure)).toContain('rejected')
    expect(asked).toHaveLength(1)
  })

  test('a mode that is not strictly wider is refused without asking', async () => {
    asked.length = 0
    const same = await escalate('workspace-write', 'workspace-write', true)
    const older = await escalate('workspace-write', 'danger-full-access', true)

    expect(same._tag).toBe('Failure')
    expect(older._tag).toBe('Failure')
    expect(asked).toEqual([])
  })

  test('a mode outside the escalation vocabulary is refused without asking', async () => {
    asked.length = 0
    const observed = await escalate('teleport', 'read-only', true)

    expect(observed._tag).toBe('Failure')
    expect(asked).toEqual([])
  })
})

describe('classifySandboxFailure', () => {
  test('a seatbelt that cannot be applied inside another sandbox is its own failure', () => {
    expect(
      classifySandboxFailure(71, 'sandbox-exec: sandbox_apply: Operation not permitted\n', []),
    ).toBe('apply-failed')
  })

  test('the apply failure says how to proceed and offers no escalation', () => {
    expect(sandboxApplyFailureMarker).toBe(
      '[sandbox: the seatbelt could not be applied inside another sandbox (exit 71); run jzh outside it, or pass sandbox: none]',
    )
    expect(sandboxApplyFailureMarker).not.toContain('sandbox_permissions')
    expect(sandboxApplyFailureMarker).not.toContain('file access denied')
  })

  test('a refusal that signed the sandbox words stays a file denial', () => {
    expect(
      classifySandboxFailure(1, 'bash: /etc/hosts: Operation not permitted', [
        'operation not permitted',
      ]),
    ).toBe('denied')
  })

  test('a command that merely failed is passed through', () => {
    expect(classifySandboxFailure(0, '', ['operation not permitted'])).toBe('none')
    expect(classifySandboxFailure(1, 'npm: command not found', ['operation not permitted'])).toBe(
      'none',
    )
  })

  test('exit 71 without the apply signature is not an apply failure', () => {
    expect(classifySandboxFailure(71, 'bash: exit 71', ['operation not permitted'])).toBe('none')
  })
})

describe('markers', () => {
  test('the denial names the mode the call ran under', () => {
    expect(sandboxDenialMarker('workspace-write')).toBe(
      '[sandbox: file access denied under workspace-write mode]',
    )
  })

  test('the hint names the retry and who will be asked', () => {
    const hint = escalationHintMarker('command')

    expect(hint).toContain('sandbox_permissions')
    expect(hint).toContain('justification')
    expect(hint).toContain('retry this exact command once')
  })
})
