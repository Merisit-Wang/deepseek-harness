// @vitest-environment jsdom
/** SSH workspace client plugin apply specs: remote mount, slot registration, and action flows. */
import { Context, type Fiber } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { SshBackendStatus, SshEnsureResult, SshTarget } from '@deepseek-ai/dsh-experimental-ssh-remote/client'
import sshRemoteContribution from '@deepseek-ai/dsh-experimental-ssh-remote/remote'
import { apply, inject, type SshRemotePanelInjected, type SshRemotePanelState } from '../src/client/index.ts'
import { apply as hostApply } from '../src/index.ts'

const TARGET: SshTarget = { id: 'cfg#dev-box' as SshTarget['id'], alias: 'dev-box' }
const READY: SshBackendStatus = { targetId: TARGET.id, phase: 'ready', backendUrl: 'http://127.0.0.1:5001/?token=tok' }

function ok<T>(value: T): RemoteResult<T> {
  return { ok: true, value }
}

function fail(message: string): RemoteResult<never> {
  return { ok: false, error: { code: 'x', message } } as unknown as RemoteResult<never>
}

interface Bench {
  remote: {
    $mount: ReturnType<typeof vi.fn>
    sshRemote: {
      targets: ReturnType<typeof vi.fn>
      status: ReturnType<typeof vi.fn>
      ensure: ReturnType<typeof vi.fn>
      disconnect: ReturnType<typeof vi.fn>
    }
  }
  slots: SlotRegistry
  injected: () => SshRemotePanelInjected
}

const owners = new Set<Fiber>()
afterEach(async () => {
  try {
    for (const owner of owners) await owner.dispose()
  } finally {
    owners.clear()
  }
  vi.unstubAllGlobals()
})

async function bench(): Promise<Bench> {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('locale', new LocaleRuntime(ctx))
  const remote = {
    $mount: vi.fn(() => Promise.resolve(() => Promise.resolve())),
    sshRemote: {
      targets: vi.fn(() => Promise.resolve(ok([TARGET]))),
      status: vi.fn(() => Promise.resolve(ok([READY]))),
      ensure: vi.fn(() => Promise.resolve(ok<SshEnsureResult>({ targetId: TARGET.id, backendUrl: READY.backendUrl as string }))),
      disconnect: vi.fn(() => Promise.resolve(ok(undefined))),
    },
  }
  ctx.provide('remote', remote as never)
  const slots = ctx.get('slots') as SlotRegistry
  // Declare the seat chain the panel registers into, mirroring the layout
  // frame ('main') and the sidebar shell ('sidebar.panellist').
  slots.register({ name: 'root', children: {
    'main': { kind: 'keyed', scope: 'root' },
    'sidebar': { kind: 'single', scope: 'root' },
  } } as never, (() => null) as never)
  slots.register({ name: 'sidebar', children: {
    'sidebar.panellist': { kind: 'list', scope: 'root' },
  } } as never, (() => null) as never)
  const owner = ctx.plugin({ inject: [...inject], apply: apply as never })
  owners.add(owner)
  await owner.await()
  const mainEntry = slots.entriesOfSlot('main').find(entry => (entry.options.key as string) === 'ssh-remote')
  if (mainEntry === undefined) throw new Error('the ssh-remote main entry did not register')
  const injectFace = mainEntry.inject as (() => SshRemotePanelInjected) | undefined
  if (injectFace === undefined) throw new Error('the ssh-remote main entry carries no inject face')
  return { remote, slots, injected: injectFace }
}

/** Read the current panel state from the injected hook source. */
function stateOf(face: SshRemotePanelInjected): SshRemotePanelState {
  return face.hooks.sshRemote.getSnapshot()
}

