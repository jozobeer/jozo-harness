export * from './args.ts'
export * from './bin.ts'
import {
  Agents,
  projectInbox,
  type Agent,
  type AgentOptions,
  type AgentsShape,
} from '@jozo-harness/agent'
import {
  Hooks,
  isRowEnabled,
  loadPluginRow,
  loadProfile,
  mergeRows,
  parseProfile,
  renderConfig,
  renderPluginKeys,
  type HookRegistry,
  type Plugin,
  type PluginError,
  type PluginRow,
} from '@jozo-harness/kernel'
import {
  SessionPersistenceService,
  Sessions,
  cwdOf,
  rootOf,
  lastSkillCatalog,
  titleOf,
  type Session,
  type SessionEvent,
  type SessionId,
  type SessionSummary,
} from '@jozo-harness/session'
import { attachmentRootOf } from '@jozo-harness/session/attachment-store'
import { expandHome, makeSessionQuery, type SearchHit } from '@jozo-harness/session-jsonl'
import {
  SystemPrompt,
  additionalInstructionsText,
  guiContextEntry,
  loadedAgentsOf,
  nestedAgentsFiles,
  registerAgentsMd,
  type AgentsMdOptions,
  type RuntimeContextSubject,
  type SystemPromptShape,
} from '@jozo-harness/system-prompt'
import { ToolError, type ToolDefinition, type ToolExecution } from '@jozo-harness/tools'
import { Tools, type ToolRegistry } from '@jozo-harness/tools'
import {
  compositionPlan,
  compositionWritable,
  currentPreset,
  DEFAULT_COMPACT_MAX_BYTES,
  effectivePreset,
  makeCommands,
  presetChange,
  presetProblem,
  presetResumable,
  presetWithTools,
  selectedPreset,
  usageViewOf,
  type CommandsShape,
  type Preset,
  type SessionError,
  type TokenBudget,
} from '@jozo-harness/session'
import {
  Tier0Tools,
  childEnvironment,
  logManagedEnv,
  makeShellSessions,
  managedEnvOf,
  type Tier0ToolBuilder,
  type WorktreeHost,
} from '@jozo-harness/tools-tier0'
import {
  agentLoopConfigSchema,
  checkpointHelpersFor,
  installRetry,
  modelOfRoute,
  tokenBudgetOf,
  type RetryConfig,
} from '@jozo-harness/agent-loop'
import { installBuiltinCommands } from './commands.ts'
import { listModels, modelEndpointOf } from './models.ts'
import {
  currentGoal,
  goalRounds,
  installHostScheduleRuns,
  makeScheduleStore,
  ruleText,
  scheduleTitle,
  type Schedule,
  type ScheduleHost,
  type ScheduleStore,
} from '@jozo-harness/tools-tier1'
import { runConfig } from './config-command.ts'
import { searchFromEnv } from './search-env.ts'
import { existsSync, readFileSync } from 'node:fs'
import { writeFileAtomic } from './atomic-write.ts'
import { editRunSettings, readEditableSettings, type EditableInputs } from './run-settings.ts'
import { runContextOf } from './run-state.ts'
import { jobDetailOf, jobRecorderOf, jobsOf, stopJobOf } from './jobs.ts'
import { messageSubagentOf, stopSubagentOf, subagentsOf } from './subagents.ts'
import { sessionRootOf } from './session-list.ts'
import { credentialSource, type SettingsSurface } from './settings.ts'
import { configPaths } from './config.ts'
import { resolveCredentialRef, type CredentialRefResult } from './credentials.ts'
import { makePluginHost } from './plugin-host.ts'
import { makeWebPluginsPort } from './plugin-web.ts'
import { makePluginWiringState, type PluginWiringState } from './plugin-wiring.ts'
import { optionalBundles } from './plugins.ts'
import {
  agentTools,
  jobTools,
  makeJobs,
  mcpTools,
  McpServers,
  startMcpServer,
  makeWebSearchTool,
  type JobsShape,
  type McpServerConfig,
  type SearchHost,
  makeSubagentTool,
  makeWorkingDirectoryTool,
  makeExitPlanModeTool,
  makeStructuredOutputs,
  makeStructuredOutputTool,
  makeGoalTool,
  makeRalphTool,
  DELEGATION_CONTEXT_ORDER,
  TEAM_IDENTITY_CONTEXT_ORDER,
  delegationLine,
  ArtifactTools,
  LspTools,
  ScreenCaptureTools,
  ComputerUseTools,
  BrowserTools,
  DelegateTools,
  WorkspaceDependenciesTools,
  teamIdentityLine,
  teamIdentityOf,
  teamInboxLine,
  unreadMessages,
  makeScheduleTool,
  fireSchedule,
  makeWorkflowTool,
  makePluginTool,
  makeTeamTool,
  type PluginHost,
  type PluginUnmount,
  installRepeatReminders,
  startGoalRound,
  discoverSkills,
  renderSkillCatalog,
  skillRoots,
  userSkills,
  tier1Tools,
  makeRunCodeSessions,
  SessionSearchTools,
  type RunCodeHost,
  type SessionSearchHost,
  type SkillSummary,
} from '@jozo-harness/tools-tier1'
import {
  Approval,
  Ask,
  AutoReview,
  Permission,
  Policy,
  Sandbox,
  autoReviewGuard,
  modelAutoReview,
  noneSandbox,
  approvalServiceLayer,
  askServiceLayer,
  type AutoReviewCompletion,
  currentPlanMode,
  resumedPermission,
  installAsk,
  lateAnswerMessage,
  makeAsk,
  makePlanMode,
  answerOf,
  safetyConfigSchema,
  seatbeltStartupNotice,
  type SafetyConfig,
  type SeatbeltProbeResult,
  recordingAnswerer,
  type ApprovalAnswerer,
  type ApprovalRequested,
  type ApprovalShape,
  type AskBatchAnswerer,
  type AskRequested,
  type AskShape,
  type PermissionShape,
  permissionWordOf,
  type PlanModeShape,
  type SandboxShape,
} from '@jozo-harness/safety'
import { isAbsolute, dirname, join, relative } from 'node:path'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { runTui, type TuiIo } from '@jozo-harness/tui'
import { fileURLToPath } from 'node:url'
import { makeUiHost, type UiHost } from '@jozo-harness/ui-host'
import { serveAcp } from '@jozo-harness/acp'
import {
  WebError,
  detectTailnet,
  listDirectories,
  makeOpenInApp,
  pageIsThere,
  serveWeb,
  tailnetExec,
  type CommandView,
  type InitialSession,
  type OpenSession,
  type PublicOrigin,
  type ReadyUrls,
  type RunStateView,
  type SessionFactory,
  type SettingsPort,
  type TailnetAddresses,
  type WorkspacesPort,
} from '@jozo-harness/web'
import { Llm, type LlmAdapter, type StreamChunk } from '@jozo-harness/llm'
import { Cause, Context, Effect, Exit, Layer, Schema, Scope, Stream } from 'effect'
import {
  EFFORT_KEY,
  MODEL_KEY,
  PLAN_MODE_KEY,
  SPILL_TOKENS_KEY,
  renderEffective,
  renderModelInEffect,
  renderSurface,
} from './surface.ts'
import { loadConfigFile, type JozoHarnessConfig } from './config-file.ts'
import { acpSessionPortOf, type AcpSessionSource } from './acp.ts'

export interface CommandOptions {
  /** Profile documents, first layer first (`bundle/base` then the selected profile). */
  readonly profiles: ReadonlyArray<string>
  /** Rows from the settings file; patches still win over them. */
  readonly extraRows?: ReadonlyArray<PluginRow>
  readonly patches?: ReadonlyArray<string>
  readonly plugins: ReadonlyArray<Plugin<any, any, any>>
  /** The settings file the command read; without one the dump names the default. */
  readonly settingsPath?: string
  /** What that file held, so the dump can show the state. */
  readonly settings?: JozoHarnessConfig
  /** The effort resolved from --effort and the settings file; '' means a row, or the provider. */
  readonly effort?: string
  /** One-shot task. */
  readonly task?: string
  /** Lines of a batch session, used when stdin is not a terminal. */
  readonly lines?: Stream.Stream<string>
  /** When true, serve the ACP stdio server instead of running one turn. */
  readonly acp?: boolean
  /** When present, the command serves the interactive terminal UI. */
  readonly tui?: TuiIo
  /** When present, the command serves the browser UI on that port (0 picks one). */
  readonly web?: {
    readonly port: number
    readonly staticRoot?: string
    /** The https origin a proxy publishes, when the caller named one. */
    readonly publicUrl?: PublicOrigin | undefined
  }
  /** Completes to request a \`user\` cancellation, as SIGINT does. */
  readonly interrupt?: Effect.Effect<void>
  /** Answers an approval request; the default denies, so nothing hangs unanswered. */
  readonly approve?: (request: ApprovalRequested) => Effect.Effect<boolean>
  /** Answers ask_user questions; without it the question waits for an Ask answer. */
  readonly answer?: (request: AskRequested) => Effect.Effect<string>
  /** The startup seatbelt probe; tests replace the spawn, and a direct caller may omit it. */
  readonly seatbeltProbe?: () => SeatbeltProbeResult
  /** Extra skill roots from the settings file; the workspace and the jzh home always rank around them. */
  readonly skills?: ReadonlyArray<string>
  /** The jzh home: user-global AGENTS.md and skills live here. */
  readonly jzhHome?: string
  /** What is in effect for this run and which file filled each credential. */
  readonly surface?: SettingsSurface
  /** The credentials store a row's apiKeyRef points into; tests pass one under their own root. */
  readonly credentialsPath?: string
  /** Continue even when this run's composition differs from the one the session recorded. */
  readonly allowPresetChange?: boolean
  /** Lets the model run tasks in child agents. */
  readonly subagents?: boolean
  /** The host's schedule file; tests pass one under their own root. */
  readonly schedulesPath?: string
  /** The host store this run opened; filled once in `runCommand`. */
  readonly schedules?: ScheduleStore
  /** A search provider; without one the web_search tool is not registered. */
  readonly search?: SearchHost
  readonly resume?: SessionId
  readonly cwd: string
  /** `provider/model`, taken from the CLI or the profile row. */
  readonly route: string
  readonly dumpConfig?: boolean
  /** Writes session events as JSONL instead of streaming the assistant text. */
  readonly json?: boolean
  readonly stdout: (text: string) => void
  readonly stderr: (text: string) => void
}

/** Exit codes: completed 0, error 1. SIGINT (130) lands with the signal handling slice. */
const spillTokensOf = (rows: ReadonlyArray<PluginRow>): number | undefined => {
  for (const row of rows) {
    if (isRecord(row.config) && typeof row.config[SPILL_TOKENS_KEY] === 'number') {
      return row.config[SPILL_TOKENS_KEY]
    }
  }
  return undefined
}

/** The failure of the newest turn, when it ended in an error. */
const turnFailure = (agent: Agent): string | undefined => {
  const events = agent.session.events()
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'turn/end') continue
    const reason = event.data.reason
    if (reason.kind === 'error') {
      return reason.failure.code + ': ' + reason.failure.message
    }
    return undefined
  }
  return undefined
}

const planModeOf = (config: unknown): boolean => isRecord(config) && config[PLAN_MODE_KEY] === true

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The first row that names a string under this key, in row order. */
const stringFromRows = (rows: ReadonlyArray<PluginRow>, key: string): string => {
  for (const row of rows) {
    const value = isRecord(row.config) ? row.config[key] : undefined
    if (typeof value === 'string' && value !== '') return value
  }
  return ''
}

/** A profile may carry the route on a row's config, as model: provider/model. */
const routeFromRows = (rows: ReadonlyArray<PluginRow>): string => stringFromRows(rows, MODEL_KEY)

/**
 * The routes this run lets a child take: the one the run started with, and the
 * models the agent-loop row prices. A row that names no models still offers the
 * parent's route, so a child can always stay where the parent runs.
 */
const childRoutes = (
  rows: ReadonlyArray<PluginRow>,
  route: string,
): ReadonlyArray<string> | undefined => {
  // A route without a provider has no provider to prefix a configured model with.
  const provider = route.indexOf('/') < 0 ? '' : route.slice(0, route.indexOf('/'))
  const priced = rows.flatMap(modelsOfRow).flatMap((model) => routesOfModel(model, provider))
  // A run that prices no models cannot say what a child may take, so the shape is
  // the only check; listing just the parent's route would refuse every other one.
  if (priced.length === 0) return undefined
  return [...new Set([...(route === '' ? [] : [route]), ...priced])]
}

/** The model names one row prices, as the agent-loop row spells them. */
const modelsOfRow = (row: PluginRow): ReadonlyArray<string> => {
  if (row.name !== '@jozo-harness/agent-loop' || !isRecord(row.config)) return []
  const models = row.config['models']
  return isRecord(models) ? Object.keys(models) : []
}

/** A priced model is offered as it is spelled and under the provider the run runs on. */
const routesOfModel = (model: string, provider: string): ReadonlyArray<string> =>
  model.includes('/') || provider === '' ? [model] : [model, provider + '/' + model]

/** A profile may carry the effort on a row's config, as effort: high. */
const effortFromRows = (rows: ReadonlyArray<PluginRow>): string => stringFromRows(rows, EFFORT_KEY)

