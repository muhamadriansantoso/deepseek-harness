#!/usr/bin/env node
/**
 * dsh — command-line entry. Dynamic imports per mode keep unrelated modes out
 * of each dispatch path; the adapter prints and exits for
 * `--help`/`--version`/a parse error, so only a valid mode reaches the switch.
 * @module @deepseek-ai/dsh/bin
 */

/* v8 ignore file -- built-bin acceptance exercises this self-executing dispatch. */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadLayeredEnv, runProfile } from '@deepseek-ai/dsh-app-boot'
import { parseDshArgs } from './args.ts'

// Both the source tree (apps/cli/src) and the bundled bin (apps/cli/lib) sit
// one directory under apps/cli, so the checked-in manifest and config resolve
// with the same relative hop from either artifact.
/** This dsh app's package.json — the install anchor the flat module fallback walks. */
const INSTALL_ANCHOR = fileURLToPath(new URL('../package.json', import.meta.url))
/** The shipped agent-preset root, beside this app's own config (source and built layouts). */
const SHIPPED_PRESET_ROOT = fileURLToPath(new URL('../config/agent-presets/', import.meta.url))

/** This app's version, read from its checked-in package.json. */
function readVersion(): string {
  const manifest = JSON.parse(
    readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
  ) as { version?: unknown }
  return typeof manifest.version === 'string' ? manifest.version : '0.0.0'
}

const invocation = parseDshArgs(process.argv.slice(2), readVersion())

switch (invocation.mode) {
  case 'profile': {
    await runProfile({
      binName: 'dsh',
      installAnchor: INSTALL_ANCHOR,
      shippedPresetRoot: SHIPPED_PRESET_ROOT,
      environment: loadLayeredEnv('dsh'),
      profile: invocation.profile,
      patchFiles: invocation.patches,
      args: invocation.args,
    })
    break
  }
  case 'plugin': {
    const { runPlugin } = await import('./plugin.ts')
    process.exit(runPlugin(invocation.profile, invocation.args))
    break
  }
  case 'dump-config': {
    const { runDumpConfig } = await import('./dump-config.ts')
    runDumpConfig(invocation.profile, invocation.defaultOnly, invocation.patches)
    break
  }
  case 'runner': {
    // `dsh runner connect ...` boots the runner profile (a laptop agent whose
    // model calls are proxied to a dsh server). It is a fixed-profile boot of
    // the 'runner' profile, forwarding the connect arguments to its startup
    // plugin exactly like `dsh --profile web ...` forwards to the web app.
    await runProfile({
      binName: 'dsh',
      installAnchor: INSTALL_ANCHOR,
      shippedPresetRoot: SHIPPED_PRESET_ROOT,
      environment: loadLayeredEnv('dsh'),
      profile: 'runner',
      patchFiles: [],
      args: invocation.args,
    })
    break
  }
  default:
    invocation satisfies never
    throw new Error(`dsh: unhandled invocation mode ${JSON.stringify(invocation)}`)
}
