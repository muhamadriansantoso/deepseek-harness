/**
 * Admin settings section: the user table with promote/demote. Rendered inside
 * the `settings.section` slot declared by `ui-settings-general`. Gated to admins
 * client-side (the section registers only for an `admin` `/api/auth/me` role);
 * `/api/admin/*` re-checks role server-side, so non-admins cannot reach data
 * even by bypassing the UI.
 */
import { useEffect, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-web-react'
import type { AdminState, AdminController } from './section-store.ts'
import type { AdminKey } from './locales.ts'

export type AdminSectionInjected = {
  controller: AdminController
  useSnapshot: SnapshotSelectorHook<AdminState>
  t: (key: AdminKey) => string
}

export type AdminSectionProps = AdminSectionInjected

export function AdminSection(props: AdminSectionProps): ReactNode {
  const { controller, useSnapshot, t } = props
  const status = useSnapshot(s => s.status)
  const error = useSnapshot(s => s.error)
  const users = useSnapshot(s => s.users)
  const busyId = useSnapshot(s => s.busyId)

  useEffect(() => { void controller.load(); return () => { controller.dispose() } }, [controller])

  if (status === 'idle' || status === 'loading') {
    return <div className="ds-card" style={{ padding: 16 }}>{t('loading')}</div>
  }
  if (status === 'error') {
    return (
      <div className="ds-card" style={{ padding: 16 }}>
        <div>{t('error')}{error !== null ? `: ${error}` : ''}</div>
        <div style={{ marginTop: 8 }}>
          <Button type="button" variant="outline" size="sm" onClick={() => { void controller.load() }}>
            {t('retry')}
          </Button>
        </div>
      </div>
    )
  }
  if (error === 'forbidden') {
    return <div className="ds-card" style={{ padding: 16 }}>{t('forbidden')}</div>
  }
  if (users.length === 0) {
    return <div className="ds-card" style={{ padding: 16 }}>{t('noUsers')}</div>
  }
  return (
    <div className="ds-card" style={{ padding: 16 }}>
      <div style={{ marginBottom: 12 }}>{t('intro')}</div>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={{ textAlign: 'left', padding: '6px 8px' }}>{t('userId')}</th>
            <th style={{ textAlign: 'left', padding: '6px 8px' }}>{t('role')}</th>
            <th style={{ textAlign: 'left', padding: '6px 8px' }}>{t('createdAt')}</th>
            <th style={{ textAlign: 'left', padding: '6px 8px' }}>{t('actions')}</th>
          </tr>
        </thead>
        <tbody>
          {users.map((row: import('./section-store.ts').UserRow) => (
            <tr key={row.id}>
              <td style={{ padding: '6px 8px' }}>{row.id}</td>
              <td style={{ padding: '6px 8px' }}>{row.role === 'admin' ? t('admin') : t('user')}</td>
              <td style={{ padding: '6px 8px' }}>{row.createdAt}</td>
              <td style={{ padding: '6px 8px' }}>
                {row.role === 'user' ? (
                  <Button
                    type="button" variant="outline" size="sm"
                    disabled={busyId === row.id}
                    onClick={() => { void controller.setRole(row.id, 'admin') }}
                  >
                    {busyId === row.id ? t('promoting') : t('promote')}
                  </Button>
                ) : (
                  <Button
                    type="button" variant="outline" size="sm"
                    disabled={busyId === row.id}
                    onClick={() => { void controller.setRole(row.id, 'user') }}
                  >
                    {busyId === row.id ? t('promoting') : t('demote')}
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