/** The effort in effect: what the flag or the settings file resolved, else the first row that names one. */
const effortInEffect = (options: CommandOptions, rows: ReadonlyArray<PluginRow>): string =>
  options.effort === undefined || options.effort === '' ? effortFromRows(rows) : options.effort

const NO_MODEL =
  'no model is set: run jzh config set model <provider/model>, or pass --model for one run (jzh models lists them)'

const exitCodeOf = (_cause: Cause.Cause<unknown>): number => 1

/** The rows the command runs with: profiles first, then settings, then patches. */
export const profileRows = (
  options: Pick<CommandOptions, 'profiles' | 'extraRows' | 'patches'>,
): Effect.Effect<ReadonlyArray<PluginRow>, PluginError> =>
  Effect.gen(function* () {
    const layers: Array<ReadonlyArray<PluginRow>> = []
    for (const text of options.profiles) {
      layers.push((yield* parseProfile(text)).plugins)
    }
    if (options.extraRows !== undefined) layers.push(options.extraRows)
    for (const text of options.patches ?? []) {
      layers.push((yield* parseProfile(text)).plugins)
    }
    return mergeRows(layers)
  })

/** A row installs its plugin only while the loader leaves it in the layer. */
const hasEnabledRow = (rows: ReadonlyArray<PluginRow>, name: string): boolean =>
  rows.some((row) => row.name === name && isRowEnabled(row))

/** The safety row's config when the profile has one; a malformed row is not this check's to report. */
const safetyConfigOf = (rows: ReadonlyArray<PluginRow>): SafetyConfig | undefined => {
  const row = rows.find((each) => each.name === '@jozo-harness/safety' && isRowEnabled(each))
  return row !== undefined && Schema.is(safetyConfigSchema)(row.config) ? row.config : undefined
}

/**
 * Asks once whether the profile this command is about to run under can apply its
 * seatbelt. The answer only names the reason on stderr; the mode, and every
 * command wrapped in it, stay as they were.
 */
const warnUnappliableSeatbelt = (rows: ReadonlyArray<PluginRow>, options: CommandOptions): void => {
  const safety = safetyConfigOf(rows)
  if (safety === undefined || options.seatbeltProbe === undefined) return
  const notice = seatbeltStartupNotice(safety, process.platform, options.seatbeltProbe)
  if (notice !== undefined) options.stderr(notice + '\n')
}

/** Streams assistant text unless the caller asked for JSON session events. */
const installOutput = (hooks: HookRegistry, options: CommandOptions) =>
  Effect.gen(function* () {
    if (options.json === true) {
      yield* hooks.on('session/event', (event) => {
        options.stdout(JSON.stringify(event) + '\n')
      })
      return
    }
    yield* hooks.on('agent/assistant-stream', (timed) => {
      if (timed.chunk.type === 'text-delta' && timed.chunk.text !== '')
        options.stdout(timed.chunk.text)
    })
  })

/** MCP servers bring their own tools; the caller owns their processes. */
const installMcpServers = (tools: ToolRegistry, servers: ReadonlyArray<McpServerConfig>) =>
  Effect.gen(function* () {
    for (const server of servers) {
      const client = yield* startMcpServer({ command: server.command })
      for (const tool of yield* mcpTools(client, server.prefix ?? 'mcp__')) {
        yield* tools.register(tool)
      }
    }
  })

/** Nobody is there to answer an escalation, so the call stays denied. */
const refuseApproval: ApprovalAnswerer = () => Effect.succeed(false)

const installTier0 = (
  tools: ToolRegistry,
  tier0: Tier0ToolBuilder,
  approval: ApprovalShape | undefined,
  jobs: JobsShape,
  /** The session state the worktree tool moves; without it the tool is not offered. */
  worktree: WorktreeHost,
  /** The wait a bash call gets when it names none, read again for each call. */
  live: LiveRunSettings,
) =>
  Effect.gen(function* () {
    // A named bash session keeps one shell alive across calls; the run's scope is
    // what ends it, so a session cannot outlive the run that opened it.
    const sessions = yield* Effect.acquireRelease(
      Effect.sync(() => makeShellSessions()),
      (held) => Effect.sync(() => held.closeAll()),
    )
    // The registry lets a timed-out bash call keep running as a job instead of dying.
    // The default wait is read per call, so a page's save reaches the next command.
    for (const tool of tier0(approval, jobs, worktree, sessions, () => live.bashTimeoutMs))
      yield* tools.register(tool)
  })

