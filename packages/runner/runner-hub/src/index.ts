/**
 * @deepseek-ai/dsh-runner-hub — the server-side coordinator for the
 * remote-workspace runner. Each authenticated user's laptop opens a
 * bidirectional WebSocket on `/runner/channel`; the hub holds one
 * {@link RunnerConnection} per (user, device) and exposes the registry as the
 * `ctx.runnerHub` service. Remote capability providers (and the LLM gateway)
 * resolve a device's connection and invoke methods on the laptop over it.
 *
 * One credential may be installed on several laptops. The hub therefore keys
 * connections by `(userId, deviceId)` — NOT one connection per user. A second
 * laptop on the same credential coexists with the first; only a re-connect of
 * the SAME device replaces its own stale socket. An offline device surfaces as
 * an undefined {@link getConnection} result so a caller reports "runner
 * offline" instead of silently killing a different laptop's session.
 *
 * The upgrade is gated by the same fence the `/api` route uses — the
 * DNS-rebinding `isTrustedApiRequest` check runs first, then the auth cookie
 * gate — so an unauthenticated or rebinding request is rejected before a socket
 * is negotiated.
 *
 * @module @deepseek-ai/dsh-runner-hub
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { WebSocketServer } from 'ws'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { isTrustedApiRequest, rejectWebSocketUpgrade } from '@deepseek-ai/dsh-client-connection'
import type { AuthSimpleService } from '@deepseek-ai/dsh-auth-simple'
import type { GenerateOptions, StreamChunk, LlmModelInfo } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-skill'
import { RunnerConnection } from './connection.ts'
import { LLM_GATEWAY_METHODS, serveLlmStream } from './llm-gateway.ts'
import { SYNC_GATEWAY_METHODS, serveSyncCall, toSyncedSkill } from './sync-gateway.ts'
import { ADMIN_GATEWAY_METHODS, serveAdminCall } from './admin-gateway.ts'
import type { SyncedMcpServer, SyncedSkill } from './protocol.ts'

export { RunnerConnection } from './connection.ts'
export * from './protocol.ts'

/** Stable Cordis plugin name. */
export const name = 'runner-hub'

/** The hub needs the webserver for the upgrade route, authSimple for the cookie gate, and llm for the gateway. */
export const inject = ['webServer', 'authSimple', 'llm']

/** Plugin configuration: the deployment's trusted serving authorities and synced MCP inventory. */
export interface Config {
  /** Authorities this deployment serves beyond loopback (mirrors ConnectionConfig.trustedHosts). */
  trustedHosts?: string[]
  /** MCP server configs the hub pushes to laptops so they spawn the servers locally. */
  mcpServers?: SyncedMcpServer[]
}

export const Config: z<Config> = z.object({
  trustedHosts: z.array(String).default([]),
  mcpServers: z.array(z.object({
    transport: z.const('stdio'),
    serverName: z.string().required(),
    command: z.string().required(),
    args: z.array(String).default([]),
    env: z.dict(String).default({}),
    cwd: z.string().default(''),
    toolCallTimeoutMs: z.number().default(60_000),
  })).default([]),
}) as unknown as z<Config>

interface SchemaResolvedConfig extends Config {
  trustedHosts: string[]
  mcpServers: SyncedMcpServer[]
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Server-side hub owning per-(user,device) runner WebSocket connections. */
    runnerHub: RunnerHubService
  }
}

/** The WebSocket path the hub negotiates with each laptop. */
const RUNNER_CHANNEL_PATH = '/runner/channel'

/** The HTTP prefix the hub serves the runner admin surface under. Longer than `/api`. */
const RUNNER_API_PREFIX = '/api/runner'

/** A connected-device row the UI renders. */
export interface RunnerDeviceRow {
  /** The laptop's stable device id. */
  readonly deviceId: string
  /** Whether the underlying socket is currently open. */
  readonly connected: boolean
}

/**
 * Owns one {@link RunnerConnection} per (user, device) and the `noServer`
 * WebSocket acceptor that negotiates them. Capability providers look up a
 * device's connection via {@link getConnection}.
 */
export class RunnerHubService extends Service {
  /** userId → deviceId → connection. A user with two laptops has two entries. */
  private readonly connections = new Map<string, Map<string, RunnerConnection>>()
  private readonly server = new WebSocketServer({ noServer: true })
  private readonly trustedHosts: readonly string[]
  /** Admin-maintained MCP server configs pushed to laptops for local spawn. */
  private readonly mcpServers: readonly SyncedMcpServer[]

