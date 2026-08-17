/**
 * The laptop-side half of the runner channel: a WebSocket client to the hub's
 * `/runner/channel` that implements {@link RunnerLlmTransport}. It is the
 * mirror of the hub's `RunnerConnection` — the same pending-call registry and
 * frame protocol, but here the laptop is the caller of the hub's LLM gateway.
 *
 * The transport opens the channel once (carrying the session cookie and a
 * stable device id), and every model call reuses it: `streamOverHub` sends an
 * `llm.stream` {@link RunnerCall} and yields the `StreamChunk`s the hub
 * streams back as `runner-stream { kind: 'llm-token' }` frames, until the
 * matching `runner-response` (clean) or `runner-error` (failure) frame.
 *
 * Binary awareness is unused for LLM (chunks are JSON in `data`), but the
 * frame protocol carries base64 for subprocess streams — kept here so the one
 * transport the runner owns serves every method the hub will grow.
 * @module @deepseek-ai/dsh-runner
 */

import { WebSocket } from 'ws'
import {
  parseFrame,
  serializeFrame,
  type RunnerCall,
  type RunnerFrame,
  type SyncedSkill,
  type SyncedMcpServer,
  type SyncInvalidatePayload,
} from '@deepseek-ai/dsh-runner-hub'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { RunnerLlmTransport } from '@deepseek-ai/dsh-llm-remote'

/** A pending unary call awaiting a single response. */
interface PendingUnary {
  readonly resolve: (result: unknown) => void
  readonly reject: (error: Error) => void
}

/** A pending streaming call awaiting chunks then a terminal response. */
interface PendingStream {
  /** Push a chunk into the consumer's async iterator queue. */
  readonly push: (chunk: StreamChunk) => void
  /** Complete the consumer's async iterator on a clean `runner-response`. */
  readonly complete: () => void
  /** Reject the consumer's async iterator on error or disconnect. */
  readonly reject: (error: Error) => void
}

/** Connection options for {@link RunnerTransport.connect}. */
export interface RunnerTransportOptions {
  /** The dsh server base URL (no trailing slash, https forced). */
  server: string
  /** A stable device id identifying this laptop (`?device=<id>` on the upgrade). */
  device: string
  /** The `name=value` session cookie from login. */
  cookie: string
}

/** Reconnect/backoff tunables. All optional; defaults below. */
export interface RunnerReconnectConfig {
  /** First-retry backoff cap in ms (jittered: actual delay is cap/2..cap). */
  backoffBaseMs?: number
  /** Exponential growth factor per consecutive failed attempt. */
  backoffFactor?: number
  /** Upper bound for the backoff cap in ms. */
  backoffMaxMs?: number
}

const RECONNECT_DEFAULTS: Required<RunnerReconnectConfig> = {
  backoffBaseMs: 500,
  backoffFactor: 2,
  backoffMaxMs: 10_000,
}

/**
 * Coarse channel state the driver observes: {@link RunnerTransport.state} and
 * {@link RunnerTransport.onStateChange} fire one of these. `disconnected` is
 * terminal (dispose); `reconnecting` covers the whole backoff+retry span after a
 * lost socket until the next generation opens.
 */
export type RunnerConnectionState = 'connected' | 'reconnecting' | 'disconnected'

/**
 * The laptop's WebSocket transport to the hub. One instance owns one channel;
 * the runner keeps it alive for the process and shares it across model calls.
 *
 * The transport reconnects with exponential backoff on a lost socket (a network
 * drop, a hub restart) so a long-lived runner stays usable. Each reconnect opens
 * a fresh socket carrying the same cookie + device id; pending calls from the
 * old socket are rejected (the laptop re-issues any in-flight LLM call), and the
 * driver's {@link onReconnect} hook re-fetches the catalog and re-syncs skills
 * and MCP after a generation comes back up.
 */
