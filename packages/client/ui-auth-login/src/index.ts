/** Empty host-half apply — the login gate is entirely browser-side. */

/**
 * The node half is empty: the auth gate runs in the browser only. The server
 * plugin (`@deepseek-ai/dsh-auth-simple`) registers the `/api/auth/*` routes
 * and the authHook; this client package renders the login overlay.
 */
export function apply(): void {}
