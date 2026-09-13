/**
 * SSH remote workspace panel: lists discovered targets with their backend
 * phase, drives connect/disconnect, and hands off to the tunnel URL on
 * success. All data and actions arrive through the four props shares.
 */

import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SidebarPanelIconOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { SshBackendPhase, SshBackendStatus, SshTarget } from '@deepseek-ai/dsh-experimental-ssh-remote/client'
import type { SshRemotePanelInjected, SshRemotePanelState } from './index.ts'
import css from './SshRemotePanel.module.css'

/** Full panel props: runtime standard kit & injected face & locale seat. */
export type SshRemotePanelProps =
  PropsRuntime<'main'> & InjectFace<SshRemotePanelInjected> & PropsLocale<'sshRemote'>

/** Subtitle line for one target: `user@host` when known, else the raw host or nothing. */
function subtitleOf(target: SshTarget): string | undefined {
  if (target.user !== undefined && target.hostName !== undefined) return `${target.user}@${target.hostName}`
  return target.hostName
}

/** Phase label key for one status, or undefined while idle. */
function phaseKeyOf(status: SshBackendStatus | undefined): Exclude<SshBackendPhase, 'idle'> | undefined {
  return status?.phase === 'idle' ? undefined : status?.phase
}

/** One target row: identity, phase, and the phase-appropriate action. */
function TargetRow({ target, status, busy, connect, disconnect, openBackend, t }: {
  readonly target: SshTarget
  readonly status: SshBackendStatus | undefined
  readonly busy: boolean
  readonly connect: SshRemotePanelInjected['connect']
  readonly disconnect: SshRemotePanelInjected['disconnect']
  readonly openBackend: SshRemotePanelInjected['openBackend']
  readonly t: SshRemotePanelProps['t']
}) {
  const phase = phaseKeyOf(status)
  const inFlight = busy || (phase !== undefined && phase !== 'ready' && phase !== 'error')
  const readyUrl = phase === 'ready' ? status?.backendUrl : undefined
  return (
    <div className={css.row}>
      <div className={css.rowMain}>
        <span className={css.alias}>{target.alias}</span>
        {subtitleOf(target) !== undefined && <span className={css.subtitle}>{subtitleOf(target)}</span>}
        {phase !== undefined && (
          <span className={phase === 'error' ? css.phaseError : css.phase}>
            {t(`phase.${phase}`)}
            {phase === 'error' && status?.error !== undefined ? ` — ${status.error}` : ''}
          </span>
        )}
      </div>
      {readyUrl !== undefined ? (
        <>
          <button type="button" onClick={() => { openBackend(readyUrl) }}>{t('target.open')}</button>
          <button type="button" onClick={() => void disconnect(target.id)}>{t('target.disconnect')}</button>
        </>
      ) : (
        <button type="button" disabled={inFlight} onClick={() => void connect(target.id)}>
          {inFlight ? t('target.connecting') : phase === 'error' ? t('target.retry') : t('target.connect')}
        </button>
      )}
    </div>
  )
}

/** The SSH workspace main panel. */
export function SshRemotePanel({ useSshRemote, refresh, connect, disconnect, openBackend, t }: SshRemotePanelProps) {
  const state: SshRemotePanelState = useSshRemote(snapshot => snapshot)
  return (
    <div className={css.root}>
      <div className={css.header}>
        <span className={css.title}>{t('panel.title')}</span>
        <button type="button" onClick={() => void refresh()}>{t('panel.refresh')}</button>
      </div>
      {state.error !== undefined && <span className={css.phaseError}>{state.error}</span>}
      {!state.loaded ? null : state.targets.length === 0 ? (
        <span className={css.empty}>{t('panel.empty')}</span>
      ) : (
        <div className={css.list}>
          {state.targets.map(target => (
            <TargetRow
              key={target.id}
              target={target}
              status={state.statuses[target.id]}
              busy={state.busyTarget === target.id}
              connect={connect}
              disconnect={disconnect}
              openBackend={openBackend}
              t={t}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/** The sidebar panel glyph: a simple terminal mark. */
export function SshRemotePanelIcon({ size, active }: SidebarPanelIconOwnerProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="1" y="2" width="14" height="12" rx="2" stroke="currentColor" strokeWidth={active ? 1.6 : 1.2} />
      <path d="M4 6l3 2.5L4 11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8.5 11H12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}
