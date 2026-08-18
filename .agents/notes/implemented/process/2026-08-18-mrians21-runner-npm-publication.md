# Agent Note: NPM publication of the runner stack under @mrians21

Status: implemented

English | [中文](2026-08-18-mrians21-runner-npm-publication.zh.md)

## Problem

The remote-workspace runner stack (`packages/runner/runner`, `runner-hub`, `llm-remote`, `fs-remote`, `subprocess-remote`) is a fork-only addition — `packages/runner/` does not exist upstream — so no `@deepseek-ai` release of it exists or is planned. A laptop that installs only `@deepseek-ai/*` from npm therefore cannot `npm i -g dsh-runner` and run the remote-workspace profile: the four new packages and two fork-extended support packages (`auth-simple`, `client-connection`) have no published tarball.

The fork cannot publish under `@deepseek-ai`: the npm account on the publish host is not a member of that org (`npm access list packages @deepseek-ai` returns 403; the org maintainers are `imccyu` and `tianyicui-deepseek`). Renaming in the monorepo is rejected because the repo must stay `@deepseek-ai` — the `dsh.base` root plugin, every cordis manifest, the config catalog, and the `cordis.patch.yml` loader rows all reference `@deepseek-ai/dsh-runner`, and a repo-wide rename would break the local `dsh web` install and collide with upstream merges.

The 9 `peerDependencies` on `dsh-runner` (cordis, loader, agent, agent-default-model, invariants, llm, session, tools, tool-fs-search) crash npm's arborist on a global install. `npm i -g @mrians21/dsh-runner` aborts with `Cannot read properties of null (reading 'children')` at `@npmcli/arborist/lib/place-dep.js:299` — reproduced on npm 11.6.2 and 12.0.2, the latest. Bisecting the 9 peers shows no single peer triggers it: 4 peers alone install, 5 peers alone install, but all 9 together crash the virtual peer-placement loop. `--legacy-peer-deps` installs cleanly, proving the trigger is auto-peer-install.

## Decision

Publish the runner stack under a scope the fork owns (`@mrians21`) via a **staging script that rewrites scope at pack time, never in the monorepo**. `scripts/stage-runner-publish.mjs` copies each package's built `lib/`, `package.json`, and `cordis.patch.yml` into `.scratch/runner-publish`, then rewrites only the staged copies:

- `package.json` `name`: `@deepseek-ai/dsh-*` → `@mrians21/dsh-*` (7 packages).
- `workspace:^` dep specifiers → published ranges from a `PUBLISHED` map. The `@deepseek-ai` deps pin the `0.1.0-rc.6` line — the first line whose `dsh-base` transitive closure is internally consistent on npm (the older `0.0.1-rc.1` line depends on the renamed-then-unpublished `dsh-bash-env` and 404s).
- `lib/*.js` + `lib/types/*.d.ts` import specifiers for the renamed packages.
- `cordis.patch.yml` loader `name` rows (a stale `@deepseek-ai/dsh-runner/startup` 404s the include even when `lib/` is renamed).

`npm pack` runs in dependency order; the monorepo source tree stays 100% `@deepseek-ai`.

### The 7 published packages

`principal`, `app-boot`, `llm-remote`, `auth-simple`, `client-connection`, `runner-hub`, `runner`. `auth-simple` and `client-connection` ship as `@mrians21` forks because the published `@deepseek-ai` versions lack the exports the hub imports (`isTrustedApiRequest`, `rejectWebSocketUpgrade`, `runProfile`). `principal` ships because its `@deepseek-ai` name was never published at an `rc.*` version.

### flattenPeers fixes the global-install crash

`dsh-runner` carries `flattenPeers: true` in the staging script's `PACKAGES` table; `rewriteManifest` then merges its `peerDependencies` into `dependencies` and deletes the `peerDependencies` section before packing. A local-probe global install with peers-as-deps succeeded (385 packages, bin works), so the published `@mrians21/dsh-runner` installs with a plain `npm i -g @mrians21/dsh-runner` and no flags. The other six packages keep their `peerDependencies` — only `dsh-runner` (9 peers) triggers the arborist bug.

### Versioning and dist-tags

Fresh `@mrians21` releases start at `0.1.0-rc.9`. When 111 upstream commits merged and rebuilt `dsh-runner`, `dsh-runner-hub`, and `dsh-client-connection`, their `lib/` changed but `rc.9` was already taken on the registry; those three bumped to `0.1.0-rc.10`. The `flattenPeers` fix bumped `dsh-runner` alone to `0.1.0-rc.11`. The four byte-identical packages (`principal`, `app-boot`, `llm-remote`, `auth-simple`) stayed at `rc.9` and were not republished. `rc` and `latest` dist-tags point at the newest published version per package.

## Consequences

**Repo stays `@deepseek-ai`.** No source file, manifest, `cordis.patch.yml`, or `tsconfig.base.json` path alias is renamed. The staging script is the only place the `@mrians21` name lives; `rm -rf .scratch/runner-publish` reverses staging.

**Consumers need the `@deepseek-ai` closure.** A published `@mrians21/dsh-runner` still depends on the public `@deepseek-ai/dsh-base@^0.1.0-rc.6`, `dsh-cmdline`, `dsh-llm`, etc., plus `@deepseek-ai/cordis@^4.0.1`. These are public on npm and resolve anonymously; the install probe confirmed 385 packages resolve.

**`rc.9`/`rc.10` stay on the registry as stale.** npm forbids overwriting a published version, so superseded builds remain downloadable at their exact version; only the `latest`/`rc` dist-tags move forward.

**The arborist bug is unworked around at the npm level.** `flattenPeers` sidesteps it for this package set; if npm fixes `place-dep.js:299`, the flag can stay (peers-as-deps is harmless for a bundle binary) or revert. The root cause — a virtual-root `children` null during peer placement when several peer groups combine — is npm's, not the package's.

**This is independent of the `@deepseek-ai` release sequences** ([2026-08-10-npm-release-sequences](2026-08-10-npm-release-sequences.md)): that path publishes the restricted `@deepseek-ai` family from GitHub Actions with one shared version across all packages; this path publishes a fork-only subset under a public personal scope from a local staging script with per-package versions. They share no trigger, version, or waiting.

## Alternatives considered

- **Publish under `@deepseek-ai` directly.** Rejected: the publishing npm account is not a member of the `deepseek-ai` npm org (`npm access list packages` returns 403; maintainers are `imccyu` and `tianyicui-deepseek`). The fork cannot request access on its own, and upstream owns the restricted-family release path.
- **Rename the runner stack to `@mrians21/*` in the monorepo.** Rejected: `dsh-base`'s root plugin, every cordis manifest, `cordis.patch.yml` loader rows, `tsconfig.base.json` path aliases, the config catalog, and the local `dsh web` profile all reference `@deepseek-ai/dsh-runner`; a repo-wide rename breaks the local install and churns every future upstream merge.
- **Keep `peerDependencies` and tell consumers to pass `--legacy-peer-deps`.** Rejected: it works (verified), but every install then needs a non-obvious flag, and the crash would resurface for any consumer or CI that forgets it. Flattening into `dependencies` makes the bundle self-contained with no behavioral cost.
- **Pre-install the 9 peers into the global prefix before installing the runner.** Rejected: verified empirically — arborist still walks the peer-placement loop and crashes identically.
- **Route publication through the `@deepseek-ai` GitHub Actions release pipeline.** Rejected: that pipeline publishes the restricted family with one shared version from `release.yml` and needs org credentials the fork does not have; the fork-only packages cannot enter it.
