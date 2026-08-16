/**
 * Runner devices plugin, browser half: registers the Runner Devices settings
 * section. It reads the connected-laptop list (device id + status only) and,
 * for a connected device, browses a laptop folder and attaches it as a server
 * workspace — all through the hub's per-userId-scoped `/api/runner` HTTP API
 * (plain fetch — no generated Remote surface). The agent loop runs server-side;
 * tool calls execute on the laptop. A reconnect refetches the device list.
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
// Type-only: pulls the settings shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { RunnerDevicesSection } from './RunnerDevicesSection.tsx'
import type { RunnerDevicesSectionInjected } from './RunnerDevicesSection.tsx'
import { RunnerDevicesController } from './section-store.ts'
import { en, zh, type RunnerDevicesKey } from './locales.ts'

export type { RunnerDevicesSectionInjected, RunnerDevicesSectionProps } from './RunnerDevicesSection.tsx'
export type { RunnerDevicesController, RunnerDevicesState, DeviceRow, BrowseState, BrowseEntry } from './section-store.ts'
export type { RunnerDevicesKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Runner devices settings section copy. */
    'runner.devices': RunnerDevicesKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'runner.devices'

/**
 * Required services (cordis fiber inject). The target slot is declared by
 * ui-settings' apply, whose activation order relative to this one is NOT
 * constrained; registration depends on the slot through `slots.inject()`.
 */
export const inject = ['slots', 'locale']

/**
 * Register the dictionaries and the Runner Devices section once the
 * `settings.section` declaration is on the ledger, and refetch on reconnect.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-runner-devices: copy dictionaries')

  const controller = new RunnerDevicesController()
  const useSnapshot = bindSnapshotSelector(controller.store)
  const t = ctx.locale.bind(NS)
  const injected = (): RunnerDevicesSectionInjected => ({ controller, useSnapshot, t })

  // A reconnect (socket re-established after a drop) means the device list may
  // have changed while the browser was detached; refetch both lists. Only after
  // the first load, so an unopened section does not fetch on a background reset.
  ctx.effect(() => ctx.on('connection/reset', () => {
    if (controller.store.getSnapshot().status !== 'idle') void controller.load()
  }), 'ui-runner-devices: reconnect refetch')

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'runner-devices',
    order: 30,
    label: () => t('nav'),
    locale: NS,
    inject: injected,
  }, RunnerDevicesSection))
}
