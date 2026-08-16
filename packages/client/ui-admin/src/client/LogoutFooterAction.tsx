/**
 * Sidebar footer logout action: a persistent one-click control in the
 * `sidebar.footer.action` slot (rendered above the Settings trigger in
 * SidebarRoot.tsx). Visible to any authenticated user — not just admins,
 * since `POST /api/auth/logout` clears the session cookie for any session.
 * The server route already exists (`auth-simple/src/index.ts:419 handleLogout`).
 */

import { useCallback, useState, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AdminKey } from './locales.ts'

/** Props injected by the slot registration in `index.ts:apply`. */
export type LogoutFooterActionInjected = {
  /** Localised copy. */
  t: (key: AdminKey) => string
}

/** Props the shell owns and supplies to every `sidebar.footer.action` entry. */
export type LogoutFooterActionOwner = {
  /** Whether the sidebar is in wide (non-rail) mode. */
  wide: boolean
}

export type LogoutFooterActionProps = LogoutFooterActionInjected & LogoutFooterActionOwner

/**
 * One-click logout: posts to `/api/auth/logout` (clears `dsh_session` with
 * `Max-Age=0` on the server), then reloads the page so the boot chain
 * re-probes `/api/auth/me`, gets 401, and `ui-auth-login` re-shows the
 * overlay. Mirrors the login flow's `window.location.reload()` in
 * `ui-auth-login/src/client/index.ts:379`.
 */
export function LogoutFooterAction(props: LogoutFooterActionProps): ReactNode {
  const { wide, t } = props
  const [busy, setBusy] = useState(false)

  const onLogout = useCallback(async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' })
    } catch { /* the stale token is already 401 on next boot anyway */ }
    window.location.reload()
  }, [busy])

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={busy}
      onClick={() => { void onLogout() }}
      aria-label={t('logout')}
    >
      {busy ? t('loggingOut') : (wide ? t('logout') : t('logoutShort'))}
    </Button>
  )
}
