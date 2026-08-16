/**
 * @deepseek-ai/dsh-runner — the laptop runner. The bundle patch rides over
 * dsh-base (every local tool/skill/MCP capability comes from the repo's base
 * layer, so a DSH update reaches the runner unchanged) and swaps the ONE
 * capability that must be remote: the LLM adapter. This plugin logs in to the
 * server, opens the runner channel, mounts `dsh-llm-remote` under the server's
 * `deepseek-official` route, then drives one task through the local agent loop
 * — or connects and idles when no task is given.
 *
 * The model calls the loop makes are proxied to the server (which holds the
 * central API key); bash/fs/skill/MCP run on THIS laptop's files. That is the
 * "brain on server, hands on laptop" split.
 * @module @deepseek-ai/dsh-runner
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { createUserMessage, type LlmModelInfo } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-cmdline'
import { RUNNER_STARTUP_SERVICE, type RunnerStartupValues } from './startup.ts'
import { connectRunner } from './connect.ts'
import { mountSkillSync } from './skill-sync.ts'
import { mountMcpSync } from './mcp-sync.ts'
import { serveRemoteCall } from './remote-calls.ts'

/** Stable Cordis plugin name. */
export const name = 'runner-driver'

/**
 * Core services required before the runner can connect and run.
 *
 * `fs` and `subprocess` are served to the server: when the hub routes a
 * remote session's tool calls back here, `serveRemoteCall` drives the
 * laptop's OWN local providers through `ctx.fs`/`ctx.subprocess`, so both
 * must be injected — otherwise accessing `ctx.fs`/`ctx.subprocess` from
 * the idle-connect path throws "cannot get property without inject".
 */
export const inject = ['agentDefaultModel', 'agents', 'sessions', 'fs', 'subprocess', RUNNER_STARTUP_SERVICE]

/** Re-export the connect driver for tests and embedding. */
export { connectRunner } from './connect.ts'
export { RunnerTransport } from './transport.ts'

/** Outcome of one owned run interval. */
interface RunOutcome {
  text: string
  reason: SessionEvent<'turn/end'>['data']['reason'] | undefined
}

/**
 * The non-nullable core services `runOneTask` needs. The `run` driver narrows
 * the `ctx.get(...)` values to defined before calling, so the extracted helper
 * is pure (no stdout/exit — the caller owns process effects).
 */
interface RunDeps {
  readonly agents: NonNullable<Context['agents']>
  readonly defaultModel: NonNullable<Context['agentDefaultModel']>
  readonly sessions: NonNullable<Context['sessions']>
  /** The working directory the agent runs in. */
  readonly workspace: string
}

/**
 * Run one task through a freshly created Agent and return its outcome. Factored
 * out of `run` so both the CLI one-shot and a server-dispatched (idle) task
 * share one path: create an agent, drive the user message to idle, flush, and
 * summarize. Pure: writes nothing to stdout and never requests process exit —
 * the caller decides what to do with the {@link RunOutcome}.
 * @param deps - the narrowed core services + the workspace cwd.
 * @param task - the task text to run.
 * @returns the assistant text and turn-end reason for this interval.
 */
async function runOneTask(deps: RunDeps, task: string): Promise<RunOutcome> {
  const selection = deps.defaultModel.currentSelection()
  const { agent } = await deps.agents.create({
    sessionId: SessionId(`session-${randomUUID()}`),
    meta: { cwd: deps.workspace },
    agentOptions: { provider: selection.provider, model: selection.model },
    setup: (agentCtx) => {
      const selected: ModelSelectionRef = { current: selection, assembled: undefined }
      installModelSelection(agentCtx, selected)
    },
  })
  await agent.whenIdle()
  const firstSeq = agent.session.seq
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: task }],
    source: { kind: 'user' },
  }))
  await agent.whenIdle()
  await deps.sessions.flush(agent.session)
  return summarize(agent.session.events, firstSeq)
}

/** Process-facing effects of one run: output streams plus the launcher's bounded exit request. */
interface RunnerIo {
  stdout: { write(chunk: string): unknown }
  stderr: { write(chunk: string): unknown }
  /** Request process exit with `code` after the tree disposes. */
  exit(code: number): void
}

/** The process streams the runner writes to; tests substitute captures. */
export const internals: { stdout: RunnerIo['stdout']; stderr: RunnerIo['stderr'] } = {
  stdout: process.stdout,
  stderr: process.stderr,
}

/** Aggregate the last assistant text and turn outcome in one owned interval. */
function summarize(events: readonly SessionEvent[], firstSeq: number): RunOutcome {
  let started = false
  let text = ''
  let reason: SessionEvent<'turn/end'>['data']['reason'] | undefined
  for (const event of events) {
    if (event.seq < firstSeq) continue
    if (event.type === 'turn/start') {
      started = true
      continue
    }
    if (!started) continue
    if (event.type === 'assistant/message') {
      const joined = event.data.message.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('')
      if (joined !== '') text = joined
    }
    if (event.type === 'turn/end') reason = event.data.reason
  }
  return { text, reason }
}

/** Report an unexpected runner failure and request a failing exit. */
function fail(io: RunnerIo, error: unknown): void {
  io.stderr.write(`dsh-runner: ${error instanceof Error ? error.message : String(error)}\n`)
  io.exit(1)
}

