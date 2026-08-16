# Agent Note: 侧边栏页脚登出按钮

[English](2026-08-16-web-logout-button.md) | 中文

Status: implemented

## 问题

此前 `dsh web` 的 auth gate 没有清除会话的途径，除了手动删除 `dsh_session` cookie。登录 gate（`ui-auth-login`）为每个 web 请求签发 cookie，但没有任何已认证面展示"你是 X"，也无持久控件用于登出。

旧的 `handleLogout` cookie 写入在不携带 `Secure` 的情况下硬编码 `HttpOnly; SameSite=Strict; Max-Age=0`，而登录条件地设置了 `Secure`（`isHttps → Secure`）。在 https 部署（`dsh.mrians.my.id`）上，登录签发的 `Secure` cookie 在登出的 `Set-Cookie` 中幸存，直至 TTL 过期才清除，留下陈旧会话。

浏览器侧无自然位置放置控件：无账号菜单、无侧栏头像、无 `General` 账户行。每个已认证用户——admin 与非 admin——都需要同一个一键登出。

## 决策

一个增量的浏览器插件在侧边栏页脚注册一个持久控件——位于 `SidebarRoot.tsx:182-189` 中 `Settings` 触发器上方的增量内部 slot `sidebar.footer.action`，为项目自有 plugin-dev 技能背书（"prefer additive inner Slots such as `sidebar.footer.action`; do not replace the entire sidebar"）。登出按钮以登录与 admin gate 已用的同一个 `GET /api/auth/me → 200` 探测为门禁的一键动作。

### 缝隙

服务器路由已存在且保持不变：`POST /api/auth/logout`（`packages/auth/auth-simple/src/index.ts:419 handleLogout`）以 `Max-Age=0` 清除 `dsh_session`。无需额外路由、无需会话存储、无需 `connection/reset`——无状态 HMAC token 仍保持无状态；清除 cookie 即为此简单认证层所需的唯一撤销。对 `handleLogout` 的修复让 `req` 透传，使 `isHttps → Secure` 在 https 上镜像 `handleLogin`。`GET /api/auth/me` 保持无状态。

浏览器侧复用 Admin 插件包，而非铸造新的 `ui-auth`：

- `packages/client/ui-admin/src/client/LogoutFooterAction.tsx`——`POST /api/auth/logout`（`credentials:'include'`）→ `window.location.reload()`（与 `ui-auth-login/src/client/index.ts:379` 处的登录 reload 镜像，使启动重新探测 `/api/auth/me`，得到 401 后登录覆盖层重现）。busy 状态；来自 `SidebarFooterActionOwnerProps` 的 `wide` 在 `logout` 与 `logoutShort`（rail）间选择。`Button` 来自 `ui-primitives`——与 `AdminSection.tsx:9` 所用同一导入。
- `packages/client/ui-admin/src/client/index.ts:apply`——在同一个 `/api/auth/me` 探测后两个独立的异步 IIFE。Admin 的 `settings.section id admin order 40` gate 仍在 `role==='admin'` 上；登出的 `sidebar.footer.action id logout order 20` gate 仅在 `resp.ok` 上（任何已认证用户，而非仅 admin）。合约 `packages/client/ui-sidebar/src/client/contract/slots.ts:35` 声明 `sidebar.footer.action { kind: 'list'; scope: 'root'; owner: SidebarFooterActionOwnerProps { wide } }`。类型侧的增量 `declare module '@deepseek-ai/dsh-client-ui-slots'` 仅当程序看到 `import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'` 时合并——`ui-admin` 增加该导入以及 `tsconfig.json` 中 `{ path: '../ui-sidebar' }` 的引用，使 `tsc -b` 在 ledger 联合中看到 `sidebar.footer.action`。没有任一引用或导入，`tsc -b` 会拒接该 slot 名称，而 `tsdown` 则会愉快地打包——一种烧毁 host 构建类型门禁的假绿。
- `packages/client/ui-admin/src/client/locales.ts`——`logout` / `logoutShort`（rail）/ `loggingOut`（en+zh，使 `verify-translation-pairing` 保持配对）。En/wide 与 zh/rail 的配对在 pre-commit 钩子的 `verify-translation-pairing` 中对两种语言检查。

`packages/bundle/web-app/cordis.patch.yml` 或新的 `dsh.client` 层级无需新增行——`ui-admin` 已落在 `dsh-web-app` 的 `dsh.bundle.patch` 中；一个专用的 `ui-auth` 将需要二者并新增依赖簇，但会复制探测。

## 后果

**auth-幂等。** 来自 `GET /api/auth/me` 的 401（无会话）或任何非 ok/未抛异常，在两道 gate 上都是静默 no-op——该插件在每个组合中按 `ui-auth-login` 的方式安全携带。非认证部署既不见 Admin 亦不见登出。非 admin 见登出但不见 Admin（Admin 区的探测先检查 `body.role === 'admin'`）。

**登出是单标签。** 在一个标签中登出会丢弃共享 cookie，因此另一标签刷新 `/api/auth/me` 已是 401。无需 per-tab 的 `storage` 事件。

**无状态生命周期未缩短。** 签名的 `dsh_session` payload 在登出前复制了 token 的持有者仍可在 TTL 过期前验证。服务端撤销列表将是加固的后续工作，超出单一按钮的范围。