/** The ask tool's configured batch wait, when the tier1 row opts in. */
const timeLimitMsOf = (rows: ReadonlyArray<PluginRow>): number | undefined => {
  const config = rows.find((row) => row.name === '@jozo-harness/tools-tier1')?.config
  const value = (config as { readonly timeLimitMs?: unknown } | undefined)?.timeLimitMs
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

/** Tier 1 tools ask the user; their questions and answers join the log. */
const installTier1 = (
  tools: ToolRegistry,
  holder: AskShape,
  agents: AgentsShape,
  options: CommandOptions,
  agent: Agent,
  route: string,
  answer: CommandOptions['answer'],
  answerBatch: AskBatchAnswerer | undefined,
  skills: ReadonlyArray<string>,
  /** Present only when the profile asked for plan mode; the tool that leaves it needs it. */
  planMode: PlanModeShape | undefined,
  /** The rows this run was built from, so the plugin tool can list and change them. */
  rows: ReadonlyArray<PluginRow>,
  /** The background commands of this session; the session also reports them to a UI. */
  jobs: JobsShape,
  /** The boundary the run's commands are confined to; run_code's child uses it too. */
  sandbox: SandboxShape | undefined,
  /** Builds an added row over this run's services and reports the tools it wired. */
  mount: (row: PluginRow) => Effect.Effect<ReadonlyArray<string>, ToolError>,
  /** Takes a wired row back out and reports the tools that left with it. */
  unmount: (id: string) => Effect.Effect<PluginUnmount, ToolError>,
  /** The limits and search provider a call reads now. */
  live: LiveRunSettings,
) =>
  Effect.gen(function* () {
    // A run_code child outlives one call; the run's scope is what ends it, so the
    // memory never reaches another session.
    const runCodeSessions = yield* makeRunCodeSessions()
    // A run with nobody to answer leaves the seam unserved, so a question fails
    // at once instead of waiting forever for an answer that cannot come.
    const ask = installAsk(holder, agent.session)
    if (answer !== undefined) yield* holder.serve((request) => answer(request))
    if (answerBatch !== undefined) {
      yield* holder.serveBatch(answerBatch)
      // The answerer stays attached after a timed-out batch, so this message is
      // the only place a later answer reaches the model and the log.
      ask.onLateAnswer((answered) =>
        agent.followup({ text: lateAnswerMessage(answered), source: 'user' }).pipe(Effect.ignore),
      )
    }
    const pluginHost = makePluginHost({
      rows,
      plugins: options.plugins,
      settingsPath: options.settingsPath ?? configPaths().config,
      ask,
      mount,
      unmount,
    })
    for (const tool of tier1ToolList(
      ask,
      options,
      agent,
      route,
      childRoutes(rows, route),
      agents,
      jobs,
      skills,
      planMode,
      pluginHost,
      {
        tools: () => tools.schemas(),
        call: (name, argumentsJson, nested) =>
          tools.call({
            callId: nested.callId,
            tool: name,
            arguments: argumentsJson,
            context: nested,
          }),
        // A nested call is part of what the session did, so it goes in the same log.
        append: (type, data) => agent.session.append(type, data),
        ...(sandbox === undefined ? {} : { sandbox }),
        sessions: runCodeSessions,
        env: childEnvironment(managedEnvOf(rows)),
      },
      sandbox,
      timeLimitMsOf(rows),
      live,
    )) {
      yield* tools.register(tool)
    }
  })

/** The workflow tool over the run's sandbox, keeping the optional key absent when unconfined. */
const workflowToolFor = (agents: AgentsShape, route: string, sandbox: SandboxShape | undefined) =>
  makeWorkflowTool({ agents, route, ...(sandbox === undefined ? {} : { sandbox }) })

/** The run's host store; a build without one is a wiring mistake, not a user error. */
const scheduleStoreOf = (options: CommandOptions): ScheduleStore => {
  const store = options.schedules
  if (store === undefined) throw new Error('the run opened no schedule store')
  return store
}

/** The schedules this session wrote, with any an older log recorded adopted first. */
const schedulesOf = (agent: Agent, store: ScheduleStore): ReadonlyArray<Schedule> => {
  store.adoptLegacy(agent.session.id, agent.session.events())
  return store.list(agent.session.id)
}

/** One session's face on the host store: writes also keep the session log's record. */
const scheduleHostOf = (agent: Agent, store: ScheduleStore): ScheduleHost => ({
  sessionId: agent.session.id,
  list: () => schedulesOf(agent, store),
  nextId: () => store.nextId(),
  now: () => store.now(),
  write: (write) =>
    Effect.gen(function* () {
      if (write.kind === 'deleted') {
        yield* agent.session.append('schedule/deleted', { id: write.id })
      } else {
        yield* agent.session.append(
          write.kind === 'created' ? 'schedule/created' : 'schedule/updated',
          { schedule: write.schedule },
        )
      }
      yield* Effect.sync(() => store.write(write))
    }).pipe(
      Effect.mapError(
        () => new ToolError({ code: 'execution', message: 'cannot record the schedule' }),
      ),
    ),
})

const tier1ToolList = (
  ask: AskShape,
  options: CommandOptions,
  agent: Agent,
  route: string,
  /** The routes a child may take, as this run's settings name them; absent when none are priced. */
  routes: ReadonlyArray<string> | undefined,
  agents: AgentsShape,
  jobs: JobsShape,
  skills: ReadonlyArray<string>,
  planMode: PlanModeShape | undefined,
  pluginHost: PluginHost,
  runCode: RunCodeHost,
  /** The boundary the run's commands are confined to; a workflow script's child uses it too. */
  sandbox: SandboxShape | undefined,
  /** The ask tool's default wait for a batch; absent waits until answered. */
  timeLimitMs: number | undefined,
  /** The values a call reads now: the delegation depth and the search provider. */
  live: LiveRunSettings,
) => {
  const list = [...tier1Tools(ask, skills, runCode, timeLimitMs)]
  list.push(makePluginTool(pluginHost))
  // A session opened while search is on keeps the tool, and reads the provider the
  // run holds when the call is made, so changing the provider does not need a reload.
  if (live.search !== undefined) list.push(makeWebSearchTool(() => live.search))
  for (const tool of jobTools(jobs)) list.push(tool)
  list.push(makeScheduleTool(scheduleHostOf(agent, scheduleStoreOf(options))))
  list.push(
    makeGoalTool({
      events: () => agent.session.events(),
      append: (state) =>
        agent.session
          .append('goal/updated', state)
          .pipe(
            Effect.mapError(
              () => new ToolError({ code: 'execution', message: 'cannot record the goal' }),
            ),
          ),
    }),
  )
  list.push(
    makeWorkingDirectoryTool({
      // A worktree moves the root, so the boundary is read from the log per call.
      root: () => rootOf(agent.session.events(), agent.session.header),
      change: (cwd) =>
        agent.session.append('session/cwd/changed', { cwd }).pipe(
          Effect.mapError(
            () =>
              new ToolError({
                code: 'execution',
                message: 'cannot record the working directory',
              }),
          ),
        ),
    }),
  )
  list.push(makeRalphTool({ agents, route }))
  if (options.subagents === true) {
    // The tools are shared with every child, so a call reads and writes the log
    // of the session that made it, not the root session this run opened.
    const sessionOf = (sessionId: string) => agents.get(sessionId)?.session
    const outputs = makeStructuredOutputs()
    list.push(
      makeSubagentTool({
        agents,
        route,
        outputs,
        maxDepth: () => live.subagentDepth,
        ...(routes === undefined ? {} : { routes }),
      }),
      makeStructuredOutputTool(outputs),
      ...agentTools(agents),
      workflowToolFor(agents, route, sandbox),
      makeTeamTool({
        agents,
        route,
        log: {
          events: (sessionId) => sessionOf(sessionId)?.events() ?? [],
          spawnMember: (sessionId, member) => {
            const session = sessionOf(sessionId)
            return session === undefined ? Effect.void : session.append('team/spawned', member)
          },
          createTask: (sessionId, task) => {
            const session = sessionOf(sessionId)
            return session === undefined
              ? Effect.void
              : session.append('team/task/created', { task })
          },
          updateTask: (sessionId, task) => {
            const session = sessionOf(sessionId)
            return session === undefined
              ? Effect.void
              : session.append('team/task/updated', { task })
          },
          sendMessage: (sessionId, message) => {
            const session = sessionOf(sessionId)
            return session === undefined
              ? Effect.fail(
                  new ToolError({ code: 'execution', message: 'no session for ' + sessionId }),
                )
              : session.append('team/message', message)
          },
          markMessagesRead: (sessionId, count) => {
            const session = sessionOf(sessionId)
            return session === undefined
              ? Effect.fail(
                  new ToolError({ code: 'execution', message: 'no session for ' + sessionId }),
                )
              : session.append('team/message/read', { count })
          },
          nextId: (sessionId) =>
            'task-' +
            String(
              (sessionOf(sessionId)?.events() ?? []).filter(
                (event) => event.type === 'team/task/created',
              ).length + 1,
            ),
        },
      }),
    )
  }
  if (planMode !== undefined) {
    list.push(makeExitPlanModeTool(planMode, ask))
  }
  return list
}

const createAgent = (
  agents: AgentsShape,
  options: CommandOptions,
  route: string,
  spillTokens: number | undefined,
  effort: string,
  resume: SessionId | undefined,
  cwd: string,
  attachmentDir: string,
  seed?: ReadonlyArray<SessionEvent>,
) =>
  Effect.gen(function* () {
    const agentOptions: AgentOptions = {
      route,
      // The effort the run resolved: '' leaves the choice to the provider.
      ...(effort === '' ? {} : { reasoningEffort: effort }),
      ...(spillTokens === undefined ? {} : { maxSpillTokens: spillTokens }),
      // Spilled text belongs in the jzh home, under the session that owns it.
      ...(options.jzhHome === undefined ? {} : { spillDir: join(options.jzhHome, 'spill') }),
      // Attachments sit beside the session logs, so the store and the model read one place.
      attachmentDir,
    }
    // A resumed session opens with the workspace its header recorded; `cwd` only
    // decides where a session that does not exist yet is created.
    return resume === undefined
      ? yield* agents.create({
          cwd,
          options: agentOptions,
          ...(seed === undefined ? {} : { seed }),
        })
      : yield* agents.create({ cwd, resume, options: agentOptions })
  })

const serveLines = (
  agent: Agent,
  options: CommandOptions,
  lines: Stream.Stream<string>,
  commands: CommandsShape,
) =>
  Effect.gen(function* () {
    yield* Stream.runForEach(lines, (line) =>
      line.trim() === ''
        ? Effect.void
        : Effect.gen(function* () {
            // A command is answered here and now; the model never sees it. The
            // switches a chip would move are handed to the command that names them.
            const outcome = yield* commands.run(line, agent.session, {
              route: () => agent.options.route,
              effort: () => agent.options.reasoningEffort ?? '',
              setModel: (model) => agent.setRoute(model),
              setEffort: (effort) => agent.setEffort(effort),
            })
            if (outcome !== undefined) {
              options.stdout(outcome.text + '\n')
              return
            }
            yield* agent.followup({ text: line, source: 'user' })
            yield* agent.whenIdle
          }),
    )
    const failure = turnFailure(agent)
    if (failure !== undefined) {
      options.stderr('jzh: a turn failed: ' + failure + '\n')
      return 1
    }
    return 0
  })

const serveTask = (agent: Agent, options: CommandOptions, task: string) =>
  Effect.gen(function* () {
    yield* agent.followup({ text: task, source: 'user' })
    let cancelled = false
    if (options.interrupt !== undefined) {
      const interrupt = options.interrupt
      yield* Effect.forkScoped(
        Effect.gen(function* () {
          yield* interrupt
          cancelled = true
          yield* agent.cancel('user')
        }),
      )
    }
    yield* agent.whenIdle
    const failure = turnFailure(agent)
    if (failure !== undefined) {
      options.stderr('jzh: the turn failed: ' + failure + '\n')
      return 1
    }
    return cancelled ? 130 : 0
  })

/** What one run serves: a task, a batch of lines, or one of the UIs. */
type Work =
  | { readonly kind: 'acp' }
  | { readonly kind: 'task'; readonly task: string }
  | { readonly kind: 'lines'; readonly lines: Stream.Stream<string> }
  | { readonly kind: 'tui'; readonly io: TuiIo }
  | {
      readonly kind: 'web'
      readonly port: number
      /** The built app to serve; the shipped build when the caller names none. */
      readonly staticRoot: string | undefined
      /** The https origin a proxy publishes; undefined keeps the page loopback-only. */
      readonly publicUrl: PublicOrigin | undefined
    }

const workOf = (options: CommandOptions): Work | undefined => {
  // An editor owns stdin when it drives the server; a task or a line batch never
  // shares the process with it.
  if (options.acp === true) return { kind: 'acp' }
  if (options.task !== undefined) return { kind: 'task', task: options.task }
  if (options.web !== undefined) {
    return {
      kind: 'web',
      port: options.web.port,
      staticRoot: options.web.staticRoot,
      publicUrl: options.web.publicUrl,
    }
  }
  if (options.tui !== undefined) return { kind: 'tui', io: options.tui }
  if (options.lines !== undefined) return { kind: 'lines', lines: options.lines }
  return undefined
}

const serveAgent = (agent: Agent, options: CommandOptions, work: Work, commands: CommandsShape) =>
  work.kind === 'task'
    ? serveTask(agent, options, work.task)
    : work.kind === 'lines'
      ? serveLines(agent, options, work.lines, commands)
      : Effect.succeed(0)

/** The names the profile documents declare, first layer first: what the human chose. */
const profileNamesOf = (documents: ReadonlyArray<string>): ReadonlyArray<string> =>
  documents.map((document) => /^name:\s*(\S+)/m.exec(document)?.[1] ?? 'unnamed')

/** Instruction discovery options of this run. */
const agentsOptionsOf = (options: CommandOptions): AgentsMdOptions =>
  options.jzhHome === undefined ? {} : { home: options.jzhHome }

/** The skill roots of this run: the workspace, the settings, then the jzh home. */
const skillsOf = (options: CommandOptions): ReadonlyArray<string> =>
  skillRoots({
    cwd: options.cwd,
    custom: (options.skills ?? []).map(expandHome),
    ...(options.jzhHome === undefined ? {} : { home: options.jzhHome }),
  })

/**
 * The skill catalog this agent still needs to read: the current skills, or undefined
 * when there are none or the newest catalog in its log is already this text. The log
 * is the only memory, so a resumed session does not restate the same catalog.
 */
const skillCatalogOf = (
  agent: Agent,
  roots: ReadonlyArray<string>,
): Effect.Effect<{
  readonly skills: ReadonlyArray<SkillSummary>
  readonly text: string | undefined
}> =>
  Effect.gen(function* () {
    const skills = yield* discoverSkills(roots)
    const text = renderSkillCatalog(skills)
    return {
      skills,
      text: text === '' || text === lastSkillCatalog(agent.session.events()) ? undefined : text,
    }
  })

/** Tools whose first argument names the file they touched. */
const TOUCHED_PATH_TOOLS = new Set(['read', 'write', 'edit'])

const touchedPathOf = (exec: ToolExecution): string | undefined => {
  if (!TOUCHED_PATH_TOOLS.has(exec.tool)) return undefined
  const args = exec.args
  if (typeof args !== 'object' || args === null) return undefined
  const path = (args as { readonly path?: unknown }).path
  return typeof path === 'string' ? path : undefined
}

/**
 * Nested instruction files reach the model as it touches their directories: the
 * files between the workspace root and the touched file are read once and injected
 * as the next step's input, so the model learns they apply where it is working.
 */
export const installNestedAgentsMd = (input: {
  readonly hooks: HookRegistry
  readonly agent: Agent
  readonly root: string
  readonly loaded: Map<string, string>
}) =>
  input.hooks.on('tools/post-execute', (exec, result, next) =>
    Effect.gen(function* () {
      // Let the listeners after this one transform the result first: the input
      // queued below belongs to the next step, not to this result.
      const posted = (yield* next()) ?? result
      const path = touchedPathOf(exec)
      if (path === undefined) return posted
      const cwd = cwdOf(input.agent.session.events(), input.agent.session.header)
      const files = yield* nestedAgentsFiles(input.loaded, { root: input.root, cwd, path })
      for (const file of files) {
        input.loaded.set(file.path, file.text.trim())
        const scope = relative(input.root, dirname(file.path))
        // A session that cannot be written stops the agent.
        yield* input.agent
          .inject({
            text: additionalInstructionsText(file, scope === '' ? '.' : scope),
            source: 'inject',
          })
          .pipe(Effect.orDie)
      }
      return posted
    }),
  )

/**
 * The values a running session reads per call, so a save reaches the next call
 * even in a session that was already open. A field that changes the plugin
 * composition (the delegate row, the loop's parallelism) waits for the next session.
 */
interface LiveRunSettings {
  bashTimeoutMs: number
  subagentDepth: number
  /** The provider in effect; a reader keeps the tool pointed at the current one. */
  search: SearchHost | undefined
}

/** Everything the profile's rows install on one running agent. */
interface ProfileWiring {
  readonly rows: ReadonlyArray<PluginRow>
  readonly options: CommandOptions
  readonly route: string
  readonly agent: Agent
  readonly answer: CommandOptions['answer']
  /** The batch seam; absent when neither a UI nor an answer hook can answer one. */
  readonly answerBatch: AskBatchAnswerer | undefined
  readonly approve: CommandOptions['approve']
  readonly hooks: HookRegistry
  /** The skill roots of this run, so the tool and the catalog search the same ones. */
  readonly skills: ReadonlyArray<string>
  /** Read only inside a branch: an absent row means the service was never built. */
  readonly context: Context.Context<any>
  /** The background commands this session may start; a UI lists them. */
  readonly jobs: JobsShape
  /** The rows this run could not wire, when a page can report and retry them. */
  readonly plugins?: PluginWiringState
  /** The limits and the search provider a call reads now. */
  readonly live: LiveRunSettings
}

/** The optional field a session carries only when a page can report failed wirings. */
const wiringOf = (
  plugins: PluginWiringState | undefined,
): { readonly plugins?: PluginWiringState } => (plugins === undefined ? {} : { plugins })

/** A row this run wired: the tools it added, and how to take them back. */
interface WiredRow {
  readonly names: ReadonlyArray<string>
  readonly release: Effect.Effect<void>
}

/** A name another row already offers: a second row of the same plugin would not load either. */
const clashOf = (
  row: PluginRow,
  list: ReadonlyArray<ToolDefinition<any, any>>,
  tools: ToolRegistry,
): ToolError | undefined => {
  const known = new Set(tools.schemas().map((schema) => schema.name))
  const clash = list.find((tool) => known.has(tool.name))
  if (clash === undefined) return undefined
  return new ToolError({
    code: 'duplicate-tool',
    message:
      'tool ' +
      clash.name +
      ' is already registered; another row of ' +
      row.name +
      ' would not load on the next start either',
  })
}

/**
 * Registers the line an agent at the delegation limit reads. The entry reads the
 * agents registry, so every child sharing the prompt service sees its own depth.
 */
const installDelegationContext = (
  wiring: ProfileWiring,
): Effect.Effect<void, ToolError, Scope.Scope> =>
  Effect.gen(function* () {
    if (wiring.options.subagents !== true) return
    const agents = Context.get(wiring.context, Agents)
    yield* Context.get(wiring.context, SystemPrompt)
      .context({
        name: 'delegation',
        order: DELEGATION_CONTEXT_ORDER,
        text: (subject: RuntimeContextSubject) =>
          Effect.sync(() =>
            subject.agentId === undefined
              ? undefined
              : delegationLine(agents.depthOf(subject.agentId), () => wiring.live.subagentDepth),
          ),
      })
      .pipe(
        Effect.mapError((error) => new ToolError({ code: 'execution', message: error.message })),
      )
  })

/**
 * Registers the teammate's identity in the runtime snapshot. The entry reads the
 * rosters of the live agents, so a teammate and the lead that spawned it see the
 * same record while the work runs.
 */
const installTeamIdentityContext = (
  wiring: ProfileWiring,
): Effect.Effect<void, ToolError, Scope.Scope> =>
  Effect.gen(function* () {
    if (wiring.options.subagents !== true) return
    const agents = Context.get(wiring.context, Agents)
    yield* Context.get(wiring.context, SystemPrompt)
      .context({
        name: 'team:identity',
        order: TEAM_IDENTITY_CONTEXT_ORDER,
        text: (subject: RuntimeContextSubject) =>
          Effect.sync(() => {
            if (subject.agentId === undefined) return undefined
            const identity = teamIdentityOf(agents, subject.agentId)
            if (identity === undefined) return undefined
            const session = agents.get(subject.agentId)?.session
            const inbox = teamInboxLine(unreadMessages(session?.events() ?? []))
            return [teamIdentityLine(identity), ...(inbox === undefined ? [] : [inbox])].join('\n')
          }),
      })
      .pipe(
        Effect.mapError((error) => new ToolError({ code: 'execution', message: error.message })),
      )
  })

/** Tiers and guards come from the profile's rows. */

/** The boundary this run's commands are confined to; absent when no tier 0 row asked for one. */
const sandboxOf = (wiring: ProfileWiring): SandboxShape | undefined =>
  hasEnabledRow(wiring.rows, '@jozo-harness/tools-tier0')
    ? Context.get(wiring.context, Sandbox)
    : undefined

/**
 * Plan mode hides every tool that could change the workspace, until the model
 * offers a plan and the user lets it go. A resumed session takes the mode the log
 * last recorded, so a plan approved before the restart is not asked again.
 */
const planModeFromProfile = (
  rows: ReadonlyArray<PluginRow>,
  session: Session,
): PlanModeShape | undefined => {
  const requested = rows.some(
    (row) => row.name === '@jozo-harness/safety' && planModeOf(row.config),
  )
  if (!requested) return undefined
  const recorded = currentPlanMode(session.events())
  return makePlanMode({
    ...(recorded === undefined ? {} : { recorded }),
    record: (mode) =>
      session
        .append('plan/mode', { mode })
        .pipe(
          Effect.mapError(
            () => new ToolError({ code: 'execution', message: 'cannot record plan mode' }),
          ),
        ),
  })
}

/**
 * The tools one context's artifact service hands the run. The artifact row is
 * opt-in and its page belongs beside the sessions root, so it takes that root from
 * the profile rather than one of its own. The page is written by a tool, not a
 * command, so the sandbox never wraps it; the preset has to reach the tool here to
 * keep read-only runs from publishing. Without a safety row there is no preset to
 * obey.
 */
const artifactToolsOf = (
  source: Context.Context<any>,
  wiring: ProfileWiring,
): ReadonlyArray<ToolDefinition<any, any>> => {
  const sandbox = hasEnabledRow(wiring.rows, '@jozo-harness/safety')
    ? Context.get(wiring.context, Sandbox)
    : noneSandbox
  return Context.get(source, ArtifactTools)(sessionRootOf(wiring.rows), sandbox)
}

/**
 * Past sessions are searchable only when the profile names the row. A hit is
 * useful only where its session ran, so the header's cwd decides what counts as
 * this workspace; the run's own cwd is what the model is searching from.
 */
const sessionSearchToolsOf = (
  source: Context.Context<any>,
  wiring: ProfileWiring,
): Effect.Effect<ReadonlyArray<ToolDefinition<any, any>>, ToolError, Scope.Scope> =>
  Effect.gen(function* () {
    const sessions = Context.get(wiring.context, SessionPersistenceService)
    const summaries = yield* sessions
      .list()
      .pipe(
        Effect.mapError(
          () => new ToolError({ code: 'execution', message: 'cannot list past sessions' }),
        ),
      )
    // The header cwd, not the newest change: a session that moved to a worktree
    // still belongs to the workspace it was started from.
    const cwdById = new Map(summaries.map((summary) => [summary.id, summary.cwd] as const))
    // The index stays open for as long as the session it was built for.
    const query = yield* Effect.acquireRelease(
      Effect.sync(() => makeSessionQuery({ root: sessionRootOf(wiring.rows), sessions })),
      (held) => Effect.sync(() => held.close()),
    )
    const host: SessionSearchHost = {
      cwd: wiring.options.cwd,
      cwdOf: (sessionId) => cwdById.get(sessionId),
      search: (text, limit) => query.search(text, limit),
      // The cut is leased to this read only, so it is given back before the next
      // call can reuse it; a session read never becomes a cache entry of its own.
      eventsOf: (sessionId) =>
        Effect.acquireUseRelease(
          query.observe(sessionId),
          (observed) => Effect.succeed(observed.events),
          (observed) => Effect.sync(() => observed.dispose()),
        ),
    }
    return Context.get(source, SessionSearchTools)(host)
  })

/**
 * Installs what the profile's rows ask for and reports the composition the session
 * runs with: the profiles it was launched from and every tool it was given. The
 * snapshot is taken before any restriction narrows the registry, because plan mode
 * and the like narrow what a call may see, not what the session was built from.
 */
const installFromProfile = (wiring: ProfileWiring): Effect.Effect<Preset, ToolError, Scope.Scope> =>
  Effect.gen(function* () {
    const tools = Context.get(wiring.context, Tools)
    const planMode = planModeFromProfile(wiring.rows, wiring.agent.session)
    // A row this run wires gets a scope of its own, forked from the session's, so
    // taking the row back out releases only what it built. A row taken out lets go
    // of that scope before the next request, once this step's calls have finished.
    const scope = yield* Scope.Scope
    const wired = new Map<string, WiredRow>()
    const pendingReleases: Array<Effect.Effect<void>> = []

    /** One opt-in row's tools, built from the services that row provides. */
    type RowMounter = (
      source: Context.Context<any>,
    ) => Effect.Effect<ReadonlyArray<ToolDefinition<any, any>>, ToolError, Scope.Scope>

    const sandboxedMounterOf = (name: string): RowMounter | undefined => {
      if (name === '@jozo-harness/screen-capture') {
        // The capture runs through the run's sandbox, so an unconfined run wraps nothing.
        return (source) =>
          Effect.succeed(Context.get(source, ScreenCaptureTools)(sandboxOf(wiring) ?? noneSandbox))
      }
      if (name === '@jozo-harness/computer-use') {
        // Approvals go through the same log-wrapped ask as every other Tier 1 tool.
        return (source) =>
          Effect.succeed(
            Context.get(source, ComputerUseTools)(
              sandboxOf(wiring) ?? noneSandbox,
              installAsk(Context.get(wiring.context, Ask), wiring.agent.session),
            ),
          )
      }
      if (name === '@jozo-harness/browser') {
        // The browser runs through the run's sandbox, so an unconfined run wraps nothing.
        // Its session tools register a finalizer, so the row's scope owns the process.
        return (source) => Context.get(source, BrowserTools)(sandboxOf(wiring) ?? noneSandbox)
      }
      if (name === '@jozo-harness/delegate') {
        // A delegated CLI runs through the run's sandbox too; the row fixes what it may start.
        return (source) =>
          Effect.succeed(Context.get(source, DelegateTools)(sandboxOf(wiring) ?? noneSandbox))
      }
      return undefined
    }

    const mounterOf = (name: string): RowMounter | undefined => {
      const sandboxed = sandboxedMounterOf(name)
      if (sandboxed !== undefined) return sandboxed
      if (name === '@jozo-harness/lsp') {
        return (source) => Effect.succeed(Context.get(source, LspTools))
      }
      if (name === '@jozo-harness/artifact') {
        return (source) => Effect.succeed(artifactToolsOf(source, wiring))
      }
      if (name === '@jozo-harness/session-search') {
        return (source) => sessionSearchToolsOf(source, wiring)
      }
      if (name === '@jozo-harness/workspace-dependencies') {
        // The payload is fixed by the row, so the tool only reads what that directory holds.
        return (source) => Effect.succeed(Context.get(source, WorkspaceDependenciesTools))
      }
      return undefined
    }

    /**
     * Registers the tools one row hands back in a scope of its own and keeps how to
     * take them back. The check refuses the list before any of it is registered, so
     * a refused row leaves the registry as it was.
     */
    const wireRow = (
      row: PluginRow,
      mounter: RowMounter,
      source: Effect.Effect<Context.Context<any>, ToolError, Scope.Scope>,
      check: (list: ReadonlyArray<ToolDefinition<any, any>>) => ToolError | undefined,
    ): Effect.Effect<ReadonlyArray<string>, ToolError> =>
      Effect.gen(function* () {
        const child = yield* Scope.fork(scope)
        const names = yield* Effect.gen(function* () {
          const list = yield* mounter(yield* source)
          const refused = check(list)
          if (refused !== undefined) return yield* Effect.fail(refused)
          for (const tool of list) yield* tools.register(tool)
          return list.map((tool) => tool.name)
        }).pipe(
          Effect.provideService(Scope.Scope, child),
          // A wiring that fails or is interrupted must not leave its scope open.
          Effect.onExit((exit) =>
            Exit.isFailure(exit) ? Scope.close(child, Exit.void) : Effect.void,
          ),
        )
        wired.set(row.id, { names, release: Scope.close(child, Exit.void) })
        return names
      })

    /**
     * Wires the one row of a plugin this run was built with, when its rows hold
     * one. A page that can report the failure keeps the row and its retry rather
     * than failing the session it was opening.
     */
    const installWiredRow = (name: string): Effect.Effect<void, ToolError> =>
      Effect.gen(function* () {
        const mounter = mounterOf(name)
        if (mounter === undefined) return
        const row = wiring.rows.find((each) => each.name === name && isRowEnabled(each))
        if (row === undefined) return
        const wiredRow = wireRow(row, mounter, Effect.succeed(wiring.context), () => undefined)
        const state = wiring.plugins
        if (state === undefined) {
          yield* wiredRow
          return
        }
        yield* wiredRow.pipe(
          Effect.tap(() => Effect.sync(() => state.clear(row.id))),
          Effect.catch((error: ToolError) =>
            Effect.sync(() => {
              state.record(row.id, row.name, error.message, () => installWiredRow(name))
            }),
          ),
        )
      })

    /**
     * Builds one added row over the running services and registers what it adds.
     * A row no mounter knows is left to the next start. A tool that is already
     * registered is refused before the settings change, because another row of
     * the same plugin would not load on the next start either.
     */
    const mountRow = (row: PluginRow) =>
      Effect.gen(function* () {
        const mounter = mounterOf(row.name)
        if (mounter === undefined) return []
        const source = loadPluginRow({
          plugins: wiring.options.plugins,
          row,
          context: wiring.context,
        }).pipe(
          Effect.mapError(
            (error) =>
              new ToolError({
                code: 'invalid-arguments',
                message:
                  'the row ' +
                  row.id +
                  ' (' +
                  row.name +
                  ') would not load in this run: ' +
                  error.message,
              }),
          ),
        )
        return yield* wireRow(row, mounter, source, (list) => clashOf(row, list, tools))
      })

    /**
     * Takes one row this run wired back out. Its tools leave the offered list now;
     * the services it built are released before the next request, once this step's
     * calls have finished.
     */
    const unmountRow = (id: string): Effect.Effect<PluginUnmount, ToolError> =>
      Effect.sync((): PluginUnmount => {
        const held = wired.get(id)
        if (held === undefined) return { detached: false, tools: [] }
        wired.delete(id)
        for (const name of held.names) tools.retire(name)
        pendingReleases.push(held.release)
        return { detached: true, tools: held.names }
      })

    /** Releases the rows taken out since the last request; no step offers their tools now. */
    const releaseUnmounted = (): Effect.Effect<void> =>
      Effect.gen(function* () {
        const releases = pendingReleases.splice(0, pendingReleases.length)
        for (const release of releases) yield* release
      })
    if (hasEnabledRow(wiring.rows, '@jozo-harness/tools-tier0')) {
      const sessions = Context.get(wiring.context, Agents)
      // A worktree call is shared with every child, so it moves the log of the
      // session that made the call rather than the run's root session.
      const sessionOf = (sessionId: string) =>
        sessions.get(sessionId)?.session ?? wiring.agent.session
      const worktree: WorktreeHost = {
        rootOf: (sessionId) => {
          const session = sessionOf(sessionId)
          return rootOf(session.events(), session.header)
        },
        change: (sessionId, cwd, root) =>
          sessionOf(sessionId)
            .append('session/cwd/changed', { cwd, root })
            .pipe(
              Effect.mapError(
                () =>
                  new ToolError({
                    code: 'execution',
                    message: 'cannot record the working directory',
                  }),
              ),
            ),
      }
      yield* installTier0(
        tools,
        Context.get(wiring.context, Tier0Tools),
        Context.get(wiring.context, Approval),
        wiring.jobs,
        worktree,
        wiring.live,
      )
    }
    if (hasEnabledRow(wiring.rows, '@jozo-harness/tools-tier1')) {
      yield* installTier1(
        tools,
        Context.get(wiring.context, Ask),
        Context.get(wiring.context, Agents),
        wiring.options,
        wiring.agent,
        wiring.route,
        wiring.answer,
        wiring.answerBatch,
        wiring.skills,
        planMode,
        wiring.rows,
        wiring.jobs,
        sandboxOf(wiring),
        mountRow,
        unmountRow,
        wiring.live,
      )
      // A row the plugin tool took back out releases what it built before the next
      // request, after the calls this step already chose have finished.
      yield* wiring.hooks.on('agent/request', (_request, next) =>
        Effect.gen(function* () {
          yield* releaseUnmounted()
          return yield* next()
        }),
      )
      // An agent at the delegation limit reads it in the next runtime snapshot;
      // the tool stays visible and refuses the call, as dsh does.
      yield* installDelegationContext(wiring)
      yield* installTeamIdentityContext(wiring)
    }
    // The opt-in rows this run was built with are wired like a row added later, so
    // the plugin tool can take one back out without a restart.
    yield* installWiredRow('@jozo-harness/lsp')
    yield* installWiredRow('@jozo-harness/artifact')
    yield* installWiredRow('@jozo-harness/session-search')
    yield* installWiredRow('@jozo-harness/screen-capture')
    yield* installWiredRow('@jozo-harness/computer-use')
    yield* installWiredRow('@jozo-harness/browser')
    yield* installWiredRow('@jozo-harness/delegate')
    yield* installWiredRow('@jozo-harness/workspace-dependencies')
    // A failed provider attempt is retried for the codes the loop row lists; the
    // loop only decides what to do when a listener answers, so this is the wiring
    // that makes the retry path part of a run.
    const loopRow = wiring.rows.find((row) => row.name === '@jozo-harness/agent-loop')
    const retry = (loopRow?.config as { readonly retry?: RetryConfig } | undefined)?.retry
    yield* installRetry(wiring.hooks, retry ?? {})
    const composition: Preset = {
      profiles: profileNamesOf(wiring.options.profiles),
      tools: tools.schemas().map((schema) => schema.name),
    }
    if (planMode !== undefined) {
      yield* planMode.install(tools)
    }
    yield* installAutoReview(wiring, tools)
    // An active goal keeps going by itself: at the end of a turn of this agent, the
    // next round is queued before the turn closes, so the run cannot go idle in between.
    if (hasEnabledRow(wiring.rows, '@jozo-harness/tools-tier1')) {
      const agents = Context.get(wiring.context, Agents)
      yield* wiring.hooks.on('agent/turn-stopping', (ending: Agent) =>
        ending === wiring.agent ? startGoalRound(ending, agents) : Effect.void,
      )
      // A call the model repeats with the same arguments answers the same way every
      // time; the third, fifth, and eighth each get a word in their own result.
      yield* installRepeatReminders(wiring.agent, wiring.hooks)
    }
    return composition
  })

/**
 * Records the composition of a new session, or says why the run may not carry on
 * with one whose composition differs from what it recorded. A tool this build
 * added is one more capability, so the session simply keeps the new set; losing a
 * tool or changing the profile still needs the human to say so.
 */
const applyPreset = (
  agent: Agent,
  composition: Preset,
  allowChange: boolean,
): Effect.Effect<string | undefined, SessionError> =>
  Effect.gen(function* () {
    const recorded = currentPreset(agent.session.events())
    if (recorded === undefined) {
      yield* agent.session.append('preset/selected', composition)
      return undefined
    }
    const change = presetChange(recorded, composition)
    if (change === undefined) return undefined
    if (allowChange || presetResumable(change)) {
      // The new composition becomes the session's own.
      yield* agent.session.append('preset/selected', composition)
      return undefined
    }
    return presetProblem(recorded, composition)
  })

/** What one session runs with now: the rows it was built from and the set in effect. */
interface CompositionInEffect {
  readonly profiles: ReadonlyArray<string>
  readonly selected: ReadonlyArray<string>
  readonly offered: ReadonlyArray<string>
}

const compositionInEffect = (agent: Agent, registry: ToolRegistry): CompositionInEffect => {
  const events = agent.session.events()
  const offered = registry.schemas().map((schema) => schema.name)
  return {
    profiles: currentPreset(events)?.profiles ?? [],
    selected: effectivePreset(events)?.tools ?? offered,
    offered,
  }
}

/**
 * Records the set a human picked for one open session. Nothing is written while
 * the set names a tool this run cannot offer; the refusal says which ones. The
 * layers stay as they were built, so the next step reads the smaller set and the
 * tools behind the history keep running.
 */
const changeComposition = (
  agent: Agent,
  registry: ToolRegistry,
  tools: ReadonlyArray<string>,
): Effect.Effect<CompositionInEffect, WebError> =>
  Effect.gen(function* () {
    const offered = registry.schemas().map((schema) => schema.name)
    const inEffect = compositionInEffect(agent, registry)
    const plan = compositionPlan(offered, inEffect.selected, tools)
    if (!compositionWritable(plan)) {
      return yield* Effect.fail(
        new WebError({
          message: 'this run cannot offer ' + plan.missing.join(', ') + '; the set was not written',
        }),
      )
    }
    const chosen = [...new Set(tools)].filter((name) => offered.includes(name))
    const profiles = currentPreset(agent.session.events())?.profiles ?? []
    yield* agent.session.append(
      'composition/selected',
      presetWithTools({ profiles, tools: inEffect.selected }, chosen),
    )
    return compositionInEffect(agent, registry)
  }).pipe(
    Effect.mapError((error) =>
      error instanceof WebError ? error : new WebError({ message: messageOf(error) }),
    ),
  )

/** Tells the model where the page lives, when this session is served by one. */
const installGuiContext = (prompt: SystemPromptShape, gui: GuiEndpoint | undefined) =>
  gui === undefined || !prompt.devContext
    ? Effect.void
    : prompt.context(guiContextEntry(() => gui.url))

/**
 * Records the default a page saved as a new session's first composition. A
 * resumed or forked session keeps the set its own log already carries, because
 * that was the human's choice under whatever default was in effect then.
 */
const seedDefaultComposition = (
  agent: Agent,
  composition: Preset,
  resume: SessionId | undefined,
  defaultTools: ReadonlyArray<string> | undefined,
): Effect.Effect<void, SessionError> =>
  Effect.gen(function* () {
    if (resume !== undefined || defaultTools === undefined) return
    if (selectedPreset(agent.session.events()) !== undefined) return
    yield* agent.session.append(
      'composition/selected',
      presetWithTools(
        composition,
        composition.tools.filter((name) => defaultTools.includes(name)),
      ),
    )
  })

/** A UI runs the session itself instead of streaming into the caller's terminal. */
const ownsTheScreen = (work: Work): boolean => work.kind === 'tui' || work.kind === 'web'

/** One line of the command a human typed; the model never sees it. */
const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/**
 * What the sessions this run opens from now on start with. A page picks the
 * model and the effort for them; a session already open keeps the model route
 * it began with, because its route was fixed when its agent was built, though
 * its effort can be switched for that session alone.
 */
interface RunChoice {
  route: string
  /** The effort a session this run opens starts from; '' leaves it to the provider. */
  effort: string
}

/** What a page reads about the run behind it, which is known before any session is. */
interface RunFacts {
  /** The rows in effect; a page may save a settings change, so this is read again. */
  rows: ReadonlyArray<PluginRow>
  /** The layer the next session is built from, rebuilt after a save changes the rows. */
  layer: Layer.Layer<any, PluginError, never>
  /** The effort words the provider takes, as a page offers them; empty declares none. */
  readonly efforts: ReadonlyArray<string>
}

/** The live values a session reads per call, seeded from the rows in effect. */
const liveSettingsOf = (
  options: CommandOptions,
  rows: ReadonlyArray<PluginRow>,
): LiveRunSettings => {
  const view = readEditableSettings({
    rows,
    settings: options.settings ?? {},
    settingsPath: options.settingsPath ?? '',
    env: process.env,
    credentialsPath: options.credentialsPath ?? configPaths().credentials,
  })
  return {
    bashTimeoutMs: view.bashTimeoutMs.value,
    subagentDepth: view.subagentDepth.value,
    search: options.search,
  }
}

/**
 * The settings file and the rows in effect, read again so a change written by one
 * page is what the next read and the next session see.
 */
const editableStateOf = (options: CommandOptions) =>
  Effect.gen(function* () {
    const path = options.settingsPath ?? configPaths().config
    const settings = yield* loadConfigFile(path).pipe(
      Effect.mapError((error) => new WebError({ message: error.message })),
    )
    const rows = yield* profileRows({
      profiles: options.profiles,
      extraRows: settings.plugins ?? [],
      ...(options.patches === undefined ? {} : { patches: options.patches }),
    }).pipe(Effect.mapError((error) => new WebError({ message: error.message })))
    const inputs: EditableInputs = {
      rows,
      settings,
      settingsPath: path,
      env: process.env,
      credentialsPath: options.credentialsPath ?? configPaths().credentials,
    }
    return { rows, inputs }
  })

/** What a page may read and change about this run: the settings file, and the provider's list. */
const settingsPortOf = (
  options: CommandOptions,
  facts: RunFacts,
  choice: RunChoice,
  live: LiveRunSettings,
): SettingsPort => ({
  read: () =>
    Effect.succeed({
      // The model and the effort a session opened now would ask, which are the
      // choices a page made.
      model: choice.route,
      effort: choice.effort,
      efforts: facts.efforts,
      settingsPath: options.settingsPath ?? '',
      cwd: options.cwd,
      sessionRoot: sessionRootOf(facts.rows),
    }),
  models: () => {
    const endpoint = modelEndpointOf(facts.rows)
    return endpoint === undefined
      ? Effect.fail(new WebError({ message: 'this profile has no model list to ask for' }))
      : listModels(endpoint, process.env).pipe(
          Effect.mapError((error) => new WebError({ message: messageOf(error) })),
        )
  },
  // The writer is the one `jzh config set` uses, so both paths write the same file the same way.
  setModel: (model, remember) =>
    (remember
      ? Effect.tryPromise({
          try: async () => {
            let said = ''
            const code = await runConfig(['set', 'model', model], {
              stdout: () => undefined,
              stderr: (text) => {
                said += text
              },
            })
            if (code !== 0) {
              throw new Error(
                said.trim() === '' ? 'the settings file refused the model' : said.trim(),
              )
            }
          },
          catch: (cause) => new WebError({ message: messageOf(cause) }),
        })
      : Effect.void
    ).pipe(
      // Remembered either way, so the sessions this run opens from now on start from
      // it; written only when the page asked, so the runs after this one do too.
      Effect.tap(() =>
        Effect.sync(() => {
          choice.route = model
        }),
      ),
    ),
  // The sessions this run opens from now on start from it; the runs after this one
  // resolve their own, so nothing is written.
  setEffort: (effort) =>
    Effect.sync(() => {
      choice.effort = effort
    }),
  editable: () =>
    editableStateOf(options).pipe(
      Effect.map((state) => {
        facts.rows = state.rows
        return readEditableSettings(state.inputs)
      }),
    ),
  // Every field is checked before the one writer touches the file, so a refused save
  // names the field and leaves the file as it was.
  saveEditable: (input) =>
    Effect.gen(function* () {
      const state = yield* editableStateOf(options)
      const path = state.inputs.settingsPath
      const text = yield* Effect.try({
        try: () => (existsSync(path) ? readFileSync(path, 'utf8') : ''),
        catch: (cause) => new WebError({ message: messageOf(cause) }),
      })
      const next = yield* editRunSettings(text, state.inputs, input).pipe(
        Effect.mapError(
          (problem) => new WebError({ message: problem.field + ': ' + problem.message }),
        ),
      )
      if (next !== text) {
        yield* Effect.try({
          try: () => writeFileAtomic(path, next),
          catch: (cause) => new WebError({ message: messageOf(cause) }),
        })
      }
      const after = yield* editableStateOf(options)
      // The next session is built from the rows the file now merges into, and the
      // running session's per-call values are updated in place.
      facts.rows = after.rows
      facts.layer = yield* loadProfile({ plugins: options.plugins, layers: [after.rows] }).pipe(
        Effect.mapError((error) => new WebError({ message: error.message })),
      )
      const view = readEditableSettings(after.inputs)
      live.bashTimeoutMs = view.bashTimeoutMs.value
      live.subagentDepth = view.subagentDepth.value
      live.search = searchFromEnv(process.env, after.inputs.settings)
      return view
    }),
  // The default belongs to sessions that do not exist yet, so it is read from the
  // file as it is now rather than from the settings this run loaded at start.
  defaultTools: () =>
    Effect.gen(function* () {
      const path = options.settingsPath ?? configPaths().config
      const settings = yield* loadConfigFile(path).pipe(
        Effect.mapError((error) => new WebError({ message: messageOf(error) })),
      )
      return { tools: settings.tools, settingsPath: path }
    }),
  saveDefaultTools: (tools) =>
    Effect.tryPromise({
      try: async () => {
        let said = ''
        const code = await runConfig(['set', 'tools', tools.join(',')], {
          stdout: () => undefined,
          stderr: (text) => {
            said += text
          },
        })
        if (code !== 0) {
          throw new Error(
            said.trim() === '' ? 'the settings file refused the tool set' : said.trim(),
          )
        }
      },
      catch: (cause) => new WebError({ message: messageOf(cause) }),
    }),
})

/** The address this run serves. The port is known only once the listeners are up. */
interface GuiEndpoint {
  url: string | undefined
}

/** Opens one more session for a UI that outlives its first: the same wiring, a new scope. */
const sessionFactoryOf = (
  options: CommandOptions,
  facts: RunFacts,
  choice: RunChoice,
  spillTokens: number | undefined,
  live: LiveRunSettings,
  listSessions: SessionRuntime['listSessions'],
  readSessionEvents: (id: string) => Effect.Effect<ReadonlyArray<SessionEvent>, SessionError>,
  plugins: PluginWiringState,
  gui: GuiEndpoint,
): SessionFactory => ({
  list: () =>
    listSessions().pipe(Effect.mapError((error) => new WebError({ message: messageOf(error) }))),
  read: (id) =>
    readSessionEvents(id).pipe(
      Effect.mapError((error) => new WebError({ message: messageOf(error) })),
    ),
  open: (id, cwd, seed) =>
    Effect.gen(function* () {
      // The choices are read per open: a page may have picked another model or
      // effort since.
      // The rows and layer are read per open: a save may have added a row or
      // changed a limit, and the next session should start from the new wiring.
      // A default saved while the page is open is read here, so a session opened
      // after the save starts from it without restarting the run.
      const saved = yield* loadConfigFile(options.settingsPath ?? configPaths().config).pipe(
        Effect.orElseSucceed((): JozoHarnessConfig => ({})),
      )
      const built = yield* buildSession(
        options,
        facts.rows,
        choice.route,
        choice.effort,
        spillTokens,
        facts.layer,
        true,
        id,
        // A page that named no workspace gets the one this run was started in.
        cwd ?? options.cwd,
        false,
        plugins,
        gui,
        live,
        seed,
        saved.tools ?? options.settings?.tools,
      )
      if (built.kind === 'refused') {
        return yield* Effect.fail(new WebError({ message: built.message }))
      }
      const { agent, ui } = built.runtime
      if (ui === undefined) {
        return yield* Effect.fail(
          new WebError({ message: 'the session was built without a UI host' }),
        )
      }
      return {
        summary: summaryOf(agent),
        host: ui,
        composition: () => compositionInEffect(agent, built.runtime.tools),
        setComposition: (tools: ReadonlyArray<string>) =>
          changeComposition(agent, built.runtime.tools, tools),
        commands: () => commandViewsOf(built.runtime.commands, built.runtime.skillCatalog()),
        runState: () =>
          runStateOf(
            agent,
            built.runtime.jobs,
            built.runtime.efforts,
            subagentsOf(
              built.runtime.agents,
              built.runtime.agents.childrenOf(agent.id),
              built.runtime.subagentDepth(),
            ),
            built.runtime.budget,
            scheduleStoreOf(options),
            built.runtime.permission,
          ),
        jobOutput: (jobId: string) => jobDetailOf(built.runtime.jobs, jobId),
        stopJob: (jobId: string) => stopJobOf(built.runtime.jobs, jobId),
        stopSubagent: (childId: string) => stopSubagentOf(built.runtime.agents, agent.id, childId),
        messageSubagent: (childId: string, message: string) =>
          messageSubagentOf(built.runtime.agents, agent.id, childId, message),
        busy: () => busyOf(agent, built.runtime.jobs, built.runtime.agents.childrenOf(agent.id)),
        deliver: (schedule: Schedule) =>
          fireSchedule(agent, schedule, () => scheduleStoreOf(options).now()).pipe(Effect.as(true)),
        adoptSchedules: () =>
          scheduleStoreOf(options).adoptLegacy(agent.session.id, agent.session.events()),
      }
    }).pipe(
      Effect.mapError((error) =>
        error instanceof WebError ? error : new WebError({ message: messageOf(error) }),
      ),
    ),
})

/** Where the built browser app sits: this tree's client bundle, beside the CLI. */
const defaultStaticRoot = fileURLToPath(new URL('../../web/dist/', import.meta.url))

/** What a page reads from the run before any session exists. */
interface RunReading {
  /** The store a page's rail lists from: the profile's own session store. */
  readonly listSessions: SessionRuntime['listSessions']
  /** One session's log, as an @ reference in another message may quote it. */
  readonly readSessionEvents: (
    id: string,
  ) => Effect.Effect<ReadonlyArray<SessionEvent>, SessionError>
  /** The store's full-text index, which the rail searches from its field. */
  readonly searchSessions: (text: string) => Effect.Effect<ReadonlyArray<SearchHit>, SessionError>
  /** The effort words the provider takes, which the blank seat offers. */
  readonly efforts: ReadonlyArray<string>
}

/**
 * Reads the parts of the run that exist before a session does: the profile's
 * session store and the adapter's effort words, both from the layer the run serves.
 */
const runReadingOf = (
  layer: Layer.Layer<any, PluginError, never>,
  sessionRoot: string,
): Effect.Effect<RunReading, PluginError, Scope.Scope> =>
  Effect.gen(function* () {
    const context = yield* Layer.build(layer)
    const sessions = Context.get(context, Sessions)
    // A reference reads a log without opening a live session: the page may attach a
    // session nobody has open, and reading it must not start one.
    const persistence = Context.get(context, SessionPersistenceService)
    // The rail searches the same index the search tool and --search read, so a hit
    // names the line it matched instead of the page rescanning every log.
    const query = yield* Effect.acquireRelease(
      Effect.sync(() => makeSessionQuery({ root: sessionRoot, sessions: persistence })),
      (held) => Effect.sync(() => held.close()),
    )
    // What the provider takes for an effort is the adapter's to say; a page only offers it.
    const efforts = Context.get(context, Llm).capabilities.reasoningEffort ?? []
    // A reader must not take the write lock: an @ reference or a fork may name the
    // very session this server has open, and opening it again would claim its log.
    const readSessionEvents = (id: string) =>
      persistence.read === undefined
        ? persistence.open(id).pipe(Effect.map((opened) => opened.events))
        : persistence.read(id)
    return {
      listSessions: () => sessions.list(),
      readSessionEvents,
      searchSessions: (text) => (text.trim() === '' ? Effect.succeed([]) : query.search(text)),
      efforts,
    }
  })

/** Where a page's registered workspaces live, under the jzh home. */
const workspaceFileOf = (home: string): string => join(home, 'web', 'workspaces.json')

/** The folders a reader registered: a missing or malformed file holds none of them. */
const registeredWorkspacesOf = async (home: string): Promise<ReadonlyArray<string>> => {
  try {
    const parsed: unknown = JSON.parse(await readFile(workspaceFileOf(home), 'utf8'))
    return Array.isArray(parsed)
      ? parsed.filter((each): each is string => typeof each === 'string')
      : []
  } catch {
    return []
  }
}

/** Registers one absolute, existing directory; a page cannot name a file or a guess. */
const addWorkspaceOf =
  (home: string | undefined) =>
  (cwd: string): Effect.Effect<void, WebError> => {
    if (home === undefined) {
      return Effect.fail(new WebError({ message: 'this run has no home to keep workspaces in' }))
    }
    return Effect.tryPromise({
      try: async () => {
        if (!isAbsolute(cwd)) throw new Error('a workspace path must be absolute')
        if (!(await stat(cwd)).isDirectory()) throw new Error('a workspace must be a directory')
        const known = await registeredWorkspacesOf(home)
        if (known.includes(cwd)) return
        const path = workspaceFileOf(home)
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, JSON.stringify([...known, cwd], null, 2) + '\n')
      },
      catch: (cause) => new WebError({ message: messageOf(cause) }),
    })
  }

