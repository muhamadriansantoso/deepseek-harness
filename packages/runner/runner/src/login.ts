/**
 * Login to a dsh server: POST the credentials to `/api/auth/login` and return
 * the `dsh_session` cookie. The runner carries this cookie on the
 * `/runner/channel` WebSocket upgrade, so the hub's auth gate admits it.
 *
 * The cookie is held in memory only — never written to disk — and lives for the
 * runner process. A second laptop on the same credential gets its own cookie
 * and its own device id, so the hub sees two devices on one user, not one.
 * @module @deepseek-ai/dsh-runner
 */

import type { IncomingMessage } from 'node:http'
import { request } from 'node:https'
import { request as requestHttp } from 'node:http'

/** The login credentials. */
export interface LoginCredentials {
  /** The dsh server base URL (no trailing slash, https forced). */
  server: string
  /** The user id. */
  user: string
  /** The password. */
  password: string
}

/** One cookie parsed from a Set-Cookie header. */
interface ParsedCookie {
  /** The cookie name (e.g. `dsh_session`). */
  name: string
  /** The cookie value. */
  value: string
}

/**
 * Parse a `name=value; ...` cookie string into its name and value.
 * @param setCookie - one Set-Cookie header value.
 * @returns the parsed cookie, or undefined when the header is empty/malformed.
 */
function parseCookie(setCookie: string): ParsedCookie | undefined {
  const pair = setCookie.split(';', 1)[0]
  if (pair === undefined) return undefined
  const eq = pair.indexOf('=')
  if (eq <= 0) return undefined
  const name = pair.slice(0, eq).trim()
  const value = pair.slice(eq + 1).trim()
  if (name.length === 0 || value.length === 0) return undefined
  return { name, value }
}

/**
 * Log in to the server and return the session cookie string, ready to send on
 * the WebSocket upgrade (`Cookie: dsh_session=<value>`).
 * @param credentials - the server URL, user, and password.
 * @returns the `name=value` cookie pair (e.g. `dsh_session=...`).
 * @throws when the login fails (network error, 401, or no session cookie).
 */
export function login(credentials: LoginCredentials): Promise<string> {
  const { server, user, password } = credentials
  const url = new URL('/api/auth/login', server)
  const body = JSON.stringify({ id: user, password })
  const transport = url.protocol === 'http:' ? requestHttp : request
  return new Promise<string>((resolve, reject) => {
    const req = transport(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'http:' ? '80' : '443'),
        path: url.pathname,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          // The hub's fence checks Host/Origin against trusted hosts. Sending
          // the server's own authority satisfies the DNS-rebinding check.
          host: url.host,
        },
      },
      (res: IncomingMessage) => {
        const status = res.statusCode ?? 0
        const headers = res.headers as Record<string, string | string[] | undefined>
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          if (status !== 200) {
            const text = Buffer.concat(chunks).toString('utf8')
            reject(new Error(`login failed: ${status} ${text}`))
            return
          }
          const setCookies = headers['set-cookie']
          if (setCookies === undefined) {
            reject(new Error('login succeeded but the server set no session cookie'))
            return
          }
          const cookies = (Array.isArray(setCookies) ? setCookies : [setCookies])
            .map(parseCookie)
            .filter((c): c is ParsedCookie => c !== undefined)
          const session = cookies.find(c => c.name === 'dsh_session')
          if (session === undefined) {
            reject(new Error('login succeeded but set no dsh_session cookie'))
            return
          }
          resolve(`${session.name}=${session.value}`)
        })
      },
    )
    req.on('error', (error: NodeJS.ErrnoException) => {
      reject(new Error(`login request failed: ${error.message}`))
    })
    req.write(body)
    req.end()
  })
}
