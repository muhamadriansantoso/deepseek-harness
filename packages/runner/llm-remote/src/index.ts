/**
 * @deepseek-ai/dsh-llm-remote — the laptop-side LLM adapter that makes the
 * agent loop run on the laptop while every model call is proxied to the
 * server. It extends the abstract {@link LlmAdapter} and implements
 * `stream()` by sending the {@link GenerateOptions} over the runner channel
 * and yielding the {@link StreamChunk}s the hub streams back.
 *
 * This is the ONE swapped capability on the laptop: bash/fs/skill/MCP stay on
 * local providers, but `ctx.llm` is served by this adapter, so the server's
 * `DEEPSEEK_API_KEY` and model catalog remain the single source of truth. The
 * laptop never sees the API key.
 * @module @deepseek-ai/dsh-llm-remote
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  LlmAdapter,
  type GenerateOptions,
  type StreamChunk,
  type LlmModelInfo,
} from '@deepseek-ai/dsh-llm'

/** Stable Cordis plugin name. */
export const name = 'llm-remote'

/** The adapter registers under the injected `llm` service. */
export const inject = ['llm']

/** Configuration for the remote LLM adapter. */
export interface Config {
  /** Provider route(s) this adapter claims (must match the server's catalog). */
  providers: string[]
}

export const Config: z<Config> = z.object({
  providers: z.array(String).default(['deepseek']),
})

interface SchemaResolvedConfig extends Config {
  providers: string[]
}

/**
 * Transport the runner supplies: send an `llm.stream` call to the hub and
 * return an async iterable of the chunks the hub streams back. The runner
 * owns the WebSocket; this package stays free of `ws` so the adapter is
 * unit-testable with a fake transport.
 */
export interface RunnerLlmTransport {
  /**
   * Stream one model call through the hub's LLM gateway.
   * @param options - the request (without a caller signal; cancel is a
   * transport concern the runner translates to a control frame).
   * @returns the chunk stream from the server's adapter.
   */
  streamOverHub(options: GenerateOptions): AsyncIterable<StreamChunk>
}

/**
 * A mutable holder for the server-synced model catalog. The runner swaps
 * {@link models} when the hub pushes `catalog.invalidate`, so the adapter
 * advertises the live server catalog without re-registering its route.
 */
export interface RemoteModelCatalog {
  /** The server's model catalog for this adapter's provider route(s). */
  models: readonly LlmModelInfo[]
}

/**
 * A {@link LlmAdapter} that forwards every model call to the server's LLM
 * gateway over the runner channel. The model list is supplied by the runner
 * (which receives it from the hub at connect time, and refreshes it on a hub
 * `catalog.invalidate` push), so the server's catalog is authoritative and
 * stays current without a reconnect.
 */
export class RemoteLlmAdapter extends LlmAdapter {
  /**
   * @param transport - the WS-backed transport the runner wires in.
   * @param catalog - a mutable holder for the server-synced model catalog.
   */
  constructor(
    private readonly transport: RunnerLlmTransport,
    private readonly catalog: RemoteModelCatalog,
  ) {
    super()
  }

  /** Stream one model call by proxying to the server's gateway. */
  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.transport.streamOverHub(options)
  }

  /** The server's catalog is authoritative; advertise it for this provider. */
  override listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(this.catalog.models)
  }
}

/**
 * Mount the remote LLM adapter. The runner calls this after it has opened the
 * runner channel and received the server's model catalog.
 * @param ctx - plugin context with the `llm` service injected.
 * @param transport - the WS-backed transport to the hub's LLM gateway.
 * @param catalog - a mutable holder for the server-synced model catalog; the
 *   runner swaps `catalog.models` when the hub pushes `catalog.invalidate`.
 * @param config - resolved plugin config (the provider routes to claim).
 * @returns the adapter registration disposer.
 */
export function apply(
  ctx: Context,
  config: Config,
  transport: RunnerLlmTransport,
  catalog: RemoteModelCatalog,
): () => void {
  const resolved = config as SchemaResolvedConfig | undefined
  const providers = resolved?.providers ?? ['deepseek']
  const adapter = new RemoteLlmAdapter(transport, catalog)
  return ctx.llm.registerAdapter(providers, adapter)
}
