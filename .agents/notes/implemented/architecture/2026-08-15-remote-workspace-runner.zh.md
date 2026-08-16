# Agent Note: 远程工作区 runner——大脑在服务器，双手在笔记本

[English](2026-08-15-remote-workspace-runner.md) | 中文

Status: implemented

## 问题

DSH web UI（`dsh web`）在**服务器进程**上执行每一个工具——bash、filesystem、subprocess、PTY、skill、MCP 服务器。auth gate（[2026-08-12 auth gate](2026-08-12-auth-gate-for-public-web-surface.md)）让用户能远程登录，但当笔记本 A 上的用户打开公开部署并要求 agent 运行 `bash` 或编辑文件时，它运行在**服务器**的文件系统上，而非笔记本 A 上。用户无法通过 web UI 操作自己笔记本上的文件，也没有按用户隔离的 workspace。

目标：用户在笔记本上安装一个小的 DSH runner，连接到公开服务器，agent 针对**笔记本自己的文件**执行工具。模型列表与 LLM API key 留在服务器侧（一把中心 key、集中成本）；skill 目录与 MCP 配置从服务器同步到笔记本；`mrians21` 是 super-admin。规模：单人或一个小的可信团队。

## 决策

一种**混合**模式：agent loop 运行在**笔记本**上（于是 tool/skill/MCP/bash 命中笔记本的文件），但每一次 LLM 调用都代理到**服务器**（它持有 API key 与 model catalog）。服务器是协调器 + LLM gateway + auth + 同步；笔记本是运行时 + 执行器。这既不是纯「provider 在服务器远程」（错误：skill/MCP 必须运行在文件所在处），也不是纯「笔记本独立 agent」（错误：API key/model 列表必须集中）。它是一种新模式：笔记本启动一个 DSH profile，其**唯一被替换的能力是 LLM 适配器**；bash/fs/skill/MCP 留在本地。

四个包，均为 `@deepseek-ai/dsh-<name>`、ESM、host-only（无 `tsdown.config.ts` client bundle；`tsc -b` 产出 `lib/types/`，`DSH_BUILD_FACE=host tsdown` 产出 `lib/{index,invariant,startup}.js`）：

| 包 | 侧 | 角色 |
|---|---|---|
| `dsh-runner-hub` | 服务器 | `ctx.runnerHub`：按 (user,device) 的双向 WS 连接、LLM gateway、model catalog 真源、skill/MCP inventory 同步、catalog 变更拒绝器。 |
| `dsh-llm-remote` | 笔记本 | `RemoteLlmAdapter extends LlmAdapter`：把 `stream()`/`listModels()` 委托给 hub。笔记本上唯一被替换的 provider。 |
| `dsh-runner` | 笔记本 | `dsh runner connect` CLI：启动本地 runner profile（`dsh-base` 之上的一层薄覆盖，禁用 `llm-deepseek` 并插入 `llm-remote`/`runner-startup`/`runner-driver`）、登录、打开 runner 通道、挂载同步的 skill/MCP，并运行本地 agent loop——或连接后空转。 |
| （无 admin 包） | — | runner 通道上的 catalog 变更被无条件拒绝（见下方 Catalog gate）。管理员的杠杆是服务器访问权。 |

### 唯一被替换的能力

笔记本 profile 是**`dsh-base` 之上的一层薄覆盖**：它不重新声明 base 的 plugin 行。`dsh-base` 提供本地 agent loop、bash/fs/subprocess/skill/MCP provider。runner 覆盖层禁用 `llm-deepseek`（本地 DeepSeek 适配器）并插入三行：`llm-remote`（被替换的 LLM 适配器）、`runner-startup`（解析 `--server/--user/--workspace/--device/[task]`）、`runner-driver`（连接、挂载同步、运行）。对任何 base 能力的仓库更新都原样抵达 runner——runner 不是一个会陈旧的行列表，而是一层薄 patch。

`RemoteLlmAdapter.stream(options)` 不调用 DeepSeek；它通过 WS 向 hub 发送一个 `llm.stream` 帧，并产出 hub 回流（stream back）的 `StreamChunk`。`listModels()` 返回一个可变的 `RemoteModelCatalog`，runner 在 hub 推送 `catalog.invalidate` 时替换它。笔记本永远看不到 API key。

