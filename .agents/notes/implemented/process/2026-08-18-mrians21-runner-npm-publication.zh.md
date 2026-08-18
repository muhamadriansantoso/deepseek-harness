# Agent Note: 在 @mrians21 scope 下发布 runner 栈到 NPM

Status: implemented

[English](2026-08-18-mrians21-runner-npm-publication.md) | 中文

## Problem

remote-workspace runner 栈（`packages/runner/runner`、`runner-hub`、`llm-remote`、`fs-remote`、`subprocess-remote`）是 fork 独有的新增——`packages/runner/` 在上游不存在——因此 `@deepseek-ai` 没有也不会发布它。只从 npm 安装 `@deepseek-ai/*` 的笔记本无法 `npm i -g dsh-runner` 并运行 remote-workspace profile：四个新包与两个 fork 扩展的支持包（`auth-simple`、`client-connection`）没有已发布的 tarball。

fork 不能发布到 `@deepseek-ai` 下：发布主机上的 npm 账户不是该 org 的成员（`npm access list packages @deepseek-ai` 返回 403；org 维护者是 `imccyu` 与 `tianyicui-deepseek`）。在 monorepo 里重命名也被否决，因为仓库必须保持 `@deepseek-ai`——`dsh.base` 根插件、每个 cordis manifest、config catalog 与 `cordis.patch.yml` 的 loader 行都引用 `@deepseek-ai/dsh-runner`，全仓库重命名会破坏本地 `dsh web` 安装并与上游 merge 冲突。

`dsh-runner` 的 9 个 `peerDependencies`（cordis、loader、agent、agent-default-model、invariants、llm、session、tools、tool-fs-search）会在全局安装时让 npm 的 arborist 崩溃。`npm i -g @mrians21/dsh-runner` 以 `Cannot read properties of null (reading 'children')`（`@npmcli/arborist/lib/place-dep.js:299`）中止——在 npm 11.6.2 与 12.0.2（latest）上均复现。对 9 个 peer 做二分未发现单个触发者：单独 4 个 peer 能装、单独 5 个 peer 能装，但 9 个一起就会在虚拟 peer 放置循环里崩溃。`--legacy-peer-deps` 可干净安装，证明触发点是自动安装 peer。

## Decision

通过一个**在 pack 时改写 scope、绝不改动 monorepo 的 staging script**，把 runner 栈发布到 fork 拥有的 scope（`@mrians21`）。`scripts/stage-runner-publish.mjs` 把每个包构建好的 `lib/`、`package.json` 与 `cordis.patch.yml` 复制进 `.scratch/runner-publish`，然后只改写暂存副本：

- `package.json` 的 `name`：`@deepseek-ai/dsh-*` → `@mrians21/dsh-*`（7 个包）。
- `workspace:^` 依赖声明 → `PUBLISHED` map 中的已发布 range。`@deepseek-ai` 依赖固定到 `0.1.0-rc.6` 行——这是 `dsh-base` 传递闭包在 npm 上内部一致的第一行（更早的 `0.0.1-rc.1` 行依赖已改名并下架的 `dsh-bash-env`，会 404）。
- `lib/*.js` 与 `lib/types/*.d.ts` 中改名包的 import specifier。
- `cordis.patch.yml` 的 loader `name` 行（即使 `lib/` 已改名，陈旧的 `@deepseek-ai/dsh-runner/startup` 也会让 include 404）。

`npm pack` 按依赖顺序执行；monorepo 源码树保持 100% `@deepseek-ai`。

### 发布的 7 个包

`principal`、`app-boot`、`llm-remote`、`auth-simple`、`client-connection`、`runner-hub`、`runner`。`auth-simple` 与 `client-connection` 以 `@mrians21` fork 形式发布，因为已发布的 `@deepseek-ai` 版本缺少 hub 导入的导出（`isTrustedApiRequest`、`rejectWebSocketUpgrade`、`runProfile`）。`principal` 也发布，因为它的 `@deepseek-ai` 名字从未以 `rc.*` 版本发布过。

### flattenPeers 修复全局安装崩溃

