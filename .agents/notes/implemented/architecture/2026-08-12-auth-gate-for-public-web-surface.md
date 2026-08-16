# Agent Note: Authentication gate for the public web surface

English | [中文](2026-08-12-auth-gate-for-public-web-surface.zh.md)

Status: implemented

## Problem

The DSH web GUI (`dsh web`) binds to loopback by default, and the `--host 0.0.0.0` flag is intentionally rejected at startup because exposing the server to the network would expose remote code execution — every session can run `bash`, filesystem tools, and subprocesses as the host process. The browser-trust fence (`isTrustedApiRequest`) is a DNS-rebinding and cross-site defense, explicitly not an authentication layer.

A deployment that serves the web GUI on a public domain (e.g. `dsh.mrians.my.id` behind a reverse proxy) needs an authentication gate before any `/api` request reaches the RPC bridge. Without one, anyone who can resolve the domain can create a session and run tools on the server.

## Decision

Auth is **composition, not a core change**. Two new packages add a complete user-id + password authentication layer without altering the agent loop, tool dispatch, or session model:

| Package | Role |
|---|---|
| `@deepseek-ai/dsh-auth-simple` (server plugin) | PostgreSQL user store + bcrypt password verification + HMAC-SHA-256 signed session tokens. Registers `/api/auth/*` HTTP routes and provides an `authHook` to the Connection fence. |
| `@deepseek-ai/dsh-client-ui-auth-login` (client plugin) | Browser-side login overlay. Probes `/api/auth/me` at boot; when the server responds 401 (auth enabled, no session), renders a login form directly into the DOM before the slot system exists. Self-removes after successful login + page reload. |

### The authHook seam

The connection package gains one field and one method:

- `ConnectionConfig` gains nothing — the hook is registered at runtime, not configured statically.
- `HostConnectionHandle` gains `registerAuthHook(hook: ConnectionAuthHook)`: an auth plugin calls this to install a check the fence runs after its DNS-rebinding Host/Origin check passes.
- `HostConnectionService.checkAuth(request)`: called by the `/api` route handler and the WebSocket upgrade gate. When no hook is registered, it returns `true` (the fence behaves exactly as before). When one is registered, every `/api` request and WebSocket upgrade must also pass the hook.

This follows the repo convention "Enforce a decision in the operation that makes it": the fence stays the single enforcement point. The DNS-rebinding check runs first; only if it passes does the auth hook run. An unauthenticated request from a rebinding attack is rejected by the fence before auth is even consulted.

### Route composition

The webserver's longest-prefix match routes `/api/auth/*` to the auth plugin (registered as `kind: 'prefix', path: '/api/auth'`) before the connection plugin's `/api` prefix catches it. No collision occurs because the paths differ.

### Session tokens

Tokens are `base64url(payload).base64url(hmac)` where the payload is `{ userId, issuedAt }`. Verification is stateless: HMAC comparison with `timingSafeEqual`, then TTL check. No server-side session store is needed — the cookie carries everything. The cookie is `HttpOnly`, `SameSite=Strict`, and `Secure` (when HTTPS is detected).

### Client gate

The `ui-auth-login` client plugin is `immediately: true` so it loads before the shell. Its `apply()` probes `/api/auth/me`:

- **200** → user is authenticated; the plugin is a silent no-op and the normal boot proceeds.
- **401** → auth is enabled and the user has no session; the login overlay renders.
- **Any other response** (including network failure) → no auth is composed; the plugin is a no-op and boot proceeds. This means the plugin is safe to ship in every composition — it only activates when an auth plugin is actually present.

The overlay is pure DOM/CSS, built with the Ethereal Glass design archetype (OLED-black background, radial mesh gradient, double-bezel glass card, spring-physics motion). It renders before the React slot system exists and self-removes after a successful login triggers `window.location.reload()`.

## Consequences

**The fence's authority list does not change.** `trustedHosts` is still a DNS-rebinding fence, not auth. A deployment serving a public domain declares it in `--trusted-host` so the rebinding check passes, then the auth hook is the second gate. Both must pass.

**At most one auth hook is active.** `registerAuthHook` throws if a hook is already registered. Two auth strategies cannot compose at the same enforcement point without a combiner; if one is ever needed, a combiner plugin would register itself as the hook and multiplex.

**The `ApiTrustFenceRequest` type is browser-compatible.** It uses `Record<string, string | string[] | undefined> | Headers` instead of `IncomingHttpHeaders` so `rpc.ts` (shared by the Host and Client halves) does not pull `node:http` into the browser bundle.

**Privileged methods are now role-gated (Task #8, 2026-08-16).** The `PRIVILEGED_METHODS` loopback pin in `packages/client/connection/src/index.ts:156-159` (`isTrustedApiRequest(req, [])`) was replaced by the admin gate `authSimpleHook.role !== 'admin' && !isTrustedApiRequest(req, [])`. An authenticated `admin` is unpinned on any origin; loopback still passes for anyone; non-admin non-loopback stays 403 (defense in depth). The role carrier is a parallel `AsyncLocalStorage<Role|undefined>` in `packages/util/principal` (Option B — `Principal = string|undefined` stays byte-identical). Widen: `ConnectionAuthResult` and `SessionPayload` carry `{userId, role}`; `ConnectionAuthResult` tolerates legacy `string`/`true`; `verifySession` defaults roleless tokens to `'user'`. The new bundle entry `packages/client/ui-admin` registers an Admin `settings.section` slot gated on `GET /api/auth/me`'s `role` (`packages/auth/auth-simple/src/index.ts:489 handleAdminRoute` re-checks server-side) and a persistent sidebar `sidebar.footer.action` logout button (1-click: `POST /api/auth/logout` → `window.location.reload()`, mirroring login). Host placement stays outside the preset realm (preset-local binding would starve later host rows). The AGENTS fix guarded by this doc had `WDIO` + `API` suites with deliberate real-DB reverse loops (`EventGateVerifier`) from warm context — those repros are stable; the stale wording here was the only migration fix. `Secure` on the `dsh_session` cookie and its logout clear must mirror `isHttps` (logout's `Max-Age=0` copy also conditionally `Secure`) or the https logout leaves a stale cookie. See also the Task #8 and logout-button architecture notes.

**No change to tools, sandbox, or session model.** Tools still run on the server. `session.create` is still not in `PRIVILEGED_METHODS` (by design — the default preset already carries `bash` and filesystem tools, so pinning the switch would be a fence beside an open gate). Auth (+ admin gate) is the gate that prevents anonymous access; what an authenticated user can do is now role-gated.

## Alternatives considered

**Modify `isTrustedApiRequest` to hardcode auth.** The fence is a DNS-rebounding defense, not an auth layer. Embedding auth logic would mix two concerns at one enforcement point and make the fence auth-aware. The `authHook` seam keeps the fence auth-agnostic.

**Server-side session store (Redis/database).** HMAC-signed stateless tokens are simpler, need no infrastructure beyond PostgreSQL (which the user store already uses), and scale horizontally. A server-side store would be needed for token revocation, which is not a requirement for this simple auth layer.

**OAuth / multi-tenant.** The requirement is user-id + password for a small set of users. OAuth adds a login flow, redirect handling, and provider dependency. Multi-tenant needs per-user workspace isolation, which is a separate architectural concern (phase 2: remote-execution on the client machine).

**shadcn/ui or a component library for the login page.** The overlay renders before the React slot system exists, so it must be pure DOM/CSS. No component library can load that early in the boot chain.
