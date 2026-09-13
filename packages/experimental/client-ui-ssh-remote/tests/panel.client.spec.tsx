// @vitest-environment jsdom
/** SSH workspace panel component specs: rows, phases, and row actions. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { SshRemotePanel, SshRemotePanelIcon, type SshRemotePanelProps } from '../src/client/SshRemotePanel.tsx'
import type { SshRemotePanelInjected, SshRemotePanelState } from '../src/client/index.ts'
import type { SshBackendStatus, SshTarget } from '@deepseek-ai/dsh-experimental-ssh-remote/client'
import { en } from '../src/client/locales.ts'

const t = makeTranslate(en)

const TARGET: SshTarget = {
  id: 'cfg#dev-box' as SshTarget['id'],
  alias: 'dev-box',
  hostName: '10.0.0.8',
  user: 'deploy',
}

function stateOf(patch: Partial<SshRemotePanelState>): SshRemotePanelState {
  return {
    loaded: true,
    targets: [TARGET],
    statuses: {},
    busyTarget: undefined,
    error: undefined,
    ...patch,
  }
}

function bench(state: SshRemotePanelState) {
  const store = createSnapshotStore<SshRemotePanelState>(state)
  const injected: SshRemotePanelInjected = {
    hooks: { sshRemote: store },
    refresh: vi.fn(() => Promise.resolve()),
    connect: vi.fn(() => Promise.resolve()),
    disconnect: vi.fn(() => Promise.resolve()),
    openBackend: vi.fn(),
  }
  const props = {
    useSshRemote: bindSnapshotSelector(store),
    refresh: injected.refresh,
    connect: injected.connect,
    disconnect: injected.disconnect,
    openBackend: injected.openBackend,
    t,
  } as unknown as SshRemotePanelProps
  return { injected, props }
}

afterEach(cleanup)

describe('SshRemotePanel', () => {
  it('renders the empty state when no targets are discovered', () => {
    const { props } = bench(stateOf({ targets: [] }))
    render(<SshRemotePanel {...props} />)
    expect(screen.getByText(en['panel.empty'])).toBeDefined()
  })

  it('renders nothing but the header before the first load settles', () => {
    const { props } = bench(stateOf({ loaded: false, targets: [] }))
    render(<SshRemotePanel {...props} />)
    expect(screen.queryByText(en['panel.empty'])).toBeNull()
    expect(screen.getByText(en['panel.title'])).toBeDefined()
  })

  it('shows the load failure line', () => {
    const { props } = bench(stateOf({ targets: [], error: 'gateway down' }))
    render(<SshRemotePanel {...props} />)
    expect(screen.getByText('gateway down')).toBeDefined()
  })

  it('renders a target row with its user@host subtitle and a connect action', () => {
    const { injected, props } = bench(stateOf({}))
    render(<SshRemotePanel {...props} />)
    expect(screen.getByText('dev-box')).toBeDefined()
    expect(screen.getByText('deploy@10.0.0.8')).toBeDefined()
    fireEvent.click(screen.getByText(en['target.connect']))
    expect(injected.connect).toHaveBeenCalledWith(TARGET.id)
  })

  it('falls back to the bare host and then to no subtitle', () => {
    const hostOnly: SshTarget = { id: 'cfg#plain' as SshTarget['id'], alias: 'plain', hostName: 'plain.example' }
    const aliasOnly: SshTarget = { id: 'cfg#bare' as SshTarget['id'], alias: 'bare' }
    const { props } = bench(stateOf({ targets: [hostOnly, aliasOnly] }))
    render(<SshRemotePanel {...props} />)
    expect(screen.getByText('plain.example')).toBeDefined()
    expect(screen.getByText('bare')).toBeDefined()
  })

  it('hides the phase row for an idle backend', () => {
    const status: SshBackendStatus = { targetId: TARGET.id, phase: 'idle' }
    const { props } = bench(stateOf({ statuses: { [TARGET.id]: status } }))
    render(<SshRemotePanel {...props} />)
    expect(screen.queryByText(en['phase.error'])).toBeNull()
    expect(screen.getByText(en['target.connect'])).toBeDefined()
  })

  it('shows the phase label without a detail line when the error has none', () => {
    const status: SshBackendStatus = { targetId: TARGET.id, phase: 'error' }
    const { props } = bench(stateOf({ statuses: { [TARGET.id]: status } }))
    render(<SshRemotePanel {...props} />)
    expect(screen.getByText(en['phase.error'])).toBeDefined()
  })

  it('disables the connect button while its target is connecting', () => {
    const { props } = bench(stateOf({ busyTarget: TARGET.id }))
    render(<SshRemotePanel {...props} />)
    const button = screen.getByText(en['target.connecting']) as HTMLButtonElement
    expect(button.disabled).toBe(true)
  })

  it('shows the phase label and error detail of a failed target', () => {
    const status: SshBackendStatus = { targetId: TARGET.id, phase: 'error', error: 'Connection refused' }
    const { props } = bench(stateOf({ statuses: { [TARGET.id]: status } }))
    render(<SshRemotePanel {...props} />)
    expect(screen.getByText(`${en['phase.error']} — Connection refused`)).toBeDefined()
    expect(screen.getByText(en['target.retry'])).toBeDefined()
  })

  it('offers open and disconnect for a ready backend', () => {
    const status: SshBackendStatus = { targetId: TARGET.id, phase: 'ready', backendUrl: 'http://127.0.0.1:5001/?token=tok' }
    const { injected, props } = bench(stateOf({ statuses: { [TARGET.id]: status } }))
    render(<SshRemotePanel {...props} />)
    fireEvent.click(screen.getByText(en['target.open']))
    expect(injected.openBackend).toHaveBeenCalledWith('http://127.0.0.1:5001/?token=tok')
    fireEvent.click(screen.getByText(en['target.disconnect']))
    expect(injected.disconnect).toHaveBeenCalledWith(TARGET.id)
  })

  it('refreshes through the header button', () => {
    const { injected, props } = bench(stateOf({}))
    render(<SshRemotePanel {...props} />)
    fireEvent.click(screen.getByText(en['panel.refresh']))
    expect(injected.refresh).toHaveBeenCalled()
  })
})

describe('SshRemotePanelIcon', () => {
  it('renders the terminal glyph at the requested size, active or not', () => {
    const { container } = render(<SshRemotePanelIcon size={18} active={true} />)
    expect(container.querySelector('svg')?.getAttribute('width')).toBe('18')
    const { container: inactive } = render(<SshRemotePanelIcon size={16} active={false} />)
    expect(inactive.querySelector('svg')?.getAttribute('width')).toBe('16')
  })
})
