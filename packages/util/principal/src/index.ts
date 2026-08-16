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

/** The request-scoped principal store. */
const principalStore = new AsyncLocalStorage<Principal>()

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
