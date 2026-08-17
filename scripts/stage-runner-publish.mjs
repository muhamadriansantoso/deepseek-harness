#!/usr/bin/env node
/**
 * Stage the 6 runner-publish packages under the @mrians21 scope for npm pack.
 *
 * The monorepo stays 100% @deepseek-ai (source tree untouched). This copies the
 * built `lib/` + `package.json` + `cordis.patch.yml` of each of the 6 packages
 * into a staging dir, then rewrites in the STAGED copies only:
 *   - package.json `name`           @deepseek-ai/dsh-X  -> @mrians21/dsh-X
 *   - package.json dep specifiers   workspace:^          -> published range
 *   - lib import specifiers         @deepseek-ai/dsh-(runner-hub|llm-remote|runner|app-boot|auth-simple|client-connection)
 *                                   -> @mrians21/... (only the 6 renamed)
 *   - transport/mcp-sync/skill-sync  '/src/protocol.ts'  -> main export (hub doesn't ship src)
 *   - version                       rc.6                 -> rc.6 (fresh @mrians21 releases)
 *
 * Then `npm pack`s each into <staging>/tarballs. Reversible: rm -rf staging.
 *
 * Order matters for install resolution but npm pack order does not; we pack
 * app-boot, llm-remote, auth-simple, client-connection, runner-hub, then runner.
 */
import { cpSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

const repoRoot = fileURLToPath(new URL('../', import.meta.url))
const staging = resolve(repoRoot, '.scratch/runner-publish')
const tarballs = join(staging, 'tarballs')

// The 7 packages to publish under @mrians21, in publish dependency order.
// auth-simple and client-connection are runner-hub peer/imports not published
// under @deepseek-ai with the exports the hub needs (isTrustedApiRequest etc.),
// so they ship as @mrians21 forks too. client-connection precedes runner-hub
// (runner-hub imports it; npm v7+ auto-resolves peers against the registry).
// dsh-principal is the 7th: a peer-free AsyncLocalStorage utility that
// client-connection re-exports, and whose @deepseek-ai name was never published
// at rc.* (so the client install must fetch it via @mrians21).
const PACKAGES = [
  { dir: 'packages/util/principal', name: '@mrians21/dsh-principal', version: '0.1.0-rc.9' },
  { dir: 'packages/boot/app-boot', name: '@mrians21/dsh-app-boot', version: '0.1.0-rc.9' },
  { dir: 'packages/runner/llm-remote', name: '@mrians21/dsh-llm-remote', version: '0.1.0-rc.9' },
  { dir: 'packages/auth/auth-simple', name: '@mrians21/dsh-auth-simple', version: '0.1.0-rc.9' },
  { dir: 'packages/client/connection', name: '@mrians21/dsh-client-connection', version: '0.1.0-rc.9' },
  { dir: 'packages/runner/runner-hub', name: '@mrians21/dsh-runner-hub', version: '0.1.0-rc.9' },
  { dir: 'packages/runner/runner', name: '@mrians21/dsh-runner', version: '0.1.0-rc.9' },
]

// Published ranges for the @deepseek-ai deps the staged packages reference.
// (workspace:^ -> these, in the staged package.json only.)
//
// Pinned to the 0.1.0-rc.6 release line — the FIRST @deepseek-ai line whose
// dsh-base dependency closure is internally consistent on npm. The older
// 0.0.1-rc.1 line depends on dsh-bash-env, a package that was renamed to
// dsh-shell-env and unpublished, so installing dsh-base@0.0.1-rc.1 404s.
// Every dsh-base@0.1.0-rc.6 transitive dep is itself published at ^0.1.0-rc.6.
const PUBLISHED = {
  '@deepseek-ai/dsh-app-boot': '^0.1.0-rc.6',
  '@deepseek-ai/dsh-base': '^0.1.0-rc.6',
  '@deepseek-ai/dsh-cmdline': '^0.1.0-rc.6',
  '@deepseek-ai/dsh-home-paths': '^0.1.0-rc.6',
  '@deepseek-ai/dsh-launch-environment': '^0.1.0-rc.6',
  '@deepseek-ai/dsh-mcp-client': '^0.1.0-rc.6',
  '@deepseek-ai/dsh-skill': '^0.1.0-rc.6',
  '@deepseek-ai/dsh-llm': '^0.1.0-rc.6',
  '@deepseek-ai/dsh-session': '^0.1.0-rc.6',
  '@deepseek-ai/dsh-tools': '^0.1.0-rc.6',
  '@deepseek-ai/dsh-host-webserver': '^0.1.0-rc.6',
  '@deepseek-ai/dsh-invariants': '^0.1.0-rc.6',
  '@deepseek-ai/dsh-agent': '^0.1.0-rc.6',
  '@deepseek-ai/dsh-agent-default-model': '^0.1.0-rc.6',
  '@deepseek-ai/dsh-system-prompt': '^0.1.0-rc.6',
  // The runner imports resolveRgPath from tool-fs-search to answer the hub's
  // subprocess.resolveRgPath RPC (device-aware remote search), so the runner's
  // new peer dep on it needs a published range, not workspace:^.
  '@deepseek-ai/dsh-tool-fs-search': '^0.1.0-rc.6',
  // client-connection's own @deepseek-ai workspace deps (NOT in the renamed set;
  // published on npm at the rc.6 line).
  '@deepseek-ai/dsh-attachment': '^0.1.0-rc.6',
  '@deepseek-ai/dsh-host-apiproxy': '^0.1.0-rc.6',
  '@deepseek-ai/dsh-commands': '^0.1.0-rc.6',
  '@deepseek-ai/dsh-principal': '^0.1.0-rc.6', // kept for transitive completeness; the published client manifest rewrites this dep to @mrians21/dsh-principal
  '@mrians21/dsh-principal': '^0.1.0-rc.9',
  // Non-dsh infrastructure packages (stable releases, off the rc line).
  '@deepseek-ai/schemastery': '^3.18.1',
  '@deepseek-ai/cordis': '^4.0.1',
  '@deepseek-ai/cordis-plugin-hmr': '^1.0.16',
  '@deepseek-ai/cordis-plugin-timer': '^1.1.3',
  '@deepseek-ai/cordis-plugin-loader': '^1.0.2',
  '@deepseek-ai/cordis-plugin-group': '^1.0.1',
  '@deepseek-ai/cordis-plugin-include': '^1.0.6',
  // The 6 renamed packages refer to each other under the @mrians21 scope.
  // client-connection is forked because the published @deepseek-ai version
  // lacks the isTrustedApiRequest/rejectWebSocketUpgrade re-exports the hub needs.
  '@mrians21/dsh-app-boot': '^0.1.0-rc.9',
  '@mrians21/dsh-llm-remote': '^0.1.0-rc.9',
  '@mrians21/dsh-auth-simple': '^0.1.0-rc.9',
  '@mrians21/dsh-client-connection': '^0.1.0-rc.9',
  '@mrians21/dsh-runner-hub': '^0.1.0-rc.9',
  '@mrians21/dsh-runner': '^0.1.0-rc.9',
}

// The packages renamed @deepseek-ai -> @mrians21 in manifests + JS.
// app-boot is included because the published runner imports runProfile from it,
// and the @deepseek-ai app-boot on npm (rc.6) does NOT export runProfile — so the
// runner must depend on our @mrians21/dsh-app-boot (which carries the extraction).
const MANIFEST_RENAMES = {
  '@deepseek-ai/dsh-app-boot': '@mrians21/dsh-app-boot',
  '@deepseek-ai/dsh-runner-hub': '@mrians21/dsh-runner-hub',
  '@deepseek-ai/dsh-llm-remote': '@mrians21/dsh-llm-remote',
  '@deepseek-ai/dsh-runner': '@mrians21/dsh-runner',
  '@deepseek-ai/dsh-runner/startup': '@mrians21/dsh-runner/startup',
  '@deepseek-ai/dsh-auth-simple': '@mrians21/dsh-auth-simple',
  '@deepseek-ai/dsh-client-connection': '@mrians21/dsh-client-connection',
  '@deepseek-ai/dsh-principal': '@mrians21/dsh-principal',
}

// Only rewrite import specifiers for the renamed packages inside built JS.
const RENAMED = [
  ['@deepseek-ai/dsh-app-boot', '@mrians21/dsh-app-boot'],
  ['@deepseek-ai/dsh-runner-hub/src/protocol.ts', '@mrians21/dsh-runner-hub'],
  ['@deepseek-ai/dsh-runner-hub', '@mrians21/dsh-runner-hub'],
  ['@deepseek-ai/dsh-llm-remote', '@mrians21/dsh-llm-remote'],
  ['@deepseek-ai/dsh-runner', '@mrians21/dsh-runner'],
  ['@deepseek-ai/dsh-auth-simple', '@mrians21/dsh-auth-simple'],
  ['@deepseek-ai/dsh-client-connection', '@mrians21/dsh-client-connection'],
  ['@deepseek-ai/dsh-principal', '@mrians21/dsh-principal'],
]

function rewriteSpecifiers(str) {
  let out = str
  for (const [from, to] of RENAMED) out = out.split(from).join(to)
  return out
}

// Recursively collect every .js and .d.ts under a directory (the emit layout is
// `lib/*.js` + `lib/types/*.{js,d.ts}`; both the runtime .js the bin executes
// and the shipped .d.ts must have their @deepseek-ai specifiers rewritten, or a
// TypeScript consumer's import resolution breaks on stale @deepseek-ai names).
function listSourceFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listSourceFiles(p))
    else if (entry.name.endsWith('.js') || entry.name.endsWith('.d.ts')) out.push(p)
  }
  return out
}

