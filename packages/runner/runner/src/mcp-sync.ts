/**
 * Laptop-side MCP sync: mount each server the hub advertises as a local
 * `dsh-mcp-client` instance, so the model-facing tools spawn and run ON THIS
 * LAPTOP (where the user's files are), not on the server.
 *
 * mcp-client is NOT a loader row here — its `apply(ctx, config)` needs the
 * synced config that arrives over the runner channel after connect, so the
 * runner mounts it programmatically through a scoped `ctx.plugin` fiber per
 * server (the same direct-mount pattern the runner uses for `dsh-llm-remote`).
 * Each fiber's `dispose()` unmounts one server; on refresh the runner disposes
 * fibers for dropped or changed servers and mounts the new set. Intra-server
 * tool refresh and reconnect are handled internally by mcp-client.
 * @module @deepseek-ai/dsh-runner
 */

import type { Context } from '@deepseek-ai/cordis'
import * as mcpClient from '@deepseek-ai/dsh-mcp-client'
import type { Config as McpClientConfig } from '@deepseek-ai/dsh-mcp-client'
import type { SyncedMcpServer } from '@deepseek-ai/dsh-runner-hub/src/protocol.ts'
import type { RunnerTransport } from './transport.ts'

/**
 * Handle returned by {@link mountMcpSync}; {@link refresh} re-syncs the local
 * MCP mounts from the server's inventory.
 */
export interface RunnerMcpSync {
  /** Re-fetch the server's MCP inventory and reconcile the local mounts. */
  refresh(): Promise<void>
}

/** The default per-call timeout mcp-client applies when the server omits one. */
const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60_000

/** A mounted server's fiber disposer, keyed by server name for reconciliation. */
interface MountedServer {
  readonly dispose: () => Promise<void>
  /** The config the mount used, so a refresh can detect a change. */
  readonly config: McpClientConfig
}

/**
 * Mount each synced MCP server as a local mcp-client fiber, and return a
 * handle whose `refresh()` reconciles the local mounts against the server's
 * latest inventory.
 *
 * Reconciliation is name-keyed: a server present on both sides is re-mounted
 * only when its config changed; a server that left the inventory is disposed;
 * a new server is mounted. Mounting is best-effort — a server that fails to
 * spawn (missing binary, bad command) logs and is skipped, so one bad server
 * cannot break the whole tool surface.
 * @param ctx - plugin context carrying `ctx.tools` (after the loader has settled).
 * @param transport - the runner channel used to fetch the server's MCP inventory.
 * @returns the sync handle (a no-op when `ctx.tools` is unavailable).
 */
export function mountMcpSync(ctx: Context, transport: RunnerTransport): RunnerMcpSync {
  if (ctx.get('tools') === undefined) {
    ctx.logger.warn('dsh-runner: ctx.tools unavailable — server MCP sync disabled')
    return { async refresh() {} }
  }

  const mounted = new Map<string, MountedServer>()

  const sync = async (servers: readonly SyncedMcpServer[]): Promise<void> => {
    const next = new Map<string, McpClientConfig>()
    for (const server of servers) {
      next.set(server.serverName, toConfig(server))
    }

    // Dispose servers that left the inventory or whose config changed.
    for (const [name, mountedServer] of mounted) {
      const nextConfig = next.get(name)
      if (nextConfig === undefined || !sameConfig(nextConfig, mountedServer.config)) {
        await mountedServer.dispose().catch((error: unknown) => {
          ctx.logger.warn(`dsh-runner: disposing MCP server "${name}" failed: ${error instanceof Error ? error.message : String(error)}`)
        })
        mounted.delete(name)
      }
    }

    // Mount servers that are new or changed (the changed ones were disposed above).
    for (const [name, config] of next) {
      if (mounted.has(name)) continue
      try {
        // Mount the full mcp-client module namespace — not just its `apply` — so
        // the plugin's `inject: ['tools']` declaration and `Config` schema are
        // honored (the same shape the loader resolves from a cordis.yml row).
        const fiber = await ctx.plugin(mcpClient, config)
        mounted.set(name, { dispose: () => fiber.dispose(), config })
      } catch (error: unknown) {
        ctx.logger.warn(`dsh-runner: mounting MCP server "${name}" failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  // Tear down every mount when the runner-driver fiber disposes, so spawned
  // child processes never outlive the runner.
  ctx.effect(() => () => {
    for (const server of mounted.values()) {
      void server.dispose().catch(() => {})
    }
    mounted.clear()
  }, 'dsh-runner: mcp sync mounts')

  return {
    async refresh(): Promise<void> {
      try {
        await sync(await transport.fetchMcpConfigs())
      } catch (error: unknown) {
        ctx.logger.warn(`dsh-runner: mcp sync failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    },
  }
}

/** Map a synced server config to the mcp-client config the laptop mounts. */
function toConfig(server: SyncedMcpServer): McpClientConfig {
  const config: McpClientConfig = {
    transport: 'stdio',
    serverName: server.serverName,
    command: server.command,
    args: server.args !== undefined ? [...server.args] : [],
    env: server.env !== undefined ? { ...server.env } : {},
    cwd: server.cwd ?? '',
    toolCallTimeoutMs: server.toolCallTimeoutMs ?? DEFAULT_TOOL_CALL_TIMEOUT_MS,
    failOnStartupError: false,
  }
  return config
}

/** Whether two mcp-client configs describe the same mount (so a refresh can skip a re-mount). */
function sameConfig(a: McpClientConfig, b: McpClientConfig): boolean {
  if (a.transport !== b.transport) return false
  if (a.serverName !== b.serverName) return false
  if (a.toolCallTimeoutMs !== b.toolCallTimeoutMs) return false
  if (a.transport === 'stdio' && b.transport === 'stdio') {
    if (a.command !== b.command) return false
    if (a.cwd !== b.cwd) return false
    if (!arrayEquals(a.args, b.args)) return false
    return recordEquals(a.env, b.env)
  }
  // streamable-http: the runner does not mount this transport today, so a
  // transport match that is not stdio falls through as a re-mount trigger.
  return false
}

function arrayEquals(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false
  }
  return true
}

function recordEquals(a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>): boolean {
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  if (aKeys.length !== bKeys.length) return false
  for (const key of aKeys) {
    if (a[key] !== b[key]) return false
  }
  return true
}