/**
 * The folders a page may start a session in: the ones sessions already used,
 * newest first, then the registered ones, with the run's own directory always
 * offered so a page never starts with an empty choice.
 */
const workspacesPortOf = (
  options: CommandOptions,
  listSessions: SessionRuntime['listSessions'],
): WorkspacesPort => ({
  list: () =>
    Effect.gen(function* () {
      const sessions = yield* listSessions()
      const home = options.jzhHome
      const registered =
        home === undefined ? [] : yield* Effect.promise(() => registeredWorkspacesOf(home))
      const lastUsed = new Map<string, number>()
      for (const session of sessions) {
        lastUsed.set(session.cwd, Math.max(lastUsed.get(session.cwd) ?? 0, session.updatedAt))
      }
      for (const cwd of registered) {
        if (!lastUsed.has(cwd)) lastUsed.set(cwd, 0)
      }
      if (!lastUsed.has(options.cwd)) lastUsed.set(options.cwd, 0)
      const items = [...lastUsed]
        .map(([cwd, lastUsedAt]) => ({ cwd, lastUsedAt }))
        .sort((a, b) => b.lastUsedAt - a.lastUsedAt || a.cwd.localeCompare(b.cwd))
      return { cwd: options.cwd, items }
    }).pipe(Effect.mapError((error) => new WebError({ message: messageOf(error) }))),
  browse: (path) =>
    Effect.tryPromise({
      try: () => listDirectories(path, options.cwd),
      catch: (cause) => new WebError({ message: messageOf(cause) }),
    }),
  add: addWorkspaceOf(options.jzhHome),
})

