import { describe, expect, test } from 'vitest'
import type { UiSessionEvent } from '@jozo-harness/ui-protocol'
import { toolsOf, traceOf, type TraceTool } from '../src/ui/trace.ts'
import { WORKFLOW_TOOL, workflowOf } from '../src/ui/workflow.ts'

const event = (type: string, data: unknown, time: number): UiSessionEvent => ({
  seq: time,
  time,
  type,
  data,
})

const called = (time: number, name: string = WORKFLOW_TOOL): UiSessionEvent =>
  event('tool/call', { callId: 'w1', name, summary: 'workflow', arguments: '{}' }, time)

const answered = (time: number, text: string): UiSessionEvent =>
  event(
    'tool/result',
    {
      callId: 'w1',
      isError: false,
      summary: 'workflow',
      content: [{ type: 'text', text }],
    },
    time,
  )

/** The one call the log recorded; a log without one is the test's own mistake. */
const toolOf = (log: ReadonlyArray<UiSessionEvent>): TraceTool => {
  const tool = traceOf(log).flatMap(toolsOf)[0]
  if (tool === undefined) throw new Error('the log recorded no tool call')
  return tool
}

const FAN_OUT = [
  'a: one',
  'b: (failed: the answer is not JSON)',
  '',
  'child sessions:',
  'a: done [child session: child-1]',
  'b: failed (the answer is not JSON) [child session: child-2]',
].join('\n')

describe('the children a workflow result names', () => {
  test('reads each child with its outcome and the session that ran it', () => {
    const view = workflowOf(toolOf([called(10), answered(20, FAN_OUT)]))

    expect(view?.children).toEqual([
      { name: 'a', status: 'done', reason: '', sessionId: 'child-1' },
      {
        name: 'b',
        status: 'failed',
        reason: 'the answer is not JSON',
        sessionId: 'child-2',
      },
    ])
    expect(view?.headline).toBe('')
  })

  test('keeps a child that never started a session, so its failure still shows', () => {
    const view = workflowOf(
      toolOf([
        called(10),
        answered(
          20,
          'a: (failed: cannot start a child agent)\n\nchild sessions:\na: failed (cannot start a child agent)',
        ),
      ]),
    )

    expect(view?.children).toEqual([
      { name: 'a', status: 'failed', reason: 'cannot start a child agent', sessionId: '' },
    ])
  })

  test('reads a script run from its spawn lines and keeps the script outcome', () => {
    const view = workflowOf(
      toolOf([
        called(10),
        answered(
          20,
          [
            'workflow script: ok',
            'children: 2',
            'return: "done"',
            '',
            'child sessions:',
            'draft: done [child session: child-1]',
            'review: done [child session: child-2]',
          ].join('\n'),
        ),
      ]),
    )

    expect(view?.headline).toBe('workflow script: ok')
    expect(view?.children.map((child) => child.name)).toEqual(['draft', 'review'])
  })

  test('leaves a running call without children until its result arrives', () => {
    const view = workflowOf(toolOf([called(10)]))

    expect(view?.children).toEqual([])
    expect(view?.headline).toBe('')
  })

  test('draws nothing for a call to another tool', () => {
    expect(workflowOf(toolOf([called(10, 'subagent')]))).toBeUndefined()
  })

  test('reads the block from the end when a child answer quotes its heading', () => {
    const output = [
      'a: here is the child sessions: heading',
      '',
      'child sessions:',
      'a: done [child session: child-1]',
    ].join('\n')

    expect(workflowOf(toolOf([called(10), answered(20, output)]))?.children).toHaveLength(1)
  })
})
