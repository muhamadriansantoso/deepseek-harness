/**
 * Admin plugin, browser half: registers the Admin settings section. The
 * section appears only for an `admin` role (probed via `/api/auth/me`);
 * non-admins never see the nav entry. `/api/admin/*` re-checks role
 * server-side. Mirrors `ui-auth-login`'s async-probe-in-apply pattern.
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { AdminSection } from './AdminSection.tsx'
import type { AdminSectionInjected } from './AdminSection.tsx'
import { AdminController } from './section-store.ts'
import { LogoutFooterAction } from './LogoutFooterAction.tsx'
import type { LogoutFooterActionInjected } from './LogoutFooterAction.tsx'
import { en, zh, type AdminKey } from './locales.ts'

export type { AdminSectionInjected, AdminSectionProps } from './AdminSection.tsx'
export type { AdminController, AdminState, UserRow } from './section-store.ts'
export type { LogoutFooterActionInjected, LogoutFooterActionOwner, LogoutFooterActionProps } from './LogoutFooterAction.tsx'
export type { AdminKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Admin settings section + sidebar-footer logout copy. */
    'admin': AdminKey
  }
}

const NS = 'admin'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale']

/**
 * Register the dictionaries, the sidebar-footer logout action (visible to
 * any authenticated user), and — when the current user is an admin — the
 * Admin settings section. Both gates probe `/api/auth/me` so the plugin is
 * a silent no-op where no auth is composed (mirrors `ui-auth-login`'s
 * probe-in-apply safety).
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-admin: copy dictionaries')

  const controller = new AdminController()
  const useSnapshot = bindSnapshotSelector(controller.store)
  const t = ctx.locale.bind(NS)
  const injected = (): AdminSectionInjected => ({ controller, useSnapshot, t })
  const logoutInjected = (): LogoutFooterActionInjected => ({ t })

  ctx.effect(() => ctx.on('connection/reset', () => {
    if (controller.store.getSnapshot().status !== 'idle') void controller.load()
  }), 'ui-admin: reconnect refetch')

  // Probe role via /api/auth/me; gate the Admin slot registration on `admin`.
  void (async () => {
    try {
      const resp = await fetch('/api/auth/me', { credentials: 'include' })
      if (!resp.ok) return
      const body = await resp.json() as { role?: unknown }
      if (body.role !== 'admin') return
    } catch { return }
    ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section',
      id: 'admin',
      order: 40,
      label: () => t('nav'),
      locale: NS,
      inject: injected,
    }, AdminSection))
  })()

  // Probe /api/auth/me again; register the sidebar-footer logout button for
  // any authenticated user (not just admins). A separate probe keeps the
  // Admin gate (role==='admin') independent of the logout gate (any 200).
  void (async () => {
    try {
      const resp = await fetch('/api/auth/me', { credentials: 'include' })
      if (!resp.ok) return
    } catch { return }
    ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
      name: 'sidebar.footer.action',
      id: 'logout',
      order: 20,
      inject: logoutInjected,
    }, LogoutFooterAction))
  })()
}
