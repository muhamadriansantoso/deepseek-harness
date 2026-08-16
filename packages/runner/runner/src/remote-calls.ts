/**
 * Laptop-side handler for hub→laptop capability method calls.
 *
 * The hub composes a remote session whose `ctx.subprocess`/`ctx.fs`/`ctx.shell`
 * providers proxy over the runner channel. Their calls arrive here as
 * `runner-call` frames; this module dispatches each to the laptop's OWN local
 * providers (`ctx.subprocess`/`ctx.fs`, mounted by `dsh-base`), answers with
 * `runner-response`/`runner-error`, and for streaming methods (`subprocess.spawn`,
 * `fs.streamText`) pipes output back as `runner-stream` chunks with a terminal
 * `runner-exit`/`runner-response` frame — all correlated by the inbound rpcId.
 * @module @deepseek-ai/dsh-runner/remote-calls
 */

import { encodeBytes, type RunnerCall, type RunnerFrame } from '@deepseek-ai/dsh-runner-hub'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-fs'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { resolveRgPath } from '@deepseek-ai/dsh-tool-fs-search'

/** A live local subprocess someone on the hub owns, keyed by the spawn rpcId. */
interface LiveHandle {
  readonly handle: SubprocessHandle
  /** Whole-stream byte offset already streamed for each collected reader. */
  stdout: { offset: number }
  stderr: { offset: number }
}

/**
 * Dispatch one inbound hub method call to the laptop's local providers.
 * Every outbound frame is correlated by the inbound `frame.rpcId`.
 * @param ctx - the laptop's root context (its own local providers resolve here).
 * @param send - frame sink (the transport's `RunnerTransport.send`).
 * @param frame - the inbound `subprocess.*`/`fs.*`/`terminal.*` call.
 */
export async function serveRemoteCall(
  ctx: Context,
  send: (frame: RunnerFrame) => Promise<void>,
  frame: RunnerCall,
): Promise<void> {
  const method = frame.method
  const reply = (result: unknown): Promise<void> =>
    send({ type: 'runner-response', rpcId: frame.rpcId, result })
  const fail = (code: string, message: string): Promise<void> =>
    send({ type: 'runner-error', rpcId: frame.rpcId, code, message })

  try {
    if (method.startsWith('subprocess.')) {
      if (method === 'subprocess.spawn') {
        await handleSpawn(ctx, send, frame)
        return
      }
      if (method === 'subprocess.terminate') {
        const payload = frame.payload as { rpcId?: string }
        const live = payload.rpcId !== undefined ? spawned.get(payload.rpcId) : undefined
        if (live !== undefined) live.handle.terminate()
        await reply({ terminated: live !== undefined })
        return
      }
      if (method === 'subprocess.resolveExecutable') {
        const payload = frame.payload as { command?: string; env?: Record<string, string> }
        if (typeof payload.command !== 'string') { await fail('bad-payload', 'command is required'); return }
        const resolved = await ctx.subprocess.resolveExecutable(payload.command, payload.env)
        await reply({ executable: resolved })
        return
      }
      if (method === 'subprocess.resolveRgPath') {
        // The hub's search tool routes a remote-session glob/grep to this laptop
        // but cannot use the host's packaged `@vscode/ripgrep` path (a different
        // machine). Resolve the laptop's OWN packaged rg path here — the runner
        // pulls `dsh-tool-fs-search` (hence `@vscode/ripgrep`) transitively via
        // `dsh-base`, so the same lazy `resolveRgPath` resolves locally.
        await reply({ path: await resolveRgPath() })
        return
      }
      if (method === 'subprocess.spawnTerminal') {
        // Interactive terminals are a later phase; the hub never calls this today.
        await fail('not-implemented', 'subprocess.spawnTerminal is not implemented on the runner')
        return
      }
    }
    if (method.startsWith('terminal.')) {
      // Terminal methods need a spawned-terminal handle keyed by rpcId; the
      // spawnTerminal path is not implemented yet, so no handle exists.
      await fail('not-implemented', `terminal method "${method}" is not implemented on the runner`)
      return
    }
    if (method.startsWith('fs.')) {
      if (method === 'fs.streamText') {
        await handleFsStreamText(ctx, send, frame)
        return
      }
      await handleFsUnary(ctx, send, frame)
      return
    }
    await fail('unknown-method', `runner does not serve method "${method}"`)
  } catch (error: unknown) {
    await fail('internal-error', error instanceof Error ? error.message : String(error))
  }
}