  /**
   * @param ctx - plugin context with webServer, connection, and authSimple injected.
   * @param config - resolved plugin config (schema defaults applied).
   */
  constructor(ctx: Context, config: SchemaResolvedConfig) {
    super(ctx, 'runnerHub')
    this.trustedHosts = config.trustedHosts
    this.mcpServers = config.mcpServers

    ctx.effect(() => ctx.webServer.registerUpgrade({
      path: RUNNER_CHANNEL_PATH,
      handler: (req, socket, head) => { this.handleUpgrade(req, socket, head) },
    }), 'runner-hub: /runner/channel upgrade')

    // The admin web surface for runner devices. A longer prefix than `/api`, so
    // the webserver's longest-prefix match routes `/api/runner/*` here, not to
    // the connection RPC bridge — exactly as `/api/auth` already works over
    // `/api`. Gated by the same trust fence + session cookie as the channel
    // upgrade, and scoped per-userId: every read/dispatch sees only the caller's
    // own `getDevices(userId)`. That scoping is the auth gate for this
    // single-user deployment; the multi-user role gate is a later phase.
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: RUNNER_API_PREFIX,
      handler: (req, res) => { void this.handleRunnerApi(req, res) },
    }), 'runner-hub: /api/runner routes')

    // The server catalog is process-wide. When any provider/model topology
    // changes (a `settings.yaml` edit hot-reloads `llm-deepseek`/`llm-pi-ai`,
    // which re-registers its route and emits `llm/adapters-updated`), push a
    // `catalog.invalidate` to every connected laptop so it re-fetches
    // `model.list` instead of advertising the catalog it cached at connect.
    ctx.effect(() => ctx.on('llm/adapters-updated', () => { this.invalidateCatalogForAll() }), 'runner-hub: catalog refresh')

    ctx.effect(() => async () => {
      for (const devices of this.connections.values()) {
        for (const conn of devices.values()) { conn.dispose(new Error('hub shutting down')) }
      }
      this.connections.clear()
      await new Promise<void>((resolve) => { this.server.close(() => { resolve() }) })
    }, 'runner-hub: teardown')
  }

  /**
   * The live runner connection for one device of a user, or undefined when that
   * device is not connected. Capability providers call this per-operation; an
   * undefined result surfaces as a clear "runner offline" tool error to the
   * agent (NOT a silent kill of another device on the same credential).
   * @param userId - the authenticated user id.
   * @param deviceId - the laptop's stable device id (from `?device=` at upgrade).
   * @returns the connection, or undefined.
   */
  getConnection(userId: string, deviceId: string): RunnerConnection | undefined {
    return this.connections.get(userId)?.get(deviceId)
  }

  /**
   * The live runner connections for every device of a user (for sync fan-out
   * and multi-device fan-out), or the empty array when the user has none.
   * @param userId - the authenticated user id.
   * @returns the connections, in unspecified order.
   */
  getDevices(userId: string): readonly RunnerConnection[] {
    return [...(this.connections.get(userId)?.values() ?? [])]
  }

  /** All currently-connected users (for diagnostics). */
  get connectedUsers(): readonly string[] {
    return [...this.connections.keys()]
  }

  /**
   * Whether one device of a user currently has an open channel. The workspace
   * entity consults this for a remote workspace's `status()` and the api-proxy
   * prompt gate rejects new turns while it is false.
   * @param userId - the authenticated user id.
   * @param deviceId - the laptop's stable device id.
   * @returns whether the device's socket is open.
   */
  isDeviceOnline(userId: string, deviceId: string): boolean {
    return this.getConnection(userId, deviceId)?.isOpen === true
  }

  /**
   * Stream one LLM call through the server's local LLM service (which holds
   * the central API key). The LLM gateway forwards the laptop's request here
   * and streams the resulting chunks back over the device's WebSocket.
   * @param options - the request from the laptop; any caller signal is
   * stripped by the gateway (the laptop expresses cancel as a control frame).
   * @returns the chunk stream from the server's adapter.
   */
  streamLlm(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.ctx.llm.stream(options)
  }

  /**
   * Return the server's model catalog for one provider route. The LLM gateway
   * answers `model.list` with this; the laptop's remote adapter advertises the
   * result, so the server's catalog is the single source of truth.
   * @param provider - a registered provider route (e.g. `deepseek-official`).
   * @returns detached model metadata in adapter-preferred order.
   */
  listModelsForProvider(provider: string): Promise<readonly LlmModelInfo[]> {
    return this.ctx.llm.listModels(provider)
  }

  /**
   * Snapshot the server's skill catalog with full bodies, serialized for sync.
   * Called by the sync gateway to answer `skill.catalog`. When the server
   * composition mounts no skill registry, the reply is empty (a deployment need
   * not mount skills server-side). Each skill is re-materialized with the
   * laptop-side provider label so the laptop's in-memory candidate validates.
   * @returns the synced skills, fully materialized.
   */
  async snapshotSkills(): Promise<readonly SyncedSkill[]> {
    const skills = this.ctx.get('skills')
    if (skills === undefined) return []
    const summaries = await skills.list()
    const result: SyncedSkill[] = []
    for (const summary of summaries) {
      const definition = await skills.get(summary.name)
      if (definition === undefined) continue
      result.push(toSyncedSkill(definition))
    }
    return result
  }

  /**
   * The admin-maintained MCP server inventory the hub pushes to laptops. Called
   * by the sync gateway to answer `mcp.configs`. Each entry names a command the
   * laptop spawns LOCALLY, so the model-facing tools run where the user's files
   * are.
   * @returns the MCP server configs to mount on the laptop.
   */
  mcpInventory(): readonly SyncedMcpServer[] {
    return this.mcpServers
  }

  /**
   * The caller's connected devices as plain rows for the UI. Scoped to one user:
   * the route handler passes the cookie-derived userId, so a user sees only
   * their own laptops.
   * @param userId - the authenticated user id.
   * @returns the device rows, in unspecified order.
   */
  listDevices(userId: string): readonly RunnerDeviceRow[] {
    return this.getDevices(userId).map(conn => ({ deviceId: conn.deviceId, connected: conn.isOpen }))
  }

  /**
   * Push a `sync.invalidate` to every connected device of a user, so laptops
   * re-fetch the changed catalog. Called when the server's skill catalog or MCP
   * inventory changes (e.g. on `skills/change` or an admin MCP config edit).
   * @param userId - the user whose connected laptops should re-sync.
   * @param kind - which catalog changed.
   */
  invalidateSync(userId: string, kind: 'skill' | 'mcp'): void {
    for (const conn of this.getDevices(userId)) {
      if (conn.isOpen) {
        const rpcId = crypto.randomUUID()
        void conn.send({ type: 'runner-call', rpcId, method: 'sync.invalidate', payload: { kind } })
      }
    }
  }

  /**
   * Push a `catalog.invalidate` to EVERY connected device of EVERY user. The
   * model catalog is process-wide (one settings document for the whole server,
   * confirmed via `SettingsProvider`'s single-document shape), so a topology
   * change reaches every laptop regardless of who triggered it. Called on the
   * `llm/adapters-updated` event; each laptop re-fetches `model.list` and swaps
   * its cached remote-adapter catalog.
   */
  private invalidateCatalogForAll(): void {
    for (const devices of this.connections.values()) {
      for (const conn of devices.values()) {
        if (conn.isOpen) {
          const rpcId = crypto.randomUUID()
          void conn.send({ type: 'runner-call', rpcId, method: 'catalog.invalidate', payload: null })
        }
      }
    }
  }

  /** Negotiate one laptop's WebSocket, gated by the trust fence and auth cookie. */
  private handleUpgrade(req: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer): void {
    if (!isTrustedApiRequest(req, this.trustedHosts)) {
      rejectWebSocketUpgrade(socket)
      return
    }
    // The fence's DNS-rebinding check passed; the auth gate is the session
    // cookie. extractUserId is synchronous, but keep the accept deferred so a
    // future async auth path is a drop-in — and so the socket is never
    // negotiated before the cookie is verified.
    void this.verifyAndAccept(req, socket, head)
  }

  private async verifyAndAccept(
    req: IncomingMessage,
    socket: import('node:stream').Duplex,
    head: Buffer,
  ): Promise<void> {
    // The next line silences `require-await`: async is the contract (a future
    // auth path will await), and the call site fire-and-forgets via `void`.
    await Promise.resolve()
    const authSimple = this.ctx.get('authSimple') as AuthSimpleService | undefined
    const userId = this.extractUserId(req.headers.cookie, authSimple)
    if (userId === undefined) {
      rejectWebSocketUpgrade(socket)
      return
    }
    const deviceId = this.extractDeviceId(req)
    if (deviceId === undefined) {
      // A device id is mandatory: without it the hub cannot distinguish two
      // laptops on one credential and would regress to the silent-kill model.
      rejectWebSocketUpgrade(socket)
      return
    }
    this.server.handleUpgrade(req, socket, head, (ws) => {
      const conn = new RunnerConnection(userId, deviceId, ws)
      // Route laptop→hub method calls to the matching gateway: LLM streaming,
      // model catalog, or skill/MCP sync. Other inbound calls are unanswered.
      conn.inboundHandler = (call) => {
        if (LLM_GATEWAY_METHODS.has(call.method)) {
          void serveLlmStream(this, conn, call)
        } else if (SYNC_GATEWAY_METHODS.has(call.method)) {
          void serveSyncCall(this, conn, call)
        } else if (ADMIN_GATEWAY_METHODS.has(call.method)) {
          void serveAdminCall(conn, call)
        }
      }
      // A reconnect of the SAME device replaces only that device's stale
      // socket — another laptop on the same credential is untouched. This is
      // the fix for the Phase 1 silent-kill bug.
      let devices = this.connections.get(userId)
      if (devices === undefined) {
        devices = new Map<string, RunnerConnection>()
        this.connections.set(userId, devices)
      }
      const prior = devices.get(deviceId)
      if (prior !== undefined) prior.dispose(new Error('runner device reconnected'))
      devices.set(deviceId, conn)
      // A clean disconnect must drop this device's entry so an offline device
      // surfaces as an undefined `getConnection` result (the documented "runner
      // offline" signal), not a present-but-closed connection. The guard ensures
      // a reconnect's `prior.dispose()` (which closes the old socket and fires
      // this listener asynchronously, AFTER the new conn is already stored)
      // never deletes the replacement: `devices.get(deviceId) === conn` is false
      // for the stale socket by the time its 'close' fires.
      ws.on('close', () => {
        const userDevices = this.connections.get(userId)
        if (userDevices === undefined) return
        if (userDevices.get(deviceId) === conn) {
          userDevices.delete(deviceId)
          if (userDevices.size === 0) this.connections.delete(userId)
        }
      })
    })
  }

  /** Extract the authenticated user id from the session cookie. */
  private extractUserId(
    cookieHeader: string | undefined,
    authSimple: AuthSimpleService | undefined,
  ): string | undefined {
    if (authSimple === undefined) return undefined
    const token = authSimple.extractCookie(cookieHeader)
    if (token === undefined) return undefined
    return authSimple.verifySession(token)?.userId
  }

  /**
   * Extract the laptop's stable device id from the `?device=<id>` query
   * parameter on the upgrade URL. Required: the hub keys connections by
   * (user, device) so multiple laptops on one credential coexist.
   * @param req - the incoming upgrade request.
   * @returns the device id, or undefined when absent or empty.
   */
  private extractDeviceId(req: IncomingMessage): string | undefined {
    const url = new URL(req.url ?? '/', 'http://x')
    const value = url.searchParams.get('device')
    if (value === null || value.length === 0) return undefined
    // A device id names a machine, never a path: reject anything that could
    // escape the flat-keyed registry or read like a file path.
    if (value.includes('/') || value.includes('\\') || value === '.' || value === '..') return undefined
    return value
  }

  /**
   * Serve the `/api/runner/*` admin surface. Gated by the trust fence, then the
   * session cookie (same `extractUserId` the channel upgrade uses), then scoped
   * to the caller's own devices/tasks. A 401 when no session, a 403 on a
   * rebinding Host. Matches `handleAuthRoute`'s prefix-slice dispatch.
   */
  private async handleRunnerApi(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isTrustedApiRequest(req, this.trustedHosts)) {
      writeJson(res, 403, { error: 'forbidden' })
      return
    }
    const authSimple = this.ctx.get('authSimple') as AuthSimpleService | undefined
    const userId = this.extractUserId(req.headers.cookie, authSimple)
    if (userId === undefined) {
      writeJson(res, 401, { error: 'not authenticated' })
      return
    }
    const subPath = new URL(req.url ?? '/', 'http://x').pathname.slice(RUNNER_API_PREFIX.length)

    if (subPath === '/devices' && req.method === 'GET') {
      writeJson(res, 200, { devices: this.listDevices(userId) })
      return
    }
    if (subPath === '/workspaces' && req.method === 'POST') {
      const body = await readJsonBody(req, 65_536)
      const obj = body as Record<string, unknown> | undefined
      const deviceId = obj?.['deviceId']
      const path = obj?.['path']
      if (typeof deviceId !== 'string' || typeof path !== 'string' || path.length === 0) {
        writeJson(res, 400, { error: 'deviceId and path are required' })
        return
      }
      const conn = this.getConnection(userId, deviceId)
      if (conn === undefined || !conn.isOpen) {
        writeJson(res, 409, { error: 'device offline' })
        return
      }
      try {
        // `fs.lstat` takes a raw path (no resolved target); the laptop's
        // serveRemoteCall answers it with { version, type, size }. `fs.stat`
        // would require a pre-resolved `target`, which the hub doesn't hold
        // before the workspace exists.
        const info = await conn.call('fs.lstat', { path }) as { type?: unknown } | null | undefined
        if (info === null || info === undefined || info.type !== 'directory') {
          writeJson(res, 400, { error: 'not a directory' })
          return
        }
      } catch (error: unknown) {
        writeJson(res, 400, { error: `cannot stat path on device: ${error instanceof Error ? error.message : String(error)}` })
        return
      }
      const registry = this.ctx.get('workspaceRegistry')
      if (registry === undefined) {
        writeJson(res, 500, { error: 'workspace registry is not composed' })
        return
      }
      const workspace = await registry.createRemote(path, { userId, deviceId })
      writeJson(res, 200, { workspaceId: String(workspace.id) })
      return
    }
    if (subPath === '/browse' && req.method === 'POST') {
      const body = await readJsonBody(req, 65_536)
      const obj = body as Record<string, unknown> | undefined
      const deviceId = obj?.['deviceId']
      const path = typeof obj?.['path'] === 'string' ? obj['path'] : ''
      if (typeof deviceId !== 'string') {
        writeJson(res, 400, { error: 'deviceId is required' })
        return
      }
      const conn = this.getConnection(userId, deviceId)
      if (conn === undefined || !conn.isOpen) {
        writeJson(res, 409, { error: 'device offline' })
        return
      }
      try {
        const entry = await conn.call('fs.resolve', { path, cwd: undefined }) as {
          targetKey?: unknown
          displayPath?: unknown
        }
        const targetKey = typeof entry.targetKey === 'string' ? entry.targetKey : path
        const entries = await conn.call('fs.listDir', { target: { targetKey, displayPath: path } }) as Array<{
          name?: unknown
          type?: unknown
        }>
        const listing = {
          path,
          entries: entries.map((row, index) => ({
            name: typeof row.name === 'string' ? row.name : String(index),
            path: joinPosix(path, typeof row.name === 'string' ? row.name : ''),
            type: row.type === 'directory' ? 'directory' : row.type === 'file' ? 'file' : 'other',
          })),
          crumbs: buildCrumbs(path),
        }
        writeJson(res, 200, listing)
        return
      } catch (error: unknown) {
        writeJson(res, 400, { error: `cannot browse device path: ${error instanceof Error ? error.message : String(error)}` })
        return
      }
    }
    writeJson(res, 404, { error: 'not found' })
  }
}

