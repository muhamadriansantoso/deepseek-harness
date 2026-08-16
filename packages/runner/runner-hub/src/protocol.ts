/**
 * Bidirectional frame protocol for the `/runner/channel` WebSocket.
 *
 * Unlike the browser downlinks (which are strictly server→client and close
 * with code 1008 on any client message — see
 * `packages/client/connection/src/websocket-downlink.ts`), the runner channel
 * is fully bidirectional: the hub invokes methods on the laptop and the
 * laptop invokes the LLM gateway on the hub. Every frame carries a `rpcId`
 * (UUID) that correlates a request with its response and its streaming
 * chunks.
 *
 * Frames are JSON objects. Binary payloads (stdout/stderr/PTY/stdin bytes) are
 * base64-encoded into the `data` field of a `runner-stream` frame; the LLM
 * gateway streams `StreamChunk`s as JSON objects in the same envelope.
 * @module @deepseek-ai/dsh-runner-hub/protocol
 */

/** Discriminant for every frame on the channel. */
export type RunnerFrameType =
  | 'runner-call'
  | 'runner-response'
  | 'runner-error'
  | 'runner-stream'
  | 'runner-exit'

/** Methods the hub may invoke on a connected laptop. */
export type HubToRunnerMethod =
  | 'subprocess.spawn'
  | 'subprocess.resolveExecutable'
  | 'subprocess.resolveRgPath'
  | 'subprocess.terminate'
  | 'subprocess.spawnTerminal'
  | 'terminal.write'
  | 'terminal.signalForeground'
  | 'terminal.inspectForeground'
  | 'terminal.terminate'
  | 'fs.resolve'
  | 'fs.stat'
  | 'fs.lstat'
  | 'fs.readText'
  | 'fs.readBytes'
  | 'fs.streamText'
  | 'fs.listDir'
  | 'fs.writeText'
  | 'fs.editText'
  | 'skill.sync'
  | 'mcp.sync'
  | 'control.workspace'
  /** Hub→laptop push: a synced catalog changed; the laptop re-fetches it. */
  | 'sync.invalidate'
  /** Hub→laptop push: the server model catalog changed; the laptop re-fetches `model.list`. */
  | 'catalog.invalidate'
  /** Hub→laptop: run one task through the local agent loop; the laptop answers with the result text. */
  | 'task.run'

/** Methods a connected laptop may invoke on the hub. */
export type RunnerToHubMethod =
  | 'llm.stream'
  | 'llm.complete'
  | 'model.list'
  | 'model.set'
  | 'provider.update'
  /** Laptop→hub: fetch the server's skill catalog (summaries + bodies). */
  | 'skill.catalog'
  /** Laptop→hub: fetch the server's MCP server config inventory to mount locally. */
  | 'mcp.configs'

/** A request frame: hub→laptop or laptop→hub, carrying a method call. */
export interface RunnerCall {
  readonly type: 'runner-call'
  /** Correlation id echoed on the matching response/stream/exit frames. */
  readonly rpcId: string
  /** The method to invoke; one of {@link HubToRunnerMethod} or {@link RunnerToHubMethod}. */
  readonly method: HubToRunnerMethod | RunnerToHubMethod
  /** Method arguments. */
  readonly payload: unknown
}

/** A unary success response for a {@link RunnerCall}. */
export interface RunnerResponse {
  readonly type: 'runner-response'
  /** The rpcId of the call this answers. */
  readonly rpcId: string
  /** The method's return value. */
  readonly result: unknown
}

/** A unary error response for a {@link RunnerCall}. */
export interface RunnerError {
  readonly type: 'runner-error'
  /** The rpcId of the call this answers. */
  readonly rpcId: string
  /** Machine-readable error code. */
  readonly code: string
  /** Human-readable error message. */
  readonly message: string
}

/** Kind of one streaming chunk within a {@link RunnerStream} frame. */
export type RunnerStreamKind =
  | 'stdout'
  | 'stderr'
  | 'stdin'
  | 'pty'
  | 'pid'
  | 'llm-token'

/**
 * A streaming chunk for an in-flight {@link RunnerCall}. For `stdout`,
 * `stderr`, `stdin`, `pty`, and `llm-token` (binary/text), `data` is base64.
 * For `pid`, `data` is the decimal pid string. For `llm-token`, `data` is a
 * JSON-encoded `StreamChunk`.
 */
export interface RunnerStream {
  readonly type: 'runner-stream'
  /** The rpcId of the streaming call this chunk belongs to. */
  readonly rpcId: string
  /** What the chunk carries. */
  readonly kind: RunnerStreamKind
  /** base64 bytes (or pid/JSON text) depending on {@link kind}. */
  readonly data: string
}

/** A process or terminal exit for an in-flight streaming call. */
export interface RunnerExit {
  readonly type: 'runner-exit'
  /** The rpcId of the streaming call that exited. */
  readonly rpcId: string
  /** Exit code, or null when killed by a signal. */
  readonly exitCode: number | null
  /** Signal name, or null for a normal exit. */
  readonly signal: string | null
}