/**
 * One labeled line per address, labels padded to the longest present so the
 * URLs line up. A two-address run keeps the spacing it printed before the
 * tailnet was detected.
 */
export const readyLinesOf = (urls: ReadyUrls): ReadonlyArray<string> => {
  const lines = [
    { label: 'local', url: urls.local },
    ...urls.tailnet.map((url) => ({ label: 'tailnet', url })),
    ...(urls.public === undefined ? [] : [{ label: 'public', url: urls.public }]),
  ]
  const width = Math.max(...lines.map((line) => line.label.length))
  return lines.map((line) => line.label.padEnd(width) + ' ' + line.url)
}

/**
 * Starts the browser UI; it runs until interrupted. A plain run opens no
 * session: looking at the page is not a request for one, so the first is built
 * when the human starts working (`open` with no id). `--resume` does ask for
 * one, and that session is the one the page opens.
 */
const serveWebUi = (
  options: CommandOptions,
  rows: ReadonlyArray<PluginRow>,
  route: string,
  effort: string,
  spillTokens: number | undefined,
  layer: Layer.Layer<any, PluginError, never>,
  work: Extract<Work, { kind: 'web' }>,
  /** The session the page opens first, when the command named one to resume. */
  initial: InitialSession | undefined,
  /** The rows this run could not wire, and the retries the page may ask for. */
  wiring: PluginWiringState,
  /** Filled by onReady; every session this run opens reads it when it renders. */
  gui: GuiEndpoint,
): Effect.Effect<number, PluginError> =>
  Effect.gen(function* () {
    const staticRoot = work.staticRoot ?? defaultStaticRoot
    if (!(yield* Effect.promise(() => pageIsThere(staticRoot)))) {
      options.stderr('jzh web: the browser app is not built: run pnpm run build:web\n')
      return 1
    }
    // Tailscale can be installed as an app with no CLI on PATH; a lookup that
    // fails or times out leaves the run on loopback, as it was before.
    const tailnet: TailnetAddresses = yield* detectTailnet(tailnetExec)
    const choice: RunChoice = { route, effort }
    // The blank page has no session to ask yet, so the run keeps one registry
    // for itself: the very first line typed completes against the built-ins.
    const runCommands = makeCommands()
    yield* installBuiltinCommands(runCommands)
    // A page opened before any session exists still lists the skills this run's
    // roots would offer, so the first slash is not blind.
    const defaultCommands = commandViewsOf(runCommands, yield* discoverSkills(skillsOf(options)))
    // The page writes settings through the same host the model's tool does; the
    // asker is only here because the host carries one, and this path never asks.
    const plugins = makeWebPluginsPort({
      rows,
      settingsPath: options.settingsPath ?? configPaths().config,
      plugins: options.plugins,
      catalog: optionalBundles,
      wiring,
      ask: yield* makeAsk(),
    })
    // The store the rail lists from and the seat's effort words live as long as
    // the server they serve.
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const reading = yield* runReadingOf(layer, sessionRootOf(rows))
        // The facts are mutable: a save rebuilds the rows and the layer for the next
        // session, and updates the values a running call reads.
        const live = liveSettingsOf(options, rows)
        const facts: RunFacts = { rows, layer, efforts: reading.efforts }
        return yield* serveWeb({
          ...(initial === undefined ? {} : { initial }),
          factory: sessionFactoryOf(
            options,
            facts,
            choice,
            spillTokens,
            live,
            reading.listSessions,
            reading.readSessionEvents,
            wiring,
            gui,
          ),
          settings: settingsPortOf(options, facts, choice, live),
          schedules: scheduleStoreOf(options),
          workspaces: workspacesPortOf(options, reading.listSessions),
          openInApp: makeOpenInApp(),
          readSessionEvents: reading.readSessionEvents,
          searchSessions: (text) =>
            reading
              .searchSessions(text)
              .pipe(Effect.mapError((error) => new WebError({ message: messageOf(error) }))),
          ...(options.settings?.webhooks === undefined
            ? {}
            : { webhooks: options.settings.webhooks }),
          commands: () => defaultCommands,
          plugins,
          port: work.port,
          staticRoot,
          ...(work.publicUrl === undefined ? {} : { publicUrl: work.publicUrl }),
          ...(tailnet.ip === undefined ? {} : { tailnet }),
          onReady: (urls) => {
            // The public origin wins when a proxy publishes the page; the loopback
            // URL is what the server itself bound otherwise.
            gui.url = urls.public ?? urls.local
            // One unlabeled line while the page is loopback-only; one labeled
            // line per address when a tailnet or a proxy also reaches it.
            if (urls.tailnet.length === 0 && urls.public === undefined) {
              options.stderr('jzh web: ' + urls.local + '\n')
              return
            }
            for (const line of readyLinesOf(urls)) options.stderr('jzh web: ' + line + '\n')
          },
          ...(options.interrupt === undefined ? {} : { interrupt: options.interrupt }),
        })
      }),
    )
  })

