/**
 * Subprocess capability seam bound to one laptop runner device.
 *
 * `RemoteSubprocessRuntime extends SubprocessRuntime` and proxies every method
 * over the runner channel to the laptop's OWN local subprocess provider. It is
 * constructed with a per-session `RunnerConnection` and `provide`d into an
 * isolated scope (never cordis-injected), so a session's tools resolve
 * `ctx.subprocess` to THIS provider while the rest of the process keeps the
 * host-plane `subprocess-local`.
 *
 * Streaming: `spawn` returns a `RemoteSubprocessHandle` immediately; the
 * laptop pipes stdout/stderr back as `runner-stream` chunks (base64) and
 * settles with `runner-exit`. The hub-side handle reassembles those into the
 * SubprocessHandle contract (raw piped `Readable`s when the spec asked for
 * `'pipe'`, offset-based collected readers when it asked for a `SubprocessCollect`).
 * @module @deepseek-ai/dsh-subprocess-remote
 */

import { randomUUID } from 'node:crypto'
import { PassThrough, Readable, Writable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import {
  SubprocessRuntime,
  type SubprocessHandle,
  type SubprocessOutcome,
  type SubprocessOutputReader,
  type SubprocessSpawnSpec,
  type SubprocessTerminalHandle,
  type SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { decodeBytes, type RunnerConnection, type RunnerStream } from '@deepseek-ai/dsh-runner-hub'

/**
 * The wire serialization of a {@link SubprocessSpawnSpec}: JSON-safe, no
 * AbortSignal (the caller's signal is handled locally via terminate).
 */
export interface SerializableSpawnSpec {
  readonly argv: readonly string[]
  readonly cwd: string
  readonly stdio: SubprocessSpawnSpec['stdio']
  readonly graceMs: number
  readonly env?: NodeJS.ProcessEnv | undefined
}

/** One collected remote stream's retained tail and offset accounting. */
class RemoteCollected {
  private tail = ''
  private nextOffset = 0

  /** Append one base64 chunk's decoded bytes as text (the laptop sent UTF-8). */
  append(data: string): void {
    this.tail += Buffer.from(decodeBytes(data)).toString('utf8')
  }

  /** Read everything captured since `fromByte` (whole-stream byte coordinates). */
  readFrom(fromByte: number): { text: string; nextOffset: number; lossy: boolean } {
    if (fromByte < 0) fromByte = 0
    if (fromByte > this.nextOffset) {
      // The requested offset slid out of the retained tail — lossy, like the
      // local spill/truncate path.
      return { text: this.tail, nextOffset: this.nextOffset, lossy: true }
    }
    const text = this.tail.slice(fromByte)
    this.nextOffset = this.tail.length
    return { text, nextOffset: this.nextOffset, lossy: false }
  }
}

/** The hub-side handle for one remote subprocess. */
class RemoteSubprocessHandle implements SubprocessHandle {
  readonly pid: number
  readonly stdin: Writable | undefined
  readonly stdout: Readable | undefined
  readonly stderr: Readable | undefined
  readonly collected: SubprocessHandle['collected']
  readonly done: Promise<SubprocessOutcome>

  private readonly stdoutCollected: RemoteCollected | undefined
  private readonly stderrCollected: RemoteCollected | undefined
  private readonly stdoutPipe: PassThrough | undefined
  private readonly stderrPipe: PassThrough | undefined
  private readonly terminateCall: () => void

  constructor(
    connection: RunnerConnection,
    readonly rpcId: string,
    spec: SerializableSpawnSpec,
  ) {
    // pid arrives via a `pid` stream chunk; -1 until known.
    this.pid = -1
    const stdoutIsPipe = spec.stdio.stdout === 'pipe'
    const stderrIsPipe = spec.stdio.stderr === 'pipe'
    const collected: { stdout?: SubprocessOutputReader; stderr?: SubprocessOutputReader } = {}
    if (stdoutIsPipe) {
      this.stdoutPipe = new PassThrough()
      this.stdout = this.stdoutPipe
    } else {
      this.stdoutCollected = new RemoteCollected()
      this.stdout = undefined
      collected.stdout = this.stdoutCollected
    }
    if (stderrIsPipe) {
      this.stderrPipe = new PassThrough()
      this.stderr = this.stderrPipe
    } else {
      this.stderrCollected = new RemoteCollected()
      this.stderr = undefined
      collected.stderr = this.stderrCollected
    }
    this.collected = collected
    this.stdin = spec.stdio.stdin === 'pipe'
      ? new Writable({
        write: (_chunk, _encoding, callback) => {
          // Interactive stdin writing is deferred (the bash tool uses
          // collect mode); a piped stdin resolves writes immediately.
          callback()
        },
      })
      : undefined

    const done = Promise.withResolvers<SubprocessOutcome>()
    this.done = done.promise
    let pidKnown = false

    this.terminateCall = () => {
      void connection.call('subprocess.terminate', { rpcId }).catch(() => {})
    }

    void connection.callStreaming('subprocess.spawn', spec, (chunk: RunnerStream) => {
      if (chunk.kind === 'stdout') {
        if (this.stdoutPipe !== undefined) this.stdoutPipe.write(decodeBytes(chunk.data))
        else this.stdoutCollected?.append(chunk.data)
        return
      }
      if (chunk.kind === 'stderr') {
        if (this.stderrPipe !== undefined) this.stderrPipe.write(decodeBytes(chunk.data))
        else this.stderrCollected?.append(chunk.data)
        return
      }
      if (chunk.kind === 'pid') {
        if (!pidKnown) {
          const parsed = Number.parseInt(chunk.data, 10)
          ;(this as { pid: number }).pid = Number.isFinite(parsed) ? parsed : -1
          pidKnown = true
        }
        return
      }
    }).then((exit) => {
      if (this.stdoutPipe !== undefined) this.stdoutPipe.end()
      if (this.stderrPipe !== undefined) this.stderrPipe.end()
      done.resolve({ exitCode: exit.exitCode, signal: exit.signal as NodeJS.Signals | null })
    }).catch((error: unknown) => {
      // The laptop rejected the spawn itself (bad argv/cwd) or the connection
      // dropped mid-stream; either way the handle settles as failed.
      if (this.stdoutPipe !== undefined) this.stdoutPipe.destroy(error instanceof Error ? error : new Error(String(error)))
      if (this.stderrPipe !== undefined) this.stderrPipe.destroy(error instanceof Error ? error : new Error(String(error)))
      done.reject(error instanceof Error ? error : new Error(String(error)))
    })
  }

  terminate(): void {
    this.terminateCall()
  }

  async waitForExit(signal?: AbortSignal): Promise<boolean> {
    if (signal === undefined) {
      await this.done.catch(() => undefined)
      return true
    }
    if (signal.aborted) return false
    let resolved = false
    await new Promise<void>((resolve) => {
      const onDone = (): void => {
        resolved = true
        signal.removeEventListener('abort', onAbort)
        resolve()
      }
      const onAbort = (): void => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      }
      signal.addEventListener('abort', onAbort, { once: true })
      void this.done.then(onDone, onDone)
    })
    return resolved
  }
}

/**
 * The remote subprocess provider: `ctx.subprocess` for one session whose
 * execution world is a laptop. Register via `provide('subprocess', this)` in
 * the session's isolated scope.
 */
export class RemoteSubprocessRuntime extends SubprocessRuntime {
  static inject = []

  /**
   * @param ctx - the isolated scope context this provider is provided into.
   * @param connection - the live connection to the laptop that owns the session's workspace.
   */
  constructor(
    ctx: Context,
    private readonly connection: RunnerConnection,
  ) {
    super(ctx)
  }

  /** @inheritdoc */
  async resolveExecutable(
    command: string,
    env?: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<string> {
    signal?.throwIfAborted()
    const result = await this.connection.call('subprocess.resolveExecutable', { command, env })
    signal?.throwIfAborted()
    return result as string
  }

  /** @inheritdoc */
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    if (spec.argv.length === 0 || spec.argv[0] === undefined || spec.argv[0].length === 0) {
      throw new Error('invalid argv: expected a non-empty program name at argv[0]')
    }
    if (!Number.isFinite(spec.graceMs) || spec.graceMs <= 0) {
      throw new Error('subprocess graceMs must be a positive finite number')
    }
    const rpcId = randomUUID()
    const serializable: SerializableSpawnSpec = {
      argv: spec.argv,
      cwd: spec.cwd,
      stdio: spec.stdio,
      graceMs: spec.graceMs,
      ...spec.env !== undefined ? { env: spec.env } : {},
    }
    const handle = new RemoteSubprocessHandle(this.connection, rpcId, serializable)
    if (spec.signal !== undefined) {
      // The caller's abort is the only local termination signal for this
      // handle; mirror subprocess-local's abort-to-terminate escalation.
      if (spec.signal.aborted) handle.terminate()
      else spec.signal.addEventListener('abort', () => { handle.terminate() }, { once: true })
    }
    return handle
  }

  /** @inheritdoc */
  spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    // Interactive terminals over the runner channel need a writeStdin method
    // (deferred); the bash tool never uses spawnTerminal.
    void spec
    throw new Error('subprocess-remote: spawnTerminal is not implemented (interactive terminals are a later phase)')
  }
}
