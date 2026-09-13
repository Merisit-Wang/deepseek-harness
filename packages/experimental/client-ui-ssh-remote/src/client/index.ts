/**
 * SSH remote workspace UI plugin, browser half: mounts the generated
 * `sshRemote` Remote namespace, lists discovered targets in a main panel,
 * and hands the browser off to the established tunnel URL. Panel state is a
 * registrant-private observable exposed through the inject `hooks`
 * compartment; every mutation rides the generated Remote face.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the sidebar panellist seat and its owner-props merge.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
// Type-only: pulls the layout MainPanelId merge for the panel id.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { SshBackendStatus, SshTarget, SshTargetId } from '@deepseek-ai/dsh-experimental-ssh-remote/client'
import sshRemote from '@deepseek-ai/dsh-experimental-ssh-remote/remote'
import { SshRemotePanel, SshRemotePanelIcon } from './SshRemotePanel.tsx'
import { en, NS, zh, type SshRemoteKey } from './locales.ts'

export type { SshRemoteKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The SSH workspace panel's copy. */
    sshRemote: SshRemoteKey
  }
}

/** Panel state published through the registrant-private hook source. */
export interface SshRemotePanelState {
  /** True after the first refresh settled, success or failure. */
  readonly loaded: boolean
  /** Discovered targets, in ssh-config order. */
  readonly targets: readonly SshTarget[]
  /** Latest known backend status per target id. */
  readonly statuses: Readonly<Record<string, SshBackendStatus>>
  /** Target currently inside an awaited ensure call, if any. */
  readonly busyTarget: SshTargetId | undefined
  /** Load failure line, undefined when the last refresh succeeded. */
  readonly error: string | undefined
}

/** Injected business face of the SSH workspace panel. */
export interface SshRemotePanelInjected {
  readonly hooks: {
    /** Panel state source, bound to the `useSshRemote` prop. */
    readonly sshRemote: HostObservable<SshRemotePanelState>
  }
  /**
   * Reload targets and backend statuses from the host.
   * @returns settled when the panel state republished.
   */
  readonly refresh: () => Promise<void>
  /**
   * Provision and connect one target, then hand off to its tunnel URL.
   * @param targetId - target to ensure.
   * @returns settled when the handoff happened or the failure was published.
   */
  readonly connect: (targetId: SshTargetId) => Promise<void>
  /**
   * Tear down one target's tunnel.
   * @param targetId - target to disconnect.
   * @returns settled when the panel state republished.
   */
  readonly disconnect: (targetId: SshTargetId) => Promise<void>
  /**
   * Navigate the page to an established backend URL.
   * @param backendUrl - tunnel URL carrying the remote launch token.
   */
  readonly openBackend: (backendUrl: string) => void
}

/** Main panel id shared by the sidebar row and the `main` keyed seat. */
const PANEL_ID = 'ssh-remote'

/** Required services: slot registry, generated Remote mount, and locale registry. */
export const inject = ['slots', 'remote', 'locale']

/**
 * Client plugin body: mount the sshRemote namespace and register the panel.
 * @param ctx - client root context.
 */
export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(sshRemote)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-ssh-remote: dictionaries')

  const store = createSnapshotStore<SshRemotePanelState>({
    loaded: false,
    targets: [],
    statuses: {},
    busyTarget: undefined,
    error: undefined,
  })
  const publish = (patch: Partial<SshRemotePanelState>): void => {
    store.set({ ...store.getSnapshot(), ...patch })
  }

  const refresh = async (): Promise<void> => {
    const [targetsResult, statusResult] = await Promise.all([
      ctx.remote.sshRemote.targets(),
      ctx.remote.sshRemote.status(),
    ])
    if (!targetsResult.ok) {
      publish({ loaded: true, error: `${targetsResult.error.message} (${targetsResult.error.code})` })
      return
    }
    const statuses: Record<string, SshBackendStatus> = {}
    if (statusResult.ok) {
      for (const status of statusResult.value) statuses[status.targetId] = status
    }
    publish({ loaded: true, targets: targetsResult.value, statuses, error: undefined })
  }

  const injected: SshRemotePanelInjected = {
    hooks: { sshRemote: store },
    refresh: async () => {
      await refresh()
    },
    connect: async (targetId) => {
      publish({ busyTarget: targetId })
      try {
        const result = await ctx.remote.sshRemote.ensure({ targetId })
        if (result.ok) {
          window.location.assign(result.value.backendUrl)
          return
        }
        await refresh()
      } finally {
        publish({ busyTarget: undefined })
      }
    },
    disconnect: async (targetId) => {
      await ctx.remote.sshRemote.disconnect({ targetId })
      await refresh()
    },
    openBackend: (backendUrl) => {
      window.location.assign(backendUrl)
    },
  }

  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
    inject: () => injected,
  }, SshRemotePanel))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 40,
    label: 'SSH',
  }, SshRemotePanelIcon))

  void refresh()
  return disposeRemote
}