/** One built session as the page sees it; undefined when it was built without a UI. */
const openSessionOf = (
  runtime: SessionRuntime,
  schedules: ScheduleStore,
): OpenSession | undefined => {
  const { agent, ui, jobs, efforts, agents, budget, permission } = runtime
  if (ui === undefined) return undefined
  return {
    summary: summaryOf(agent),
    host: ui,
    composition: () => compositionInEffect(agent, runtime.tools),
    setComposition: (tools: ReadonlyArray<string>) =>
      changeComposition(agent, runtime.tools, tools),
    commands: () => commandViewsOf(runtime.commands, runtime.skillCatalog()),
    runState: () =>
      runStateOf(
        agent,
        jobs,
        efforts,
        subagentsOf(agents, agents.childrenOf(agent.id), runtime.subagentDepth()),
        budget,
        schedules,
        permission,
      ),
    jobOutput: (jobId: string) => jobDetailOf(jobs, jobId),
    stopJob: (jobId: string) => stopJobOf(jobs, jobId),
    stopSubagent: (childId: string) => stopSubagentOf(agents, agent.id, childId),
    messageSubagent: (childId: string, message: string) =>
      messageSubagentOf(agents, agent.id, childId, message),
    busy: () => busyOf(agent, jobs, agents.childrenOf(agent.id)),
    deliver: (schedule) =>
      fireSchedule(agent, schedule, () => schedules.now()).pipe(Effect.as(true)),
    adoptSchedules: () => schedules.adoptLegacy(agent.session.id, agent.session.events()),
  }
}