/** Live spawned processes keyed by their spawn rpcId, for terminate. */
const spawned = new Map<string, LiveHandle>()

/** Serve `subprocess.spawn`: spawn locally, stream output, settle with `runner-exit`. */
async function handleSpawn(
  ctx: Context,
  send: (frame: RunnerFrame) => Promise<void>,
  frame: RunnerCall,
): Promise<void> {
  const payload = frame.payload as {
    argv?: readonly string[]
    cwd?: string
    stdio?: unknown
    graceMs?: unknown
    env?: Record<string, string>
  }
  if (!Array.isArray(payload.argv) || payload.argv.length === 0 || typeof payload.cwd !== 'string') {
    await send({ type: 'runner-error', rpcId: frame.rpcId, code: 'bad-payload', message: 'argv and cwd are required' })
    return
  }
  const spec: SubprocessSpawnSpec = {
    argv: payload.argv as string[],
    cwd: payload.cwd,
    stdio: payload.stdio as SubprocessSpawnSpec['stdio'],
    graceMs: typeof payload.graceMs === 'number' ? payload.graceMs : 3_000,
    ...payload.env !== undefined ? { env: payload.env } : {},
  }
  const handle = ctx.subprocess.spawn(spec)
  // Record pid first (the hub's handle needs it).
  void send({ type: 'runner-stream', rpcId: frame.rpcId, kind: 'pid', data: String(handle.pid) })
  const live: LiveHandle = {
    handle,
    stdout: { offset: 0 },
    stderr: { offset: 0 },
  }
  spawned.set(frame.rpcId, live)

  // Drain any buffered output since the last tick, streaming the delta. Collect
  // mode is what the remote bash tool requests; readFrom(offset) returns the
  // fresh tail without consuming a competing local reader.
  const drain = async (): Promise<boolean> => {
    let activity = false
    const out = handle.collected.stdout?.readFrom(live.stdout.offset)
    if (out !== undefined && out.text.length > 0) {
      live.stdout.offset = out.nextOffset
      await send({ type: 'runner-stream', rpcId: frame.rpcId, kind: 'stdout', data: encodeBytes(Buffer.from(out.text, 'utf8')) })
      activity = true
    }
    const err = handle.collected.stderr?.readFrom(live.stderr.offset)
    if (err !== undefined && err.text.length > 0) {
      live.stderr.offset = err.nextOffset
      await send({ type: 'runner-stream', rpcId: frame.rpcId, kind: 'stderr', data: encodeBytes(Buffer.from(err.text, 'utf8')) })
      activity = true
    }
    return activity
  }

  try {
    let settled = false
    // Poll the collected readers until the process settles, then do one final
    // drain so the tail that arrived alongside exit is not lost.
    void (async (): Promise<void> => {
      while (!settled) {
        await drain()
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      await drain()
    })().catch(() => {})
    const outcome = await handle.done
    settled = true
    await drain()
    await send({ type: 'runner-exit', rpcId: frame.rpcId, exitCode: outcome.exitCode, signal: outcome.signal })
  } catch (error: unknown) {
    await send({ type: 'runner-error', rpcId: frame.rpcId, code: 'spawn-failed', message: error instanceof Error ? error.message : String(error) })
  } finally {
    spawned.delete(frame.rpcId)
  }
}

/** Serve `fs.streamText`: stream the remote file's text as `runner-stream` chunks. */
async function handleFsStreamText(
  ctx: Context,
  send: (frame: RunnerFrame) => Promise<void>,
  frame: RunnerCall,
): Promise<void> {
  const payload = frame.payload as { target?: { targetKey?: string; displayPath?: string } }
  const targetKey = payload.target?.targetKey
  if (typeof targetKey !== 'string') {
    await send({ type: 'runner-error', rpcId: frame.rpcId, code: 'bad-payload', message: 'target is required' })
    return
  }
  const target = { targetKey: targetKey as never, displayPath: payload.target?.displayPath ?? '' }
  const iterable = await ctx.fs.streamText(target)
  try {
    for await (const chunk of iterable) {
      await send({ type: 'runner-stream', rpcId: frame.rpcId, kind: 'stdout', data: encodeBytes(Buffer.from(chunk, 'utf8')) })
    }
    await send({ type: 'runner-response', rpcId: frame.rpcId, result: null })
  } catch (error: unknown) {
    await send({ type: 'runner-error', rpcId: frame.rpcId, code: 'stream-failed', message: error instanceof Error ? error.message : String(error) })
  }
}

/** Serve every fs.* method whose result is a single response. */
async function handleFsUnary(
  ctx: Context,
  send: (frame: RunnerFrame) => Promise<void>,
  frame: RunnerCall,
): Promise<void> {
  const payload = frame.payload as Record<string, unknown>
  const reply = (result: unknown): Promise<void> =>
    send({ type: 'runner-response', rpcId: frame.rpcId, result })
  const fail = (code: string, message: string): Promise<void> =>
    send({ type: 'runner-error', rpcId: frame.rpcId, code, message })

  const target = (): { targetKey: never; displayPath: string } | undefined => {
    const t = payload.target as { targetKey?: string; displayPath?: string } | undefined
    return typeof t?.targetKey === 'string'
      ? { targetKey: t.targetKey as never, displayPath: t.displayPath ?? '' }
      : undefined
  }

  switch (frame.method) {
    case 'fs.resolve': {
      const path = payload.path
      const cwd = payload.cwd
      if (typeof path !== 'string') { await fail('bad-payload', 'path is required'); return }
      const resolved = await ctx.fs.resolve(path, typeof cwd === 'string' ? { cwd } : undefined)
      await reply({ targetKey: String(resolved.targetKey), displayPath: resolved.displayPath })
      return
    }
    case 'fs.stat': {
      const t = target()
      if (t === undefined) { await fail('bad-payload', 'target is required'); return }
      const info = await ctx.fs.stat(t)
      await reply(info === undefined ? null : { ...info, version: String(info.version) })
      return
    }
    case 'fs.lstat': {
      const path = payload.path
      const cwd = payload.cwd
      if (typeof path !== 'string') { await fail('bad-payload', 'path is required'); return }
      const info = await ctx.fs.lstat(path, typeof cwd === 'string' ? { cwd } : undefined)
      await reply(info === undefined ? null : { ...info, version: String(info.version) })
      return
    }
    case 'fs.readText': {
      const t = target()
      if (t === undefined) { await fail('bad-payload', 'target is required'); return }
      await reply(await ctx.fs.readText(t))
      return
    }
    case 'fs.readBytes': {
      const t = target()
      if (t === undefined) { await fail('bad-payload', 'target is required'); return }
      const maxBytes = typeof payload.maxBytes === 'number' ? payload.maxBytes : 64 * 1024
      await reply([...await ctx.fs.readBytes(t, undefined, maxBytes)])
      return
    }
    case 'fs.listDir': {
      const t = target()
      if (t === undefined) { await fail('bad-payload', 'target is required'); return }
      const entries = await ctx.fs.listDir(t)
      await reply(entries.map(entry => ({
        name: entry.name,
        type: entry.type,
        target: { targetKey: String(entry.target.targetKey), displayPath: entry.target.displayPath },
        ...entry.version !== undefined ? { version: String(entry.version) } : {},
        ...entry.size !== undefined ? { size: entry.size } : {},
      })))
      return
    }
    case 'fs.writeText': {
      const t = target()
      const content = payload.content
      if (t === undefined || typeof content !== 'string') { await fail('bad-payload', 'target and content are required'); return }
      const outcome = await ctx.fs.writeText(t, content)
      await reply({ ...outcome, version: String(outcome.version) })
      return
    }
    case 'fs.editText': {
      const t = target()
      const edit = payload.edit
      if (t === undefined || typeof edit !== 'object' || edit === null) { await fail('bad-payload', 'target and edit are required'); return }
      const outcome = await ctx.fs.editText(t, edit as Parameters<typeof ctx.fs.editText>[1])
      await reply({ ...outcome, version: String(outcome.version) })
      return
    }
    default:
      await fail('unknown-method', `runner does not serve fs method "${frame.method}"`)
  }
}
