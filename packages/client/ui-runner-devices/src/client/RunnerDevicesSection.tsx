/**
 * Runner devices settings section: the connected-laptop list plus the
 * per-device folder picker that attaches a laptop directory as a server
 * workspace, and the attach result. The data layer is the
 * {@link RunnerDevicesController} (a snapshot store over `/api/runner/*`).
 * This component is pure presentation over that store: it reads slices through
 * the bound selector hook and calls the controller's actions. It renders
 * nothing for a deployment that composes no hub (an empty device list reads as
 * the "no devices" hint, not an error).
 */

import { useEffect, useState, type FormEvent } from 'react'
import type { ReactNode } from 'react'
import { Button, Input, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-web-react'
import type { InjectFace, PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { BrowseEntry, BrowseState, RunnerDevicesController, RunnerDevicesState } from './section-store.ts'
import css from './RunnerDevicesSection.module.css'

/** Registration-side business face for the runner-devices section. */
export interface RunnerDevicesSectionInjected {
  /** The page store (loaded on mount, refreshed on reconnect). */
  controller: RunnerDevicesController
  /** uSES subscription hook bound to the store. */
  useSnapshot: SnapshotSelectorHook<RunnerDevicesState>
  /** Section copy. */
  t: TranslateNS<'runner.devices'>
}

/** Full component props (slot outlet spreads the inject face flat). */
export type RunnerDevicesSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'runner.devices'>
  & InjectFace<RunnerDevicesSectionInjected>

/** Status-dot state for a device connection (ongoing = connected, warning = offline). */
function deviceDot(connected: boolean): 'ongoing' | 'warning' {
  return connected ? 'ongoing' : 'warning'
}

/** Per-device folder picker, rendered for a connected device. */
function FolderPicker({
  controller,
  t,
  deviceId,
  browseState,
  connected,
}: {
  controller: RunnerDevicesController
  t: TranslateNS<'runner.devices'>
  deviceId: string
  browseState: BrowseState | undefined
  connected: boolean
}): ReactNode {
  const [pathInput, setPathInput] = useState('')
  const attachPath = browseState?.path ?? ''
  const entries = browseState?.entries ?? []
  const crumbs = browseState?.crumbs ?? []
  const browseBusy = browseState?.busy === true
  const browseError = browseState?.error ?? null
  const hasBrowsed = browseState !== undefined && entries.length > 0
  const hasCrumbs = crumbs.length > 0

  const onBrowse = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const next = pathInput.trim()
    if (next.length === 0) return
    void controller.browse(deviceId, next)
  }

  const onEntryClick = (entry: BrowseEntry): void => {
    if (entry.type !== 'directory') return
    void controller.browse(deviceId, entry.path)
  }

  const onCrumbClick = (path: string): void => {
    void controller.browse(deviceId, path)
  }

  const onAttach = (path: string): void => {
    void controller.attachWorkspace(deviceId, path)
  }

  return (
    <div className={css.folderPicker}>
      <p className={css.folderIntro}>{t('folderIntro')}</p>
      <form className={css.browseForm} onSubmit={onBrowse}>
        <Input
          type="text"
          value={pathInput}
          placeholder={t('pathPlaceholder')}
          disabled={!connected || browseBusy}
          onChange={(event) => { setPathInput(event.currentTarget.value) }}
          aria-label={t('pathFor', { device: deviceId })}
        />
        <Button type="submit" variant="primary" size="md" disabled={!connected || browseBusy || pathInput.trim().length === 0}>
          {browseBusy ? t('browsing') : t('browse')}
        </Button>
      </form>
      {browseError !== null ? <p className={css.browseError}>{browseError}</p> : null}
      {hasCrumbs
        ? (
          <div className={css.crumbs}>
            {crumbs.map(crumb => (
              <button
                key={crumb.path}
                className={css.crumb}
                onClick={() => { onCrumbClick(crumb.path) }}
                disabled={browseBusy}
                type="button"
              >
                {crumb.name || '/'}
              </button>
            ))}
          </div>
        )
        : null}
      {hasBrowsed
        ? (
          <ul className={css.browseEntries}>
            {entries.map(entry => (
              <li key={entry.path} className={css.browseEntry}>
                <span className={css.browseName}>{entry.name}</span>
                <span className={css.browseType}>{entry.type === 'directory' ? t('isDirectory') : entry.type === 'file' ? t('isFile') : t('isOther')}</span>
                {entry.type === 'directory'
                  ? (
                    <Button type="button" variant="outline" size="sm" disabled={browseBusy} onClick={() => { onEntryClick(entry) }}>
                      {t('openFolder')}
                    </Button>
                  )
                  : null}
              </li>
            ))}
          </ul>
        )
        : null}
      {hasBrowsed || pathInput.trim().length > 0
        ? (
          <Button
            type="button"
            variant="primary"
            size="md"
            disabled={!connected || browseBusy || (pathInput.trim().length === 0 && !hasBrowsed)}
            onClick={() => { onAttach(pathInput.trim() || attachPath) }}
          >
            {browseBusy ? t('attaching') : t('attachFolder')}
          </Button>
        )
        : null}
    </div>
  )
}

/**
 * The runner-devices settings section.
 * @param props - runtime slot currency, the locale translator, and the inject face.
 * @returns the section, or null when no hub is composed.
 */
export function RunnerDevicesSection({ controller, useSnapshot, t }: RunnerDevicesSectionProps): ReactNode {
  const status = useSnapshot(s => s.status)
  const devices = useSnapshot(s => s.devices)
  const browseByDevice = useSnapshot(s => s.browse)
  const attachMessage = useSnapshot(s => s.attachMessage)

  useEffect(() => {
    void controller.load()
    return () => { controller.dispose() }
  }, [controller])

  if (status === 'loading') {
    return <div className={css.root}>{t('loading')}</div>
  }
  if (status === 'error') {
    return (
      <div className={css.root}>
        <p className={css.errorText}>{t('error')}</p>
        <Button variant="outline" size="sm" onClick={() => { void controller.load() }}>{t('retry')}</Button>
      </div>
    )
  }

  return (
    <div className={css.root}>
      <p className={css.intro}>{t('intro')}</p>
      {attachMessage !== null ? <p className={css.attachMessage} role="status">{attachMessage}</p> : null}

      {devices.length === 0
        ? (
          <div className={css.empty}>
            <p className={css.emptyTitle}>{t('noDevices')}</p>
            <p className={css.emptyHint}>{t('noDevicesHint')}</p>
          </div>
        )
        : (
          <ul className={css.devices}>
            {devices.map((device) => {
              const browseState = browseByDevice[device.deviceId]
              return (
                <li key={device.deviceId} className={css.deviceRow}>
                  <div className={css.deviceHead}>
                    <StateDot state={deviceDot(device.connected)} className={css.deviceDot} />
                    <span className={css.deviceId}>{device.deviceId}</span>
                    <span className={device.connected ? css.statusOnline : css.statusOffline}>
                      {device.connected ? t('connected') : t('offline')}
                    </span>
                  </div>
                  {device.connected
                    ? (
                      <FolderPicker
                        controller={controller}
                        t={t}
                        deviceId={device.deviceId}
                        browseState={browseState}
                        connected={device.connected}
                      />
                    )
                    : <p className={css.deviceOfflineHint}>{t('offlineHint')}</p>}
                </li>
              )
            })}
          </ul>
        )}
    </div>
  )
}
