import { decodeSessionEvent, logOnlyEventTypes } from '@jozo-harness/session'
import { Effect, Exit } from 'effect'
import { describe, expect, test } from 'vitest'
import {
  currentPermission,
  makePermission,
  permissionEventSchemas,
  permissionPresetOf,
  permissionWordOf,
  policyOf,
  sandboxWithPermission,
  switchPermission,
  type PermissionLog,
  type PermissionPresetSwitched,
  type SandboxShape,
} from '../src/index.ts'

const logOf = (): {
  readonly log: PermissionLog
  readonly events: Array<PermissionPresetSwitched>
} => {
  const events: Array<PermissionPresetSwitched> = []
  const log: PermissionLog = {
    append: (_type, data) =>
      Effect.sync(() => {
        events.push(data)
      }),
  }
  return { log, events }
}

describe('permission presets', () => {
  test('a switch applies the new boundary on the next call and records when it happened', async () => {
    const permission = makePermission('read-only')
    const { log, events } = logOf()

    await Effect.runPromise(
      switchPermission(log, permission, 'workspace-write', { confirmed: false }),
    )

    expect(permission.current()).toBe('workspace-write')
    expect(permission.mode()).toBe('workspace-write')
    expect(events).toHaveLength(1)
    expect(events[0]?.preset).toBe('workspace-write')
    expect(events[0]?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  test('the newest switch in the log is the preset a resumed session continues with', () => {
    const events = [
      { seq: 2, time: 1, type: 'permission/preset', data: { preset: 'read-only', at: 't1' } },
      { seq: 3, time: 2, type: 'turn/start', data: { turn: 1 } },
      { seq: 4, time: 3, type: 'permission/preset', data: { preset: 'full', at: 't2' } },
    ] as const

    expect(currentPermission([...events])).toBe('full')
  })

  test('a session that never switched keeps the configured preset', () => {
    expect(currentPermission([])).toBeUndefined()
    expect(makePermission('auto').current()).toBe('auto')
  })

  test('danger-full-access needs a human confirmation before the boundary moves', async () => {
    const permission = makePermission('workspace-write')
    const { log, events } = logOf()

    const refused = await Effect.runPromise(
      Effect.exit(switchPermission(log, permission, 'full', { confirmed: false })),
    )
    await Effect.runPromise(switchPermission(log, permission, 'full', { confirmed: true }))

    expect(Exit.isFailure(refused)).toBe(true)
    expect(events.map((event) => event.preset)).toEqual(['full'])
    expect(permission.mode()).toBe('danger-full-access')
  })

  test('an unknown preset word is refused rather than guessed', () => {
    expect(permissionPresetOf('danger-full-access')).toBe('full')
    expect(permissionPresetOf('workspace-write')).toBe('workspace-write')
    expect(permissionPresetOf('yolo')).toBeUndefined()
    expect(permissionWordOf('full')).toBe('danger-full-access')
    expect(permissionWordOf('auto')).toBe('workspace-write')
  })

  test('the policy and the sandbox read the current preset instead of a startup copy', async () => {
    const permission = makePermission('read-only')
    const policy = policyOf(permission)
    const fake: SandboxShape = {
      name: 'fake',
      confines: true,
      mode: 'read-only',
      wrap: (command) =>
        Effect.succeed({
          argv: command.argv,
          cwd: command.cwd,
          mode: command.mode ?? 'read-only',
          denialSignatures: [],
        }),
    }
    const sandbox = sandboxWithPermission(fake, permission)

    permission.apply('full')
    const wrapped = await Effect.runPromise(sandbox.wrap({ argv: ['echo', 'hi'], cwd: '/tmp' }))

    expect(policy.preset).toBe('full')
    expect(policy.mode).toBe('danger-full-access')
    expect(sandbox.mode).toBe('danger-full-access')
    expect(wrapped.mode).toBe('danger-full-access')
    expect(wrapped.argv).toEqual(['echo', 'hi'])
  })

  test('a switch decodes from the log and stays out of the model history', async () => {
    const event = await Effect.runPromise(
      decodeSessionEvent({
        seq: 5,
        time: 3,
        type: 'permission/preset',
        data: { preset: 'workspace-write', at: '2026-10-28T00:00:00.000Z' },
      }),
    )

    expect(event?.type).toBe('permission/preset')
    expect(event?.type === 'permission/preset' ? event.data.preset : '').toBe('workspace-write')
    expect(logOnlyEventTypes().has('permission/preset')).toBe(true)
    expect([...permissionEventSchemas.keys()]).toEqual(['permission/preset'])
  })
})