`dsh-runner` 在 staging script 的 `PACKAGES` 表里带 `flattenPeers: true`；`rewriteManifest` 随后在 pack 前把它的 `peerDependencies` 并入 `dependencies` 并删除 `peerDependencies` 段。本地 probe 的全局安装（peers-as-deps）成功（385 个包，bin 可用），因此已发布的 `@mrians21/dsh-runner` 可以用不带任何 flag 的 `npm i -g @mrians21/dsh-runner` 安装。其余六个包保留 `peerDependencies`——只有 `dsh-runner`（9 个 peer）触发 arborist bug。

### 版本与 dist-tag

`@mrians21` 的全新发布从 `0.1.0-rc.9` 开始。当 111 个上游 commit 合并并重建 `dsh-runner`、`dsh-runner-hub`、`dsh-client-connection` 后，它们的 `lib/` 变了但 registry 上 `rc.9` 已被占用；这三个包升到 `0.1.0-rc.10`。`flattenPeers` 修复让 `dsh-runner` 单独升到 `0.1.0-rc.11`。四个字节相同的包（`principal`、`app-boot`、`llm-remote`、`auth-simple`）保持 `rc.9`，未重新发布。每个包的 `rc` 与 `latest` dist-tag 指向最新已发布版本。

## Consequences

**仓库保持 `@deepseek-ai`。** 任何源文件、manifest、`cordis.patch.yml` 或 `tsconfig.base.json` path alias 都不改名。staging script 是 `@mrians21` 名字唯一存在的地方；`rm -rf .scratch/runner-publish` 即可撤销 staging。

**消费者需要 `@deepseek-ai` 闭包。** 已发布的 `@mrians21/dsh-runner` 仍然依赖公开的 `@deepseek-ai/dsh-base@^0.1.0-rc.6`、`dsh-cmdline`、`dsh-llm` 等，以及 `@deepseek-ai/cordis@^4.0.1`。它们在 npm 上公开、可匿名 resolve；install probe 确认 385 个包可 resolve。

**`rc.9`/`rc.10` 作为 stale 版本留在 registry。** npm 禁止覆盖已发布版本，因此被取代的构建仍可按精确版本下载；只有 `latest`/`rc` dist-tag 前移。

**arborist bug 未在 npm 层面绕过。** `flattenPeers` 只绕开本包集合；若 npm 修复 `place-dep.js:299`，该 flag 可以保留（对 bundle 二进制而言 peers-as-deps 无害）或回退。根因——多个 peer group 组合时 peer 放置过程中 virtual root 的 `children` 为 null——属于 npm，不是本包。

**这与 `@deepseek-ai` 发布序列相互独立**（[2026-08-10-npm-release-sequences](2026-08-10-npm-release-sequences.md)）：那条路径从 GitHub Actions 以全包共享单一版本发布 restricted 的 `@deepseek-ai` 家族；这条路径从本地 staging script 以每包独立版本把 fork 独有子集发布到公开的个人 scope。两者无共享触发、版本或等待。

## Alternatives considered

- **直接发布到 `@deepseek-ai` 下。** 否决：发布用的 npm 账户不是 `deepseek-ai` npm org 的成员（`npm access list packages` 返回 403；维护者是 `imccyu` 与 `tianyicui-deepseek`）。fork 无法自行申请访问，且 restricted 家族的发布路径归上游所有。
- **在 monorepo 里把 runner 栈重命名为 `@mrians21/*`。** 否决：`dsh-base` 的根插件、每个 cordis manifest、`cordis.patch.yml` 的 loader 行、`tsconfig.base.json` 的 path alias、config catalog 与本地 `dsh web` profile 都引用 `@deepseek-ai/dsh-runner`；全仓库重命名会破坏本地安装，并让每次上游 merge 都产生冲突。
- **保留 `peerDependencies`，让消费者传 `--legacy-peer-deps`。** 否决：可行（已验证），但每次安装都要带一个不直观的 flag，任何忘记它的消费者或 CI 都会再次触发崩溃。并入 `dependencies` 让 bundle 自包含且无行为代价。
- **先把 9 个 peer 装进全局 prefix 再装 runner。** 否决：经验验证——arborist 仍会走进 peer 放置循环并同样崩溃。
- **改走 `@deepseek-ai` 的 GitHub Actions 发布管线。** 否决：该管线从 `release.yml` 以共享单一版本发布 restricted 家族，且需要 fork 没有的 org 凭据；fork 独有的包无法进入该管线。
