/**
 * Package-private workspace entity: the single {@link Workspace}
 * implementation. Holds a record snapshot that is swapped in place after each
 * durable mutation; every write funnels through the private `mutate` so
 * `updatedAt` stamping and invalid-account pruning happen exactly once.
 * Not re-exported from the package entrypoint — consumers see only the
 * `Workspace` interface.
 * @module @deepseek-ai/dsh-workspace/src/entity
 */

import { stat } from 'node:fs/promises'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { WorkspaceRecord } from './spec.ts'
import type { Workspace, WorkspaceId } from './types.ts'
import { realpathNormalize } from './paths.ts'

/** An insertSessionBefore request named a session or anchor not on the account (storage failures stay plain errors). */
export class WorkspaceMoveInvalidError extends Error {
  /**
   * @param message - Which id was unaccounted and where.
   */
  constructor(message: string) {
    super(message)
    this.name = 'WorkspaceMoveInvalidError'
  }
}

/**
 * The registry-owned machinery an entity mutates through. Entities never see
 * the registry itself — only the open table, the canonical session-path
 * index backing the `sessionIds` projection, and attach-time header reads.
 */
export interface WorkspaceEntityHost {
  /**
   * Resolve the open `workspaces` table.
   * @returns the table; throws while the registry has not started yet.
   */
  table(): KvTable<WorkspaceId, WorkspaceRecord>

  /**
   * Read a session's canonical directory from the registry's header index.
   * @param id - Session whose indexed path is requested.
   * @returns the canonical directory, or `undefined` when the header is
   * missing or its cwd cannot identify an existing directory.
   */
  sessionPath(id: SessionId): string | undefined

  /**
   * Read one stored session header for attach validation.
   * @param id - The session whose header to read.
   * @returns the header; rejects when session persistence is absent or holds
   * no session with this id.
   */
  readSessionHeader(id: SessionId): Promise<SessionHeader>

  /**
   * Publish a successfully validated canonical cwd to the projection index.
   * @param id - Validated session id.
   * @param path - Canonical existing directory from the immutable header cwd.
   */
  rememberSessionPath(id: SessionId, path: string): void

  /**
   * Whether the runner device backing a remote workspace is currently
   * connected. Consulted by {@link Workspace.status} for remote records; a
   * registry without a composed runner hub answers `false` (no device can be
   * checked).
   * @param userId - Hub account hosting the device connection.
   * @param deviceId - The device whose liveness is asked.
   * @returns whether the device's channel is open.
   */
  checkRemote(userId: string, deviceId: string): Promise<boolean>
}

/** Chain-slot abort sentinel thrown by the update fn when the record needs no change; only `mutate` observes it. */
const unchangedSentinel = new Error('workspace record unchanged (internal sentinel)')

/** The single {@link Workspace} implementation; constructed only by the registry. */
export class WorkspaceEntity implements Workspace {
  private record: WorkspaceRecord

  /**
   * @param host - Registry-owned table, session-path index, and header reads.
   * @param id - The record's stable id.
   * @param record - The validated record snapshot loaded or just written.
   */
  constructor(
    private readonly host: WorkspaceEntityHost,
    readonly id: WorkspaceId,
    record: WorkspaceRecord,
  ) {
    this.record = record
  }

  get path(): string {
    return this.record.path
  }

  get title(): string {
    return this.record.title
  }

  get createdAt(): string {
    return this.record.createdAt
  }

  get updatedAt(): string {
    return this.record.updatedAt
  }

  get sessionIds(): readonly SessionId[] {
    return this.record.sessionIds.filter(id => this.host.sessionPath(id) === this.record.path)
  }

  /**
   * The runner device backing this workspace, when it is a remote (laptop)
   * workspace. `undefined` for ordinary host-directory workspaces.
   */
  get remote(): { readonly userId: string; readonly deviceId: string } | undefined {
    return this.record.remote
  }

  /**
   * The authenticated userId that owns this workspace, the per-user scoping
   * key. For a remote workspace it equals {@link remote}'s `userId` (the user
   * who attached their laptop folder). `undefined` marks a legacy record
   * (written before ownership was stamped) or an auth-less single-user
   * deployment; such records are shared — visible to every authenticated user —
   * and lazily stamped to the first user who mutates one.
   */
  get owner(): string | undefined {
    return this.record.owner
  }

  /**
   * Skill names auto-loaded for every session in this workspace, in
   * selection order; an empty array means no defaults.
   */
  get defaultSkills(): string[] {
    return this.record.defaultSkills
  }

  async setDefaultSkills(names: readonly string[]): Promise<void> {
    await this.mutate(record =>
      record.defaultSkills.length === names.length
      && names.every((name, index) => record.defaultSkills[index] === name)
        ? record
        : { ...record, defaultSkills: [...names] })
  }

  async setTitle(title: string): Promise<void> {
    await this.mutate(record => ({ ...record, title }))
  }

