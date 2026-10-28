import { describe, expect, expectTypeOf, test } from 'vitest'
import * as sdk from '../src/index.ts'
import type {
  HarnessMethodName,
  HarnessNotificationName,
  InitializeResult,
  RequestPermissionParams,
  RequestPermissionResult,
  SessionCancelResult,
  SessionNewResult,
  SessionPromptResult,
  SessionUpdate,
  SessionUpdateParams,
  StopReason,
  ToolCallContent,
  ToolCallStart,
  ToolCallStatus,
  ToolCallUpdate,
} from '../src/index.ts'

describe('the SDK public face', () => {
  test('exports the request and notification names as constants', () => {
    expect(sdk.HARNESS_METHODS).toEqual({
      initialize: 'initialize',
      newSession: 'session/new',
      prompt: 'session/prompt',
      cancel: 'session/cancel',
    })
    expect(sdk.HARNESS_NOTIFICATIONS).toEqual({
      update: 'session/update',
      requestPermission: 'session/request_permission',
    })
  })

  test('keeps only the intended runtime exports on the package face', () => {
    expect(Object.keys(sdk).sort()).toEqual([
      'HARNESS_METHODS',
      'HARNESS_NOTIFICATIONS',
      'HarnessClient',
      'HarnessResponseError',
      'spawnHarness',
    ])
  })

  test('exports the protocol result and update types', () => {
    expectTypeOf<HarnessMethodName>().toEqualTypeOf<
      'initialize' | 'session/new' | 'session/prompt' | 'session/cancel'
    >()
    expectTypeOf<HarnessNotificationName>().toEqualTypeOf<
      'session/update' | 'session/request_permission'
    >()
    expectTypeOf<InitializeResult['protocolVersion']>().toEqualTypeOf<number>()
    expectTypeOf<SessionNewResult['sessionId']>().toEqualTypeOf<string>()
    expectTypeOf<SessionPromptResult['stopReason']>().toEqualTypeOf<StopReason>()
    expectTypeOf<SessionCancelResult['cancelled']>().toEqualTypeOf<boolean>()
    expectTypeOf<ToolCallStatus>().toEqualTypeOf<
      'pending' | 'in_progress' | 'completed' | 'failed'
    >()
    expectTypeOf<ToolCallStart['sessionUpdate']>().toEqualTypeOf<'tool_call'>()
    expectTypeOf<ToolCallUpdate['sessionUpdate']>().toEqualTypeOf<'tool_call_update'>()
    expectTypeOf<ToolCallContent['text']>().toEqualTypeOf<string>()
    expectTypeOf<SessionUpdate>().not.toBeNever()
    expectTypeOf<SessionUpdateParams['sessionId']>().toEqualTypeOf<string>()
    expectTypeOf<RequestPermissionParams['sessionId']>().toEqualTypeOf<string>()
    expectTypeOf<RequestPermissionResult>().not.toBeNever()
  })
})
