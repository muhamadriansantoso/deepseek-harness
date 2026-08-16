/** Locale bundles for the admin settings section. */

/** Locale keys this section renders. */
export type AdminKey =
  | 'nav' | 'intro' | 'loading' | 'error' | 'retry'
  | 'userId' | 'role' | 'createdAt' | 'actions' | 'noUsers'
  | 'promote' | 'demote' | 'promoting' | 'user' | 'admin'
  | 'forbidden' | 'notFound'
  | 'logout' | 'logoutShort' | 'loggingOut'

/** English copy. */
export const en: Record<AdminKey, string> = {
  nav: 'Admin',
  intro:
    'The user list and role management live here. An admin sees every user '
    + 'and may promote or demote roles; non-admins never see this section.',
  loading: 'Loading users...',
  error: 'Could not load users.',
  retry: 'Retry',
  userId: 'User',
  role: 'Role',
  createdAt: 'Created',
  actions: 'Actions',
  noUsers: 'No users',
  promote: 'Promote to admin',
  demote: 'Demote to user',
  promoting: 'Saving...',
  user: 'user',
  admin: 'admin',
  forbidden: 'Admin only.',
  notFound: 'User not found.',
  logout: 'Log out',
  logoutShort: 'Out',
  loggingOut: 'Logging out…',
}

/** Simplified Chinese copy. */
export const zh: Record<AdminKey, string> = {
  nav: 'Admin',
  intro: 'User list and role management live here. The admin sees every user and may promote/demote — non-admins stay silenced.',
  loading: 'Loading users...',
  error: 'Could not load users.',
  retry: 'Retry',
  userId: 'User',
  role: 'Role',
  createdAt: 'Created',
  actions: 'Actions',
  noUsers: 'No users',
  promote: 'Promote to admin',
  demote: 'Demote to user',
  promoting: 'Saving...',
  user: 'user',
  admin: 'admin',
  forbidden: 'Admin only.',
  notFound: 'User not found.',
  logout: '退出登录',
  logoutShort: '退出',
  loggingOut: '正在退出…',
}
