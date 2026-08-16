/**
 * Admin section store: the user list + role mutation over `/api/admin/*`.
 * Follows the `ui-runner-devices` store shape (snapshot store + fetch + credentials).
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'

/** One user row the table renders. */
export interface UserRow {
  /** The user id (primary key in `dsh_auth_users`). */
  readonly id: string
  /** The current role. */
  readonly role: 'user' | 'admin'
  /** The ISO `createdAt` timestamp from the DB. */
  readonly createdAt: string
}

/** Page snapshot. */
export interface AdminState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** Whole-load failure text. */
  error: string | null
  /** Every user the admin API reported. */
  users: readonly UserRow[]
  /** A userId whose role mutation is in flight (disables its buttons). */
  busyId: string | null
}

const INITIAL: AdminState = { status: 'idle', error: null, users: [], busyId: null }

const USERS_URL = '/api/admin/users'
const ROLE_URL = '/api/admin/users/role'

async function readJson(response: Response): Promise<unknown> {
  try { return await response.json() as unknown } catch { return undefined }
}

/** Reads the user list and owns the role-mutation state. */
export class AdminController {
  readonly store: SnapshotStore<AdminState> = createSnapshotStore(INITIAL)
  private disposed = false

  private set(patch: Partial<AdminState>): void {
    this.store.set({ ...this.store.getSnapshot(), ...patch })
  }

  /** Load (or reload) the user list. Idempotent. */
  async load(): Promise<void> {
    if (this.disposed) return
    if (this.store.getSnapshot().status !== 'ready') this.set({ status: 'loading' })
    try {
      const resp = await fetch(USERS_URL, { credentials: 'include' })
      if (this.disposed) return
      if (!resp.ok) {
        this.set({ status: 'error', error: resp.status === 403 ? 'forbidden' : 'load failed' })
        return
      }
      const body = await readJson(resp) as { users?: unknown } | undefined
      const users = Array.isArray(body?.users)
        ? (body.users as readonly unknown[]).map((row): UserRow => {
          const r = row as { id?: unknown; role?: unknown; createdAt?: unknown }
          return {
            id: typeof r.id === 'string' ? r.id : '',
            role: r.role === 'admin' ? 'admin' : 'user',
            createdAt: typeof r.createdAt === 'string' ? r.createdAt : '',
          }
        })
        : []
      this.set({ status: 'ready', error: null, users })
    } catch {
      if (!this.disposed) this.set({ status: 'error', error: 'network' })
    }
  }

  /** Flip one user's role. */
  async setRole(userId: string, role: 'user' | 'admin'): Promise<boolean> {
    if (this.disposed) return false
    this.set({ busyId: userId })
    try {
      const resp = await fetch(ROLE_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ id: userId, role }),
      })
      if (this.disposed) return false
      this.set({ busyId: null })
      if (!resp.ok) {
        const body = await readJson(resp)
        const message = (body as { error?: unknown } | undefined)?.error
        const error = typeof message === 'string' ? message : 'update failed'
        this.set({ error })
        return false
      }
      await this.load()
      return true
    } catch (error: unknown) {
      if (!this.disposed) this.set({ busyId: null, error: error instanceof Error ? error.message : 'network' })
      return false
    }
  }

  dispose(): void { this.disposed = true }
}