  async attachSession(sessionId: SessionId): Promise<void> {
    // Validation is skipped when the settled snapshot already accounts the
    // id: the cwd fact was checked when it first attached and both inputs
    // (stored header cwd, workspace path) are immutable. Membership itself is
    // decided on the write chain inside `mutate`, never on this snapshot.
    if (!this.record.sessionIds.includes(sessionId)) {
      const header = await this.host.readSessionHeader(sessionId)
      if (header.cwd === undefined) {
        throw new Error(
          `cannot attach session '${sessionId}' to workspace '${this.record.path}': `
          + 'its stored header carries no cwd to validate against',
        )
      }
      // A remote record's path lives on the laptop, never on this host: the
      // host-side realpath/stat canon cannot apply. The session header carries
      // the same device marker, so its string-equal cwd IS the validation.
      if (this.record.remote !== undefined) {
        if (header.deviceId !== this.record.remote.deviceId) {
          throw new Error(
            `cannot attach session '${sessionId}' to workspace '${this.record.path}': `
            + `its header device '${header.deviceId ?? '(none)'}' does not match `
            + `workspace device '${this.record.remote.deviceId}'`,
          )
        }
        if (header.cwd !== this.record.path) {
          throw new Error(
            `cannot attach session '${sessionId}' to workspace '${this.record.path}': `
            + `its cwd '${header.cwd}' differs from the workspace path`,
          )
        }
        this.host.rememberSessionPath(sessionId, header.cwd)
      } else {
        let cwd: string
        try {
          cwd = await realpathNormalize(header.cwd)
        } catch (error) {
          throw new Error(
            `cannot attach session '${sessionId}' to workspace '${this.record.path}': `
            + `its cwd '${header.cwd}' does not resolve, so it cannot be validated`,
            { cause: error },
          )
        }
        if (!(await stat(cwd)).isDirectory()) {
          throw new Error(
            `cannot attach session '${sessionId}' to workspace '${this.record.path}': `
            + `its cwd '${header.cwd}' is not a directory`,
          )
        }
        if (cwd !== this.record.path) {
          throw new Error(
            `cannot attach session '${sessionId}' to workspace '${this.record.path}': `
            + `its cwd resolves to '${cwd}'`,
          )
        }
        this.host.rememberSessionPath(sessionId, cwd)
      }
    }
    await this.mutate(record => record.sessionIds.includes(sessionId)
      ? record
      : { ...record, sessionIds: [sessionId, ...record.sessionIds] })
  }

  async insertSessionBefore(sessionId: SessionId, beforeSessionId?: SessionId): Promise<void> {
    await this.mutate((record) => {
      if (!record.sessionIds.includes(sessionId)) {
        throw new WorkspaceMoveInvalidError(
          `cannot move session '${sessionId}' in workspace '${record.path}': the session is not accounted`,
        )
      }
      if (beforeSessionId !== undefined && !record.sessionIds.includes(beforeSessionId)) {
        throw new WorkspaceMoveInvalidError(
          `cannot move session '${sessionId}' before '${beforeSessionId}' in workspace '${record.path}': `
          + 'the anchor session is not accounted',
        )
      }
      if (beforeSessionId === sessionId) return record
      const without = record.sessionIds.filter(id => id !== sessionId)
      const at = beforeSessionId === undefined ? without.length : without.indexOf(beforeSessionId)
      const sessionIds = [...without.slice(0, at), sessionId, ...without.slice(at)]
      return sessionIds.every((id, index) => id === record.sessionIds[index])
        ? record
        : { ...record, sessionIds }
    })
  }

  async detachSession(sessionId: SessionId): Promise<void> {
    await this.mutate(record => record.sessionIds.includes(sessionId)
      ? { ...record, sessionIds: record.sessionIds.filter(id => id !== sessionId) }
      : record)
  }

  async setOwner(userId: string): Promise<void> {
    await this.mutate(record => record.owner === userId ? record : { ...record, owner: userId })
  }

  async status(): Promise<'ok' | 'missing-dir'> {
    const remote = this.record.remote
    if (remote !== undefined) {
      // "The directory exists" is the device being reachable: the path cannot
      // be stat'd from this host by construction.
      return (await this.host.checkRemote(remote.userId, remote.deviceId)) ? 'ok' : 'missing-dir'
    }
    try {
      return (await stat(this.record.path)).isDirectory() ? 'ok' : 'missing-dir'
    } catch {
      // Any stat failure (ENOENT, dangling parent, permission loss) means the
      // directory is not usable right now; the record itself never mutates.
      return 'missing-dir'
    }
  }

  /**
   * The single write path: run `fn` on the domain write chain via
   * `table.update`, stamping `updatedAt` and pruning candidates that no
   * longer pass the id-plus-canonical-cwd membership check, then swap the
   * snapshot.
   *
   * `fn` sees the value current at its chain slot, so membership decisions
   * (attach/detach idempotence) are race-free against queued writes; a fn
   * signalling no change by returning `current` verbatim aborts the slot
   * through the sentinel when pruning also finds nothing, so a no-op neither
   * rewrites the medium nor emits a change event.
   */
  private async mutate(fn: (record: WorkspaceRecord) => WorkspaceRecord): Promise<void> {
    let next: WorkspaceRecord
    try {
      next = await this.host.table().update(this.id, (current) => {
        const changed = fn(current)
        const sessionIds = changed.sessionIds.filter(
          id => this.host.sessionPath(id) === changed.path,
        )
        if (changed === current && sessionIds.length === current.sessionIds.length) {
          throw unchangedSentinel
        }
        return { ...changed, sessionIds, updatedAt: new Date().toISOString() }
      })
    } catch (error) {
      if (error === unchangedSentinel) return
      throw error
    }
    this.record = next
  }
}