/** Join a device-reported path with one child name (POSIX, the runner's world). */
function joinPosix(parent: string, name: string): string {
  if (parent === '' || parent === '/') return `/${name}`
  return `${parent.replace(/\/+$/, '')}/${name}`
}

/** Breadcrumb segments for a device path, root-first. */
function buildCrumbs(path: string): Array<{ name: string; path: string }> {
  if (path === '' || path === '/') return [{ name: '/', path: '/' }]
  const segments = path.split('/').filter(segment => segment.length > 0)
  const crumbs: Array<{ name: string; path: string }> = []
  let current = ''
  for (const segment of segments) {
    current = `${current}/${segment}`
    crumbs.push({ name: segment, path: current })
  }
  return crumbs
}

/** Write a JSON response with a status code. */
function writeJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data)
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(body)
}

/** Read and parse a JSON body up to a byte cap; undefined on parse failure / oversize. */
async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(chunk as Buffer)
    if (Buffer.concat(chunks).length > maxBytes) return undefined
  }
  const body = Buffer.concat(chunks).toString('utf8')
  if (body.length === 0) return undefined
  try {
    return JSON.parse(body) as unknown
  } catch {
    return undefined
  }
}

/**
 * Mount the hub: register the `/runner/channel` upgrade route.
 * @param ctx - plugin context with webServer, connection, and authSimple injected.
 * @param config - resolved plugin config (schema defaults applied).
 */
export function apply(ctx: Context, config?: Config): void {
  const resolved = config as SchemaResolvedConfig | undefined
  new RunnerHubService(ctx, resolved ?? { trustedHosts: [], mcpServers: [] })
}
