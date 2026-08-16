/**
 * One bidirectional connection to a single laptop runner. Owns the WebSocket
 * and the pending-call registry that correlates outbound method calls with
 * inbound responses and streaming chunks. Mirrors the per-handle ownership of
 * `E2BRuntime` (one remote handle, a pending map, disposal-aware rejection).
 *
 * A connection is owned by one (userId, deviceId): a credential installed on two
 * laptops yields two connections in the hub, and only a reconnect of the SAME
 * device replaces its own stale socket.
 * @module @deepseek-ai/dsh-runner-hub
 */

import { WebSocket } from 'ws'
import {
  parseFrame,
  serializeFrame,
  type PendingStream,
  type PendingUnary,
  type RunnerCall,
  type RunnerFrame,
  type RunnerStream,
} from './protocol.ts'

/**
 * Invoke a method on a connected laptop, awaiting its unary response, or
 * stream its output chunks and exit. The hub holds one of these per device.
 */
export class RunnerConnection {
  private readonly pendingUnary = new Map<string, PendingUnary>()
  private readonly pendingStream = new Map<string, PendingStream>()
  private disposed = false

  /**
   * Handler for laptop→hub method calls (the LLM gateway). When set, inbound
   * `runner-call` frames are dispatched here; the handler owns sending the
   * matching response/error/stream frames back over this connection.
   */
  inboundHandler?: (call: RunnerCall) => void | Promise<void>

  /**
   * @param userId - the authenticated user owning this laptop connection.
   * @param deviceId - the laptop's stable device id (from `?device=` at upgrade).
   * @param ws - the upgraded WebSocket to the laptop.
   */
  constructor(
    readonly userId: string,
    readonly deviceId: string,
    private readonly ws: WebSocket,
  ) {
    ws.on('message', (data) => { this.onFrame(data) })
    ws.on('close', () => { this.dispose(new Error('runner disconnected')) })
    ws.on('error', () => { this.dispose(new Error('runner socket error')) })
  }

  /** Whether the underlying socket is still open. */
  get isOpen(): boolean {
    return !this.disposed && this.ws.readyState === WebSocket.OPEN
  }

  /**
   * Send a frame to the laptop; rejects if the socket is closed.
   * @param frame - the frame to serialize and send.
   */
  send(frame: RunnerFrame): Promise<void> {
    if (!this.isOpen) return Promise.reject(new Error('runner socket is closed'))
    return new Promise((resolve, reject) => {
      this.ws.send(serializeFrame(frame), (error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  }

  /**
   * Invoke a unary method on the laptop and await its response.
   * @param method - the method to call.
   * @param payload - the method arguments.
   * @returns the method's return value.
   */
  async call(method: RunnerCall['method'], payload: unknown): Promise<unknown> {
    const rpcId = crypto.randomUUID()
    const result = new Promise<unknown>((resolve, reject) => {
      this.pendingUnary.set(rpcId, { resolve, reject })
    })
    await this.send({ type: 'runner-call', rpcId, method, payload })
    return result
  }

  /**
   * Invoke a streaming method on the laptop; chunks are delivered to
   * `onChunk` and the call settles on the exit frame.
   * @param method - the streaming method to call.
   * @param payload - the method arguments.
   * @param onChunk - sink for each `runner-stream` chunk of this rpcId.
   * @returns the terminal exit frame (or rejection on error/disconnect).
   */
  async callStreaming(
    method: RunnerCall['method'],
    payload: unknown,
    onChunk: (chunk: RunnerStream) => void,
  ): Promise<{ exitCode: number | null; signal: string | null }> {
    const rpcId = crypto.randomUUID()
    const result = new Promise<{ exitCode: number | null; signal: string | null }>((resolve, reject) => {
      this.pendingStream.set(rpcId, { onChunk, resolve: (exit) => { resolve({ exitCode: exit.exitCode, signal: exit.signal }) }, reject })
    })
    await this.send({ type: 'runner-call', rpcId, method, payload })
    return result
  }

  /** Dispatch one inbound WS message to its pending call, if any. */
  private onFrame(data: unknown): void {
    const frame = parseFrame(data as string | Buffer)
    if (frame === undefined) return
    switch (frame.type) {
      case 'runner-response': {
        const pending = this.pendingUnary.get(frame.rpcId)
        if (pending !== undefined) {
          this.pendingUnary.delete(frame.rpcId)
          pending.resolve(frame.result)
        }
        return
      }
      case 'runner-error': {
        const unary = this.pendingUnary.get(frame.rpcId)
        if (unary !== undefined) {
          this.pendingUnary.delete(frame.rpcId)
          unary.reject(new Error(`${frame.code}: ${frame.message}`))
        }
        const stream = this.pendingStream.get(frame.rpcId)
        if (stream !== undefined) {
          this.pendingStream.delete(frame.rpcId)
          stream.reject(new Error(`${frame.code}: ${frame.message}`))
        }
        return
      }
      case 'runner-stream': {
        const stream = this.pendingStream.get(frame.rpcId)
        if (stream !== undefined) stream.onChunk(frame)
        return
      }
      case 'runner-exit': {
        const stream = this.pendingStream.get(frame.rpcId)
        if (stream !== undefined) {
          this.pendingStream.delete(frame.rpcId)
          stream.resolve(frame)
        }
        return
      }
      case 'runner-call':
        // A laptop→hub method call (the LLM gateway, model catalog, etc.).
        // Dispatched to the hub's inbound handler, which owns the response.
        void this.inboundHandler?.(frame)
        return
    }
  }

  /** Reject every pending call and close the socket. Idempotent. */
  dispose(cause: Error): void {
    if (this.disposed) return
    this.disposed = true
    for (const pending of this.pendingUnary.values()) pending.reject(cause)
    this.pendingUnary.clear()
    for (const pending of this.pendingStream.values()) pending.reject(cause)
    this.pendingStream.clear()
    try {
      this.ws.close()
    } catch {
      // Socket loss won the race.
    }
  }
}