/**
 * Run one task through a freshly created Agent and request process exit. With
 * no task, the runner connects and idles: it stays alive on the open channel
 * and runs server-dispatched tasks (`task.run`) through the local agent loop,
 * resolving each with its result text for the web UI's poll.
 * @param ctx - plugin context carrying the Agent, default model, Session, and launcher IO services.
 * @param values - the resolved connect values.
 * @param task - one-shot task text (empty = connect and idle).
 * @param io - process-facing effects.
 */
async function run(ctx: Context, values: RunnerStartupValues, task: string, io: RunnerIo): Promise<void> {
  // Connect (login + channel + remote LLM swap) BEFORE awaiting the loader, so
  // the remote adapter is registered before sibling tool rows finish composing.
  const { transport, catalog } = await connectRunner(ctx, values)

  // Loader siblings mount concurrently. Await the complete application before
  // mounting synced skills/MCP or creating an Agent, so `ctx.skills` and
  // `ctx.tools` exist and the agent's scoped tools are not half-composed.
  await ctx.get('loader')?.await()
  const agents = ctx.get('agents')
  const defaultModel = ctx.get('agentDefaultModel')
  const sessions = ctx.get('sessions')
  // Early process shutdown can dispose the tree while settlement is pending.
  if (agents === undefined || defaultModel === undefined || sessions === undefined) return

  // Mount the server-synced skill catalog and MCP inventory. Both fetch their
  // first snapshot from the hub now; `transport.onSyncInvalidate` re-fetches
  // when the server pushes `sync.invalidate`. MCP servers spawn LOCALLY, so
  // their tools run on this laptop's files. Skills rank below a workspace's own
  // overrides, so local project skills always win.
  const skillSync = mountSkillSync(ctx, transport)
  const mcpSync = mountMcpSync(ctx, transport)
  transport.onSyncInvalidate = (kind) => {
    if (kind === 'skill') void skillSync.refresh()
    else void mcpSync.refresh()
  }
  // Re-fetch the server's model catalog for the remote adapter. Used both for a
  // hub-pushed `catalog.invalidate` (the server's topology changed) and after a
  // reconnect (the laptop was offline; the catalog may have changed while it was
  // away). Swapping `catalog.models` in place lets the remote adapter advertise
  // the live server catalog without re-registering its route.
  const refreshCatalog = (): void => {
    void transport.listModelsForProvider('deepseek-official').then(
      (models) => {
        catalog.models = models as readonly LlmModelInfo[]
        ctx.logger.info(`dsh-runner: catalog refreshed (${(models as readonly unknown[]).length} models)`)
      },
      (error: unknown) => {
        ctx.logger.warn(`dsh-runner: catalog refresh failed: ${error instanceof Error ? error.message : String(error)}`)
      },
    )
  }
  transport.onCatalogInvalidate = refreshCatalog
  // A lost socket is auto-reconnected by the transport with backoff. When a new
  // generation comes back up, the laptop may have been offline across a server
  // catalog/skill/MCP change, so re-fetch all three. The transport fires
  // `onReconnect` only for generations after the first connect.
  transport.onReconnect = () => {
    ctx.logger.info('dsh-runner: channel reconnected — re-syncing catalog and skills/MCP')
    refreshCatalog()
    void skillSync.refresh()
    void mcpSync.refresh()
  }
  await skillSync.refresh()
  await mcpSync.refresh()

  if (task.trim() === '') {
    // Connect-and-idle: keep the channel open and serve the laptop's
    // capability providers to the server. A server-composed remote session
    // (brain on server) proxies its subprocess/fs/shell tool calls over the
    // channel to THIS laptop's local providers (hands on laptop). The
    // launcher's shutdown owns teardown; the process stays alive via the open
    // channel.
    transport.onRemoteCall = frame => serveRemoteCall(ctx, out => transport.send(out), frame)
    io.stdout.write(`dsh-runner: connected as ${values.user} (device ${values.device}); workspace ${values.workspace}\n`)
    io.stdout.write('dsh-runner: connected and idle, serving tool calls to the server. Press Ctrl+C to disconnect.\n')
    return
  }

  const outcome = await runOneTask({ agents, defaultModel, sessions, workspace: values.workspace }, task)
  io.stdout.write(outcome.text + '\n')
  if (outcome.reason?.kind === 'error') {
    io.stderr.write(`dsh-runner: ${outcome.reason.error.code}: ${outcome.reason.error.message}\n`)
  }
  io.exit(outcome.reason?.kind === 'completed' ? 0 : 1)
}

/**
 * Mount the runner driver: read the startup values, connect, and run.
 * @param ctx - plugin context carrying core services and the launcher-provided exit request.
 */
export function apply(ctx: Context): void {
  const exit = ctx.get('appExit')
  if (exit === undefined) {
    throw new Error('dsh-runner: the launcher must provide ctx.appExit before the tree mounts')
  }
  const startup = ctx.get(RUNNER_STARTUP_SERVICE)
  if (startup === undefined) {
    throw new Error('dsh-runner: the runner-startup plugin must provide its service before the runner mounts')
  }
  const io: RunnerIo = { stdout: internals.stdout, stderr: internals.stderr, exit }
  void run(ctx, startup, startup.task, io).catch((error: unknown) => { fail(io, error) })
}
