/** Host HTTP bridge for browser-client RPC. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-attachment'
// Activates the webServer Context merge used below.
import type { WebRoute, WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'
import { toFetchHandler } from '@deepseek-ai/dsh-host-apiproxy'
import { API_PATH, HOST_EVENTS_PATH, MUX_EVENTS_PATH } from './api-path.ts'
import { bridge, DEFAULT_MAX_REQUEST_BODY_BYTES } from './http-bridge.ts'
import { assertTrustedAuthority, isTrustedApiRequest } from './api-request-trust.ts'
import { HostConnectionService } from './rpc-host.ts'
import { rejectWebSocketUpgrade, WebSocketDownlinks } from './websocket-downlink.ts'
import { withPrincipal, withRole } from '@deepseek-ai/dsh-principal'

export type {
  ConnectionAuthHook,
  ConnectionRpcAuthority,
  ConnectionRpcEndpointMatcher,
  ConnectionRpcHandler,
  ConnectionRpcHandlerOptions,
  HostConnectionHandle,
  HostConnectionRpc,
  ApiTrustFenceRequest,
} from './rpc.ts'
export { HostConnectionService } from './rpc-host.ts'
export type { AuthenticatedAuth } from './rpc-host.ts'
export { withPrincipal, currentPrincipal, withRole, currentRole } from '@deepseek-ai/dsh-principal'
export type { Principal } from '@deepseek-ai/dsh-principal'
export type { Role } from '@deepseek-ai/dsh-principal'

export { API_PATH, HOST_EVENTS_PATH, MUX_EVENTS_PATH } from './api-path.ts'

// The fence and WebSocket-reject primitives are shared with sibling host
// packages that gate their own upgrade routes (e.g. dsh-runner-hub's
// /runner/channel). Re-exported from the built main so consumers compose
// against the compiled output, not the /src/*.ts source.
export { isTrustedApiRequest, assertTrustedAuthority } from './api-request-trust.ts'
export { rejectWebSocketUpgrade } from './websocket-downlink.ts'

/** Stable Cordis plugin name. */
export const name = 'client-connection'

/** Headroom for RPC JSON fields around aggregate base64 image payloads. */
const REQUEST_ENVELOPE_HEADROOM_BYTES = 1024 * 1024

function assertImageBodyCapacity(ctx: Context, maxRequestBodyBytes: number): void {
  const attachments = ctx.get('attachments')
  if (attachments === undefined) return
  const requiredImageBodyBytes = Math.ceil(
    attachments.imageLimits.maxMessageImageBytes * 4 / 3,
  ) + REQUEST_ENVELOPE_HEADROOM_BYTES
  if (maxRequestBodyBytes < requiredImageBodyBytes) {
    throw new Error(
      `client-connection maxRequestBodyBytes (${String(maxRequestBodyBytes)}) must be at least `
      + `${String(requiredImageBodyBytes)} for the configured aggregate image limit`,
    )
  }
}

/** Services required before providing Connection; API Proxy is an optional `/api` fallback. */
export const inject = ['webServer']

/** Plugin config: the deployment's non-loopback serving authorities. */
export interface ConnectionConfig {
  /**
   * Authorities this deployment serves beyond loopback: exact `host:port`, or
   * port-less `host` matching any port. The /api trust fence refuses any
   * request whose Host is neither loopback nor listed here, so a
   * non-loopback (`0.0.0.0`) deployment must declare the names it is reached
   * by (the dsh CLI derives the machine's LAN IP literals itself). An entry
   * that is not a bare, canonical authority fails the plugin load.
   */
  trustedHosts?: string[]
  /** Maximum buffered JSON body for every `/api` request. */
  maxRequestBodyBytes?: number
}

export const Config: z<ConnectionConfig> = z.object({
  trustedHosts: z.array(String).default([]),
  maxRequestBodyBytes: z.natural().min(1).default(DEFAULT_MAX_REQUEST_BODY_BYTES),
})