/** The UI a work kind asks for, when the caller supplied one. */
const serveUi = (
  options: CommandOptions,
  runtime: SessionRuntime,
  work: Work,
): Effect.Effect<number> | undefined => {
  const { agent, ui } = runtime
  if (ui === undefined) return undefined
  if (work.kind === 'tui') {
    return runTui(ui, work.io, {
      title: 'jozo-harness · ' + runtime.route + ' · ' + agent.id.slice(0, 8),
      ...(options.interrupt === undefined ? {} : { interrupt: options.interrupt }),
    })
  }
  return undefined
}

/** Turns the one-string answer hook into the batch seam; labels select, other text is custom. */
const batchAnswersOf =
  (answer: (request: AskRequested) => Effect.Effect<string>): AskBatchAnswerer =>
  (request) =>
    Effect.forEach(
      request.questions,
      (question) =>
        answer({
          id: question.id,
          question: question.question,
          options: question.options.map((option) => option.label),
        }).pipe(Effect.map((text) => answerOf(question, text))),
      { concurrency: 1 },
    )

/** A UI answers approvals and questions through its host; a caller through its own hook. */
const answerersOf = (
  ui: UiHost | undefined,
  options: CommandOptions,
): Pick<ProfileWiring, 'answer' | 'answerBatch' | 'approve'> => ({
  answer: ui === undefined ? options.answer : ui.answerAsk,
  answerBatch:
    ui === undefined
      ? options.answer === undefined
        ? undefined
        : batchAnswersOf(options.answer)
      : ui.serveQuestions,
  approve: ui === undefined ? options.approve : ui.answerApproval,
})

/** Everything one running session owns: its agent, its UI face, and the wiring a second one repeats. */
interface SessionRuntime {
  readonly agent: Agent
  readonly ui: UiHost | undefined
  /** What this run can offer the session; a composition change is chosen from it. */
  readonly tools: ToolRegistry
  readonly commands: CommandsShape
  /** The store this session lives in: a UI that lists sessions reads the same one. */
  readonly listSessions: () => Effect.Effect<ReadonlyArray<SessionSummary>, SessionError>
  /** The background commands of this session; a UI lists them. */
  readonly jobs: JobsShape
  /** The agent registry this session was built in; its children run here too. */
  readonly agents: AgentsShape
  /** The deepest delegation level the run allows now; a setting change reaches the next read. */
  readonly subagentDepth: () => number
  readonly rows: ReadonlyArray<PluginRow>
  readonly route: string
  readonly effort: string
  /** The effort words the provider takes, as a page offers them; empty declares none. */
  readonly efforts: ReadonlyArray<string>
  /** The skills the catalog lists now, as the composer offers them beside commands. */
  readonly skillCatalog: () => ReadonlyArray<SkillSummary>
  readonly spillTokens: number | undefined
  /** The budget the loop compacts with, so a page reads the same line it fires on. */
  readonly budget: TokenBudget
  /** The live permission holder this session's tools and page read; absent without a safety row. */
  readonly permission?: PermissionShape
  readonly layer: Layer.Layer<any, PluginError, never>
}

/** A session that was built, or one whose recorded composition refuses this run. */
type BuiltSession =
  | { readonly kind: 'ready'; readonly runtime: SessionRuntime }
  | { readonly kind: 'refused'; readonly message: string }

/**
 * What the human can type at one session, as a page's composer offers it: the
 * registry's commands first, then the skills a human may invoke. A name both
 * sides hold stays a command, because that is the one the slash actually runs.
 */
export const commandViewsOf = (
  commands: CommandsShape,
  skills: ReadonlyArray<SkillSummary> = [],
): ReadonlyArray<CommandView> => {
  const registered = commands.list()
  const named = new Set(registered.map((command) => command.name))
  return [
    ...registered.map((command) => ({
      name: command.name,
      summary: command.summary,
      kind: 'command' as const,
    })),
    ...userSkills(skills)
      .filter((skill) => !named.has(skill.name))
      .map((skill) => ({
        name: skill.name,
        summary: skill.description,
        kind: 'skill' as const,
      })),
  ]
}

/** Whether a session still owns running work: a turn, a job, or a child agent. */
const busyOf = (agent: Agent, jobs: JobsShape, children: ReadonlyArray<Agent>): boolean =>
  agent.status === 'running' ||
  agent.status === 'cancelling' ||
  jobs.list().some((job) => job.running) ||
  children.some((child) => child.status === 'running' || child.status === 'cancelling')

/** What the session can say about itself right now: its goal, its schedules, its background work. */
const runStateOf = (
  agent: Agent,
  jobs: JobsShape,
  /** The effort words the provider takes, which a page offers as the choices. */
  efforts: ReadonlyArray<string>,
  /** The children this session started, with where each sits in the delegation tree. */
  subagents: RunStateView['subagents'],
  /** The line the loop compacts on; the page reports the same estimate. */
  budget: TokenBudget,
  /** The host's schedules, which outlive this session's process. */
  schedules: ScheduleStore,
  /** The boundary this session's next tool call runs under; absent without a safety row. */
  permission: PermissionShape | undefined,
): RunStateView => {
  const events = agent.session.events()
  const goal = currentGoal(events)
  const context = runContextOf(events)
  return {
    // A page may switch the model or the effort while the session runs, so this
    // is what the agent holds now rather than what the run resolved when it started.
    model: agent.options.route,
    effort: agent.options.reasoningEffort ?? '',
    efforts,
    ...(permission === undefined ? {} : { permission: permissionWordOf(permission.current()) }),
    usage: usageViewOf(events, budget),
    todos: context.todos,
    todoCounts: context.todoCounts,
    skills: context.skills,
    promptSections: context.promptSections,
    queued: projectInbox(events)
      .nextTurn.filter((message) => message.source === 'user')
      .map((message) => message.text),
    steering: projectInbox(events)
      .nextStep.filter((message) => message.source === 'user')
      .map((message) => message.text),
    jobs: jobsOf(jobs),
    subagents,
    goal:
      goal === undefined
        ? null
        : {
            objective: goal.objective,
            phase: goal.phase,
            rounds: goalRounds(events),
            maxRounds: goal.maxGoalRounds,
          },
    schedules: schedulesOf(agent, schedules).map((schedule) => ({
      id: schedule.id,
      when: ruleText(schedule.rule),
      title: scheduleTitle(schedule),
      prompt: schedule.prompt,
      lastFiredAt: schedule.lastFiredAt ?? 0,
      paused: schedule.paused === true,
    })),
  }
}

const summaryOf = (agent: Agent): SessionSummary => {
  const events = agent.session.events()
  return {
    id: agent.session.id,
    cwd: agent.session.header.cwd,
    createdAt: agent.session.header.createdAt,
    updatedAt: events[events.length - 1]?.time ?? agent.session.header.createdAt,
    title: titleOf(events),
  }
}

/** The provider half of a route; a route without a slash is the provider itself. */
const providerOfRoute = (route: string): string => {
  const index = route.indexOf('/')
  return index < 0 ? route : route.slice(0, index)
}

/**
 * The one model round trip the auto preset makes per reviewed call. It takes the
 * session's route and no tools, so the answer is a line of text and not another
 * call to decide about.
 */
const autoReviewCompletion = (llm: LlmAdapter, route: () => string): AutoReviewCompletion => {
  return (prompt) =>
    llm
      .stream({
        provider: providerOfRoute(route()),
        model: modelOfRoute(route()),
        params: {},
        tools: [],
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      })
      .pipe(
        Stream.runFold(
          () => '',
          (text: string, chunk: StreamChunk) =>
            chunk.type === 'text-delta' ? text + chunk.text : text,
        ),
      )
}

/**
 * Installs the review the auto preset promises. A profile without the safety row
 * has no preset to read, and every other preset leaves the tool pipeline alone:
 * their sandbox is their whole policy, exactly as before.
 */
const installAutoReview = (
  wiring: ProfileWiring,
  tools: ToolRegistry,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    if (!hasEnabledRow(wiring.rows, '@jozo-harness/safety')) return
    const policy = Context.get(wiring.context, Policy)
    if (policy.preset !== 'auto') return
    const review = Context.get(wiring.context, AutoReview)
    const agents = Context.get(wiring.context, Agents)
    yield* review.serve(
      modelAutoReview(
        autoReviewCompletion(Context.get(wiring.context, Llm), () => wiring.agent.options.route),
      ),
    )
    yield* tools.guard(
      autoReviewGuard({
        // Read per call: a session that switches away from auto stops reviewing.
        preset: () => policy.preset,
        review,
        isReadOnly: (tool) => tools.isReadOnly(tool),
        // A denied call lands in the log of the session that made it, which for a
        // delegated call is the child's, not the parent's.
        record: (reviewed) =>
          (agents.get(reviewed.sessionId)?.session ?? wiring.agent.session)
            .append('safety/auto/reviewed', reviewed)
            .pipe(Effect.ignore),
      }),
    )
  })

/** Streams the run's text only when no UI owns the screen. */
const installRunOutput = (wantsUi: boolean, hooks: HookRegistry, options: CommandOptions) =>
  wantsUi ? Effect.void : installOutput(hooks, options)

/**
 * MCP servers are opt-in. The services are read only after the row check,
 * because a profile without the row has no MCP services in its context.
 */
const installMcpIfEnabled = <A, E, R>(
  rows: ReadonlyArray<PluginRow>,
  install: () => Effect.Effect<A, E, R>,
): Effect.Effect<A | void, E, R> =>
  hasEnabledRow(rows, '@jozo-harness/mcp') ? install() : Effect.void

/** Who answers an escalation: the UI, the caller's hook, or a refusal that records itself. */
const answererFor = (ui: UiHost | undefined, options: CommandOptions): ApprovalAnswerer =>
  answerersOf(ui, options).approve ?? refuseApproval

/**
 * A run that is its own host fires what came due while it was away; the web
 * server owns one clock for every session, so its runs leave this off.
 */
const installHostClock = (
  options: CommandOptions,
  rows: ReadonlyArray<PluginRow>,
  agent: Agent,
  hostClock: boolean,
) => {
  if (!hostClock || !hasEnabledRow(rows, '@jozo-harness/tools-tier1')) return Effect.void
  const store = scheduleStoreOf(options)
  return installHostScheduleRuns({
    store,
    deliver: (schedule) =>
      schedule.sessionId === agent.session.id
        ? fireSchedule(agent, schedule, () => store.now()).pipe(Effect.as(true))
        : Effect.succeed(false),
    now: () => store.now(),
  })
}

/** The holder a session's tools read, seeded from its log; absent without a safety row. */
const permissionFor = (
  context: Context.Context<any>,
  rows: ReadonlyArray<PluginRow>,
  session: Session,
): PermissionShape | undefined => {
  if (!hasEnabledRow(rows, '@jozo-harness/safety')) return undefined
  const permission = Context.get(context, Permission)
  permission.apply(resumedPermission(session.events(), permission.current()))
  return permission
}

/** The option key a caller adds only when the session has a safety row. */
const permissionOption = (
  permission: PermissionShape | undefined,
): { readonly permission?: PermissionShape } => (permission === undefined ? {} : { permission })

