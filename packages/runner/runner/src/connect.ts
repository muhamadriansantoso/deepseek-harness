/**
 * The laptop runner's connect driver: log in to the server, open the runner
 * channel, fetch the server's model catalog, and mount the remote LLM adapter
 * so the agent loop's model calls are proxied to the server.
 *
 * The agent loop itself is NOT owned here — it comes from `dsh-base` and the
 * startup provider's task, exactly like `dsh-headless`. This module only swaps
 * the ONE capability that must be remote (the LLM) and opens the channel every
 * model call flows over. bash/fs/skill/MCP stay on local providers from
 * `dsh-base`, so a repo update to any of them reaches this runner unchanged.
 * @module @deepseek-ai/dsh-runner
 */

import type { Context } from '@deepseek-ai/cordis'
import type { LlmModelInfo } from '@deepseek-ai/dsh-llm'
import { apply as applyRemoteLlm, type RemoteModelCatalog } from '@deepseek-ai/dsh-llm-remote'
import { login } from './login.ts'
import { RunnerTransport } from './transport.ts'

/** The connect values resolved from the startup service. */
export interface RunnerConnectValues {
  /** The dsh server base URL (no trailing slash, https forced). */
  server: string
  /** The login user id. */
  user: string
  /** The login password, or undefined when it must be prompted. */
  password?: string
  /** The local workspace directory to operate in. */
  workspace: string
  /** A stable device id identifying this laptop. */
  device: string
}

/**
 * The outcome of {@link connectRunner}: the live transport and a mutable handle
 * on the server-synced model catalog. The driver refreshes `catalog.models`
 * when the hub pushes `catalog.invalidate`, so the remote adapter advertises the
 * live server catalog without re-registering its route.
 */
export interface RunnerConnectResult {
  /** The live WS transport (dispose to tear the channel down). */
  readonly transport: RunnerTransport
  /** The mutable model catalog the remote adapter reads. */
  readonly catalog: RemoteModelCatalog
}

/**
 * Connect this laptop to the server: log in, open the runner channel, fetch
 * the server's model catalog for the `deepseek-official` route, and register
 * the remote LLM adapter under that route (replacing `dsh-base`'s local
 * `llm-deepseek` row, which the bundle disables).
 *
 * The returned transport is the one the adapter streams over; the caller keeps
 * it alive for the process (the adapter holds no other reference to it).
 * @param ctx - plugin context carrying the `llm` service to swap.
 * @param values - the resolved connect values.
 * @returns the live transport and the mutable catalog handle.
 */
export async function connectRunner(
  ctx: Context,
  values: RunnerConnectValues,
): Promise<RunnerConnectResult> {
  if (values.password === undefined) {
    throw new Error(
      'no password — pass --password, set DSH_RUNNER_PASSWORD, or run interactively '
      + '(interactive prompt is not yet implemented)',
    )
  }
  ctx.logger.info(`dsh-runner: logging in as ${values.user} to ${values.server}`)
  const cookie = await login({
    server: values.server,
    user: values.user,
    password: values.password,
  })
  const transport = new RunnerTransport()
  await transport.connect({ server: values.server, device: values.device, cookie })
  // Tear the channel down when the fiber disposes, so the socket never outlives
  // the tree (e.g. on SIGINT/SIGTERM through the launcher's bounded shutdown).
  ctx.effect(() => () => { transport.dispose(new Error('runner fiber disposed')) }, 'dsh-runner: transport')

  ctx.logger.info('dsh-runner: fetching server model catalog')
  const models = (await transport.listModelsForProvider('deepseek-official')) as readonly LlmModelInfo[]
  if (models.length === 0) {
    ctx.logger.warn('dsh-runner: server advertised no models for deepseek-official')
  }
  // A mutable catalog the adapter reads from; a later `catalog.invalidate` from
  // the hub swaps `models` in place, so the live catalog follows the server.
  const catalog: RemoteModelCatalog = { models }
  // Register the remote adapter for the route the server owns. This is the
  // single swapped capability; everything else stays local from dsh-base.
  applyRemoteLlm(ctx, { providers: ['deepseek-official'] }, transport, catalog)
  ctx.logger.info(`dsh-runner: remote LLM adapter mounted (${models.length} models)`)
  return { transport, catalog }
}
