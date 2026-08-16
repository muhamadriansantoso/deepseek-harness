#!/usr/bin/env node
/**
 * dsh-runner — the standalone laptop-runner CLI. Boots the `runner` profile
 * (a thin layer over dsh-base that swaps the local LLM adapter for the remote
 * gateway) from THIS package's own install anchor, so every base plugin
 * resolves from the runner's dependency closure without the full `dsh` CLI
 * installed. The `connect` subcommand (or bare flags) forwards its inner
 * arguments to the runner startup plugin, which parses
 * `--server/--user/--password/--workspace/--device/[task]` exactly like
 * `dsh runner connect ...`.
 *
 * `dsh runner connect ...` in the full CLI is a back-compat alias for this bin.
 * @module @deepseek-ai/dsh-runner/bin
 */

/* v8 ignore file -- built-bin acceptance exercises this self-executing dispatch. */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Command, CommanderError } from 'commander'
import { loadLayeredEnv, runProfile } from '@deepseek-ai/dsh-app-boot'

// Both the source tree (src) and the bundled bin (lib) sit one directory under
// this package, so the checked-in manifest resolves with the same relative hop
// from either artifact.
/** This runner app's package.json — the install anchor the flat module fallback walks. */
const INSTALL_ANCHOR = fileURLToPath(new URL('../package.json', import.meta.url))

/** This app's version, read from its checked-in package.json. */
function readVersion(): string {
  const manifest = JSON.parse(
    readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
  ) as { version?: unknown }
  return typeof manifest.version === 'string' ? manifest.version : '0.0.0'
}

// The runner recognizes one subcommand (`connect`) and a bare default; everything
// after it reaches the runner startup plugin verbatim, which owns its own flag
// family and `--help`. The launcher's own help prints for a bare `dsh-runner`
// or `dsh-runner --help`.
let args: string[] = []
try {
  const program = new Command()
  program
    .name('dsh-runner')
    .version(readVersion(), '-V, --version', 'output the version number')
    .description('dsh-runner: boot the laptop runner profile and connect it to a dsh server (model calls are proxied to the server; bash/fs/skill/MCP run on this laptop).')
    .exitOverride()
    .helpOption('-h, --help', 'show this help')
    .allowUnknownOption()
    .passThroughOptions()
    .enablePositionalOptions()
    .argument('[args...]', 'arguments for the runner startup plugin (see: dsh-runner connect --help)')
    .action((rest: string[]) => { args = rest })

  const connect = program.command('connect').description('connect this laptop to a dsh server and run a task against the local workspace')
  connect
    .helpOption(false)
    .allowUnknownOption()
    .passThroughOptions()
    .enablePositionalOptions()
    .argument('[args...]', 'arguments for the runner startup plugin (see: dsh-runner connect --help)')
    .action((rest: string[]) => { args = rest })

  program.parse(process.argv.slice(2), { from: 'user' })
} catch (error) {
  process.exit(error instanceof CommanderError ? error.exitCode : 1)
}

await runProfile({
  binName: 'dsh-runner',
  installAnchor: INSTALL_ANCHOR,
  environment: loadLayeredEnv('dsh-runner'),
  profile: 'runner',
  patchFiles: [],
  args,
})