export class RunnerTransport implements RunnerLlmTransport, Disposable {
  private ws: WebSocket | undefined
  private readonly pendingUnary = new Map<string, PendingUnary>()
  private readonly pendingStream = new Map<string, PendingStream>()
  private disposed = false
  /** Reconnect loop liveness: true from {@link connect} until {@link dispose}. */
  private running = false
  /** Consecutive failed reconnect attempts since the last open socket. */
  private attempt = 0
  private readonly reconnect: Required<RunnerReconnectConfig>
  /** The options the first {@link connect} resolved — reused on every reconnect. */
  private connectOptions: RunnerTransportOptions | undefined
  /** A reconnect timer inflight; cleared on dispose so a teardown never races a retry. */
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  /** WS keepalive handle (`setInterval` ping) — armed per-generation, cleared on close/dispose. */
  private keepaliveTimer: ReturnType<typeof setInterval> | undefined

  /** Coarse state transitions for the driver. Fires only on change. */
  onStateChange?: (state: RunnerConnectionState) => void
  /** After each (re)connect generation comes back up; the driver re-fetches catalog/sync. */
  onReconnect?: () => void
  private lastState: RunnerConnectionState | null = null

  /**
   * @param reconnect - reconnect/backoff tunables; omission uses the defaults.
   */
  constructor(reconnect: RunnerReconnectConfig = {}) {
    this.reconnect = { ...RECONNECT_DEFAULTS, ...reconnect }
  }

  /**
   * Open the channel and begin the reconnect loop. Resolves once the first
   * WebSocket is open; rejects on a first-connect socket/upgrade failure.
   * After the first open, a later lost socket triggers an auto-reconnect and
   * this transport stays alive until {@link dispose} is called.
   * @param options - server URL, device id, and session cookie.
   */
  connect(options: RunnerTransportOptions): Promise<void> {
    this.connectOptions = options
    this.running = true
    return this.openGeneration()
  }

  /** Whether the channel is open. */
  get isOpen(): boolean {
    return !this.disposed && this.ws?.readyState === WebSocket.OPEN
  }

  /** Coarse connection state. */
  get state(): RunnerConnectionState {
    if (this.disposed) return 'disconnected'
    return this.isOpen ? 'connected' : 'reconnecting'
  }

