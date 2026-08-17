/**
 * LLM gateway: the hub-side half of the remote LLM adapter. A laptop's
 * `dsh-llm-remote` adapter sends an `llm.stream` / `llm.complete` / `model.list`
 * {@link RunnerCall}; the gateway calls the server's local `ctx.llm` (which holds
 * the central `DEEPSEEK_API_KEY`) and streams each {@link StreamChunk} back as a
 * `runner-stream` frame with `kind: 'llm-token'`.
 *
 * The laptop never sees the API key; it only receives model output. The model
 * list the laptop advertises comes from the gateway's `model.list` answer, so
 * the server's catalog is the single source of truth.
 * @module @deepseek-ai/dsh-runner-hub
 */

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { RunnerHubService } from './index.ts'
import type { RunnerConnection } from './connection.ts'
import type { RunnerCall } from './protocol.ts'

/** Methods the gateway handles when invoked from a laptop. */
export const LLM_GATEWAY_METHODS = new Set(['llm.stream', 'llm.complete', 'model.list'])

/**
 * Serve one inbound LLM-gateway call dispatched by the hub. Routes `llm.stream`
 * to the streaming path, `model.list` to the server's catalog, and rejects
 * anything else with `bad-method`.
 * @param hub - the hub service, for `ctx.llm`.
 * @param conn - the device's live runner connection (to send frames back).
 * @param call - the inbound gateway call.
 */
export async function serveLlmStream(
  hub: RunnerHubService,
  conn: RunnerConnection,
  call: RunnerCall,
): Promise<void> {
  switch (call.method) {
    case 'llm.stream':
    case 'llm.complete':
      await serveStream(hub, conn, call)
      return
    case 'model.list':
      await serveModelList(hub, conn, call)
      return
    default:
      await conn.send({ type: 'runner-error', rpcId: call.rpcId, code: 'bad-method', message: `gateway got ${call.method}` })
  }
}

/**
 * Serve one `llm.stream` (or `llm.complete`, which streams identically — the
 * laptop assembles completion from the stream): iterate the server's LLM and
 * forward chunks. Errors convert to a `runner-error` frame so the laptop's
 * adapter yields a terminal `finish` chunk (never a thrown generator),
 * matching how the local `ctx.llm` stream surfaces adapter failures.
 */
async function serveStream(
  hub: RunnerHubService,
  conn: RunnerConnection,
  call: RunnerCall,
): Promise<void> {
  const options = call.payload as GenerateOptions
  // The server owns the API key; the laptop's request carries only the
  // provider/model/messages. The laptop expresses cancellation as a separate
  // control frame, so drop any caller-supplied signal before dispatch.
  const { signal: _drop, ...serverOptions } = options
  void _drop
  let stream: AsyncIterable<StreamChunk>
  try {
    stream = hub.streamLlm(serverOptions)
  } catch (error: unknown) {
    await conn.send({ type: 'runner-error', rpcId: call.rpcId, code: 'llm-dispatch', message: String(error) })
    return
  }
  try {
    for await (const chunk of stream) {
      if (!conn.isOpen) break
      await conn.send({ type: 'runner-stream', rpcId: call.rpcId, kind: 'llm-token', data: JSON.stringify(chunk) })
    }
    // A clean stream ends with a finish chunk; laptop disconnect races settle there too (see
    // Agent Note: LLM streaming + runner disconnect — an abandon loop shows as a clean idle).
    if (conn.isOpen) await conn.send({ type: 'runner-response', rpcId: call.rpcId, result: { ok: true } })
  } catch (error: unknown) {
    if (conn.isOpen) await conn.send({ type: 'runner-error', rpcId: call.rpcId, code: 'llm-stream', message: String(error) })
  }
}

/**
 * Serve one `model.list` call: return the server's catalog for the requested
 * provider route. The payload names the provider (e.g. `deepseek-official`);
 * the reply is the {@link LlmRuntime.listModels} array, detached JSON. This is
 * the source of truth the laptop's remote adapter advertises.
 */
async function serveModelList(
  hub: RunnerHubService,
  conn: RunnerConnection,
  call: RunnerCall,
): Promise<void> {
  const provider = typeof call.payload === 'string' ? call.payload : undefined
  if (provider === undefined || provider.length === 0) {
    await conn.send({ type: 'runner-error', rpcId: call.rpcId, code: 'bad-payload', message: 'model.list needs a provider string' })
    return
  }
  try {
    // The hub exposes `streamLlm`; reach the runtime's catalog through it.
    const models = await hub.listModelsForProvider(provider)
    await conn.send({ type: 'runner-response', rpcId: call.rpcId, result: models })
  } catch (error: unknown) {
    await conn.send({ type: 'runner-error', rpcId: call.rpcId, code: 'model-list', message: String(error) })
  }
}
