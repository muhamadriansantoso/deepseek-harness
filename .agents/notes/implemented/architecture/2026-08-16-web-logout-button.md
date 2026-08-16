# Agent Note: Sidebar-footer logout button

English | [中文](2026-08-16-web-logout-button.zh.md)

Status: implemented

## Problem

Before this work the `dsh web` auth gate had no way to clear a session except deleting the `dsh_session` cookie by hand. The login gate (`ui-auth-login`) gives every web request a signed cookie, but no authenticated surface ever showed "you are X" and there was no persistent control to sign out.

The old `handleLogout` cookie writer hard-coded `HttpOnly; SameSite=Strict; Max-Age=0` without mirroring the `Secure` flag login set conditionally (`isHttps → Secure`). On an https deployment (`dsh.mrians.my.id`) the login-issued `Secure` cookie survived the logout `Set-Cookie`, leaving a stale session until TTL expiry.

The browser had nowhere natural to hang the control: there was no account menu, no sidebar avatar, no `General` account row. Every authenticated user — admin and non-admin — needed the same one-click logout.

## Decision

One additive browser plugin registers a persistent control in the sidebar footer — the additive inner slot `sidebar.footer.action` (rendered above the Settings trigger in `SidebarRoot.tsx:182-189`), endorsed by the project's own plugin-dev skill ("prefer additive inner Slots such as `sidebar.footer.action`; do not replace the entire sidebar"). The logout button is a one-click action gated on the same `GET /api/auth/me → 200` probe the login and admin gates use.

### Seam

The server route already existed unchanged: `POST /api/auth/logout` (`packages/auth/auth-simple/src/index.ts:419 handleLogout`) clears `dsh_session` with `Max-Age=0`. No extra route, no session store, no `connection/reset` — the stateless HMAC tokens remain stateless; clearing the cookie is the only revocation needed for this simple auth layer. The fix to `handleLogout` threads `req` through so `isHttps → Secure` mirrors `handleLogin` on https. `GET /api/auth/me` stays stateless.

The browser half reuses the Admin plugin package instead of minting a new `ui-auth`:

- `packages/client/ui-admin/src/client/LogoutFooterAction.tsx` — `POST /api/auth/logout` (with `credentials:'include'`) → `window.location.reload()` (mirrors login's reload at `ui-auth-login/src/client/index.ts:379` so boot re-probes `/api/auth/me`, gets 401, and the login overlay reappears). Busy state; `wide` prop from `SidebarFooterActionOwnerProps` picks `logout` vs `logoutShort` (rail). `Button` from `ui-primitives` — same import `AdminSection.tsx:9` uses.
- `packages/client/ui-admin/src/client/index.ts:apply` — two independent async IIFEs behind the same `/api/auth/me` probe. The Admin `settings.section id admin order 40` gate stays on `role==='admin'`; the logout `sidebar.footer.action id logout order 20` gate is on `resp.ok` alone (any authenticated user, not just admins). The contract `packages/client/ui-sidebar/src/client/contract/slots.ts:35` declares `sidebar.footer.action { kind: 'list'; scope: 'root'; owner: SidebarFooterActionOwnerProps { wide } }`. The type-only augmentation `declare module '@deepseek-ai/dsh-client-ui-slots'` merges only when `import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'` is seen by the program — `ui-admin` adds that import plus a `{ path: '../ui-sidebar' }` reference in `tsconfig.json` so `tsc -b` sees `sidebar.footer.action` in the ledger union. Without either the reference or the import, `tsc -b` rejects the slot name while `tsdown` (which ignores types) happily bundles — a false-green that bricked the host build's type gate.
- `packages/client/ui-admin/src/client/locales.ts` — `logout` / `logoutShort` (rail) / `loggingOut` (en+zh, so `verify-translation-pairing` stays paired). En/wide vs zh/rail pairing is checked on both languages at the `verify-translation-pairing` pre-commit hook.

No new row in `packages/bundle/web-app/cordis.patch.yml` or new `dsh.client` tier is needed — `ui-admin` already lives in `dsh-web-app`'s `dsh.bundle.patch`; a dedicated `ui-auth` would have required both plus a new dependency cluster, but would have duplicated the probe.

## Consequences

**Auth-idempotent.** 401 (no session) or any non-ok/never-thrown from `GET /api/auth/me` is a silent no-op at both gates — the plugin ships in every composition exactly like `ui-auth-login`. Non-auth deployments see neither Admin nor logout. Non-admins see logout but not Admin (the Admin section's probe checks `body.role === 'admin'` first).

**Logout is single-tab.** Signing out in one tab drops the shared cookie, so refreshing the other tab's `/api/auth/me` is already 401. No per-tab `storage` event is needed.

**Stateless lifetime is not shortened.** The signed `dsh_session` payload remains verifiable until TTL expiry by any holder who copied the token before logout. A server-side revocation list would be the hardening follow-up, out of scope for a single button.

**Authoritative at most one.** The `Secure` mirror (`isHttps` on both login and logout) is strictly additive — it does not change non-https behavior but makes https logout actually overwrite the `Secure` cookie. On non-https `127.0.0.1:3080` the bit stays absent symmetrically.

**`tsc -b` trap survives.** Every new client plugin adds a `packages/client/<name>/lib/index.js` host face that `tsc -b --clean` deletes. A naked `tsc -b --clean` without a `tsdown --env.DSH_BUILD_FACE host` follow-up bricks `dsh web` startup with `Cannot find module dsh-client-ui-admin/lib/index.js` until the `tsdown --env.DSH_BUILD_FACE` pair is re-run. `pnpm run typecheck` / `pre-push` restores host+client bundle; direct `tsc -b` does not.

**Footer vs a future Account section.** The footer solves the *action* (one click, no navigation) but not *identity* (no room for userId/role). The complementary `settings.section id:account order:50` — rendering userId + role + a second logout affordance — mirrors `ui-admin`'s pattern exactly and is the better home when account prefs arrive. The two surfaces are not mutually exclusive: footer is the action, Account is the identity/settings home (the Explore agent's suggested split). Caps are implemented in the next todo; the agent note will attach the pairing.

## Alternatives considered

**A new settings.section `id:account` (instead of the footer).** Has room for userId + role + future prefs and fits the "Account" mental model. Rejected for *this* task: logout would be buried behind opening Settings → Account tab, worse UX for a frequent and sometimes-urgent action. It is the better home for identity display, not for the action.

**A new `ui-auth` package owning `logout` alone.** Would have given the tightest seam. Rejected: `ui-admin` already probes `GET /api/auth/me` and already composes the web bundle, so the second probe + one file is the smaller patch than minting a package with its own `tsdown.config.ts` `clientBundle(...)`, `cordis.patch.yml` row, and `package.json` tier entry. If an Account settings section is later added, extracting `ui-auth` then is the cleaner seam.

**Server-side token revocation sets at logout.** Would shorten the stolen-token window. Rejected for user-id+password stage: it collides with the stateless `-store` milestone's recovery rules and belongs with its own architecture note.

**`handleLogout` without touching `req`.** Left `Secure` unmirrored; on `dsh.mrians.my.id` (https) the stale Secure cookie survived logout. Mirroring `isHttps → Secure` in the `Max-Age=0` copy is therefore required by every deployment that serves auth over https.

**Delete two deployed file-persisted fixtures while this shipped.** Deferred: two small JSONs under the deployed doc (`docs/`) were candidates to prune but are unrelated to the logout surface; deleting them in the same doc-pass would have hidden their revert diffs in the pairing update. The todo to prune them sits adjacent to that diff; the prunes commit their pair separately so the fixture diffs stay double-timed on retry.

## Verification

1. **Typecheck + two faces.** `tsc`-checked `packages/client/ui-admin/tsconfig.json` includes `@deepseek-ai/dsh-client-ui-sidebar/client` so `sidebar.footer.action` is in the ledger union. Re-build `ui-admin` host face (`lib/index.js`) and client face (`lib/client.js`) — `tsdown --env.DSH_BUILD_FACE host/client` — so the client bundle `__ModuleLoader__.load` carries `LogoutFooterAction`. (`pnpm run typecheck` / `pre-push` rebuilds both; the standalone `pnpm` bin re-runs `tsdown -- DSH_BUILD_FACE` pair but the raw `tsc -b --clean` wipes host.)
2. **Live 3080 loopback.** Provision `mrians21` (`admin`, `!Mrians1309`) and `demo` (`user`, `demo1234`) in `dsh_auth_users`. From two `curl -c/-b` cookie jars:
   - Login as `mrians21` → `GET /api/auth/me → {userId:'mrians21', role:'admin'}`; as `demo` → `{role:'user'}`. Sidebar footer shows the logout button in both wide and rail states (`wide ? t('logout') : t('logoutShort')`) while the admin still shows the Admin nav.
   - As `mrians21`, `POST /api/auth/logout` (200, `Set-Cookie Max-Age=0`) → `GET /api/auth/me` → 401; in a separate tab `demo`'s `/api/auth/me` stays `user` (cross-user isolation). `demo` can also independently `POST /api/auth/logout` to sign out without touching `mrians21` if re-logged in.
   - Repeat after expanding `packages/client/ui-admin` — the host `lib/index.js` guard and the client `lib/client.js` `LogoutFooterAction` are in the rebuilt bundle before the `Cordis:include` loader request for `dsh-client-ui-admin/lib/index.js`.
3. **Non-auth deployment invariant.** Where `auth-simple` is not composed, every `fetch('/api/auth/me')` probe is 404/never-throw, so neither the Admin nav nor the logout footer registers — the plugin is the same safe no-op as landing.
