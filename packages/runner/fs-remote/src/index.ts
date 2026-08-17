/**
 * Filesystem capability seam bound to one laptop runner device.
 *
 * `RemoteFileSystem extends FileSystem` and proxies every method over the
 * runner channel to the laptop's OWN local filesystem provider. `FsTarget`s
 * are opaque JSON `{targetKey, displayPath}` minted by the laptop and
 * round-tripped verbatim — no path translation ever happens on the hub (the
 * laptop's fs IS the execution world).
 *
 * Constructed with a per-session `RunnerConnection` and `provide`d into an
 * isolated scope, mirroring `RemoteSubprocessRuntime`.
 * @module @deepseek-ai/dsh-fs-remote
 */

import { Context } from '@deepseek-ai/cordis'
import {
  FileSystem,
  FsTargetKey,
  FsVersion,
  type FsDirEntry,
  type FsEditOutcome,
  type FsEditRequest,
  type FsInfo,
  type FsPathInfo,
  type FsTarget,
  type FsWriteIntent,
  type FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import { decodeBytes, type RunnerConnection, type RunnerStream } from '@deepseek-ai/dsh-runner-hub'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'

/** Reconstruct a hub-returned target as an opaque {@link FsTarget}. */
function reviveTarget(value: { targetKey: string; displayPath: string }): FsTarget {
  return { targetKey: FsTargetKey(value.targetKey), displayPath: value.displayPath }
}

/**
 * The remote filesystem provider: `ctx.fs` for one session whose execution
 * world is a laptop. Register via `provide('fs', this)` in the session's
 * isolated scope.
 */
export class RemoteFileSystem extends FileSystem {
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
  async resolve(
    path: string,
    opts?: { cwd?: string; signal?: AbortSignal },
  ): Promise<FsTarget> {
    opts?.signal?.throwIfAborted()
    const result = await this.connection.call('fs.resolve', { path, cwd: opts?.cwd })
    opts?.signal?.throwIfAborted()
    return reviveTarget(result as { targetKey: string; displayPath: string })
  }

  /** @inheritdoc */
  processPath(target: FsTarget): string {
    return String(target.targetKey)
  }

  /** @inheritdoc */
  fileUrl(target: FsTarget): string {
    // Mirror fs-e2b's encoding: the target key is a canonical absolute path.
    return 'file://' + encodeURIComponent(String(target.targetKey)).replace(/%2F/g, '/')
  }

  /** @inheritdoc */
  contains(parent: FsTarget, child: FsTarget): boolean {
    const p = String(parent.targetKey)
    const c = String(child.targetKey)
    if (c === p) return true
    return c.startsWith(p.endsWith('/') ? p : `${p}/`)
  }

  /** @inheritdoc */
  async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    signal?.throwIfAborted()
    const result = await this.connection.call('fs.stat', { target }) as FsInfo | null
    signal?.throwIfAborted()
    return result === null ? undefined : { ...result, version: FsVersion(String(result.version)) }
  }

  /** @inheritdoc */
  async lstat(
    path: string,
    opts?: { cwd?: string },
    signal?: AbortSignal,
  ): Promise<FsPathInfo | undefined> {
    signal?.throwIfAborted()
    const result = await this.connection.call('fs.lstat', { path, cwd: opts?.cwd }) as FsPathInfo | null
    signal?.throwIfAborted()
    return result === null ? undefined : { ...result, version: FsVersion(String(result.version)) }
  }

  /** @inheritdoc */
  async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted()
    const result = await this.connection.call('fs.readText', { target })
    signal?.throwIfAborted()
    return result as string
  }

  /** @inheritdoc */
  async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    signal?.throwIfAborted()
    const connection = this.connection
    const targetKey = target.targetKey
    return {
      async *[Symbol.asyncIterator]() {
        // Push-to-pull: chunks queue into a sink the async iterator drains;
        // the laptop streams text chunks then settles the call.
        const queue: string[] = []
        const waiters: Array<() => void> = []
        let settled = false
        let failure: Error | undefined
        const notify = (): void => {
          const waiter = waiters.shift()
          if (waiter !== undefined) waiter()
        }
        const exitPromise = connection.callStreaming(
          'fs.streamText',
          { target: { targetKey, displayPath: '' } },
          (chunk: RunnerStream) => {
            if (chunk.kind !== 'stdout') return
            queue.push(Buffer.from(decodeBytes(chunk.data)).toString('utf8'))
            notify()
          },
        ).catch((error: unknown) => {
          failure = error instanceof Error ? error : new Error(String(error))
          settled = true
          notify()
          return undefined
        })
        void exitPromise.then(
          () => {
            settled = true
            notify()
          },
          () => {},
        )
        while (true) {
          const chunk = queue.shift()
          if (chunk !== undefined) {
            if (signal?.aborted) {
              throw signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason))
            }
            yield chunk
            continue
          }
          if (settled) {
            if (failure !== undefined) throw failure
            return
          }
          await new Promise<void>(resolve => waiters.push(resolve))
        }
      },
    }
  }

  /** @inheritdoc */
  async readBytes(
    target: FsTarget,
    signal: AbortSignal | undefined,
    maxBytes: number,
  ): Promise<Uint8Array> {
    signal?.throwIfAborted()
    const result = await this.connection.call('fs.readBytes', { target, maxBytes })
    signal?.throwIfAborted()
    return new Uint8Array(result as number[])
  }

  /** @inheritdoc */
  async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    signal?.throwIfAborted()
    const result = await this.connection.call('fs.listDir', { target }) as Array<{
      name: string
      type: 'file' | 'directory' | 'other'
      target: { targetKey: string; displayPath: string }
      version?: unknown
      size?: number
    }>
    signal?.throwIfAborted()
    return result.map(entry => ({
      name: entry.name,
      type: entry.type,
      target: reviveTarget(entry.target),
      ...entry.version !== undefined ? { version: FsVersion(String(entry.version)) } : {},
      ...entry.size !== undefined ? { size: entry.size } : {},
    }))
  }

  /** @inheritdoc */
  async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsWriteOutcome> {
    signal?.throwIfAborted()
    const result = await this.connection.call('fs.writeText', {
      target,
      content,
      ...expected !== undefined ? { expected } : {},
      ...sandboxPolicy !== undefined ? { sandboxPolicy } : {},
    }) as FsWriteOutcome
    signal?.throwIfAborted()
    return { ...result, version: FsVersion(String(result.version)) }
  }

  /** @inheritdoc */
  async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsEditOutcome> {
    signal?.throwIfAborted()
    const result = await this.connection.call('fs.editText', {
      target,
      edit,
      ...expected !== undefined ? { expected: { version: String(expected.version) } } : {},
      ...sandboxPolicy !== undefined ? { sandboxPolicy } : {},
    }) as FsEditOutcome
    signal?.throwIfAborted()
    return { ...result, version: FsVersion(String(result.version)) }
  }
}

export default RemoteFileSystem