  /** Open one socket generation. Resolves on open; rejects on a connect failure. */
  private openGeneration(): Promise<void> {
    const options = this.connectOptions
    if (options === undefined) return Promise.reject(new Error('runner transport connect() was not called'))
    const device = options.device.trim()
    if (device.length === 0) return Promise.reject(new Error('runner transport: device id is required'))
    const url = new URL('/runner/channel', options.server)
    url.searchParams.set('device', device)
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url, {
        headers: { cookie: options.cookie, host: url.host },
      })
      this.ws = ws
      ws.on('open', () => {
        // A successful open resets the backoff and fires the reconnect hook +
        // connected state for any generation after the first (the first is the
        // initial connect; its caller already knows it is up).
        const firstOpen = this.attempt === 0
        this.attempt = 0
        this.emitState('connected')
        this.armKeepalive(ws)
        if (!firstOpen) this.onReconnect?.()
        resolve()
      })
      ws.on('message', (data) => { this.onFrame(data as string | Buffer) })
      ws.on('close', () => { this.handleClose() })
      ws.on('error', (error) => {
        // A connect-time error (failed handshake): reject the openGeneration
        // promise and LET the `close` event drive the reconnect. Passing that
        // duty to `handleClose` keeps one scheduling point and avoids a
        // double-orphan where both an `error→catch→schedule` and
        // `close→handleClose→schedule` fire for the same failure (two timers
        // where the second `openGeneration` races and can kill the winner's
        // live call via its own close→rejectPending).
        if (this.disposed) return
        if (ws.readyState === WebSocket.OPEN) return
        reject(new Error(`runner channel error: ${error.message}`))
      })
    })
  }

  /** A lost socket: reject in-flight calls, then schedule a reconnect (unless disposed). */
  private handleClose(): void {
    const cause = new Error('runner channel closed — reconnecting')
    this.clearKeepalive()
    this.rejectPending(cause)
    this.ws = undefined
    if (this.disposed || !this.running) {
      this.emitState('disconnected')
      return
    }
    this.emitState('reconnecting')
    this.scheduleReconnect()
  }

  /** Backoff for the next reconnect attempt, jittered over cap/2..cap. */
  private backoffDelay(): number {
    this.attempt += 1
    const { backoffBaseMs, backoffFactor, backoffMaxMs } = this.reconnect
    const cap = Math.min(backoffMaxMs, backoffBaseMs * backoffFactor ** Math.max(0, this.attempt - 1))
    return cap / 2 + Math.random() * (cap / 2)
  }

  /** Schedule the next reconnect attempt; cleared on dispose. Coalesces double calls. */
  private scheduleReconnect(): void {
    if (this.reconnectTimer !== undefined) return
    const delay = this.backoffDelay()
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      if (this.disposed || !this.running) return
      // `openGeneration`'s sole reconnect path is `handleClose`'s `close`
      // event. The `catch` here must NOT re-schedule — otherwise a single
      // connect-time failure would arm two timers (`close` + this `catch`) and
      // create two racing sockets (the loser `close`s and `rejectPending`s the
      // winner's live call). Just surface the error and keep reconnecting.
      void this.openGeneration().catch((error: unknown) => {
        if (this.disposed) return
        this.emitState('reconnecting')
        void error
      })
    }, delay)
  }

  /** Reject every pending unary + stream call with `cause`. */
  private rejectPending(cause: Error): void {
    for (const pending of this.pendingUnary.values()) pending.reject(cause)
    this.pendingUnary.clear()
    for (const pending of this.pendingStream.values()) pending.reject(cause)
    this.pendingStream.clear()
  }

  /** Emit a state transition only on change. */
  private emitState(state: RunnerConnectionState): void {
    if (this.lastState === state) return
    this.lastState = state
    this.onStateChange?.(state)
  }

  /**
   * List the models the server advertises for one provider. The laptop's remote
   * adapter calls this once at boot to populate its catalog from the server's
   * source of truth.
   * @param provider - the provider route (e.g. `deepseek-official`).
   * @returns the server's model catalog for that provider.
   */
  async listModelsForProvider(provider: string): Promise<readonly unknown[]> {
    const rpcId = crypto.randomUUID()
    const result = new Promise<unknown>((resolve, reject) => {
      this.pendingUnary.set(rpcId, { resolve, reject })
    })
    await this.send({ type: 'runner-call', rpcId, method: 'model.list', payload: provider })
    return (await result) as readonly unknown[]
  }

  /**
   * Fetch the server's skill catalog (fully materialized skills). The runner
   * mounts an in-memory provider from the reply.
   * @returns the synced skills.
   */
  async fetchSkillCatalog(): Promise<readonly SyncedSkill[]> {
    const rpcId = crypto.randomUUID()
    const result = new Promise<unknown>((resolve, reject) => {
      this.pendingUnary.set(rpcId, { resolve, reject })
    })
    await this.send({ type: 'runner-call', rpcId, method: 'skill.catalog', payload: null })
    const reply = (await result) as { skills?: readonly SyncedSkill[] }
    return reply.skills ?? []
  }

  /**
   * Fetch the server's MCP server config inventory. The runner mounts each entry
   * locally via a scoped `dsh-mcp-client` `apply()`.
   * @returns the synced MCP server configs.
   */
  async fetchMcpConfigs(): Promise<readonly SyncedMcpServer[]> {
    const rpcId = crypto.randomUUID()
    const result = new Promise<unknown>((resolve, reject) => {
      this.pendingUnary.set(rpcId, { resolve, reject })
    })
    await this.send({ type: 'runner-call', rpcId, method: 'mcp.configs', payload: null })
    const reply = (await result) as { servers?: readonly SyncedMcpServer[] }
    return reply.servers ?? []
  }

  /** Handler for hub→laptop `sync.invalidate` pushes; set by the runner driver. */
  onSyncInvalidate?: (kind: 'skill' | 'mcp') => void

  /** Handler for hub→laptop `catalog.invalidate` pushes; set by the runner driver. */
  onCatalogInvalidate?: () => void

  /**
   * Handler for hub→laptop capability calls — `subprocess.*`/`fs.*`/`terminal.*`
   * for a remote session composed on the server. Set by the runner driver: it
   * dispatches each to the laptop's local providers and owns the
   * response/stream/exit frames. Unlike the invalidate pushes (which respond
   * immediately), a streaming call defers its terminal frame until the local
   * process settles.
   */
  onRemoteCall?: (frame: RunnerCall) => void | Promise<void>

  /**
   * Stream one model call through the hub's LLM gateway. Implements
   * {@link RunnerLlmTransport.streamOverHub}: send `llm.stream`, yield each
   * `StreamChunk` the hub streams back, and complete on the `runner-response`.
   * @param options - the request (the laptop never sends its API key).
   * @returns the chunk stream from the server's adapter.
   */
  streamOverHub(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.streamCall('llm.stream', options)
  }

  /**
   * Send a streaming call and yield its chunks. The hub streams
   * `runner-stream { kind: 'llm-token' }` frames (JSON `StreamChunk` in `data`)
   * and ends with `runner-response` (clean) or `runner-error` (failure). The
   * push-to-pull bridge is a `Promise` gate the frame handlers resolve; each
   * generator `yield` awaits the next chunk, the completion, or the error.
   * @param method - `llm.stream` (or `llm.complete`, streamed identically).
   * @param options - the request payload.
   * @returns the chunk stream.
   */
  private async *streamCall(method: RunnerCall['method'], options: GenerateOptions): AsyncGenerator<StreamChunk> {
    // The hub strips any caller signal; do the same here so a serialized
    // request never carries a non-cloneable AbortSignal across the WS.
    const { signal: _drop, ...serializable } = options as GenerateOptions & { signal?: AbortSignal }
    void _drop
    const rpcId = crypto.randomUUID()
    // One gate per pending call: the generator awaits it for each chunk, and
    // every frame handler (push/complete/reject) resolves it once. `done`
    // distinguishes "here is a chunk" from "the stream is over".
    let gate: { done: boolean; error?: Error; resolve: (value: void) => void } | undefined
    const queue: StreamChunk[] = []
    let finished = false
    let failure: Error | undefined
    const wake = (done: boolean, error?: Error): void => {
      if (gate === undefined) return
      gate.done = done
      if (error !== undefined) gate.error = error
      const resolve = gate.resolve
      gate = undefined
      resolve()
    }
    this.pendingStream.set(rpcId, {
      push: (chunk) => {
        if (finished) return
        queue.push(chunk)
        wake(false)
      },
      complete: () => {
        if (finished) return
        finished = true
        wake(true)
      },
      reject: (error) => {
        if (finished) return
        finished = true
        failure = error
        wake(true, error)
      },
    })
    try {
      await this.send({ type: 'runner-call', rpcId, method, payload: serializable })
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error))
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- cross-tick: rejectPending().wake sets `finished`
      if (finished) throw err
      const entry = this.pendingStream.get(rpcId)
      if (entry !== undefined) {
        this.pendingStream.delete(rpcId)
        throw err
      }
      throw err
    }
    try {
      while (true) {
        if (queue.length > 0) {
          yield queue.shift() as StreamChunk
          continue
        }
        if (finished) {
          // oxlint-disable-next-line typescript/no-unnecessary-condition -- cross-tick: reject(error) sets `failure`
          if (failure !== undefined) throw failure
          return
        }
        // No chunk ready and not finished: wait for the next frame to wake us.
        await new Promise<void>((resolve) => {
          gate = { done: false, resolve }
        })
      }
    } finally {
      this.pendingStream.delete(rpcId)
    }
  }

  /** Serialize and send a frame; rejects if the channel is closed. */
  send(frame: RunnerFrame): Promise<void> {
    if (!this.isOpen) return Promise.reject(new Error('runner channel is closed'))
    return new Promise<void>((resolve, reject) => {
      this.ws?.send(serializeFrame(frame), (error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  }

  /** Dispatch one inbound frame to its pending call. */
  private onFrame(data: string | Buffer): void {
    const frame = parseFrame(data)
    if (frame === undefined) return
    switch (frame.type) {
      case 'runner-response': {
        const unary = this.pendingUnary.get(frame.rpcId)
        if (unary !== undefined) {
          this.pendingUnary.delete(frame.rpcId)
          unary.resolve(frame.result)
          return
        }
        const stream = this.pendingStream.get(frame.rpcId)
        if (stream !== undefined) {
          this.pendingStream.delete(frame.rpcId)
          stream.complete()
        }
        return
      }
      case 'runner-error': {
        const error = new Error(`${frame.code}: ${frame.message}`)
        const unary = this.pendingUnary.get(frame.rpcId)
        if (unary !== undefined) {
          this.pendingUnary.delete(frame.rpcId)
          unary.reject(error)
        }
        const stream = this.pendingStream.get(frame.rpcId)
        if (stream !== undefined) {
          this.pendingStream.delete(frame.rpcId)
          stream.reject(error)
        }
        return
      }
      case 'runner-stream': {
        const stream = this.pendingStream.get(frame.rpcId)
        if (stream !== undefined && frame.kind === 'llm-token') {
          const chunk = JSON.parse(frame.data) as StreamChunk
          stream.push(chunk)
        }
        return
      }
      case 'runner-call':
        if (frame.method === 'sync.invalidate') {
          const payload = frame.payload as SyncInvalidatePayload
          this.onSyncInvalidate?.(payload.kind)
          void this.send({ type: 'runner-response', rpcId: frame.rpcId, result: null })
        } else if (frame.method === 'catalog.invalidate') {
          this.onCatalogInvalidate?.()
          void this.send({ type: 'runner-response', rpcId: frame.rpcId, result: null })
        } else {
          // A hub→laptop capability call: subprocess.*/fs.*/terminal.* for a
          // remote session composed on the server. Dispatch to the laptop's
          // local providers; the handler owns the response/stream/exit frames.
          void Promise.resolve(this.onRemoteCall?.(frame)).then(
            () => {},
            (error: unknown) => {
              void this.send({
                type: 'runner-error', rpcId: frame.rpcId, code: 'dispatch-failed',
                message: error instanceof Error ? error.message : String(error),
              })
            },
          )
        }
        return
      case 'runner-exit':
        // runner-exit is an outbound frame (the laptop emits it to settle a
        // hub-originated spawn stream); the hub never sends it back to the
        // laptop, so it is unreachable here.
        return
    }
  }

  /**
   * Tear the channel down for good: stop the reconnect loop, reject every
   * pending call, clear any armed backoff timer, and close the socket.
   * Idempotent. The disconnect state is emitted once so a driver/UI reflects a
   * clean shutdown rather than an unbounded reconnecting span.
   */
  dispose(cause: Error): void {
    if (this.disposed) return
    this.disposed = true
    this.running = false
    this.clearKeepalive()
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
    this.rejectPending(cause)
    this.emitState('disconnected')
    try {
      this.ws?.close()
    } catch {
      // Socket loss won the race.
    }
  }

  /** Arm a periodic WS ping for this generation (NAT/proxy idle keepalive). */
  private armKeepalive(ws: WebSocket): void {
    this.clearKeepalive()
    // ws.ping() is a WebSocket-level ping (not an app frame) — proxies and
    // NATs see liveness even while the app is idle. 25 s keeps most idle
    // path timeouts (< 60 s) from silently dropping the channel. Failures
    // are not fatal: the pending socket's `close` event will drive the
    // reconnect loop and the next generation will arm a fresh interval.
    ws.on('pong', () => {})
    ws.on('error', () => {})
    this.keepaliveTimer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return
      try { ws.ping() } catch {}
    }, 25_000)
  }

  private clearKeepalive(): void {
    if (this.keepaliveTimer !== undefined) {
      clearInterval(this.keepaliveTimer)
      this.keepaliveTimer = undefined
    }
  }

  /** Disposable interop for `using transport`. */
  [Symbol.dispose](): void {
    this.dispose(new Error('runner transport disposed'))
  }
}
