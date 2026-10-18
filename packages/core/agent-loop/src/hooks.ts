import type { Waterfall, Serial, Emit } from '@jozo-harness/kernel'
import type { Effect } from 'effect'
import type { LlmFailure, TimedStreamChunk, RequestMessage, ToolSchema } from '@jozo-harness/llm'
import type { Agent, UserMessage } from '@jozo-harness/agent'

export interface PreStepInput {
  readonly agent: Agent
  readonly messages: ReadonlyArray<UserMessage>
}

export type PreStepDecision =
  | {
      readonly kind: 'enter'
      /** Context the turn opens with, before the input that was claimed for it. */
      readonly messages?: ReadonlyArray<UserMessage>
    }
  | { readonly kind: 'reject'; readonly reason: string }

/** The request as the loop will send it, after every adjustment. */
export interface AgentRequest {
  readonly provider: string
  readonly model: string
  readonly params: Readonly<Record<string, unknown>>
  readonly messages: ReadonlyArray<RequestMessage>
  readonly tools: ReadonlyArray<ToolSchema>
}

/** What a listener wants after a failed attempt. A retry may say how long to wait. */
export type RequestErrorDecision =
  | { readonly kind: 'retry'; readonly delayMs?: number }
  | { readonly kind: 'fail' }

declare module '@jozo-harness/kernel/hook' {
  interface HookMap {
    'agent/pre-step': Waterfall<(input: PreStepInput) => Effect.Effect<PreStepDecision>>
    'agent/request': Waterfall<(request: AgentRequest) => Effect.Effect<AgentRequest>>
    'agent/request-error': Waterfall<
      (agent: Agent, failure: LlmFailure, attempt: number) => Effect.Effect<RequestErrorDecision>
    >
    'agent/assistant-stream': Emit<(chunk: TimedStreamChunk, agent: Agent) => void>
    'agent/turn-stopping': Serial<(agent: Agent) => Effect.Effect<void>>
  }
}