/**
 * Methods whose callers must be privileged.
 *
 * Two postures share this set:
 *  - Single-user (`auth` absent): loopback-only. `isTrustedApiRequest(request, [])`
 *    admits only loopback (no declared authority), so a remote caller is refused
 *    even without a role to read.
 *  - Multi-user (`auth` present): admin-only on any origin. The browser reaches
 *    the `/api` surface through loopback (or a reverse proxy whose Host is the
 *    loopback address), so a loopback check would let every authenticated `user`
 *    mutate the configuration plane; the role is the gate and an `admin` is
 *    unpinned on any origin.
 *
 * Mutations (`settings.mutate/update/replace`, `credentials.set/unset`,
 * `llm.discoverModels`, plus the preset/host dialogs) are always here. The
 * read surfaces `settings.describe`, `credentials.describe`, and the model
 * catalog (`llm.providers`, `llm.models`) are deliberately NOT here: the
 * Models page's read-only posture for a `user` needs them to render. `describe`
 * is redacted (secrets never ride the wire; credentials report configured/
 * source/writable only), matching the `llm.*` catalog which carries only ids and
 * display names — no endpoints, keys, or key state — so a `user` can still fill
 * a model picker without reconnaissance. `llm.discoverModels` belongs to the
 * privileged plane on both counts: it carries a draft credential, and it makes
 * the host issue a GET to a URL the caller chose and reports back the status or
 * the parsed body — an unauthenticated or non-admin LAN caller would have a probe
 * for whatever the host can reach and the browser cannot.
 *
 * `agentPreset.list` and choosing one at `session.create` are also not here: the
 * capability is not the preset's to grant (the deployment's own default already
 * carries shell/filesystem tools), so any caller that may start a session can
 * already run commands as this process; pinning the switch would be a fence
 * beside an open gate.
 */
const PRIVILEGED_METHODS = new Set([
  // A preset composition names the plugins a session runs, so reading one is
  // reconnaissance; copy and remove rearrange what the deployment offers, and
  // openDocument drives the host desktop — all more than the roster beside
  // them. (Authoring is copy-only, so no method here accepts composition text
  // or a path; the pin is about who may manage the roster at all.)
  //
  // CHOOSING one is not pinned, and `agentPreset.list` is not either. Picking a
  // preset looks like escalation — one of them mounts the toolset that edits the
  // live runtime — but `session.create` already takes an `agentPreset`, so
  // pinning only the switch would leave the same capability one method over.
  // The deeper reason is that the capability is not the preset's to grant: the
  // deployment's own default already carries `bash` and the filesystem tools, so
  // any caller that may start a session at all can already run commands as this
  // process. Pinning the switch would be a fence beside an open gate.
  'agentPreset.read',
  'agentPreset.copy',
  'agentPreset.openDocument',
  'agentPreset.remove',
  'host.pickDirectory',
  'host.openPath',
  'settings.openDocument',
  'settings.update',
  'settings.replace',
  'settings.mutate',
  'credentials.set',
  'credentials.unset',
  'llm.discoverModels',
])

/**
 * Mounts the API gateway under the browser transport prefix. Every request on
 * the prefix passes the browser-trust fence first (DNS-rebinding and
 * cross-site defense — [api-request-trust](./api-request-trust.ts));
 * privileged methods additionally pass it with an empty trust list, which
 * pins them to loopback.
 * @param ctx - Host plugin context.
 * @param config - resolved plugin config (schema defaults applied).
 */