### 双向 `/runner/channel` 协议

与浏览器 WS downlink（严格单向下行——客户端发送即以 1008 关闭，`websocket-downlink`）不同，runner 通道是**全新且完全双向**的。JSON 帧、`rpcId` 关联、二进制流用 base64：

- `laptop→hub`：`runner-call {rpcId, method, payload}`（`llm.stream`、`model.list`、`skill.catalog`、`mcp.configs`、`model.set`、`provider.update`），由 `runner-response`/`runner-error` 应答；`runner-stream {rpcId, kind:'llm-token', data}` 用于流式 LLM 分片。
- `hub→laptop`：`runner-call`（`subprocess.*`、`fs.*`、`skill.sync`、`mcp.sync`、`control.workspace`、`sync.invalidate`、`catalog.invalidate`），由笔记本应答。

升级由与 `/api` 路由相同的 fence 把守：`isTrustedApiRequest`（DNS rebinding）先跑，再通过 `ctx.authSimple`（`extractCookie` + `verifySession`）校验 `dsh_session` cookie。cookie 校验通过前绝不协商 socket。

### 多设备：按 (user,device) 的连接

同一凭据可能装在多台笔记本上。hub 按 `(userId, deviceId)` 为连接建立索引——`Map<userId, Map<deviceId, RunnerConnection>>`——而非每用户一个连接。笔记本在升级时发送 `?device=<id>`。同一凭据上的第二台笔记本与第一台**共存**；只有**同一**设备重连才会替换它自己的陈旧 socket。离线设备表现为 `getConnection` 返回 `undefined`，于是调用方报告「runner 离线」，而非静默杀掉另一台笔记本的会话（Phase 1 的 last-writer-wins bug）。

笔记本的 device id 持久化在 `$DSH_HOME/runner-device-id`，于是 supervisor 重启复用同一设备（绝不生成会遗留上一个注册表条目的新 UUID）。显式的 `--device` 标志为一次性运行覆盖它。

### Skill/MCP 同步

在连接时（以及 hub 推送 `sync.invalidate` 时），笔记本拉取服务器的 skill 目录与 MCP inventory：

- **Skill**：一个内存型 `SkillProvider`（`name: 'runner-sync'`，rank 350——低于 project/custom 根 100-300 以让本地 skill 胜出，高于 user/bundled 400-600）。`resourceBase: {kind:'opaque'}`。hub 用笔记本侧的 provider 标签重新物化每个 skill，使笔记本的候选能通过校验。无磁盘 I/O；filesystem 没有内存型 hook。
- **MCP**：对每个 `SyncedMcpServer`，一个带作用域的 `ctx.plugin(mcpClient, config)`（完整命名空间，而非仅 `apply`，于是 `inject:['tools']` + `Config` schema 得到遵守）。子进程在笔记本上**本地** spawn，于是工具运行在用户文件所在处。`failOnStartupError: false` 以使一个坏服务器不会破坏整个面。刷新时按 name 做 reconciliation。

两者都在 `loader.await()` **之后**挂载，因为 `skills`/`tools` 不是 `runner-driver` 的传递性 inject。

### Catalog gate + 新鲜度

runner 通道**始终拒绝** `model.set`/`provider.update`——对 admin 与非 admin 一视同仁（`code: 'forbidden'`）。纵深防御：这些方法保留声明在 `RunnerToHubMethod` 中，于是 hub 应答它们而非静默丢弃。管理员的杠杆是服务器访问权（直接编辑 `~/.dsh/settings.yaml`，`llm-deepseek`/`llm-pi-ai` 会热加载）。

真正的缺口是 catalog **新鲜度**：笔记本的 `RemoteLlmAdapter` catalog 在连接时缓存，并在服务器 catalog 变化时变陈旧。hub 监听 `ctx.llm` 的 `llm/adapters-updated` 事件（任何 provider/model 拓扑变化时触发，例如一次 `settings.yaml` 编辑热加载某个适配器），并向每个用户的每个已连接设备推送 `catalog.invalidate`（catalog 是进程级的——一份 settings 文档）。笔记本重新拉取 `model.list` 并原地替换其缓存 catalog，无需重新注册路由或重连。