/** Any frame on the channel. */
export type RunnerFrame =
  | RunnerCall
  | RunnerResponse
  | RunnerError
  | RunnerStream
  | RunnerExit

/** A pending call awaiting a unary response. */
export interface PendingUnary {
  readonly resolve: (result: unknown) => void
  readonly reject: (error: Error) => void
}

/** A pending streaming call awaiting stream chunks and an exit. */
export interface PendingStream {
  /** Delivered for each `runner-stream` chunk of this rpcId. */
  readonly onChunk: (chunk: RunnerStream) => void
  /** Delivered on `runner-exit`; rejects on `runner-error`/disconnect. */
  readonly resolve: (exit: RunnerExit) => void
  readonly reject: (error: Error) => void
}

// ── sync payload shapes (JSON-serializable; cross the WS as `runner-call`/`runner-response`) ───

/**
 * A server-synced skill, fully materialized. The hub's `skill.catalog` reply
 * carries one of these per catalog entry: the laptop's in-memory provider
 * serves these directly as `SkillDefinition`s with no disk I/O. Fields mirror
 * the skill registry's `SkillDefinition` but are plain data — no `locator`,
 * no functions — so the whole catalog serializes as one JSON response.
 */
export interface SyncedSkill {
  /** Kebab-case skill name. */
  readonly name: string
  /** Short routing description. */
  readonly description: string
  /** Optional extra routing guidance. */
  readonly whenToUse?: string
  /** Resolved invocation controls. */
  readonly invocation: { readonly modelInvocable: boolean; readonly userInvocable: boolean }
  /** Discovery source label (e.g. `synced`). */
  readonly source: string
  /** Provider label the laptop advertises (e.g. `runner-sync`). */
  readonly provider: string
  /** Markdown instruction body. */
  readonly content: string
  /** Optional parsed metadata object. */
  readonly metadata?: Readonly<Record<string, unknown>>
}

/**
 * The reply to a `skill.catalog` call: every synced skill, fully materialized.
 * The laptop registers one in-memory `SkillProvider` whose `list()` returns a
 * candidate per entry and whose `get()` returns the matching definition.
 */
export interface SkillCatalogReply {
  readonly skills: readonly SyncedSkill[]
}

/**
 * A server-synced MCP server config — plain data mirroring `dsh-mcp-client`'s
 * `StdioConfig`/`StreamableHttpConfig`. The laptop mounts each via a scoped
 * `apply(ctx, config)` so the server process spawns LOCALLY on the laptop.
 */
export interface SyncedMcpServer {
  /** Transport kind — only `stdio` is synced (the laptop spawns the server locally). */
  readonly transport: 'stdio'
  /** Unique namespace, ^[A-Za-z0-9_-]{1,32}$, namespacing `mcp__<server>__<tool>`. */
  readonly serverName: string
  /** Executable to spawn on the laptop. */
  readonly command: string
  /** Arguments, verbatim. */
  readonly args?: readonly string[]
  /** Per-server environment merged over the scrubbed ambient env. */
  readonly env?: Readonly<Record<string, string>>
  /** Working directory for the spawned server. */
  readonly cwd?: string
  /** Per-tool-call timeout in milliseconds (optional; the mcp-client default applies when omitted). */
  readonly toolCallTimeoutMs?: number
}

/** The reply to a `mcp.configs` call: every MCP server config to mount locally. */
export interface McpConfigsReply {
  readonly servers: readonly SyncedMcpServer[]
}

/** The payload of a hub→laptop `sync.invalidate` push. */
export interface SyncInvalidatePayload {
  /** Which synced catalog changed; the laptop re-fetches that one. */
  readonly kind: 'skill' | 'mcp'
}

/**
 * Encode bytes as base64 for a stream frame's `data` field.
 * @param bytes - raw bytes to carry.
 * @returns base64 string.
 */
export function encodeBytes(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

/**
 * Decode a base64 `data` field back to bytes.
 * @param data - base64 string from a stream frame.
 * @returns the raw bytes.
 */
export function decodeBytes(data: string): Uint8Array {
  return Buffer.from(data, 'base64')
}

/**
 * Parse a raw WS message into a frame, or undefined when malformed.
 * @param data - the raw message bytes/string.
 * @returns the parsed frame, or undefined (caller logs and drops).
 */
export function parseFrame(data: string | Buffer): RunnerFrame | undefined {
  let value: unknown
  try {
    value = JSON.parse(typeof data === 'string' ? data : data.toString('utf8'))
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const frame = value as { type?: unknown }
  switch (frame.type) {
    case 'runner-call':
    case 'runner-response':
    case 'runner-error':
    case 'runner-stream':
    case 'runner-exit':
      return value as RunnerFrame
    default:
      return undefined
  }
}

/**
 * Serialize a frame for sending over the WebSocket.
 * @param frame - the frame to send.
 * @returns the JSON string to pass to `ws.send`.
 */
export function serializeFrame(frame: RunnerFrame): string {
  return JSON.stringify(frame)
}
