# Agent Note: Remote-workspace runner — brain on server, hands on laptop

English | [中文](2026-08-15-remote-workspace-runner.zh.md)

Status: implemented

## Problem

The DSH web UI (`dsh web`) executes every tool — bash, filesystem, subprocess, PTY, skills, MCP servers — on the **server process**. The auth gate ([2026-08-12 auth gate](2026-08-12-auth-gate-for-public-web-surface.md)) lets users log in remotely, but when a user at Laptop A opens the public deployment and asks the agent to run `bash` or edit a file, it runs on the **server's** filesystem, not on Laptop A's. There is no way for a user to operate on their own laptop's files through the web UI, and no per-user workspace isolation.

The goal: a user installs a small DSH runner on their laptop, connects to the public server, and the agent executes tools against **the laptop's own files**. The model list and LLM API key stay server-owned (one central key, central cost); the skill catalog and MCP config sync server → laptop; `mrians21` is a super-admin. Scale: a single user or a small trusted team.

## Decision

A **hybrid** mode: the agent loop runs on the **laptop** (so tool/skill/MCP/bash hit the laptop's files), but every LLM call is proxied to the **server** (which owns the API key and model catalog). The server is a coordinator + LLM gateway + auth + sync; the laptop is the runtime + executor. This is neither pure "provider remote on server" (wrong: skill/MCP must run where the files are) nor pure "standalone laptop agent" (wrong: API key/model list must be central). It is a new mode where the laptop boots a DSH profile whose **only swapped capability is the LLM adapter**; bash/fs/skill/MCP stay local.

Four packages, all `@deepseek-ai/dsh-<name>`, ESM, host-only (no `tsdown.config.ts` client bundle; `tsc -b` emits `lib/types/`, `DSH_BUILD_FACE=host tsdown` emits `lib/{index,invariant,startup}.js`):

| Package | Side | Role |
|---|---|---|
| `dsh-runner-hub` | server | `ctx.runnerHub`: per-(user,device) bidirectional WS connections, LLM gateway, model-catalog source of truth, skill/MCP inventory sync, catalog-mutation rejector. |
| `dsh-llm-remote` | laptop | `RemoteLlmAdapter extends LlmAdapter`: delegates `stream()`/`listModels()` to the hub. The ONE swapped provider on the laptop. |
| `dsh-runner` | laptop | `dsh runner connect` CLI: boots the local runner profile (a thin layer over `dsh-base` that disables `llm-deepseek` and inserts `llm-remote`/`runner-startup`/`runner-driver`), logs in, opens the runner channel, mounts synced skills/MCP, and runs the local agent loop — or connects and idles. |
| (no admin package) | — | Catalog mutation over the runner channel is unconditionally rejected (see Catalog gate below). The admin's lever is server access. |

### The ONE swapped capability

The laptop profile is a **thin layer over `dsh-base`**: it does not redeclare base's plugin rows. `dsh-base` provides the local agent loop, bash/fs/subprocess/skill/MCP providers. The runner overlay disables `llm-deepseek` (the local DeepSeek adapter) and inserts three rows: `llm-remote` (the swapped LLM adapter), `runner-startup` (parses `--server/--user/--workspace/--device/[task]`), and `runner-driver` (connect, mount sync, run). A repo update to any base capability reaches the runner unchanged — the runner is not a row list that goes stale, it is a thin patch.

`RemoteLlmAdapter.stream(options)` does NOT call DeepSeek; it sends an `llm.stream` frame over the WS to the hub and yields the `StreamChunk`s the hub streams back. `listModels()` returns a mutable `RemoteModelCatalog` the runner swaps on a hub `catalog.invalidate` push. The laptop never sees the API key.

### Bidirectional `/runner/channel` protocol

Unlike the browser WS downlinks (strictly downlink-only — close 1008 if the client sends, `websocket-downlink`), the runner channel is **new and fully bidirectional**. JSON frames, `rpcId` correlation, base64 for binary streams:

- `laptop→hub`: `runner-call {rpcId, method, payload}` (`llm.stream`, `model.list`, `skill.catalog`, `mcp.configs`, `model.set`, `provider.update`), answered by `runner-response`/`runner-error`; `runner-stream {rpcId, kind:'llm-token', data}` for streamed LLM chunks.
- `hub→laptop`: `runner-call` (`subprocess.*`, `fs.*`, `skill.sync`, `mcp.sync`, `control.workspace`, `sync.invalidate`, `catalog.invalidate`), answered by the laptop.

The upgrade is gated by the same fence the `/api` route uses: `isTrustedApiRequest` (DNS-rebinding) runs first, then the `dsh_session` cookie is verified via `ctx.authSimple` (`extractCookie` + `verifySession`). The socket is never negotiated before the cookie is verified.

### Multi-device: per-(user,device) connections

One credential may be installed on several laptops. The hub keys connections by `(userId, deviceId)` — `Map<userId, Map<deviceId, RunnerConnection>>` — NOT one connection per user. The laptop sends `?device=<id>` on the upgrade. A second laptop on the same credential **coexists** with the first; only a reconnect of the **same** device replaces its own stale socket. An offline device surfaces as an undefined `getConnection` result so a caller reports "runner offline" instead of silently killing a different laptop's session (the Phase-1 last-writer-wins bug).

A laptop's device id is persisted under `$DSH_HOME/runner-device-id` so a supervisor restart reuses the SAME device (never mints a new UUID that would orphan the previous registry entry). An explicit `--device` flag overrides it for one-shot runs.

### Skill/MCP sync

At connect (and on a hub `sync.invalidate` push), the laptop fetches the server's skill catalog and MCP inventory:

- **Skills**: an in-memory `SkillProvider` (`name: 'runner-sync'`, rank 350 — below project/custom roots 100-300 so local skills win, above user/bundled 400-600). `resourceBase: {kind:'opaque'}`. The hub re-materializes each skill with the laptop-side provider label so the laptop's candidate validates. No disk I/O; filesystem has no in-memory hook.
- **MCP**: per `SyncedMcpServer`, a scoped `ctx.plugin(mcpClient, config)` (full namespace, not just `apply`, so `inject:['tools']` + the `Config` schema are honored). The child process spawns **locally** on the laptop, so the tools run where the user's files are. `failOnStartupError: false` so one bad server can't break the surface. Name-keyed reconciliation on refresh.

Both are mounted **after** `loader.await()` because `skills`/`tools` are not transitive injects of `runner-driver`.

### Catalog gate + freshness

The runner channel **always rejects** `model.set`/`provider.update` — for admin and non-admin alike (`code: 'forbidden'`). Defense-in-depth: the methods stay declared in `RunnerToHubMethod` so the hub answers them rather than silently dropping. The admin's lever is server access (edit `~/.dsh/settings.yaml`, which `llm-deepseek`/`llm-pi-ai` hot-reload).

The real gap is catalog **freshness**: the laptop's `RemoteLlmAdapter` catalog is cached at connect and goes stale when the server catalog changes. The hub listens to `ctx.llm`'s `llm/adapters-updated` event (fired on any provider/model topology change, e.g. a `settings.yaml` edit hot-reloading an adapter) and pushes `catalog.invalidate` to every connected device of every user (the catalog is process-wide — one settings document). The laptop re-fetches `model.list` and swaps its cached catalog in place, without re-registering its route or reconnecting.

### Reconnect + supervisor

The transport reconnects with exponential backoff on a lost socket (mirroring `ConnectionController`): `backoffDelay = min(max, base * factor^(attempt-1))`, jittered `cap/2 + rand*cap/2`. Defaults: base 500ms, factor 2, max 10s. A lost socket rejects in-flight calls (the laptop re-issues any LLM call), schedules a reconnect, and on a successful re-open fires `onReconnect` so the driver re-fetches the catalog AND re-syncs skills/MCP (the laptop may have been offline across a server change). `dispose()` stops the loop, clears the armed backoff timer, and emits a terminal `disconnected` state.

A hub-side `ws.on('close')` cleanup drops the device's registry entry so an offline device surfaces as `undefined` (not a present-but-closed connection). The guard `userDevices.get(deviceId) === conn` prevents a reconnect's `prior.dispose()` from deleting the replacement.

A background runner is a no-task `dsh runner connect`: it connects and idles, holding the channel open, and MUST NOT call `ctx.appExit`. A Windows scheduled-task supervisor (`dsh-runner.ps1`, mirroring the `dsh-web.ps1` watchdog) relaunches the runner on process exit; the transport's backoff handles transient drops within a process. Credentials live in `~/.dsh/dsh-runner.env` (a file dsh itself never loads, since it rejects `DSH_*` names in `.env`), injected as `DSH_RUNNER_PASSWORD`.

## Consequences

**The agent loop is the laptop's.** Tools run on the laptop's files. The server holds only the API key, model catalog, auth, and sync — it never runs user tools. A repo update to bash/fs/skill/MCP reaches the runner unchanged because the runner is a thin patch over `dsh-base`, not a redeclared row list.

**The API key never leaves the server.** The laptop's `ctx.llm` is served by `RemoteLlmAdapter`, which proxies each call. The model list the laptop advertises is the server's catalog, kept current by `catalog.invalidate`.

**Multi-device is real.** Two laptops on one credential coexist; the hub never silently kills one when the other connects. Reconnecting the same laptop replaces only its own socket.

**Catalog mutation is impossible over the runner channel.** Every `model.set`/`provider.update` is `forbidden`. The admin edits `settings.yaml` on the server; the hub fans the change to all laptops.

**Server-side fallback (exec on the server when no runner is online) is deferred.** Without a reconciliation mechanism it forces silent overwrite of local edits made while offline. If added later, the reconciliation path is git-per-workspace (server commits; reconnect = pull/rebase; conflicts surface as git conflicts, no data loss).

## Alternatives considered

**Provider-remote-on-server (the original plan-agent design).** Wrong: skill/MCP must run where the files are (`skill-filesystem` reads `node:fs`; `mcp-client` spawns local child processes). Running them on the server operates on the server's files.

**Standalone laptop agent.** Wrong: the API key and model list must be central (one key, central cost, single source of truth). A standalone laptop would need its own key.

**One connection per user.** Phase 1's `Map<userId, RunnerConnection>` with last-writer-wins silently killed Laptop A when Laptop B connected on the same credential. Per-device keys fix this.

**An in-process super-admin membership gate (`dsh-runner-admin` with a `['mrians21']` seed).** The user chose "reject all" runner-channel mutation: a hardcoded admin list that always rejects is dead code. The admin role is server access, not an in-process check. (A future phase wanting `dsh runner admin set-model` from the laptop resurrects the membership gate + `settings.mutate` mapping — deferred, not deleted.)

**Server-side file sync as the workspace mechanism.** Full file-sync is a separate product; without reconciliation it loses offline edits. The MVP keeps the "files on the laptop" promise and defers sync.
