# Agent Note: 公开 web 面的认证 gate

[English](2026-08-12-auth-gate-for-public-web-surface.md) | 中文

Status: implemented

## 问题

DSH web GUI（`dsh web`）默认绑定 loopback，启动时有意拒绝 `--host 0.0.0.0` 标志，因为把服务器暴露给网络会暴露远程代码执行——每个会话都能以宿主进程身份运行 `bash`、文件系统工具与子进程。浏览器信任 fence（`isTrustedApiRequest`）是 DNS rebinding 与跨站防御，明确不是认证层。

在公开域名（例如反代后面的 `dsh.mrians.my.id`）上提供 web GUI 的部署，需要一道认证 gate 在任何 `/api` 请求抵达 RPC 桥之前就位。没有它，任何能解析该域名的人都能创建会话并在服务器上运行工具。

## 决策

认证是**组合，而非核心改动**。两个新包在不改动 agent loop、工具分派或会话模型的前提下，加入一层完整的 user-id + 密码认证：

| 包 | 角色 |
|---|---|
| `@deepseek-ai/dsh-auth-simple`（服务器插件） | PostgreSQL 用户存储 + bcrypt 密码校验 + HMAC-SHA-256 签名会话 token。注册 `/api/auth/*` HTTP 路由，并向 Connection fence 提供一个 `authHook`。 |
| `@deepseek-ai/dsh-client-ui-auth-login`（客户端插件） | 浏览器侧登录覆盖层。启动时探测 `/api/auth/me`；当服务器回 401（认证已启用、无会话）时，在 slot 系统存在之前直接把登录表单渲染进 DOM。登录成功 + 页面重载后自移除。 |

### authHook seam

connection 包获得一个字段和一个方法：

- `ConnectionConfig` 不增内容——hook 在运行时注册，而非静态配置。
- `HostConnectionHandle` 获得 `registerAuthHook(hook: ConnectionAuthHook)`：一个 auth 插件调用它来安装一道校验，fence 在其 DNS rebinding Host/Origin 校验通过后运行。
- `HostConnectionService.checkAuth(request)`：由 `/api` 路由处理器与 WebSocket 升级 gate 调用。未注册 hook 时返回 `true`（fence 行为与之前完全一致）。注册了一个时，每个 `/api` 请求与 WebSocket 升级也必须通过该 hook。

这遵循仓库约定「在做出该决定的操作中强制该决定」：fence 仍是单一强制点。DNS rebinding 校验先跑；只有它通过时 auth hook 才跑。来自 rebinding 攻击的未认证请求在 auth 被咨询之前就被 fence 拒绝。

### 路由组合

webserver 的最长前缀匹配在 connection 插件的 `/api` 前缀捕获之前，把 `/api/auth/*` 路由给 auth 插件（注册为 `kind: 'prefix', path: '/api/auth'`）。不会冲突，因为路径不同。

### 会话 token

token 形如 `base64url(payload).base64url(hmac)`，其中 payload 是 `{ userId, issuedAt }`。校验是无状态的：用 `timingSafeEqual` 做 HMAC 比较，再做 TTL 检查。不需要服务端会话存储——cookie 携带一切。cookie 是 `HttpOnly`、`SameSite=Strict`，且在检测到 HTTPS 时为 `Secure`。

### 客户端 gate

`ui-auth-login` 客户端插件是 `immediately: true`，于是在 shell 之前加载。它的 `apply()` 探测 `/api/auth/me`：

- **200** → 用户已认证；插件是无声的 no-op，正常启动继续。
- **401** → 认证已启用且用户无会话；登录覆盖层渲染。
- **任何其他响应**（含网络失败）→ 没有组合 auth；插件是 no-op，启动继续。这意味着插件在每个组合中都可安全携带——它只在确实存在 auth 插件时激活。

覆盖层是纯 DOM/CSS，以 Ethereal Glass 设计原型构建（OLED 黑背景、径向网格渐变、双边框玻璃卡、弹簧物理动效）。它在 React slot 系统存在之前渲染，并在成功登录触发 `window.location.reload()` 后自移除。

## 后果

**fence 的权威列表不变。** `trustedHosts` 仍是 DNS rebinding fence，而非 auth。在公开域名上提供服务的部署把它声明在 `--trusted-host` 以通过 rebinding 校验，然后 auth hook 是第二道 gate。两者都必须通过。

**至多一个 auth hook 处于活跃。** `registerAuthHook` 在已有 hook 注册时抛错。两种 auth 策略无法在同一强制点组合而无组合器；若将来需要，一个组合器插件会把自己注册为 hook 并复用。

**`ApiTrustFenceRequest` 类型浏览器兼容。** 它用 `Record<string, string | string[] | undefined> | Headers` 而非 `IncomingHttpHeaders`，于是 `rpc.ts`（Host 与 Client 两半共享）不会把 `node:http` 拉进浏览器 bundle。

**特权方法保持 loopback 绑定。** `PRIVILEGED_METHODS` 集合（settings、credentials、preset 管理、`host.openPath`、`llm.discoverModels`）仍以空信任列表 gate 到 loopback。认证不放松它——一个非 loopback 的已认证用户仍无法触达特权方法。这是纵深防御。

**不改工具、sandbox 或会话模型。** 工具仍在服务器上运行。`session.create` 仍不在 `PRIVILEGED_METHODS` 中（设计如此——默认 preset 已带 `bash` 与文件系统工具，把切换 pin 住将是开着的门旁再加一道 fence）。auth 是阻止匿名访问的 gate；已认证用户能做什么不变。

## 考虑过的替代方案

**修改 `isTrustedApiRequest` 硬编码 auth。** fence 是 DNS rebinding 防御，而非 auth 层。嵌入 auth 逻辑会在同一强制点混合两个关注点并使 fence 变得 auth-aware。`authHook` seam 保持 fence 与 auth 无关。

**服务端会话存储（Redis/数据库）。** HMAC 签名的无状态 token 更简单，除了 PostgreSQL（用户存储已在用）之外无需基础设施，且能水平扩展。服务端存储用于 token 撤销，而这并非此简单 auth 层的需求。

**OAuth / 多租户。** 需求是少量用户的 user-id + 密码。OAuth 增加登录流程、重定向处理与 provider 依赖。多租户需要按用户隔离 workspace，这是另一个架构关注点（phase 2：在客户端机器上远程执行）。

**shadcn/ui 或组件库做登录页。** 覆盖层在 React slot 系统存在之前渲染，于是它必须是纯 DOM/CSS。没有组件库能在启动链那么早加载。
