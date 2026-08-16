/**
 * Sync gateway: the hub-side half of skill/MCP sync. A laptop's runner fetches
 * the server's skill catalog (`skill.catalog`) and MCP server inventory
 * (`mcp.configs`) at connect time, and re-fetches on a `sync.invalidate` push.
 *
 * The skill catalog is the server's own `ctx.skills` snapshot (when the server
 * composition mounts a skill registry), serialized to plain `SyncedSkill`s. The
 * laptop mounts an in-memory provider from them — no disk, no parser reuse.
 *
 * The MCP inventory is admin-maintained config (the set of MCP servers to push
 * to laptops); the server does not introspect live MCP clients. Each entry names
 * a command the laptop spawns LOCALLY, so the model-facing tools run where the
 * user's files are.
 * @module @deepseek-ai/dsh-runner-hub
 */

import type { RunnerHubService } from './index.ts'
import type { RunnerConnection } from './connection.ts'
import type { RunnerCall, SyncedSkill } from './protocol.ts'

/** Methods the sync gateway handles when invoked from a laptop. */
export const SYNC_GATEWAY_METHODS = new Set(['skill.catalog', 'mcp.configs'])

/**
 * Serve one inbound sync-gateway call: `skill.catalog` or `mcp.configs`.
 * @param hub - the hub service, for `ctx.skills` and the configured MCP inventory.
 * @param conn - the device's live runner connection (to send frames back).
 * @param call - the inbound sync call.
 */
export async function serveSyncCall(
  hub: RunnerHubService,
  conn: RunnerConnection,
  call: RunnerCall,
): Promise<void> {
  switch (call.method) {
    case 'skill.catalog':
      await serveSkillCatalog(hub, conn, call)
      return
    case 'mcp.configs':
      await serveMcpConfigs(hub, conn, call)
      return
    default:
      await conn.send({ type: 'runner-error', rpcId: call.rpcId, code: 'bad-method', message: `sync gateway got ${call.method}` })
  }
}

/**
 * Answer `skill.catalog`: snapshot the server's skill registry (if mounted) and
 * materialize every skill with its body. The laptop's provider serves the
 * results directly. When the server has no skill registry, the reply is empty
 * rather than an error — a deployment need not mount skills server-side.
 */
async function serveSkillCatalog(
  hub: RunnerHubService,
  conn: RunnerConnection,
  call: RunnerCall,
): Promise<void> {
  const skills = await hub.snapshotSkills()
  await conn.send({ type: 'runner-response', rpcId: call.rpcId, result: { skills } })
}

/**
 * Answer `mcp.configs`: return the admin-maintained MCP server inventory. Each
 * entry is a command the laptop spawns locally.
 */
async function serveMcpConfigs(
  hub: RunnerHubService,
  conn: RunnerConnection,
  call: RunnerCall,
): Promise<void> {
  await conn.send({ type: 'runner-response', rpcId: call.rpcId, result: { servers: hub.mcpInventory() } })
}

/**
 * Map a server-side skill summary + body into a serializable {@link SyncedSkill}.
 * The provider name is rewritten to the laptop-side label so the in-memory
 * candidate validates (`candidate.provider === provider.name`).
 * @param skill - the server's skill definition (name, description, body, ...).
 * @returns the plain-data sync shape.
 */
export function toSyncedSkill(skill: {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly invocation: { readonly modelInvocable: boolean; readonly userInvocable: boolean }
  readonly source: string
  readonly provider: string
  readonly content: string
  readonly metadata?: Readonly<Record<string, unknown>>
}): SyncedSkill {
  return {
    name: skill.name,
    description: skill.description,
    ...skill.whenToUse !== undefined ? { whenToUse: skill.whenToUse } : {},
    invocation: skill.invocation,
    source: skill.source,
    provider: 'runner-sync',
    content: skill.content,
    ...skill.metadata !== undefined ? { metadata: skill.metadata } : {},
  }
}

/** The laptop-facing MCP server config type (re-exported for the inventory). */
export type { SyncedMcpServer } from './protocol.ts'
