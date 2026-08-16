/**
 * Laptop-side skill sync: mount an in-memory `SkillProvider` whose catalog is
 * the server's pushed skill set, and keep it current on `sync.invalidate`.
 *
 * The server's `skill.catalog` reply carries fully materialized skills (name,
 * description, body, invocation policy). The runner serves them straight from
 * memory — no disk, no frontmatter parser (skill-filesystem owns neither an
 * in-memory hook nor an exported parser). One provider lives for the process;
 * a re-sync swaps its in-memory catalog and calls `control.invalidate()` so the
 * registry drops its caches and notifies consumers.
 *
 * Precedence: synced skills rank below project/custom roots (so a workspace's
 * own skill always wins) and above user/bundled roots (so the server's curated
 * catalog is authoritative for the rest). See {@link SYNCED_RANK}.
 * @module @deepseek-ai/dsh-runner
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  isSkillName,
  type SkillCandidate,
  type SkillDefinition,
  type SkillProvider,
  type SkillProviderControl,
} from '@deepseek-ai/dsh-skill'
import type { SyncedSkill } from '@deepseek-ai/dsh-runner-hub/src/protocol.ts'
import type { RunnerTransport } from './transport.ts'

/**
 * Precedence rank for server-synced skills. Lower wins. Project roots
 * (100/200) and custom roots (300) outrank synced skills, so a workspace's own
 * skill always shadows the server's. Synced skills outrank user roots
 * (400/500) and bundled roots (600), making the server's curated catalog
 * authoritative for everything the workspace does not override locally.
 */
const SYNCED_RANK = 350

/** Resource base for synced skills: no directory or URL to resolve against. */
const SYNCED_RESOURCE_BASE = { kind: 'opaque', description: 'Synced from the server by the dsh runner.' } as const

/** The provider label synced skills advertise (a candidate's `provider` must equal it). */
const PROVIDER_NAME = 'runner-sync'

/** Handle returned by {@link mountSkillSync}; {@link refresh} re-syncs from the server. */
export interface RunnerSkillSync {
  /** Re-fetch the server's skill catalog and invalidate the registry cache. */
  refresh(): Promise<void>
}

/**
 * Mount the in-memory synced-skill provider and return a handle whose
 * `refresh()` re-fetches the catalog. The provider is unregistered when the
 * calling context's fiber disposes.
 * @param ctx - plugin context carrying the `skills` registry (after the loader has settled).
 * @param transport - the runner channel used to fetch the server's catalog.
 * @returns the sync handle (a no-op when `ctx.skills` is unavailable).
 */
export function mountSkillSync(ctx: Context, transport: RunnerTransport): RunnerSkillSync {
  const registry = ctx.get('skills')
  if (registry === undefined) {
    ctx.logger.warn('dsh-runner: ctx.skills unavailable — server skill sync disabled')
    return { async refresh() {} }
  }

  let current: readonly SyncedSkill[] = []
  let control: SkillProviderControl | undefined

  const provider: SkillProvider = {
    name: PROVIDER_NAME,
    list(): Promise<readonly SkillCandidate[]> {
      // Defense-in-depth: a buggy or hostile server could send an invalid name
      // or empty description; validateCandidate throws on those and would break
      // the whole catalog merge, so drop them here rather than fail the read.
      return Promise.resolve(current
        .filter(skill => isSkillName(skill.name) && typeof skill.description === 'string' && skill.description.length > 0)
        .map(toCandidate))
    },
    get(candidate: SkillCandidate): Promise<SkillDefinition | undefined> {
      return Promise.resolve(toDefinition(candidate.locator as SyncedSkill))
    },
  }

  const disposer = registry.registerProvider((c) => {
    control = c
    return provider
  })
  // registerProvider's own effect lives on the skills plugin's fiber; also tie
  // it to this context so a mid-process runner-driver disposal unregisters it.
  ctx.effect(() => () => { disposer() }, 'dsh-runner: skill sync provider')

  return {
    async refresh(): Promise<void> {
      try {
        current = await transport.fetchSkillCatalog()
        control?.invalidate()
      } catch (error: unknown) {
        ctx.logger.warn(`dsh-runner: skill sync failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    },
  }
}

/** Build a registry candidate from one synced skill (the locator stashes the skill). */
function toCandidate(skill: SyncedSkill): SkillCandidate {
  return {
    name: skill.name,
    description: skill.description,
    ...skill.whenToUse !== undefined ? { whenToUse: skill.whenToUse } : {},
    invocation: skill.invocation,
    source: skill.source,
    provider: PROVIDER_NAME,
    rank: SYNCED_RANK,
    locator: skill,
    resourceBase: SYNCED_RESOURCE_BASE,
    ...skill.metadata !== undefined ? { metadata: skill.metadata } : {},
  }
}

/** Reconstruct the full skill definition a `get()` returns from a synced skill. */
function toDefinition(skill: SyncedSkill): SkillDefinition {
  return {
    name: skill.name,
    description: skill.description,
    ...skill.whenToUse !== undefined ? { whenToUse: skill.whenToUse } : {},
    invocation: skill.invocation,
    source: skill.source,
    provider: PROVIDER_NAME,
    content: skill.content,
    resourceBase: SYNCED_RESOURCE_BASE,
    ...skill.metadata !== undefined ? { metadata: skill.metadata } : {},
  }
}