/** The scoped body that builds one session: its layer, agent, tools, and UI host. */
const buildSession = (
  options: CommandOptions,
  rows: ReadonlyArray<PluginRow>,
  route: string,
  effort: string,
  spillTokens: number | undefined,
  layer: Layer.Layer<any, PluginError, never>,
  wantsUi: boolean,
  resume: SessionId | undefined,
  /** Where a new session starts; a resumed one keeps the workspace its header has. */
  cwd: string,
  /** Whether this session owns the clock. A web server runs one for every session. */
  hostClock: boolean,
  /** The run's failed wirings, when a page can report and retry them. */
  plugins?: PluginWiringState,
  /** The page this session serves, when a browser UI opened it. */
  gui?: GuiEndpoint,
  /** The live limits; absent seeds them from the rows, as a one-shot run does. */
  live?: LiveRunSettings,
  /** Events a new session starts from, e.g. a fork of another log. */
  seed?: ReadonlyArray<SessionEvent>,
  /** The tools a new session starts with; absent offers every tool the rows register. */
  defaultTools?: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const liveSettings = live ?? liveSettingsOf(options, rows)
    const context = yield* Layer.build(Layer.mergeAll(layer, approvalServiceLayer, askServiceLayer))
    const hooks = Context.get(context, Hooks)
    // A UI owns the screen; only the non-interactive paths stream text out.
    yield* installRunOutput(wantsUi, hooks, options)
    yield* installMcpIfEnabled(rows, () =>
      installMcpServers(Context.get(context, Tools), Context.get(context, McpServers)),
    )

    const agents = Context.get(context, Agents)
    const agent = yield* createAgent(
      agents,
      options,
      route,
      spillTokens,
      effort,
      resume,
      cwd,
      attachmentRootOf(sessionRootOf(rows)),
      seed,
    )
    // The last explicit choice in the log outranks the profile: a resumed session
    // continues at the boundary the human last picked, without asking again.
    const permission = permissionFor(context, rows, agent.session)
    // The workspace belongs to the session, not to the run that serves it: tools,
    // instructions, and skill roots all read the cwd the session header recorded.
    const sessionOptions: CommandOptions = { ...options, cwd: agent.session.header.cwd }

    // Workspace instructions join the prompt before the first turn.
    const prompt = Context.get(context, SystemPrompt)
    const instructions = yield* registerAgentsMd(
      prompt,
      sessionOptions.cwd,
      agentsOptionsOf(options),
    )
    // The page's URL is a user context, so the system prompt keeps the same bytes
    // whatever address the server bound. A session without a page adds nothing.
    yield* installGuiContext(prompt, gui)
    // What the provider takes for an effort is the adapter's to say; a page only offers it.
    const efforts = Context.get(context, Llm).capabilities.reasoningEffort ?? []
    // The loop measured the request against this budget; reading the same values
    // here lets /status and the page report the line compaction would fire on.
    const loopRow = rows.find((row) => row.name === '@jozo-harness/agent-loop')
    const loopConfig = Schema.decodeUnknownSync(agentLoopConfigSchema)(loopRow?.config ?? {})
    const budget = tokenBudgetOf(
      loopConfig,
      Context.get(context, Llm).capabilities,
      modelOfRoute(agent.options.route),
    )
    // What a human can type at this session is not the model's business; both the
    // REPL and a UI run it through the same registry and the log keeps the record.
    const commands = makeCommands()
    // A human-asked fold asks the loop's own summary call, over the route the next
    // step would take, so the checkpoint it records names the model it was made with.
    const { checkpointFor } = checkpointHelpersFor(Context.get(context, Llm))
    yield* installBuiltinCommands(commands, {
      ...permissionOption(permission),
      budget,
      compactNow: () =>
        checkpointFor(
          {
            provider: providerOfRoute(agent.options.route),
            model: modelOfRoute(agent.options.route),
            params: {
              ...(agent.options.reasoningEffort === undefined
                ? {}
                : { reasoning_effort: agent.options.reasoningEffort }),
              ...(budget.reserveTokens === 0 ? {} : { max_tokens: budget.reserveTokens }),
            },
            // The summary call takes no tools; only the route and params reach it.
            tools: [],
          },
          agent.session.events(),
          { retainTokens: 0, maxBytes: DEFAULT_COMPACT_MAX_BYTES },
        ),
      isBusy: () => agent.status === 'running' || agent.status === 'cancelling',
    })
    // The catalog is read once for the page's completion list and again by the tool
    // and the host, who read the roots themselves so a changed file is never stale.
    const skills = skillsOf(sessionOptions)
    // What the composer lists follows the discovery the model reads: every step
    // refreshes it, so a skill added while the session runs reaches both.
    let skillCatalog = yield* discoverSkills(skills)
    // The managed registry is one environment for every child of this session: bash,
    // background jobs, and run_code all inherit it with the managed values applied last.
    const environment = childEnvironment(managedEnvOf(rows))
    logManagedEnv(environment)
    // The background commands of this session: the tier 1 tools start them, a UI lists
    // them, and their starts and ends stay in the log for a resumed run to read.
    const jobs = yield* makeJobs({ record: jobRecorderOf(agent.session), env: environment })
    const ui = wantsUi
      ? yield* makeUiHost({ session: agent.session, agent, hooks, commands, skills })
      : undefined

    // An escalation asks whoever answers for this run: a UI, a caller's hook, or
    // nobody — and nobody leaves the call denied, recorded as such.
    yield* Context.get(context, Approval).serve(
      recordingAnswerer(agent.session, answererFor(ui, options)),
    )

    yield* installNestedAgentsMd({
      hooks,
      agent,
      root: sessionOptions.cwd,
      loaded: loadedAgentsOf(instructions),
    })

    // A catalog this agent has not read yet opens its turn, before the input it claimed.
    yield* hooks.on('agent/pre-step', (input, next) =>
      Effect.gen(function* () {
        const decision = yield* next()
        if (decision?.kind === 'reject') return decision
        const catalog = yield* skillCatalogOf(input.agent, skills)
        skillCatalog = catalog.skills
        if (catalog.text === undefined) return decision
        return {
          kind: 'enter' as const,
          messages: [
            ...(decision?.messages ?? []),
            { text: catalog.text, source: 'skill-catalog' as const },
          ],
        }
      }),
    )

    const composition = yield* installFromProfile({
      rows,
      options: sessionOptions,
      route,
      agent,
      hooks,
      skills,
      ...answerersOf(ui, options),
      context,
      jobs,
      live: liveSettings,
      ...wiringOf(plugins),
    })

    yield* seedDefaultComposition(
      agent,
      composition,
      resume,
      defaultTools ?? options.settings?.tools,
    )
    // A session keeps the composition it was started with: the tools behind its
    // history are not something a later run may swap out without being told to.
    const problem = yield* applyPreset(agent, composition, options.allowPresetChange === true)
    if (problem !== undefined) return { kind: 'refused', message: problem } satisfies BuiltSession
    yield* installHostClock(options, rows, agent, hostClock)
    return {
      kind: 'ready',
      runtime: {
        agent,
        ui,
        tools: Context.get(context, Tools),
        commands,
        listSessions: () => Context.get(context, Sessions).list(),
        jobs,
        agents,
        subagentDepth: () => liveSettings.subagentDepth,
        rows,
        route,
        effort,
        efforts,
        skillCatalog: () => skillCatalog,
        spillTokens,
        budget,
        ...permissionOption(permission),
        layer,
      },
    } satisfies BuiltSession
  })

/**
 * Serves the browser UI. A page asks for its sessions one by one, so a plain run
 * opens none up front; `--resume` named one, and that is what the page starts on.
 */
const serveWebWork = (
  options: CommandOptions,
  rows: ReadonlyArray<PluginRow>,
  route: string,
  effort: string,
  spillTokens: number | undefined,
  layer: Layer.Layer<any, PluginError, never>,
  work: Extract<Work, { kind: 'web' }>,
) =>
  Effect.gen(function* () {
    // The page reports a row that failed to wire and asks for the same wiring
    // again; every session this run opens records into this one list.
    const wiring = makePluginWiringState()
    const gui: GuiEndpoint = { url: undefined }
    const resumed =
      options.resume === undefined
        ? undefined
        : yield* Effect.gen(function* () {
            // The boot session must be releasable while the server keeps running,
            // so its resources live in a scope the registry can close.
            const scope = yield* Scope.make()
            const built = yield* buildSession(
              options,
              rows,
              route,
              effort,
              spillTokens,
              layer,
              true,
              options.resume,
              options.cwd,
              false,
              wiring,
              gui,
            ).pipe(
              Effect.provideService(Scope.Scope, scope),
              // A build that fails or is interrupted must not leave its scope open.
              Effect.onExit((exit) =>
                Exit.isFailure(exit) ? Scope.close(scope, Exit.void) : Effect.void,
              ),
            )
            if (built.kind === 'refused') yield* Scope.close(scope, Exit.void)
            return { built, scope }
          })
    if (resumed !== undefined && resumed.built.kind === 'refused') {
      options.stderr('jzh: ' + resumed.built.message + '\n')
      return 1
    }
    let initial: InitialSession | undefined
    if (resumed !== undefined && resumed.built.kind === 'ready') {
      const session = openSessionOf(resumed.built.runtime, scheduleStoreOf(options))
      if (session !== undefined) {
        const scope = resumed.scope
        initial = { session, close: () => Scope.close(scope, Exit.void) }
      }
    }
    return yield* serveWebUi(
      options,
      rows,
      route,
      effort,
      spillTokens,
      layer,
      work,
      initial,
      wiring,
      gui,
    )
  })

/**
 * Serves ACP over stdio. An editor names a cwd and gets a session built the way
 * the browser UI builds one, so the turn writes the same JSONL and shows up in
 * `jzh sessions` without a second store.
 */
const serveAcpWork = (
  options: CommandOptions,
  rows: ReadonlyArray<PluginRow>,
  route: string,
  effort: string,
  spillTokens: number | undefined,
  layer: Layer.Layer<any, PluginError, never>,
): Effect.Effect<number, PluginError, Scope.Scope> =>
  Effect.gen(function* () {
    const source: AcpSessionSource = {
      open: (cwd) =>
        Effect.gen(function* () {
          const scope = yield* Scope.make()
          // The session lives until the server stops; its own scope is what
          // closes the core, its jobs, and its child agents.
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
          const built = yield* buildSession(
            options,
            rows,
            route,
            effort,
            spillTokens,
            layer,
            true,
            undefined,
            cwd,
            false,
          ).pipe(Effect.provideService(Scope.Scope, scope))
          if (built.kind === 'refused') {
            return yield* Effect.fail(new Error(built.message))
          }
          const { agent, ui } = built.runtime
          if (ui === undefined) {
            return yield* Effect.fail(new Error('the ACP session was built without a UI host'))
          }
          return { id: agent.id, host: ui }
        }),
    }
    yield* serveAcp({
      // The editor owns the process; stdin is the protocol, never a task.
      input: process.stdin,
      write: (line) => options.stdout(line + '\n'),
      sessions: acpSessionPortOf(source),
    })
    return 0
  })

/** The scoped body that owns the built layer and serves one run. */
const runSession = (
  options: CommandOptions,
  rows: ReadonlyArray<PluginRow>,
  route: string,
  effort: string,
  spillTokens: number | undefined,
  layer: Layer.Layer<any, PluginError, never>,
  work: Work,
) =>
  Effect.gen(function* () {
    // One host store per run: every session this process opens writes the same
    // file, so a schedule a page creates is the one the model lists.
    const store =
      options.schedules ?? makeScheduleStore(options.schedulesPath ?? configPaths().schedules)
    const runOptions: CommandOptions = { ...options, schedules: store }
    if (work.kind === 'web') {
      return yield* serveWebWork(runOptions, rows, route, effort, spillTokens, layer, work)
    }
    if (work.kind === 'acp') {
      return yield* serveAcpWork(runOptions, rows, route, effort, spillTokens, layer)
    }
    const built = yield* buildSession(
      runOptions,
      rows,
      route,
      effort,
      spillTokens,
      layer,
      ownsTheScreen(work),
      options.resume,
      options.cwd,
      true,
    )
    if (built.kind === 'refused') {
      options.stderr('jzh: ' + built.message + '\n')
      return 1
    }
    const served = serveUi(options, built.runtime, work)
    if (served !== undefined) return yield* served
    return yield* serveAgent(built.runtime.agent, options, work, built.runtime.commands)
  })

/** What `--dump-config` says about the key: the variable, and the store that filled it. */
const dumpCredential = (
  rows: ReadonlyArray<PluginRow>,
  options: CommandOptions,
  reference: CredentialRefResult,
) => {
  const endpoint = modelEndpointOf(rows)
  if (endpoint === undefined || options.surface === undefined) return undefined
  return {
    name: endpoint.apiKeyEnv,
    source:
      reference.kind === 'filled'
        ? 'credentials'
        : credentialSource({
            name: endpoint.apiKeyEnv,
            environment: process.env,
            ...options.surface.filled,
          }),
    ...(reference.kind === 'none'
      ? {}
      : { ref: reference.credential.ref, store: reference.credential.store }),
  }
}

const dumpText = (
  options: CommandOptions,
  rows: ReadonlyArray<PluginRow>,
  route: string,
  effort: string,
  reference: CredentialRefResult,
): string =>
  renderModelInEffect(route, effort) +
  renderConfig(rows) +
  renderPluginKeys(options.plugins) +
  renderSurface(options.settingsPath, options.settings) +
  renderEffective(options.surface, dumpCredential(rows, options, reference))

/**
 * Runs one `jzh` command over a profile: build the layer, start the agent,
 * wait for the turn, and return the process exit code (0 completed, 1 error).
 */
export function runCommand(options: CommandOptions): Effect.Effect<number> {
  return Effect.gen(function* () {
    const rows = yield* profileRows(options)
    // The environment chain ran first; the reference fills only what it left
    // empty. A reference the store does not hold stops a run and names itself,
    // never a value.
    const reference = resolveCredentialRef(
      modelEndpointOf(rows),
      process.env,
      options.credentialsPath ?? configPaths().credentials,
    )
    if (reference.kind === 'missing' && options.dumpConfig !== true) {
      options.stderr('jzh: ' + reference.reason + '\n')
      return 1
    }
    const route = options.route !== '' ? options.route : routeFromRows(rows)
    const effort = effortInEffect(options, rows)

    if (options.dumpConfig === true) {
      options.stdout(dumpText(options, rows, route, effort, reference))
      return 0
    }

    warnUnappliableSeatbelt(rows, options)

    const work = workOf(options)
    if (work === undefined) {
      options.stderr('nothing to do: pass a task or run on a terminal')
      return 2
    }

    if (route === '') {
      options.stderr(`jzh: ${NO_MODEL}\n`)
      return 1
    }
    const layer = yield* loadProfile({ plugins: options.plugins, layers: [rows] })
    const spillTokens = spillTokensOf(rows)
    return yield* Effect.scoped(runSession(options, rows, route, effort, spillTokens, layer, work))
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.sync(() => {
        options.stderr(`jzh: ${Cause.pretty(cause)}\n`)
        return exitCodeOf(cause)
      }),
    ),
  )
}
export * from './search-env.ts'
export * from './surface.ts'
export * from './env-file.ts'
export * from './config.ts'
export * from './atomic-write.ts'
export * from './secrets-file.ts'
export * from './auth.ts'
export * from './auth-cli.ts'
export * from './providers.ts'
export * from './config-file.ts'
export * from './run-settings.ts'

export * from './acp.ts'
