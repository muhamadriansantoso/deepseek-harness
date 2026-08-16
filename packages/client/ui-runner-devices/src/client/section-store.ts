/**
 * Runner devices page store: the connected-laptop list plus the folder-picker
 * state that attaches a laptop directory as a server workspace, both fetched
 * from the hub's per-userId-scoped `/api/runner` HTTP API.
 *
 * The hub is the single fact source. Devices come and go as laptops connect or
 * drop. Attaching a folder verifies it ON THE LAPTOP (`fs.stat` via the
 * channel), then creates a remote workspace record server-side; the workspace
 * appears in the sidebar via the existing `host/workspace-changed` frame, so
 * no workspace UI change exists here at all.
 *
 * No cordis mirror or forwarded event feeds this surface: the browser downlink
 * broadcasts to every browser with no per-user filter, so a forwarded
 * `runner/device-connected` would leak one user's device activity to another's
 * browser. Per-userId-scoped HTTP polling is proxy-safe and leak-free.
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'

/** One connected-device row the page renders. */
export interface DeviceRow {
  /** The laptop's stable device id (from `?device=` at the runner connect). */
  readonly deviceId: string
  /** Whether the underlying socket is currently open. */
  readonly connected: boolean
}

/** One entry of a device folder listing. */
export interface BrowseEntry {
  readonly name: string
  /** Full path on the device (parent joined with the name). */
  readonly path: string
  readonly type: 'file' | 'directory' | 'other'
}

/** One breadcrumb segment of the current browse path. */
export interface BrowseCrumb {
  readonly name: string
  readonly path: string
}

/** The folder-picker state for one device. */
export interface BrowseState {
  /** The device being browsed. */
  readonly deviceId: string
  /** Current path on the device ('' = root). */
  readonly path: string
  /** The current directory's children. */
  readonly entries: readonly BrowseEntry[]
  /** Breadcrumbs root-first for the current path. */
  readonly crumbs: readonly BrowseCrumb[]
  /** Whether a browse or attach is in flight. */
  readonly busy: boolean
  /** The last failure text, cleared by the next browse. */
  readonly error: string | null
}

/** Page snapshot. */
export interface RunnerDevicesState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** Whole-load failure text. */
  error: string | null
  /** Every connected device the hub reports for this user. */
  devices: readonly DeviceRow[]
  /** The open folder-picker states, keyed by deviceId. */
  browse: Readonly<Record<string, BrowseState>>
  /** The last attach success message, cleared by the next attach. */
  attachMessage: string | null
}

const INITIAL: RunnerDevicesState = {
  status: 'idle',
  error: null,
  devices: [],
  browse: {},
  attachMessage: null,
}

/** The /api/runner endpoints (served by the hub; same origin as the UI). */
const DEVICES_URL = '/api/runner/devices'
const BROWSE_URL = '/api/runner/browse'
const WORKSPACES_URL = '/api/runner/workspaces'

/**
 * Read a JSON body or return undefined on any failure. Mirrors the host's own
 * boundary parse so a non-JSON hub reply surfaces as `undefined`, not a throw.
 * @param response - the fetch response.
 * @returns the parsed body, or undefined.
 */
async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json() as unknown
  } catch {
    return undefined
  }
}

/** Allocate the initial browse state for a fresh device. */
function initialBrowse(deviceId: string): BrowseState {
  return { deviceId, path: '', entries: [], crumbs: [], busy: false, error: null }
}

/**
 * Reads the device list and owns the folder-picker state that attaches a
 * laptop directory as a server workspace.
 */
export class RunnerDevicesController {
  /** Page snapshot the renderer subscribes to. */
  readonly store: SnapshotStore<RunnerDevicesState> = createSnapshotStore(INITIAL)
  private disposed = false

  private set(patch: Partial<RunnerDevicesState>): void {
    this.store.set({ ...this.store.getSnapshot(), ...patch })
  }

  private browseStateFor(deviceId: string): BrowseState {
    return this.store.getSnapshot().browse[deviceId] ?? initialBrowse(deviceId)
  }

  private patchBrowse(deviceId: string, patch: Partial<BrowseState>): void {
    const current = this.browseStateFor(deviceId)
    this.set({ browse: { ...this.store.getSnapshot().browse, [deviceId]: { ...current, ...patch } } })
  }