**至多一个权威。** `Secure` 镜像（登录与登出上的 `isHttps`）严格是增量的——它不改变非 https 行为，但在 https 上让登出真正覆盖 `Secure` cookie。在非 https 的 `127.0.0.1:3080` 上，该位对称地保持缺席。

**`tsc -b` 陷阱仍在。** 每个新的客户端插件都加入一个 `packages/client/<name>/lib/index.js` host 面，`tsc -b --clean` 会删除它。一个裸的 `tsc -b --clean` 若无 `tsdown --env.DSH_BUILD_FACE host` 跟进，会以 `Cannot find module dsh-client-ui-admin/lib/index.js` 烧毁 `dsh web` 的启动，直至重跑 `tsdown --env.DSH_BUILD_FACE` 对。不像 `ui-auth-login` 那般切断了 `Cordis:include` 加载器对 `dsh-client-ui-admin/lib/index.js` 的请求。`pnpm run typecheck` / `pre-push` 恢复 host+client bundle；直接的 `tsc -b` 则不会。

**页脚 vs 未来的 Account 区块。** 页脚解决 *动作*（一次点击，无需导航），但未解决 *身份*（无空间显示 userId/role）。互补的 `settings.section id:account order:50`——渲染 userId + role + 第二个登出入口——与 `ui-admin` 模式完全镜像，是存放账户偏好的更好归宿。二者并不互斥：页脚是动作，Account 是身份/设置之家（Explore agent 建议的分工）。限制在下一待办中实现；agent note 将附上配对。

## 考虑过的替代方案

**一个新的 settings.section `id:account`（而非页脚）。** 有空间放 userId + role + 未来偏好，符合"Account"的心智模型。被本次任务拒绝：登出将埋在打开 Settings → Account tab 之后，对一个频繁且有时紧急的动作体验更差。它是展示身份的更好归宿，而非动作。

**一个仅拥有 `logout` 的新 `ui-auth` 包。** 将给出最紧的缝隙。被拒绝：`ui-admin` 已探测 `GET /api/auth/me` 且已组合进 web bundle，因此第二探测 + 一个文件的增量比铸造一个带自有 `tsdown.config.ts` `clientBundle(...)`、`cordis.patch.yml` 行与 `package.json` 层级入口的包更小。若后续加入 Account 设置区块，则届时抽取 `ui-auth` 是更清晰的缝隙。

**在登出时的服务端 token 撤销集。** 将缩短被盗 token 窗口。与 user-id+password 阶段的无状态 `-store` 里程碑的恢复规则冲突，归属于其自有的架构笔记而拒绝。

**不触碰 `req` 的 `handleLogout`。** 使 `Secure` 未镜像；在 `dsh.mrians.my.id`（https）上，陈旧的 Secure cookie 在登出后幸存。将 `isHttps → Secure` 镜像到 `Max-Age=0` 的副本是每个以 https 承载认证的部署所必需。

**在本次落地同时删除两个已部署的文件持久化 fixture。** 推迟：`docs/` 下两个小 JSON 在删减候选之列但与登出面无关；在同一 doc-pass 中删除它们会被配对更新隐藏其回滚差异。删减的待办紧邻该差异；删减提交在配对上单独提交，使 fixture 差异在重试时双计时。

## 验证

1. **Typecheck + 两面。** `tsc` 检查的 `packages/client/ui-admin/tsconfig.json` 包含 `@deepseek-ai/dsh-client-ui-sidebar/client`，因此 `sidebar.footer.action` 位于 ledger 联合中。重构 `ui-admin` 的 host 面（`lib/index.js`）与 client 面（`lib/client.js`）——`tsdown --env.DSH_BUILD_FACE host/client`——使 client bundle 的 `__ModuleLoader__.load` 携带 `LogoutFooterAction`。（`pnpm run typecheck` / `pre-push` 重建两者；单机的 `pnpm` bin 重跑 `tsdown -- DSH_BUILD_FACE` 对但裸的 `tsc -b --clean` 会抹除 host。）
2. **实时 3080 loopback。** 在 `dsh_auth_users` 中预置 `mrians21`（`admin`，`!Mrians1309`）与 `demo`（`user`，`demo1234`）。来自两个 `curl -c/-b` cookie jar：
   - 以 `mrians21` 登录 → `GET /api/auth/me → {userId:'mrians21', role:'admin'}`；以 `demo` → `{role:'user'}`。侧栏页脚在 wide 与 rail 状态均显示登出按钮（`wide ? t('logout') : t('logoutShort')`），而 admin 仍显示 Admin 导航。
   - 以 `mrians21` 身份 `POST /api/auth/logout`（200，`Set-Cookie Max-Age=0`）→ `GET /api/auth/me` → 401；在另一个标签中 `demo` 的 `/api/auth/me` 仍为 `user`（跨用户隔离）。`demo` 也可独立 `POST /api/auth/logout` 以在 `mrians21` 重新登录时不影响其登出。
   - 在扩容 `packages/client/ui-admin` 后——host 的 `lib/index.js` 守卫与 client 的 `lib/client.js` 中的 `LogoutFooterAction` 在 `Cordis:include` loader 请求 `dsh-client-ui-admin/lib/index.js` 前已位于重建包中。
3. **非认证部署不变量。** 在未组合 `auth-simple` 的地方，每个 `fetch('/api/auth/me')` 探测为 404/未抛异常，因此 Admin 导航与登出页脚均不注册——该插件为与落地时相同的无声 no-op。