function rewriteManifest(pkg) {
  const manifest = JSON.parse(readFileSync(join(staging, pkg.dir, 'package.json'), 'utf8'))
  manifest.name = pkg.name
  manifest.version = pkg.version
  // Drop the `dsh.bundle`/repo/source-only fields are fine to keep; but remove
  // `./src/*` exports + `./src/*`-style since published packages don't ship src.
  // (hub/runner/llm-remote/app-boot already have lib/ in files; src is dev-only.)
  if (manifest.exports) {
    for (const key of Object.keys(manifest.exports)) {
      if (key === './src/*') delete manifest.exports[key]
    }
  }
  // Convert every workspace:^ dep/peer/dev to a published range.
  for (const section of ['dependencies', 'peerDependencies', 'devDependencies']) {
    const deps = manifest[section]
    if (deps === undefined) continue
    // Dev deps are not needed in a published tarball; drop them entirely.
    if (section === 'devDependencies') { delete manifest.devDependencies; continue }
    const next = {}
    for (const [dep, spec] of Object.entries(deps)) {
      // Rename the 3 runner deps @deepseek-ai -> @mrians21 first.
      const renamedDep = MANIFEST_RENAMES[dep] ?? dep
      if (spec === 'workspace:^') {
        const published = PUBLISHED[renamedDep]
        if (!published) throw new Error(`${pkg.name}: no PUBLISHED entry for workspace:^ dep ${renamedDep} (section ${section}) — add it to PUBLISHED before publishing`)
        next[renamedDep] = published
        continue
      }
      next[renamedDep] = spec
    }
    manifest[section] = next
  }
  // Remove `./src/*` from files if present (not shipped).
  writeFileSync(join(staging, pkg.dir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
}

// fresh staging
mkdirSync(tarballs, { recursive: true })

for (const pkg of PACKAGES) {
  const src = join(repoRoot, pkg.dir)
  const dst = join(staging, pkg.dir)
  mkdirSync(dst, { recursive: true })
  // copy built lib + manifest + patch yml + README
  for (const item of ['lib', 'package.json', 'cordis.patch.yml']) {
    const s = join(src, item)
    if (existsSync(s)) cpSync(s, join(dst, item), { recursive: true })
  }
  // rewrite import specifiers in every built .js and .d.ts under lib/ (recursive
  // so the lib/types/ emit dir is covered too — its .d.ts files ship to consumers).
  const libDir = join(dst, 'lib')
  if (existsSync(libDir)) {
    for (const file of listSourceFiles(libDir)) {
      writeFileSync(file, rewriteSpecifiers(readFileSync(file, 'utf8')))
    }
  }
  // rewrite import specifiers in the bundle's cordis.patch.yml too: its loader
  // entry `name` rows reference the package by scope (e.g.
  // '@deepseek-ai/dsh-runner/startup'), which the loader imports at boot — a
  // stale @deepseek-ai name there 404s the include even when lib/ is renamed.
  const patchPath = join(dst, 'cordis.patch.yml')
  if (existsSync(patchPath)) {
    writeFileSync(patchPath, rewriteSpecifiers(readFileSync(patchPath, 'utf8')))
  }
  rewriteManifest(pkg)
  console.log(`staged ${pkg.name}@${pkg.version} -> ${dst}`)
}

// npm pack each, into tarballs/
for (const pkg of PACKAGES) {
  const dir = join(staging, pkg.dir)
  execSync(`npm pack --pack-destination "${tarballs}"`, { cwd: dir, stdio: 'inherit' })
}

console.log('\nStaged tarballs:')
for (const f of readdirSync(tarballs)) console.log('  ' + join(tarballs, f))