  /**
   * Load the device list. Idempotent: safe to call on mount, on reconnect, and
   * on manual retry. A device that drops while its picker is open keeps its
   * browse state (the next browse re-verifies).
   * @returns once the snapshot reflects the hub.
   */
  async load(): Promise<void> {
    if (this.disposed) return
    if (this.store.getSnapshot().status !== 'ready') this.set({ status: 'loading' })
    try {
      const resp = await fetch(DEVICES_URL, { credentials: 'include' })
      if (this.disposed) return
      if (!resp.ok) {
        this.set({ status: 'error', error: 'load failed' })
        return
      }
      const body = await readJson(resp) as { devices?: unknown } | undefined
      const devices = Array.isArray(body?.devices)
        ? (body.devices as readonly unknown[]).map((row): DeviceRow => {
          const d = row as { deviceId?: unknown; connected?: unknown }
          return { deviceId: typeof d.deviceId === 'string' ? d.deviceId : '', connected: d.connected === true }
        })
        : []
      this.set({ status: 'ready', error: null, devices })
    } catch {
      this.set({ status: 'error', error: 'network' })
    }
  }

  /**
   * Browse one device directory. Lists the children of `path` ('': root) and
   * stores entries + breadcrumbs so the picker can descend and attach.
   * @param deviceId - the laptop to browse.
   * @param path - the directory to list on the device.
   * @returns once the listing is reflected (or failed onto the browse state).
   */
  async browse(deviceId: string, path: string): Promise<void> {
    if (this.disposed || this.browseStateFor(deviceId).busy) return
    this.patchBrowse(deviceId, { busy: true, error: null })
    try {
      const resp = await fetch(BROWSE_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ deviceId, path }),
      })
      if (this.disposed) return
      const body = await readJson(resp)
      if (!resp.ok) {
        const message = (body as { error?: unknown } | undefined)?.error
        this.patchBrowse(deviceId, { busy: false, error: typeof message === 'string' ? message : 'browse failed' })
        return
      }
      const listing = body as { path?: unknown; entries?: unknown; crumbs?: unknown } | undefined
      const entries = Array.isArray(listing?.entries)
        ? (listing.entries as readonly unknown[]).map((row): BrowseEntry => {
          const e = row as { name?: unknown; path?: unknown; type?: unknown }
          return {
            name: typeof e.name === 'string' ? e.name : '',
            path: typeof e.path === 'string' ? e.path : '',
            type: e.type === 'directory' ? 'directory' : e.type === 'file' ? 'file' : 'other',
          }
        })
        : []
      const crumbs = Array.isArray(listing?.crumbs)
        ? (listing.crumbs as readonly unknown[]).map((row): BrowseCrumb => {
          const c = row as { name?: unknown; path?: unknown }
          return { name: typeof c.name === 'string' ? c.name : '', path: typeof c.path === 'string' ? c.path : '' }
        })
        : []
      this.patchBrowse(deviceId, {
        busy: false,
        path: typeof listing?.path === 'string' ? listing.path : path,
        entries,
        crumbs,
      })
    } catch (error: unknown) {
      this.patchBrowse(deviceId, { busy: false, error: error instanceof Error ? error.message : 'network' })
    }
  }

  /**
   * Attach one device directory as a server workspace. The hub verifies it is
   * a directory ON THE LAPTOP, then creates the remote workspace record; the
   * sidebar picks it up through `host/workspace-changed` with zero UI changes.
   * @param deviceId - the laptop owning the path.
   * @param path - the device directory to attach.
   * @returns whether the workspace was created.
   */
  async attachWorkspace(deviceId: string, path: string): Promise<boolean> {
    const state = this.browseStateFor(deviceId)
    if (this.disposed || state.busy) return false
    this.set({ attachMessage: null })
    this.patchBrowse(deviceId, { busy: true, error: null })
    try {
      const resp = await fetch(WORKSPACES_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ deviceId, path }),
      })
      if (this.disposed) return false
      const body = await readJson(resp)
      this.patchBrowse(deviceId, { busy: false })
      if (!resp.ok) {
        const message = (body as { error?: unknown } | undefined)?.error
        this.patchBrowse(deviceId, { error: typeof message === 'string' ? message : 'attach failed' })
        return false
      }
      this.set({ attachMessage: path })
      return true
    } catch (error: unknown) {
      this.patchBrowse(deviceId, { busy: false, error: error instanceof Error ? error.message : 'network' })
      return false
    }
  }

  /** Tear down any in-flight work. Call when the section unmounts. */
  dispose(): void {
    this.disposed = true
  }
}
