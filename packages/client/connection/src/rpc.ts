/** Generic unary RPC contracts shared by the Host and Client Connection halves. */

import type { RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api'

/** Trust fence applied before a Host RPC channel reaches its handler. */
export type ConnectionRpcAuthority = 'trusted-host' | 'loopback'

/**
 * The authenticated principal a hook resolved: the userId string, or `undefined`
 * / `false` to reject. A bare `true` admits an authenticated request that
 * carries no per-user identity (legacy behavior, single-user), so the scoping
 * guards see `undefined` and run with isolation OFF.
 */
export type ConnectionAuthResult = string | undefined | boolean

/**
 * Authentication hook called by the trust fence AFTER the DNS-rebinding
 * Host/Origin check passes. Returns the request's userId to admit it (and make
 * that identity available to downstream scoping via `currentPrincipal()`),
 * or `undefined`/`false` to reject. A legacy hook returning `true` admits the
 * request without a per-user identity. An auth plugin provides this through
 * {@link HostConnectionHandle.registerAuthHook}; when no auth plugin is
 * composed, no hook is registered and the fence behaves exactly as before.
 */
export type ConnectionAuthHook = (request: ApiTrustFenceRequest) => ConnectionAuthResult | Promise<ConnectionAuthResult>

/**
 * Request facts the auth hook reads from either HTTP representation. The
 * headers type is browser-compatible (no `node:http` dependency) so this
 * interface is shared by the Host and Client halves of Connection.
 */
export interface ApiTrustFenceRequest {
  /** The request headers (Node HTTP or Fetch Headers). */
  readonly headers: Record<string, string | string[] | undefined> | Headers
}

/** Registration policy for one logical RPC channel. */
export interface ConnectionRpcHandlerOptions {
  /** Browser authority accepted by every endpoint in this channel. */
  readonly authority: ConnectionRpcAuthority
}

/** Handler invoked after Connection has decoded the transport envelope. */
export type ConnectionRpcHandler = (
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
) => Promise<RpcResult<unknown>>

/** Synchronous ownership test for one endpoint on a shared RPC channel. */
export type ConnectionRpcEndpointMatcher = (endpoint: string) => boolean

/** Host registry for logical RPC channels carried by the current transport. */
export interface HostConnectionRpc {
  /**
   * Register one absolute channel prefix and its trust policy.
   * @param channel - absolute logical channel such as `/rpc`.
   * @param handler - decoded endpoint handler returning the existing RPC result shape.
   * @param options - channel trust policy.
   * @returns asynchronous disposer removing the channel and its physical route.
   */
  handle(
    channel: string,
    handler: ConnectionRpcHandler,
    options: ConnectionRpcHandlerOptions,
  ): () => Promise<void>

  /**
   * Intercept owned endpoints on the shared `/api` channel before its fallback.
   * @param channel - reserved shared channel; currently `/api`.
   * @param matches - synchronous endpoint ownership test.
   * @param handler - decoded endpoint handler returning the existing RPC result shape.
   * @param options - trust policy for every endpoint claimed by this interceptor.
   * @returns asynchronous disposer removing the interceptor.
   */
  intercept(
    channel: '/api',
    matches: ConnectionRpcEndpointMatcher,
    handler: ConnectionRpcHandler,
    options: ConnectionRpcHandlerOptions,
  ): () => Promise<void>
}

/** Host `ctx.connection` shape consumed by transport-independent adapters. */
export interface HostConnectionHandle {
  /** Generic RPC channel registry. */
  readonly rpc: HostConnectionRpc
  /**
   * Register an authentication hook the trust fence calls after its
   * DNS-rebinding Host/Origin check passes. When a hook is registered, every
   * `/api` request and WebSocket upgrade must also pass the hook (return a
   * userId string, or the legacy `true`) to reach the RPC bridge. When no
   * hook is registered, the fence behaves exactly as before (trusted-host /
   * loopback authority only).
   * @param hook - the auth check; returns the userId to admit, `undefined`/`false` to reject.
   * @returns asynchronous disposer removing the hook.
   */
  registerAuthHook(hook: ConnectionAuthHook): () => Promise<void>
}

/** Client caller for logical RPC channels carried by the current transport. */
export interface ClientConnectionRpc {
  /**
   * Call one endpoint through an already registered logical channel.
   * @param channel - absolute logical channel such as `/api`.
   * @param endpoint - channel-relative endpoint such as `goals/create`.
   * @param payload - channel-owned request payload.
   * @param signal - optional caller cancellation.
   * @returns the existing RPC success/error result; correlation stays inside Connection.
   */
  call(
    channel: string,
    endpoint: string,
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<RpcResult<unknown>>
}
