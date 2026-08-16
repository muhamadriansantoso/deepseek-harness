/**
 * The laptop runner's command-line provider: it parses the connect flags and
 * the task positional, then publishes {@link RUNNER_STARTUP_SERVICE}. The
 * runner is an ordinary consumer whose lazy config waits for that service.
 *
 * Flags:
 *   --server <url>      the dsh server to connect to (e.g. https://dsh.mrians.my.id)
 *   --user <id>         the login user id
 *   --password <pw>     the login password (optional; prompted when absent)
 *   --workspace <path>  the local workspace to operate in (defaults to cwd)
 *   --device <id>       a stable device id (defaults to a machine-local UUID)
 *   [task...]           the task text to run (optional; an empty task just
 *                       connects and idles, useful for a long-lived runner)
 * @module @deepseek-ai/dsh-runner/startup
 */

import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** Stable Cordis plugin name. */
export const name = 'runner-startup'

/** Services required before the task can be resolved. */
export const inject = ['cmdlineArgs']

/** Service provided by this plugin and injected by the runner. */
export const RUNNER_STARTUP_SERVICE = 'runnerStartup'

/** What the runner row reads from {@link RUNNER_STARTUP_SERVICE}. */
export interface RunnerStartupValues {
  /** The dsh server base URL (no trailing slash). */
  server: string
  /** The login user id. */
  user: string
  /** The login password, or undefined when the runner should prompt. */
  password?: string
  /** The local workspace directory to operate in. */
  workspace: string
  /** A stable device id identifying this laptop. */
  device: string
  /** The task text; empty for a connect-and-idle runner. */
  task: string
}

/** File under `$DSH_HOME` holding this laptop's stable runner device id. */
const DEVICE_ID_FILE = 'runner-device-id'

/**
 * Resolve a stable device id for THIS laptop, persisted under `$DSH_HOME`.
 * Without it, every process start (a supervisor restart, a re-run) would mint a
 * fresh UUID and the hub would see a brand-new device each time — orphaning the
 * previous one's registry entry until its socket times out. A persisted id keeps
 * a reconnect of the same laptop replacing the SAME device, never a new one.
 * @returns the persisted id, or a freshly generated and persisted one.
 */
function resolveDeviceId(): string {
  const file = join(resolveDshHome(), DEVICE_ID_FILE)
  try {
    const existing = readFileSync(file, 'utf8').trim()
    if (existing.length > 0) return existing
  } catch {
    // First run, or the file was removed: fall through and mint one.
  }
  const generated = randomUUID()
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, generated, 'utf8')
  } catch {
    // Read-only home or a race: the in-memory id still works for this process;
    // the next start mints a new one, which is a degraded but functional path.
  }
  return generated
}

/**
 * Normalize a server URL to a base URL without a trailing slash, forcing https.
 * @param value - the raw `--server` argument.
 * @returns the normalized base URL.
 */
function normalizeServer(value: string): string {
  let url = value.trim()
  if (url.length === 0) throw new Error('--server is required')
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`
  return url.replace(/\/+$/, '')
}

/**
 * This app's command: the connect flags, the task positional, and its help.
 * @returns a fresh program, so one process can parse more than once (tests).
 */
function runnerCommand(): Command {
  return new Command()
    .name('dsh runner connect')
    .description('Connect this laptop to a dsh server and run a task against the local workspace.')
    .helpOption('-h, --help', 'show this help')
    .requiredOption('--server <url>', 'the dsh server to connect to (e.g. https://dsh.mrians.my.id)')
    .requiredOption('--user <id>', 'the login user id')
    .option('--password <pw>', 'the login password (omitted: read from DSH_RUNNER_PASSWORD or prompt)')
    .option('--workspace <path>', 'the local workspace to operate in (defaults to cwd)')
    .option('--device <id>', 'a stable device id for this laptop (defaults to a generated UUID)')
    .argument('[task...]', 'the task text; multiple words are joined by spaces (optional: connect and idle)')
    .addHelpText('after', `
Examples:
  dsh runner connect --server https://dsh.mrians.my.id --user mrians21 "run the tests"
  dsh runner connect --server dsh.mrians.my.id --user mrians21 --workspace D:\\MyProject
`)
}

/**
 * Parse and provide the connect values as an ordinary Cordis service. A missing
 * server or user is a usage error, so on rejection (and on `--help`) nothing is
 * provided.
 * @param ctx - plugin context carrying the command line.
 */
export function apply(ctx: Context): void {
  const program = runnerCommand()
  program.action(() => {
    const server = normalizeServer(program.opts<{ server: string }>().server)
    const user = program.opts<{ user: string }>().user
    if (user.length === 0) program.error('error: --user needs a value')
    const password = program.opts<{ password?: string }>().password
      ?? (process.env.DSH_RUNNER_PASSWORD && process.env.DSH_RUNNER_PASSWORD.length > 0
        ? process.env.DSH_RUNNER_PASSWORD
        : undefined)
    const workspace = program.opts<{ workspace?: string }>().workspace ?? process.cwd()
    const explicitDevice = program.opts<{ device?: string }>().device
    const device = explicitDevice !== undefined && explicitDevice.length > 0
      ? explicitDevice
      : resolveDeviceId()
    const task = program.args.join(' ')
    ctx.provide(RUNNER_STARTUP_SERVICE, {
      server,
      user,
      ...password === undefined ? {} : { password },
      workspace,
      device,
      task,
    } satisfies RunnerStartupValues)
  })
  parseCmdline(ctx, program)
}
