import { agentPlugin } from '@jozo-harness/agent'
import { agentLoopPlugin } from '@jozo-harness/agent-loop'
import { kernelPlugin, type Plugin } from '@jozo-harness/kernel'
import { llmDeepSeekPlugin } from '@jozo-harness/llm-deepseek'
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
  computerUsePlugin,
  delegatePlugin,
  lspPlugin,
  mcpPlugin,
  screenCapturePlugin,
  sessionSearchPlugin,
  tier1Plugin,
  workspaceDependenciesPlugin,
} from '@jozo-harness/tools-tier1'

/** One optional bundle the web page may install with a row. */
export interface OptionalBundle {
  /** The row id the install writes. */
  readonly id: string
  readonly name: string
  /** What the page says the row adds, in one line. */
  readonly summary: string
  /**
   * True when an id-and-name row cannot load, so the page refuses the install
   * and points at the settings file instead of writing a row the next start
   * would refuse.
   */
  readonly needsConfig: boolean
}

/**
 * The bundled plugins the base profile does not carry, as the page offers them.
 *
 * This is a catalog beside `bundledPlugins`, not a second allow-list: a name
 * only reaches a settings write after it is in both the build's table and this
 * one. The three that need config stay listed so a human sees what the build
 * has, but the page cannot write their row.
 */
export const optionalBundles: ReadonlyArray<OptionalBundle> = [
  {
    id: 'artifact',
    name: '@jozo-harness/artifact',
    summary: 'publish HTML pages the conversation can open and download',
    needsConfig: false,
  },
  {
    id: 'screen-capture',
    name: '@jozo-harness/screen-capture',
    summary: 'capture the screen as an image through the run sandbox',
    needsConfig: false,
  },
  {
    id: 'computer-use',
    name: '@jozo-harness/computer-use',
    summary: 'click, type, and press keys on screen after the human approves',
    needsConfig: false,
  },
  {
    id: 'browser',
    name: '@jozo-harness/browser',
    summary: 'read a web page as text through the run sandbox',
    needsConfig: false,
  },
  {
    id: 'lsp',
    name: '@jozo-harness/lsp',
    summary: 'ask a language server for definitions, references, and diagnostics',
    needsConfig: false,
  },
  {
    id: 'session-search',
    name: '@jozo-harness/session-search',
    summary: 'search the session logs of this machine',
    needsConfig: false,
  },
  {
    id: 'delegate',
    name: '@jozo-harness/delegate',
    summary: 'hand a task to an external agent CLI the settings allow',
    needsConfig: true,
  },
  {
    id: 'mcp',
    name: '@jozo-harness/mcp',
    summary: 'connect stdio MCP servers and offer their tools',
    needsConfig: true,
  },
  {
    id: 'workspace-dependencies',
    name: '@jozo-harness/workspace-dependencies',
    summary: 'report the runtimes a workspace manifest declares',
    needsConfig: true,
  },
]

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
  llmDeepSeekPlugin,
  agentPlugin,
  agentLoopPlugin,
  safetyPlugin,
  askPlugin,
  tier0Plugin,
  tier1Plugin,
  artifactPlugin,
  screenCapturePlugin,
  computerUsePlugin,
  browserPlugin,
  delegatePlugin,
  mcpPlugin,
  lspPlugin,
  sessionSearchPlugin,
  workspaceDependenciesPlugin,
]