describe('client-ui-ssh-remote apply', () => {
  it('keeps the host Loader entry inert', () => {
    expect(hostApply).not.toThrow()
  })

  it('declares only the services it uses', () => {
    expect(inject).toEqual(['slots', 'remote', 'locale'])
  })

  it('mounts the sshRemote contribution and registers the panel seats', async () => {
    const { remote, slots } = await bench()
    expect(remote.$mount).toHaveBeenCalledWith(sshRemoteContribution)
    expect(slots.entriesOfSlot('main').some(entry => (entry.options.key as string) === 'ssh-remote')).toBe(true)
    expect(slots.entriesOfSlot('sidebar.panellist').some(entry => (entry.options.id as string) === 'ssh-remote')).toBe(true)
  })

  it('publishes targets and statuses after the initial refresh', async () => {
    const { injected } = await bench()
    await vi.waitFor(() => {
      if (!stateOf(injected()).loaded) throw new Error('not loaded yet')
    })
    const state = stateOf(injected())
    expect(state.targets).toEqual([TARGET])
    expect(state.statuses[TARGET.id]).toEqual(READY)
  })

  it('hands off to the backend URL when ensure succeeds', async () => {
    const assign = vi.fn()
    vi.stubGlobal('location', { assign })
    const { injected, remote } = await bench()
    await injected().connect(TARGET.id)
    expect(remote.sshRemote.ensure).toHaveBeenCalledWith({ targetId: TARGET.id })
    expect(assign).toHaveBeenCalledWith(READY.backendUrl)
    expect(stateOf(injected()).busyTarget).toBeUndefined()
  })

  it('publishes the host error status when ensure fails', async () => {
    const { injected, remote } = await bench()
    remote.sshRemote.ensure.mockResolvedValueOnce(fail('boom'))
    const errored: SshBackendStatus = { targetId: TARGET.id, phase: 'error', error: 'boom' }
    remote.sshRemote.status.mockResolvedValueOnce(ok([errored]))
    await injected().connect(TARGET.id)
    expect(stateOf(injected()).statuses[TARGET.id]).toEqual(errored)
    expect(stateOf(injected()).busyTarget).toBeUndefined()
  })

  it('disconnects through the remote and republishes', async () => {
    const { injected, remote } = await bench()
    remote.sshRemote.status.mockResolvedValue(ok([]))
    await injected().disconnect(TARGET.id)
    expect(remote.sshRemote.disconnect).toHaveBeenCalledWith({ targetId: TARGET.id })
    expect(stateOf(injected()).statuses[TARGET.id]).toBeUndefined()
  })

  it('publishes a load failure line when targets cannot be listed', async () => {
    const { injected, remote } = await bench()
    remote.sshRemote.targets.mockRejectedValueOnce(new Error('gateway down'))
    await injected().refresh()
    expect(stateOf(injected()).error).toContain('gateway down')
  })

  it('publishes a business Remote failure with its code', async () => {
    const { injected, remote } = await bench()
    remote.sshRemote.targets.mockResolvedValueOnce(fail('broken pipe'))
    await injected().refresh()
    expect(stateOf(injected()).error).toBe('broken pipe (x)')
  })

  it('keeps statuses empty when the status call fails but targets succeed', async () => {
    const { injected, remote } = await bench()
    remote.sshRemote.status.mockResolvedValueOnce(fail('no stream'))
    await injected().refresh()
    const state = stateOf(injected())
    expect(state.error).toBeUndefined()
    expect(state.targets).toEqual([TARGET])
    expect(state.statuses).toEqual({})
  })

  it('formats a non-Error refresh rejection with String()', async () => {
    const { injected, remote } = await bench()
    remote.sshRemote.targets.mockRejectedValueOnce('plain rejection')
    await injected().refresh()
    expect(stateOf(injected()).error).toBe('plain rejection')
  })

  it('opens a backend URL through window.location.assign', async () => {
    const assign = vi.fn()
    vi.stubGlobal('location', { assign })
    const { injected } = await bench()
    injected().openBackend('http://127.0.0.1:5001/?token=tok')
    expect(assign).toHaveBeenCalledWith('http://127.0.0.1:5001/?token=tok')
  })
})
