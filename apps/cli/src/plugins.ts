import { agentPlugin } from '@jozo-harness/agent'
import { agentLoopPlugin } from '@jozo-harness/agent-loop'
import { kernelPlugin, type Plugin } from '@jozo-harness/kernel'
import { llmOpenAiPlugin } from '@jozo-harness/llm-openai'
import { sessionPlugin } from '@jozo-harness/session'
import { sessionJsonlPlugin } from '@jozo-harness/session-jsonl'
import { askPlugin, safetyPlugin } from '@jozo-harness/safety'
import { systemPromptPlugin } from '@jozo-harness/system-prompt'
import { toolsPlugin } from '@jozo-harness/tools'
import { tier0Plugin } from '@jozo-harness/tools-tier0'
import {
  artifactPlugin,
  browserPlugin,
  delegatePlugin,
  lspPlugin,
  mcpPlugin,
  screenCapturePlugin,
  sessionSearchPlugin,
  tier1Plugin,
} from '@jozo-harness/tools-tier1'

/**
 * Every plugin a profile row or a settings row may name.
 *
 * `jzh config` reads this table too, so a name it refuses is a name the loader
 * would refuse at startup.
 */
export const bundledPlugins: ReadonlyArray<Plugin<any, any, any>> = [
  kernelPlugin,
  sessionJsonlPlugin,
  sessionPlugin,
  toolsPlugin,
  systemPromptPlugin,
  llmOpenAiPlugin,
  agentPlugin,
  agentLoopPlugin,
  safetyPlugin,
  askPlugin,
  tier0Plugin,
  tier1Plugin,
  artifactPlugin,
  screenCapturePlugin,
  browserPlugin,
  delegatePlugin,
  mcpPlugin,
  lspPlugin,
  sessionSearchPlugin,
]