export function apply(ctx: Context, config?: ConnectionConfig): void {
  // The Loader resolves schema defaults; hand-built test contexts may pass none.
  const trustedHosts = config?.trustedHosts ?? []
  const maxRequestBodyBytes = config?.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES
  // Config boundary: a malformed entry fails the load loudly here rather than
  // silently authorizing its hostname prefix at request time.
  for (const entry of trustedHosts) assertTrustedAuthority(entry)
  if (ctx.get('apiProxy') !== undefined) assertImageBodyCapacity(ctx, maxRequestBodyBytes)
  const connection = new HostConnectionService(ctx, trustedHosts)
  const fetchHandler = connection.createSharedFetchHandler(API_PATH, {
    async fetch(request) {
      const pathname = new URL(request.url).pathname
      const method = pathname.startsWith(`${API_PATH}/`)
        ? pathname.slice(API_PATH.length + 1)
        : undefined

      // Auth hook — run BEFORE the privileged pin so the role is known when
      // the pin evaluates. `undefined` = no auth composed (single-user) /
      // legacy true (isolation OFF); `null` = rejected; object = identity+role.
      const auth = await connection.authenticate({ headers: request.headers })
      if (auth === null) {
        return new Response('unauthorized', { status: 401 })
      }

      // Privileged plane. Two postures:
      //  - No auth composed (`auth === undefined`, single-user / legacy): the
      //    privileged methods stay loopback-only, exactly as before auth existed.
      //    `isTrustedApiRequest(request, [])` admits only loopback (no declared
      //    authority), so a remote caller is refused even without a role to read.
      //  - Auth composed (`auth` is an identity object): the privileged methods
      //    are admin-only regardless of origin. A multi-user deployment serves
      //    the browser through loopback (or a reverse proxy whose Host is the
      //    loopback address), so a loopback check would let every authenticated
      //    `user` mutate the configuration plane; the role is the gate instead.
      //    An authenticated `admin` is unpinned on any origin (remote + auth).
      if (method !== undefined && PRIVILEGED_METHODS.has(method)) {
        if (auth === undefined) {
          if (!isTrustedApiRequest(request, [])) {
            return new Response('forbidden', { status: 403 })
          }
        } else if (auth.role !== 'admin') {
          return new Response('forbidden', { status: 403 })
        }
      }

      if (request.method === 'GET' && (pathname === MUX_EVENTS_PATH || pathname === HOST_EVENTS_PATH)) {
        return new Response('upgrade required', {
          status: 426,
          headers: { connection: 'Upgrade', upgrade: 'websocket' },
        })
      }
      const apiProxy = ctx.get('apiProxy')
      if (apiProxy === undefined) return new Response('not found', { status: 404 })
      return withPrincipal(auth?.userId, () => withRole(auth?.role, () => toFetchHandler(apiProxy).fetch(request)))
    },
  })
  const route: WebRoute = {
    kind: 'prefix',
    path: API_PATH,
    handler: async (req, res) => {
      if (!isTrustedApiRequest(req, trustedHosts)) {
        res.writeHead(403)
        res.end('forbidden')
        return
      }
      if (!await connection.checkAuth({ headers: req.headers })) {
        res.writeHead(401)
        res.end('unauthorized')
        return
      }
      await bridge(req, res, fetchHandler, maxRequestBodyBytes)
    },
  }
  ctx.effect(() => ctx.webServer.register(route), 'client-connection: /api route')
  ctx.inject(['apiProxy'], (apiCtx) => {
    assertImageBodyCapacity(apiCtx, maxRequestBodyBytes)
    const downlinks = new WebSocketDownlinks(apiCtx.apiProxy)
    const registerDownlink = (
      path: string,
      handle: WebUpgradeRoute['handler'],
    ): void => {
      apiCtx.effect(() => apiCtx.webServer.registerUpgrade({
        path,
        handler: async (req, socket, head) => {
          if (!isTrustedApiRequest(req, trustedHosts)) {
            rejectWebSocketUpgrade(socket)
            return
          }
          // Establish the request-scoped principal+role on the upgrade path so
          // the mux/host SSE handlers downstream can scope frames by user/role.
          // A rejecting hook rejects the upgrade; an admitting hook with no
          // identity (legacy `true` / no auth composed) runs isolation OFF.
          const auth = await connection.authenticate({ headers: req.headers })
          if (auth === null) {
            rejectWebSocketUpgrade(socket)
            return
          }
          return withPrincipal(auth?.userId, () => withRole(auth?.role, () => handle(req, socket, head)))
        },
      }), `client-connection: ${path} WebSocket`)
    }
    apiCtx.effect(() => () => downlinks.close(), 'client-connection: WebSocket downlinks')
    registerDownlink(MUX_EVENTS_PATH, (req, socket, head) => { downlinks.handleMux(req, socket, head) })
    registerDownlink(HOST_EVENTS_PATH, (req, socket, head) => { downlinks.handleHost(req, socket, head) })
  })
}
