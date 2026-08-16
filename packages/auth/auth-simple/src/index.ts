/**
 * @deepseek-ai/dsh-auth-simple — Simple user-id + password authentication for
 * the web surface. PostgreSQL-backed user store with bcrypt password hashing,
 * HMAC-SHA-256 signed session tokens carried in HttpOnly cookies, and an
 * authHook the Connection fence reads after its DNS-rebinding check passes.
 *
 * The plugin registers `/api/auth/*` routes (outside the RPC fence — these are
 * plain HTTP endpoints) and provides an `authHook` through the `connection`
 * service that the existing `isTrustedApiRequest` fence calls after the Host/
 * Origin rebinding defense. Auth is composition, not a core change: the fence
 * stays the single enforcement point.
 *
 * @module @deepseek-ai/dsh-auth-simple
 */

import { createHmac, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-client-connection'
import bcrypt from 'bcryptjs'
import { Pool } from 'pg'

/** Stable Cordis plugin name. */
export const name = 'auth-simple'

/** Services required: the webserver for routes, connection for the authHook. */
export const inject = ['webServer', 'connection']

/** Plugin configuration: PostgreSQL connection, session signing, and cookie name. */
export interface Config {
  /** PostgreSQL connection string (libpq format). */
  connectionString: string
  /** HMAC secret for signing session tokens. Must be at least 32 bytes. */
  sessionSecret: string
  /** Session lifetime in milliseconds. Defaults to 24 hours. */
  sessionTtlMs?: number
  /** Cookie name carrying the session token. Defaults to `dsh_session`. */
  cookieName?: string
}

export const Config: z<Config> = z.object({
  connectionString: z.string().required(),
  sessionSecret: z.string().required(),
  sessionTtlMs: z.natural().default(86_400_000),
  cookieName: z.string().default('dsh_session'),
})

interface ResolvedConfig {
  connectionString: string
  sessionSecret: string
  sessionTtlMs: number
  cookieName: string
}

interface SchemaResolvedConfig extends Config {
  /** Session lifetime in milliseconds (resolved from the schema default when omitted). */
  sessionTtlMs: number
  /** Cookie name carrying the session token (resolved from the schema default when omitted). */
  cookieName: string
}

/** One authenticated user row from the PostgreSQL store. */
interface AuthUser {
  /** Unique user identifier. */
  id: string
  /** bcrypt password hash. */
  passwordHash: string
}

/** Decoded session token payload. */
interface SessionPayload {
  /** User id this session belongs to. */
  userId: string
  /** Token issue time (epoch ms). */
  issuedAt: number
}

/**
 * The auth service: owns the PostgreSQL pool, session-token signing, and the
 * authHook. The hook is stateless — every request verifies the HMAC and
 * checks the TTL, so no server-side session store is needed.
 */
export class AuthSimpleService extends Service {
  private readonly pool: Pool
  private readonly resolved: ResolvedConfig

  /**
   * @param ctx - owning plugin context with webServer + connection injected.
   * @param config - validated plugin config.
   */
  constructor(ctx: Context, config: SchemaResolvedConfig) {
    super(ctx, 'authSimple')
    this.resolved = {
      connectionString: config.connectionString,
      sessionSecret: config.sessionSecret,
      sessionTtlMs: config.sessionTtlMs,
      cookieName: config.cookieName,
    }
    this.pool = new Pool({ connectionString: this.resolved.connectionString })
  }

  /**
   * Ensure the users table exists. Safe to call multiple times (IF NOT EXISTS).
   * Called lazily on the first login attempt.
   */
  async ensureSchema(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS dsh_auth_users (
        id TEXT PRIMARY KEY,
        password_hash TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `)
  }

  /**
   * Validate credentials against the PostgreSQL user store.
   * @param userId - the user id to look up.
   * @param password - the plaintext password to verify.
   * @returns true when the password matches the stored bcrypt hash.
   */
  async verifyCredentials(userId: string, password: string): Promise<boolean> {
    const result = await this.pool.query<AuthUser>(
      'SELECT id, password_hash AS "passwordHash" FROM dsh_auth_users WHERE id = $1',
      [userId],
    )
    const user = result.rows[0]
    if (user === undefined) return false
    return bcrypt.compare(password, user.passwordHash)
  }

  /**
   * Sign a session token for a user. The token is `base64url(payload).base64url(hmac)`.
   * @param userId - the authenticated user id.
   * @returns the signed session token string.
   */
  signSession(userId: string): string {
    const payload: SessionPayload = { userId, issuedAt: Date.now() }
    const payloadStr = Buffer.from(JSON.stringify(payload)).toString('base64url')
    const signature = this.sign(payloadStr)
    return `${payloadStr}.${signature}`
  }

  /**
   * Verify a session token's signature and TTL.
   * @param token - the raw token string from the cookie.
   * @returns the decoded payload when valid and not expired; undefined otherwise.
   */
  verifySession(token: string): SessionPayload | undefined {
    const dotIndex = token.lastIndexOf('.')
    if (dotIndex <= 0) return undefined
    const payloadStr = token.slice(0, dotIndex)
    const signature = token.slice(dotIndex + 1)
    const expected = this.sign(payloadStr)
    if (signature.length !== expected.length) return undefined
    if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return undefined
    let payload: SessionPayload
    try {
      payload = JSON.parse(Buffer.from(payloadStr, 'base64url').toString()) as SessionPayload
    } catch {
      return undefined
    }
    if (Date.now() - payload.issuedAt > this.resolved.sessionTtlMs) return undefined
    return payload
  }

  /**
   * Extract the session cookie value from a request's Cookie header.
   * @param cookieHeader - the raw Cookie header value.
   * @returns the token value or undefined when absent.
   */
  extractCookie(cookieHeader: string | undefined): string | undefined {
    if (cookieHeader === undefined) return undefined
    const prefix = `${this.resolved.cookieName}=`
    for (const part of cookieHeader.split(';')) {
      const trimmed = part.trim()
      if (trimmed.startsWith(prefix)) {
        return decodeURIComponent(trimmed.slice(prefix.length))
      }
    }
    return undefined
  }

  /** The cookie name for setting/clearing. */
  get cookieName(): string {
    return this.resolved.cookieName
  }

  /** Session TTL in milliseconds (for cookie Max-Age calculation). */
  get sessionTtlMs(): number {
    return this.resolved.sessionTtlMs
  }

  /** HMAC-SHA-256 signature of a payload string. */
  private sign(payloadStr: string): string {
    return createHmac('sha256', this.resolved.sessionSecret)
      .update(payloadStr)
      .digest('base64url')
  }

  /** Close the PostgreSQL pool on disposal. */
  [Service.init](): void {
    this.ctx.effect(() => async () => {
      await this.pool.end()
    }, 'auth-simple.pool')
  }
}

/** Route prefix for auth endpoints (outside the RPC fence). */
const AUTH_PREFIX = '/api/auth'

/**
 * Read the Cookie header from either a Node `IncomingHttpHeaders` plain object
 * or a fetch `Headers` instance. The Connection fence passes both shapes: the
 * `/api` route handler hands a Node request's headers, while the shared fetch
 * handler hands a fetch `Request`'s `Headers`. Bracket access answers
 * `undefined` on a `Headers` instance, so a `get` call covers it.
 * @param headers - the request headers in either shape.
 * @returns the raw Cookie header value, or undefined when absent.
 */
function readCookieHeader(
  headers: Record<string, string | string[] | undefined> | Headers,
): string | undefined {
  if (typeof (headers as Headers).get === 'function') {
    const value = (headers as Headers).get('cookie')
    return value ?? undefined
  }
  const value = (headers as Record<string, string | string[] | undefined>)['cookie']
  return typeof value === 'string' ? value : undefined
}

/**
 * Read and parse a JSON body from an IncomingMessage up to a byte cap.
 * @param req - the incoming HTTP request.
 * @param maxBytes - the maximum body size to accept.
 * @returns the parsed JSON value, or undefined on parse failure / oversize.
 */
async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(chunk as Buffer)
    if (Buffer.concat(chunks).length > maxBytes) return undefined
  }
  const body = Buffer.concat(chunks).toString('utf8')
  if (body.length === 0) return undefined
  try {
    return JSON.parse(body) as unknown
  } catch {
    return undefined
  }
}

/** Write a JSON response with a status code. */
function writeJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data)
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(body)
}

/** Parse a plain object from an unknown JSON value. */
function asObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

/**
 * Register the `/api/auth/*` routes and provide the authHook to the connection
 * fence. Routes are registered as a prefix on the webserver; the connection
 * plugin's `/api` prefix is longer-prefixed by `/api/auth` so the webserver's
 * longest-prefix match routes auth requests here, not to the RPC bridge.
 *
 * @param ctx - plugin context with webServer + connection injected.
 * @param config - validated plugin config.
 */
export function apply(ctx: Context, config: SchemaResolvedConfig): void {
  const auth = new AuthSimpleService(ctx, config)

  // Register auth routes.
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: AUTH_PREFIX,
    handler: async (req, res) => {
      await handleAuthRoute(auth, req, res)
    },
  }), 'auth-simple: /api/auth routes')

  // Provide the authHook to the connection fence. The fence calls this AFTER
  // the DNS-rebinding Host/Origin check passes, so by the time this runs the
  // request is from a trusted authority. Auth is the second gate: no valid
  // session cookie → 401.
  const hook = (request: { headers: Record<string, string | string[] | undefined> | Headers }) => {
    const cookieHeader = readCookieHeader(request.headers)
    const token = auth.extractCookie(cookieHeader)
    if (token === undefined) return undefined
    const payload = auth.verifySession(token)
    return payload?.userId
  }
  ctx.effect(() => ctx.connection.registerAuthHook(hook), 'auth-simple: authHook')
}

/**
 * Handle one request under `/api/auth/*`.
 * @param auth - the auth service.
 * @param req - the incoming HTTP request.
 * @param res - the server response.
 */
async function handleAuthRoute(
  auth: AuthSimpleService,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const rawPath = new URL(req.url ?? '/', 'http://x').pathname
  const subPath = rawPath.slice(AUTH_PREFIX.length)

  if (subPath === '/login' && req.method === 'POST') {
    await handleLogin(auth, req, res)
    return
  }
  if (subPath === '/logout' && req.method === 'POST') {
    handleLogout(auth, res)
    return
  }
  if (subPath === '/me' && req.method === 'GET') {
    handleMe(auth, req, res)
    return
  }
  writeJson(res, 404, { error: 'not found' })
}

/** POST /api/auth/login — validate credentials, set session cookie. */
async function handleLogin(auth: AuthSimpleService, req: IncomingMessage, res: ServerResponse): Promise<void> {
  await auth.ensureSchema()
  const body = await readJsonBody(req, 8192)
  const obj = asObject(body)
  const userId = obj?.['id']
  const password = obj?.['password']
  if (typeof userId !== 'string' || typeof password !== 'string') {
    writeJson(res, 400, { error: 'id and password are required' })
    return
  }
  const valid = await auth.verifyCredentials(userId, password)
  if (!valid) {
    writeJson(res, 401, { error: 'invalid credentials' })
    return
  }
  const token = auth.signSession(userId)
  const isHttps = new URL(req.url ?? '/', 'http://x').protocol === 'https:'
  const cookieParts = [
    `${auth.cookieName}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.floor(auth.sessionTtlMs / 1000)}`,
  ]
  if (isHttps) cookieParts.push('Secure')
  res.writeHead(200, {
    'content-type': 'application/json',
    'set-cookie': cookieParts.join('; '),
  })
  res.end(JSON.stringify({ userId }))
}

/** POST /api/auth/logout — clear the session cookie. */
function handleLogout(auth: AuthSimpleService, res: ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'application/json',
    'set-cookie': `${auth.cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
  })
  res.end('{}')
}

/** GET /api/auth/me — return the authenticated user id or 401. */
function handleMe(auth: AuthSimpleService, req: IncomingMessage, res: ServerResponse): void {
  const cookieHeader = req.headers.cookie
  const token = auth.extractCookie(cookieHeader)
  if (token === undefined) {
    writeJson(res, 401, { error: 'not authenticated' })
    return
  }
  const payload = auth.verifySession(token)
  if (payload === undefined) {
    writeJson(res, 401, { error: 'session expired' })
    return
  }
  writeJson(res, 200, { userId: payload.userId })
}
