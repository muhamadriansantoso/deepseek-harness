/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-runner`.
 * @module @deepseek-ai/dsh-runner/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-runner'

/** Cordis companion plugin name. */
export const name = 'runner-invariant'
/** Service required before the companion can register. */
export const inject = ['invariants']

/**
 * No runtime invariant: the runner is a one-shot driver over the remote LLM
 * gateway whose observable contract (login, channel connect, agent loop) is
 * process-level and owned by the launcher e2e; it registers nothing and holds
 * no mutable relation to audit inside the tree.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