### 重连 + supervisor

transport 在丢失 socket 时以指数退避重连（镜像 `ConnectionController`）：`backoffDelay = min(max, base * factor^(attempt-1))`，带抖动 `cap/2 + rand*cap/2`。默认：base 500ms、factor 2、max 10s。丢失的 socket 拒绝在途调用（笔记本重新发起任何 LLM 调用），调度一次重连，并在成功重开时触发 `onReconnect`，使 driver 重新拉取 catalog 并重新同步 skill/MCP（笔记本可能在离线期间错过了服务器的变更）。`dispose()` 停止循环、清除已武装的退避计时器，并发出终态 `disconnected`。

hub 侧的 `ws.on('close')` 清理会丢弃该设备的注册表条目，使离线设备表现为 `undefined`（而非一个存在但已关闭的连接）。守卫 `userDevices.get(deviceId) === conn` 防止重连时的 `prior.dispose()` 误删替代连接。

后台 runner 是一个无任务的 `dsh runner connect`：它连接并空转，保持通道打开，且绝不能调用 `ctx.appExit`。一个 Windows 计划任务 supervisor（`dsh-runner.ps1`，镜像 `dsh-web.ps1` 看门狗）在进程退出时重新拉起 runner；transport 的退避处理进程内的瞬时掉线。凭据放在 `~/.dsh/dsh-runner.env`（一个 dsh 自身绝不加载的文件，因为它拒绝 `.env` 中的 `DSH_*` 名字），以 `DSH_RUNNER_PASSWORD` 注入。

## 后果

**agent loop 在笔记本上。** 工具运行在笔记本的文件上。服务器只持有 API key、model catalog、auth 与同步——它从不运行用户工具。对 bash/fs/skill/MCP 的仓库更新原样抵达 runner，因为 runner 是 `dsh-base` 之上的一层薄 patch，而非重新声明的行列表。

**API key 绝不离开服务器。** 笔记本的 `ctx.llm` 由 `RemoteLlmAdapter` 提供，后者代理每次调用。笔记本通告的 model 列表是服务器的 catalog，由 `catalog.invalidate` 保持最新。

**多设备是真实的。** 同一凭据上的两台笔记本共存；当一台连接时 hub 绝不静默杀掉另一台。同一笔记本重连只替换它自己的 socket。

**runner 通道上无法变更 catalog。** 每一个 `model.set`/`provider.update` 都是 `forbidden`。管理员在服务器上编辑 `settings.yaml`；hub 把变更扇出到所有笔记本。

**服务器侧回退（无 runner 在线时在服务器上执行）被推迟。** 没有协调机制时，它会强制静默覆盖离线期间的本地编辑。若日后加入，协调路径是按 workspace 的 git（服务器提交；重连 = pull/rebase；冲突作为 git 冲突暴露，无数据丢失）。

## 考虑过的替代方案

**Provider 在服务器远程（原始的 plan-agent 设计）。** 错误：skill/MCP 必须运行在文件所在处（`skill-filesystem` 读 `node:fs`；`mcp-client` spawn 本地子进程）。在服务器上运行它们操作的是服务器的文件。

**笔记本独立 agent。** 错误：API key 与 model 列表必须集中（一把 key、集中成本、唯一真源）。独立笔记本会需要自己的 key。

**每用户一个连接。** Phase 1 的 `Map<userId, RunnerConnection>` 采用 last-writer-wins，当笔记本 B 在同一凭据上连接时会静默杀掉笔记本 A。按设备建索引修复了它。

**进程内 super-admin 成员 gate（`dsh-runner-admin` 带一个 `['mrians21']` 种子）。** 用户选择了「全部拒绝」runner 通道变更：一个总是拒绝的硬编码 admin 列表是死代码。admin 角色是服务器访问权，而非进程内检查。（想要从笔记本做 `dsh runner admin set-model` 的未来 phase 会复活成员 gate + `settings.mutate` 映射——推迟，而非删除。）

**服务器侧文件同步作为 workspace 机制。** 完整文件同步是另一个产品；没有协调机制时会丢失离线编辑。MVP 保持「文件在笔记本上」的承诺并推迟同步。
