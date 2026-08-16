/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-auth-simple`.
 * @module @deepseek-ai/dsh-auth-simple/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-auth-simple'

/** Cordis companion plugin name. */
export const name = 'auth-simple-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: session-token validity is stateless (HMAC verification
 * per request) and the user-store relation is owned by the PostgreSQL pool's
 * own lifecycle. Route register/dispose symmetry is audited by the webserver
 * package's invariant.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
