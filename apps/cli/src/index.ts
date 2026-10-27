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
  Sessions,
  cwdOf,
  rootOf,
  lastSkillCatalog,
  titleOf,
  type Session,
  type SessionId,
  type SessionSummary,
} from '@jozo-harness/session'
import { expandHome } from '@jozo-harness/session-jsonl'
import {
  SystemPrompt,
  additionalInstructionsText,
  loadedAgentsOf,
  nestedAgentsFiles,
  registerAgentsMd,
  type AgentsMdOptions,
  type RuntimeContextSubject,
} from '@jozo-harness/system-prompt'
import { ToolError, type ToolExecution } from '@jozo-harness/tools'
import { Tools, type ToolRegistry } from '@jozo-harness/tools'
import {
  currentPreset,
  DEFAULT_COMPACT_MAX_BYTES,
  makeCommands,
  presetChange,
  presetProblem,
  presetResumable,
  usageViewOf,
  type CommandsShape,
  type Preset,
  type SessionError,
  type TokenBudget,
} from '@jozo-harness/session'
import {
  Tier0Tools,
  makeShellSessions,
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
  currentSchedules,
  goalRounds,
  lastFiredAt,
  ruleText,
  scheduleTitle,
} from '@jozo-harness/tools-tier1'
import { runConfig } from './config-command.ts'
import { runContextOf } from './run-state.ts'
import { jobDetailOf, jobRecorderOf, jobsOf, stopJobOf } from './jobs.ts'
import { stopSubagentOf, subagentsOf } from './subagents.ts'
import { sessionRootOf } from './session-list.ts'
import { credentialSource, type SettingsSurface } from './settings.ts'
import { configPaths } from './config.ts'
import { bundledPlugins } from './plugins.ts'
import { makePluginHost } from './plugin-host.ts'
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
  teamIdentityLine,
  teamIdentityOf,
  makeScheduleTool,
  makeWorkflowTool,
  makePluginTool,
  makeTeamTool,
  type PluginHost,
  installScheduleRuns,
  installRepeatReminders,
  startGoalRound,
  discoverSkills,
  renderSkillCatalog,
  skillRoots,
  tier1Tools,
  type RunCodeHost,
  type SkillSummary,
} from '@jozo-harness/tools-tier1'
import {
  Approval,
  Ask,
  Sandbox,
  noneSandbox,
  approvalServiceLayer,
  askServiceLayer,
  currentPlanMode,
  installAsk,
  makePlanMode,
  safetyConfigSchema,
  seatbeltStartupNotice,
  type SafetyConfig,
  type SeatbeltProbeResult,
  recordingAnswerer,
  type ApprovalAnswerer,
  type ApprovalRequested,
  type ApprovalShape,
  type AskRequested,
  type AskShape,
  type PlanModeShape,
  type SandboxShape,
} from '@jozo-harness/safety'
import { isAbsolute, dirname, join, relative } from 'node:path'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { runTui, type TuiIo } from '@jozo-harness/tui'
import { fileURLToPath } from 'node:url'
import { makeUiHost, type UiHost } from '@jozo-harness/ui-host'
import {
  WebError,
  detectTailnet,
  listDirectories,
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
import { Llm } from '@jozo-harness/llm'
import { Cause, Context, Effect, Exit, Layer, Schema, Scope, Stream } from 'effect'
import {
  EFFORT_KEY,
  MODEL_KEY,
  PLAN_MODE_KEY,
  SPILL_BYTES_KEY,
  renderEffective,
  renderModelInEffect,
  renderSurface,
} from './surface.ts'
import type { JozoHarnessConfig } from './config-file.ts'

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
  /** Continue even when this run's composition differs from the one the session recorded. */
  readonly allowPresetChange?: boolean
  /** Lets the model run tasks in child agents. */
  readonly subagents?: boolean
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
const spillBytesOf = (rows: ReadonlyArray<PluginRow>): number | undefined => {
  for (const row of rows) {
    if (isRecord(row.config) && typeof row.config[SPILL_BYTES_KEY] === 'number') {
      return row.config[SPILL_BYTES_KEY]
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
) =>
  Effect.gen(function* () {
    // A named bash session keeps one shell alive across calls; the run's scope is
    // what ends it, so a session cannot outlive the run that opened it.
    const sessions = yield* Effect.acquireRelease(
      Effect.sync(() => makeShellSessions()),
      (held) => Effect.sync(() => held.closeAll()),
    )
    // The registry lets a timed-out bash call keep running as a job instead of dying.
    for (const tool of tier0(approval, jobs, worktree, sessions)) yield* tools.register(tool)
  })

/** Tier 1 tools ask the user; their questions and answers join the log. */
const installTier1 = (
  tools: ToolRegistry,
  holder: AskShape,
  agents: AgentsShape,
  options: CommandOptions,
  agent: Agent,
  route: string,
  answer: CommandOptions['answer'],
  skills: ReadonlyArray<string>,
  /** Present only when the profile asked for plan mode; the tool that leaves it needs it. */
  planMode: PlanModeShape | undefined,
  /** The rows this run was built from, so the plugin tool can list and change them. */
  rows: ReadonlyArray<PluginRow>,
  /** The background commands of this session; the session also reports them to a UI. */
  jobs: JobsShape,
  /** The boundary the run's commands are confined to; run_code's child uses it too. */
  sandbox: SandboxShape | undefined,
) =>
  Effect.gen(function* () {
    // A run with nobody to answer leaves the seam unserved, so a question fails
    // at once instead of waiting forever for an answer that cannot come.
    const ask = installAsk(holder, agent.session)
    if (answer !== undefined) yield* holder.serve((request) => answer(request))
    const pluginHost = makePluginHost({
      rows,
      known: bundledPlugins.map((plugin) => plugin.name),
      settingsPath: options.settingsPath ?? configPaths().config,
      ask,
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
      },
    )) {
      yield* tools.register(tool)
    }
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
) => {
  const list = [...tier1Tools(ask, skills, runCode)]
  list.push(makePluginTool(pluginHost))
  if (options.search !== undefined) list.push(makeWebSearchTool(options.search))
  for (const tool of jobTools(jobs)) list.push(tool)
  list.push(
    makeScheduleTool({
      events: () => agent.session.events(),
      // One id per created schedule, counted from the log so a resume never reuses one.
      nextId: () =>
        'sched-' +
        String(
          agent.session.events().filter((event) => event.type === 'schedule/created').length + 1,
        ),
      now: () => Date.now(),
      write: (each) =>
        (each.kind === 'deleted'
          ? agent.session.append('schedule/deleted', { id: each.id })
          : agent.session.append(
              each.kind === 'created' ? 'schedule/created' : 'schedule/updated',
              { schedule: each.schedule },
            )
        ).pipe(
          Effect.mapError(
            () => new ToolError({ code: 'execution', message: 'cannot record the schedule' }),
          ),
        ),
    }),
  )
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
      makeSubagentTool({ agents, route, outputs, ...(routes === undefined ? {} : { routes }) }),
      makeStructuredOutputTool(outputs),
      ...agentTools(agents),
      makeWorkflowTool({ agents, route }),
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
  spillBytes: number | undefined,
  effort: string,
  resume: SessionId | undefined,
  cwd: string,
) =>
  Effect.gen(function* () {
    const agentOptions: AgentOptions = {
      route,
      // The effort the run resolved: '' leaves the choice to the provider.
      ...(effort === '' ? {} : { reasoningEffort: effort }),
      ...(spillBytes === undefined ? {} : { maxSpillBytes: spillBytes }),
      // Spilled text belongs in the jzh home, under the session that owns it.
      ...(options.jzhHome === undefined ? {} : { spillDir: join(options.jzhHome, 'spill') }),
    }
    // A resumed session opens with the workspace its header recorded; `cwd` only
    // decides where a session that does not exist yet is created.
    return resume === undefined
      ? yield* agents.create({ cwd, options: agentOptions })
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

/** Everything the profile's rows install on one running agent. */
interface ProfileWiring {
  readonly rows: ReadonlyArray<PluginRow>
  readonly options: CommandOptions
  readonly route: string
  readonly agent: Agent
  readonly answer: CommandOptions['answer']
  readonly approve: CommandOptions['approve']
  readonly hooks: HookRegistry
  /** The skill roots of this run, so the tool and the catalog search the same ones. */
  readonly skills: ReadonlyArray<string>
  /** Read only inside a branch: an absent row means the service was never built. */
  readonly context: Context.Context<any>
  /** The background commands this session may start; a UI lists them. */
  readonly jobs: JobsShape
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
              : delegationLine(agents.depthOf(subject.agentId)),
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
            return identity === undefined ? undefined : teamIdentityLine(identity)
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
 * The artifact row is opt-in, and its page belongs beside the sessions root, so it
 * takes that root from the profile rather than one of its own.
 */
/** The lsp tool is opt-in: a run that does not name the row never sees it. */
const installLsp = (tools: ToolRegistry, wiring: ProfileWiring) =>
  Effect.gen(function* () {
    if (!hasEnabledRow(wiring.rows, '@jozo-harness/lsp')) return
    for (const tool of Context.get(wiring.context, LspTools)) yield* tools.register(tool)
  })

const installArtifact = (tools: ToolRegistry, wiring: ProfileWiring) =>
  Effect.gen(function* () {
    if (!hasEnabledRow(wiring.rows, '@jozo-harness/artifact')) return
    const sessionRoot = sessionRootOf(wiring.rows)
    // The page is written by a tool, not a command, so the sandbox never wraps
    // it and the preset has to reach the tool here to keep read-only runs from
    // publishing. Without a safety row there is no preset to obey.
    const sandbox = hasEnabledRow(wiring.rows, '@jozo-harness/safety')
      ? Context.get(wiring.context, Sandbox)
      : noneSandbox
    for (const tool of Context.get(wiring.context, ArtifactTools)(sessionRoot, sandbox)) {
      yield* tools.register(tool)
    }
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
        wiring.skills,
        planMode,
        wiring.rows,
        wiring.jobs,
        sandboxOf(wiring),
      )
      // An agent at the delegation limit reads it in the next runtime snapshot;
      // the tool stays visible and refuses the call, as dsh does.
      yield* installDelegationContext(wiring)
      yield* installTeamIdentityContext(wiring)
    }
    yield* installLsp(tools, wiring)
    yield* installArtifact(tools, wiring)
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
    // An active goal keeps going by itself: at the end of a turn of this agent, the
    // next round is queued before the turn closes, so the run cannot go idle in between.
    if (hasEnabledRow(wiring.rows, '@jozo-harness/tools-tier1')) {
      const agents = Context.get(wiring.context, Agents)
      yield* wiring.hooks.on('agent/turn-stopping', (ending: Agent) =>
        ending === wiring.agent ? startGoalRound(ending, agents) : Effect.void,
      )
      // Standing schedules keep their own clock; one that came due while the
      // session was away fires as soon as this run starts.
      yield* installScheduleRuns(wiring.agent, wiring.hooks)
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
  readonly rows: ReadonlyArray<PluginRow>
  /** The effort words the provider takes, as a page offers them; empty declares none. */
  readonly efforts: ReadonlyArray<string>
}

/** What a page may read and change about this run: the settings file, and the provider's list. */
const settingsPortOf = (
  options: CommandOptions,
  facts: RunFacts,
  choice: RunChoice,
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
})

/** Opens one more session for a UI that outlives its first: the same wiring, a new scope. */
const sessionFactoryOf = (
  options: CommandOptions,
  rows: ReadonlyArray<PluginRow>,
  choice: RunChoice,
  spillBytes: number | undefined,
  layer: Layer.Layer<any, PluginError, never>,
  listSessions: SessionRuntime['listSessions'],
): SessionFactory => ({
  list: () =>
    listSessions().pipe(Effect.mapError((error) => new WebError({ message: messageOf(error) }))),
  open: (id, cwd) =>
    Effect.gen(function* () {
      // The choices are read per open: a page may have picked another model or
      // effort since.
      const built = yield* buildSession(
        options,
        rows,
        choice.route,
        choice.effort,
        spillBytes,
        layer,
        true,
        id,
        // A page that named no workspace gets the one this run was started in.
        cwd ?? options.cwd,
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
        commands: () => commandViewsOf(built.runtime.commands, built.runtime.skillCatalog()),
        runState: () =>
          runStateOf(
            agent,
            built.runtime.jobs,
            built.runtime.efforts,
            built.runtime.agents.childrenOf(agent.id),
            built.runtime.budget,
          ),
        jobOutput: (jobId: string) => jobDetailOf(built.runtime.jobs, jobId),
        stopJob: (jobId: string) => stopJobOf(built.runtime.jobs, jobId),
        stopSubagent: (childId: string) => stopSubagentOf(built.runtime.agents, agent.id, childId),
        busy: () => busyOf(agent, built.runtime.jobs, built.runtime.agents.childrenOf(agent.id)),
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
  /** The effort words the provider takes, which the blank seat offers. */
  readonly efforts: ReadonlyArray<string>
}

/**
 * Reads the parts of the run that exist before a session does: the profile's
 * session store and the adapter's effort words, both from the layer the run serves.
 */
const runReadingOf = (
  layer: Layer.Layer<any, PluginError, never>,
): Effect.Effect<RunReading, PluginError, Scope.Scope> =>
  Effect.gen(function* () {
    const context = yield* Layer.build(layer)
    const sessions = Context.get(context, Sessions)
    // What the provider takes for an effort is the adapter's to say; a page only offers it.
    const efforts = Context.get(context, Llm).capabilities.reasoningEffort ?? []
    return { listSessions: () => sessions.list(), efforts }
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
  spillBytes: number | undefined,
  layer: Layer.Layer<any, PluginError, never>,
  work: Extract<Work, { kind: 'web' }>,
  /** The session the page opens first, when the command named one to resume. */
  initial: InitialSession | undefined,
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
    // The store the rail lists from and the seat's effort words live as long as
    // the server they serve.
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const reading = yield* runReadingOf(layer)
        return yield* serveWeb({
          ...(initial === undefined ? {} : { initial }),
          factory: sessionFactoryOf(options, rows, choice, spillBytes, layer, reading.listSessions),
          settings: settingsPortOf(options, { rows, efforts: reading.efforts }, choice),
          workspaces: workspacesPortOf(options, reading.listSessions),
          commands: () => defaultCommands,
          port: work.port,
          staticRoot,
          ...(work.publicUrl === undefined ? {} : { publicUrl: work.publicUrl }),
          ...(tailnet.ip === undefined ? {} : { tailnet }),
          onReady: (urls) => {
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
const openSessionOf = (runtime: SessionRuntime): OpenSession | undefined => {
  const { agent, ui, jobs, efforts, agents, budget } = runtime
  if (ui === undefined) return undefined
  return {
    summary: summaryOf(agent),
    host: ui,
    commands: () => commandViewsOf(runtime.commands, runtime.skillCatalog()),
    runState: () => runStateOf(agent, jobs, efforts, agents.childrenOf(agent.id), budget),
    jobOutput: (jobId: string) => jobDetailOf(jobs, jobId),
    stopJob: (jobId: string) => stopJobOf(jobs, jobId),
    stopSubagent: (childId: string) => stopSubagentOf(agents, agent.id, childId),
    busy: () => busyOf(agent, jobs, agents.childrenOf(agent.id)),
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

/** A UI answers approvals and questions through its host; a caller through its own hook. */
const answerersOf = (
  ui: UiHost | undefined,
  options: CommandOptions,
): Pick<ProfileWiring, 'answer' | 'approve'> => ({
  answer: ui === undefined ? options.answer : ui.answerAsk,
  approve: ui === undefined ? options.approve : ui.answerApproval,
})

/** Everything one running session owns: its agent, its UI face, and the wiring a second one repeats. */
interface SessionRuntime {
  readonly agent: Agent
  readonly ui: UiHost | undefined
  readonly commands: CommandsShape
  /** The store this session lives in: a UI that lists sessions reads the same one. */
  readonly listSessions: () => Effect.Effect<ReadonlyArray<SessionSummary>, SessionError>
  /** The background commands of this session; a UI lists them. */
  readonly jobs: JobsShape
  /** The agent registry this session was built in; its children run here too. */
  readonly agents: AgentsShape
  readonly rows: ReadonlyArray<PluginRow>
  readonly route: string
  readonly effort: string
  /** The effort words the provider takes, as a page offers them; empty declares none. */
  readonly efforts: ReadonlyArray<string>
  /** The skills the catalog lists now, as the composer offers them beside commands. */
  readonly skillCatalog: () => ReadonlyArray<SkillSummary>
  readonly spillBytes: number | undefined
  /** The budget the loop compacts with, so a page reads the same line it fires on. */
  readonly budget: TokenBudget
  readonly layer: Layer.Layer<any, PluginError, never>
}

/** A session that was built, or one whose recorded composition refuses this run. */
type BuiltSession =
  | { readonly kind: 'ready'; readonly runtime: SessionRuntime }
  | { readonly kind: 'refused'; readonly message: string }

/**
 * What the human can type at one session, as a page's composer offers it: the
 * registry's commands first, then the skills its catalog lists. A name both sides
 * hold stays a command, because that is the one the slash actually runs.
 */
const commandViewsOf = (
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
    ...skills
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
  /** The child agents this session started, as the registry holds them now. */
  children: ReadonlyArray<Agent>,
  /** The line the loop compacts on; the page reports the same estimate. */
  budget: TokenBudget,
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
    subagents: subagentsOf(children),
    goal:
      goal === undefined
        ? null
        : {
            objective: goal.objective,
            phase: goal.phase,
            rounds: goalRounds(events),
            maxRounds: goal.maxGoalRounds,
          },
    schedules: currentSchedules(events).map((schedule) => ({
      id: schedule.id,
      when: ruleText(schedule.rule),
      title: scheduleTitle(schedule),
      prompt: schedule.prompt,
      lastFiredAt: lastFiredAt(events, schedule.id) ?? 0,
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

/** The scoped body that builds one session: its layer, agent, tools, and UI host. */
const buildSession = (
  options: CommandOptions,
  rows: ReadonlyArray<PluginRow>,
  route: string,
  effort: string,
  spillBytes: number | undefined,
  layer: Layer.Layer<any, PluginError, never>,
  wantsUi: boolean,
  resume: SessionId | undefined,
  /** Where a new session starts; a resumed one keeps the workspace its header has. */
  cwd: string,
) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(Layer.mergeAll(layer, approvalServiceLayer, askServiceLayer))
    const hooks = Context.get(context, Hooks)
    // A UI owns the screen; only the non-interactive paths stream text out.
    if (!wantsUi) yield* installOutput(hooks, options)

    if (hasEnabledRow(rows, '@jozo-harness/mcp')) {
      yield* installMcpServers(Context.get(context, Tools), Context.get(context, McpServers))
    }

    const agents = Context.get(context, Agents)
    const agent = yield* createAgent(agents, options, route, spillBytes, effort, resume, cwd)
    // The workspace belongs to the session, not to the run that serves it: tools,
    // instructions, and skill roots all read the cwd the session header recorded.
    const sessionOptions: CommandOptions = { ...options, cwd: agent.session.header.cwd }

    // Workspace instructions join the prompt before the first turn.
    const instructions = yield* registerAgentsMd(
      Context.get(context, SystemPrompt),
      sessionOptions.cwd,
      agentsOptionsOf(options),
    )
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
    // The background commands of this session: the tier 1 tools start them, a UI lists
    // them, and their starts and ends stay in the log for a resumed run to read.
    const jobs = yield* makeJobs({ record: jobRecorderOf(agent.session) })
    const ui = wantsUi
      ? yield* makeUiHost({ session: agent.session, agent, hooks, commands, skills })
      : undefined

    // An escalation asks whoever answers for this run: a UI, a caller's hook, or
    // nobody — and nobody leaves the call denied, recorded as such.
    yield* Context.get(context, Approval).serve(
      recordingAnswerer(agent.session, answerersOf(ui, options).approve ?? refuseApproval),
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
    })

    // A session keeps the composition it was started with: the tools behind its
    // history are not something a later run may swap out without being told to.
    const problem = yield* applyPreset(agent, composition, options.allowPresetChange === true)
    if (problem !== undefined) return { kind: 'refused', message: problem } satisfies BuiltSession
    return {
      kind: 'ready',
      runtime: {
        agent,
        ui,
        commands,
        listSessions: () => Context.get(context, Sessions).list(),
        jobs,
        agents,
        rows,
        route,
        effort,
        efforts,
        skillCatalog: () => skillCatalog,
        spillBytes,
        budget,
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
  spillBytes: number | undefined,
  layer: Layer.Layer<any, PluginError, never>,
  work: Extract<Work, { kind: 'web' }>,
) =>
  Effect.gen(function* () {
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
              spillBytes,
              layer,
              true,
              options.resume,
              options.cwd,
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
      const session = openSessionOf(resumed.built.runtime)
      if (session !== undefined) {
        const scope = resumed.scope
        initial = { session, close: () => Scope.close(scope, Exit.void) }
      }
    }
    return yield* serveWebUi(options, rows, route, effort, spillBytes, layer, work, initial)
  })

/** The scoped body that owns the built layer and serves one run. */
const runSession = (
  options: CommandOptions,
  rows: ReadonlyArray<PluginRow>,
  route: string,
  effort: string,
  spillBytes: number | undefined,
  layer: Layer.Layer<any, PluginError, never>,
  work: Work,
) =>
  Effect.gen(function* () {
    if (work.kind === 'web') {
      return yield* serveWebWork(options, rows, route, effort, spillBytes, layer, work)
    }
    const built = yield* buildSession(
      options,
      rows,
      route,
      effort,
      spillBytes,
      layer,
      ownsTheScreen(work),
      options.resume,
      options.cwd,
    )
    if (built.kind === 'refused') {
      options.stderr('jzh: ' + built.message + '\n')
      return 1
    }
    const served = serveUi(options, built.runtime, work)
    if (served !== undefined) return yield* served
    return yield* serveAgent(built.runtime.agent, options, work, built.runtime.commands)
  })

/**
 * Runs one `jzh` command over a profile: build the layer, start the agent,
 * wait for the turn, and return the process exit code (0 completed, 1 error).
 */
export function runCommand(options: CommandOptions): Effect.Effect<number> {
  return Effect.gen(function* () {
    const rows = yield* profileRows(options)
    const route = options.route !== '' ? options.route : routeFromRows(rows)
    const effort = effortInEffect(options, rows)

    if (options.dumpConfig === true) {
      // The profile's llm row names the variable the key comes from; the surface
      // says which file filled it.
      const endpoint = modelEndpointOf(rows)
      const credential =
        endpoint === undefined || options.surface === undefined
          ? undefined
          : {
              name: endpoint.apiKeyEnv,
              source: credentialSource({
                name: endpoint.apiKeyEnv,
                environment: process.env,
                ...options.surface.filled,
              }),
            }
      const text =
        renderModelInEffect(route, effort) +
        renderConfig(rows) +
        renderPluginKeys(options.plugins) +
        renderSurface(options.settingsPath, options.settings) +
        renderEffective(options.surface, credential)
      options.stdout(text)
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
    const spillBytes = spillBytesOf(rows)
    return yield* Effect.scoped(runSession(options, rows, route, effort, spillBytes, layer, work))
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
