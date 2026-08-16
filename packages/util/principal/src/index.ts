/**
 * The per-request authenticated principal: an `AsyncLocalStorage` carrying the
 * userId an auth plugin resolved from the session cookie, or `undefined` when
 * no auth plugin is composed (single-user / in-process) or the request carries
 * no principal.
 *
 * This is an `AsyncLocalStorage` rather than a threaded argument because the
 * ApiProxy is a process singleton whose method handlers are boot-time closures,
 * and the agent loop runs inside the fetch handler's async context (the
 * AgentRegistry establishes ITS initiator scope the same way), so a
 * request-level store propagates through the agent turn into the capability
 * providers (`bash-local`/`fs-local`) without threading `owner` through every
 * tool spec. `undefined` is the explicit "isolation off" signal: every
 * scoping guard treats it as single-user and admits the operation unchanged,
 * preserving the behavior of in-process tests and auth-less deployments.
 *
 * @module @deepseek-ai/dsh-principal
 */

import { AsyncLocalStorage } from 'node:async_hooks'

/** The authenticated userId for the current request, or undefined when unscoped. */
export type Principal = string | undefined

/** The authenticated role for the current request, or undefined when unscoped. */
export type Role = 'user' | 'admin'

/** The request-scoped principal store. */
const principalStore = new AsyncLocalStorage<Principal>()

/** The request-scoped role store — set alongside the principal at the fetch/WS boundary. */
const roleStore = new AsyncLocalStorage<Role | undefined>()

/**
 * Run `fn` with `userId` as the current request principal. The store propagates
 * through the request's whole async tree (the fetch handler, the agent loop, the
 * capability providers), so any downstream {@link currentPrincipal} call
 * resolves it. A background fiber that escapes the request's async context
 * loses the store — capture {@link currentPrincipal} into its closure at the
 * detach point and pass the value explicitly to the eventual spawn.
 * @param userId - the authenticated userId, or undefined for an unauthenticated scope.
 * @param fn - the work to run inside the principal scope.
 * @returns the value `fn` produced.
 */
export function withPrincipal<T>(userId: Principal, fn: () => T): T {
  return principalStore.run(userId, fn)
}

/**
 * The authenticated userId for the current request, or `undefined` when no
 * principal scope is active (no auth composed, in-process test, or a detached
 * fiber that escaped the request's async context). Scoping guards read this and
 * treat `undefined` as "isolation off" — the pre-isolation, single-user behavior.
 * @returns the current request principal, or undefined.
 */
export function currentPrincipal(): Principal {
  return principalStore.getStore()
}

/**
 * Run `fn` with `role` as the current request role. Mirrors {@link withPrincipal}:
 * `undefined` means "isolation off" / no auth — every role guard treats it as
 * single-user/legacy and falls back to the loopback pin. The store propagates
 * through the request's whole async tree; a detached fiber loses it — capture at
 * the detach point instead.
 * @param role - the authenticated role, or undefined for an unauthenticated scope.
 * @param fn - the work to run inside the role scope.
 * @returns the value `fn` produced.
 */
export function withRole<T>(role: Role | undefined, fn: () => T): T {
  return roleStore.run(role, fn)
}

/**
 * The authenticated role for the current request, or `undefined` when no role
 * scope is active (no auth composed, in-process test, or a detached fiber).
 * Role guards read this and treat `undefined` as "no role" — the pre-gate,
 * single-user behavior. Only an authenticated admin reaches privileged methods.
 * @returns the current request role, or undefined.
 */
export function currentRole(): Role | undefined {
  return roleStore.getStore()
}
