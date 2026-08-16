/**
 * Admin gateway: the hub-side half of catalog-mutation control. A laptop's
 * runner may attempt `model.set` / `provider.update`; this gateway **always**
 * rejects them — for admin and non-admin alike.
 *
 * The super-admin's lever is server access (edit `~/.dsh/settings.yaml`, which
 * `llm-deepseek` / `llm-pi-ai` hot-reload), NOT an in-process membership gate.
 * So the runner channel is read-only for the catalog: `model.list` reads stay
 * served by the LLM gateway, while every mutation is refused with `forbidden`
 * (defense-in-depth — the hub answers rather than silently dropping the frame).
 * When the server catalog does change, the hub pushes `catalog.invalidate` so
 * laptops re-fetch (see {@link RunnerHubService.invalidateCatalogForAll}).
 * @module @deepseek-ai/dsh-runner-hub
 */

import type { RunnerConnection } from './connection.ts'
import type { RunnerCall } from './protocol.ts'

/** Methods the admin gateway handles (and refuses) when invoked from a laptop. */
export const ADMIN_GATEWAY_METHODS = new Set(['model.set', 'provider.update'])

/**
 * Serve one inbound admin-gateway call: refuse it unconditionally. No `userId`
 * check — rejection is the same for every caller, so the catalog is read-only
 * over the runner channel regardless of who is connected.
 * @param conn - the device's live runner connection (to send the error frame back).
 * @param call - the inbound mutation call (`model.set` / `provider.update`).
 */
export async function serveAdminCall(conn: RunnerConnection, call: RunnerCall): Promise<void> {
  await conn.send({
    type: 'runner-error',
    rpcId: call.rpcId,
    code: 'forbidden',
    message: 'catalog mutation over the runner channel is not permitted; edit settings.yaml on the server',
  })
}
