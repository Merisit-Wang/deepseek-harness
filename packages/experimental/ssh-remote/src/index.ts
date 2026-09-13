/**
 * SSH remote workspace host plugin. Discovers connection targets from
 * `~/.ssh/config`, provisions a matching dsh runtime on the target over the
 * system `ssh` binary, launches the remote `dsh web` backend, and brings its
 * HTTP/WebSocket port back to a local loopback port through `ssh -L`. The
 * browser reaches the remote backend at the tunnel URL — including its
 * launch token — so remote browser authentication works exactly as if the
 * backend were local.
 *
 * Credentials never enter this plugin: OpenSSH owns config, agents, and
 * keys, and `BatchMode=yes` turns any interactive prompt into a loud error.
 *
 * @module @deepseek-ai/dsh-experimental-ssh-remote
 */

import { createServer } from 'node:net'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { listSshTargets } from './targets.ts'
import { createSystemSshRunner, localUid } from './ssh.ts'
import type { SshRunner, SshSpawnedProcess } from './ssh.ts'
import { DEFAULT_RUNTIME_OPTIONS, createTarRuntimePackager, ensureRemoteBackend, targetWorkDir } from './runtime.ts'
import type { RuntimePackager } from './runtime.ts'
import type {
  SshBackendPhase, SshBackendStatus, SshDisconnectRequest, SshEnsureRequest, SshEnsureResult, SshTarget, SshTargetId,
} from './types.ts'
export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** SSH remote workspace provisioning and tunnels. */
    sshRemote: SshRemoteController
  }
}

/** Plugin configuration; every field has a production default. */
export interface SshRemoteConfig {
  /** ssh config file to discover targets from. */
  sshConfigPath?: string
  /** Remote home-relative directory holding node, runtime, logs, and pid files. */
  remoteRoot?: string
  /** Minimum Node.js major version accepted on the remote. */
  minimumNodeMajor?: number
  /** Node.js version installed remotely when the check fails. */
  nodeInstallVersion?: string
  /** Hard deadline for one remote script, in milliseconds. */
  commandTimeoutMs?: number
  /** Deadline for the remote backend startup line, in milliseconds. */
  launchTimeoutMs?: number
  /** Local directory for ControlMaster sockets and runtime tarballs. */
  stateDir?: string
}

const CONFIG_KEYS = new Set([
  'sshConfigPath', 'remoteRoot', 'minimumNodeMajor', 'nodeInstallVersion',
  'commandTimeoutMs', 'launchTimeoutMs', 'stateDir',
])

/**
 * Validate plugin config loudly at load.
 * @param config - raw plugin config.
 * @returns the same object after field validation.
 */
export function resolveConfig(config: SshRemoteConfig): SshRemoteConfig {
  const unknown = Object.keys(config).filter(key => !CONFIG_KEYS.has(key))
  if (unknown.length > 0) {
    throw new Error(`SshRemoteConfig has unknown key(s) ${unknown.join(', ')} — allowed: ${[...CONFIG_KEYS].join(', ')}`)
  }
  for (const key of ['commandTimeoutMs', 'launchTimeoutMs', 'minimumNodeMajor'] as const) {
    const value = config[key]
    if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
      throw new Error(`SshRemoteConfig.${key} must be a positive number`)
    }
  }
  return config
}

interface BackendEntry {
  phase: SshBackendPhase
  error?: string
  backendUrl?: string
  tunnel?: SshSpawnedProcess
  inflight?: Promise<SshEnsureResult>
}

/** Reserve a free loopback port for a tunnel's local end. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      /* v8 ignore next 4 -- a listening server's address() is null only after close, which this callback cannot observe. */
      if (address === null || typeof address !== 'object') {
        server.close()
        reject(new Error('could not reserve a local port'))
        return
      }
      const port = address.port
      server.close(() => { resolve(port) })
    })
  })
}

/**
 * Probe the tunnel until the remote backend answers HTTP, or the deadline passes.
 * @param url - tunnel-local URL to probe.
 * @param deadlineMs - total probe budget in milliseconds.
 * @param signal - caller cancellation.
 */
export async function waitForTunnel(url: string, deadlineMs: number, signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + deadlineMs
  for (;;) {
    signal.throwIfAborted()
    try {
      // Any HTTP answer — including 401 from the remote browser-auth fence —
      // proves the tunnel pipes bytes to the backend.
      await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(3000), redirect: 'manual' })
      return
    } catch (error) {
      if (Date.now() > deadline) {
        throw new Error(`the tunnel did not reach the remote backend within ${deadlineMs}ms: ${String(error)}`)
      }
      await new Promise(resolve => setTimeout(resolve, 500))
    }
  }
}

/** Tunnel-readiness probe seam; production is {@link waitForTunnel}. */
export type TunnelProbe = (url: string, deadlineMs: number, signal: AbortSignal) => Promise<void>

/**
 * `ctx.sshRemote`: target discovery, remote provisioning, and tunnel
 * lifecycle for SSH remote workspaces. The browser opens the `backendUrl`
 * an `ensure` call returns; the URL already carries the remote backend's
 * launch token, so the remote's own browser-auth exchange issues its cookie
 * against the tunnel authority with no proxy involvement.
 */
export class SshRemoteController extends TypertRemoteService {
  private readonly config: Required<SshRemoteConfig>
  private readonly runner: SshRunner
  private readonly probe: TunnelProbe
  private readonly packager: RuntimePackager
  private readonly backends = new Map<SshTargetId, BackendEntry>()
  private targets: SshTarget[] = []

  constructor(
    ctx: Context,
    config: SshRemoteConfig = {},
    runner?: SshRunner,
    probe: TunnelProbe = waitForTunnel,
    packager?: RuntimePackager,
  ) {
    super(ctx, 'sshRemote')
    const resolved = resolveConfig(config)
    this.config = {
      sshConfigPath: resolved.sshConfigPath ?? '',
      remoteRoot: resolved.remoteRoot ?? DEFAULT_RUNTIME_OPTIONS.remoteRoot,
      minimumNodeMajor: resolved.minimumNodeMajor ?? DEFAULT_RUNTIME_OPTIONS.minimumNodeMajor,
      nodeInstallVersion: resolved.nodeInstallVersion ?? DEFAULT_RUNTIME_OPTIONS.nodeInstallVersion,
      commandTimeoutMs: resolved.commandTimeoutMs ?? DEFAULT_RUNTIME_OPTIONS.commandTimeoutMs,
      launchTimeoutMs: resolved.launchTimeoutMs ?? DEFAULT_RUNTIME_OPTIONS.launchTimeoutMs,
      stateDir: resolved.stateDir ?? join(tmpdir(), `dsh-ssh-${localUid()}`),
    }
    this.runner = runner ?? createSystemSshRunner(join(this.config.stateDir, 'control'))
    this.probe = probe
    this.packager = packager ?? createTarRuntimePackager()
    ctx.effect(() => () => {
      for (const entry of this.backends.values()) entry.tunnel?.kill()
    }, 'dsh-ssh-remote: close tunnels')
  }

  private setPhase(targetId: SshTargetId, phase: SshBackendPhase, patch: Partial<BackendEntry> = {}): void {
    const entry = this.backends.get(targetId) ?? { phase: 'idle' }
    entry.phase = phase
    if (phase !== 'error') delete entry.error
    if (phase !== 'ready') delete entry.backendUrl
    Object.assign(entry, patch)
    this.backends.set(targetId, entry)
  }

  private requireTarget(targetId: SshTargetId): SshTarget {
    const target = this.targets.find(candidate => candidate.id === targetId)
    if (target === undefined) throw new Error(`unknown SSH target "${targetId}"; call sshRemote.targets() to refresh the list`)
    return target
  }

  /**
   * List the SSH targets discovered from the operator's ssh config.
   * @returns targets in config-file order.
   */
  @Remote('targets')
  async remoteTargets(): Promise<SshTarget[]> {
    this.targets = await listSshTargets(this.config.sshConfigPath || undefined)
    return this.targets
  }

  /**
   * Read the current lifecycle of every backend this controller manages.
   * @returns one status row per target with non-idle state.
   */
  @Remote('status')
  remoteStatus(): Promise<SshBackendStatus[]> {
    const rows: SshBackendStatus[] = []
    for (const [targetId, entry] of this.backends) {
      rows.push({
        targetId,
        phase: entry.phase,
        ...entry.error !== undefined ? { error: entry.error } : {},
        ...entry.backendUrl !== undefined ? { backendUrl: entry.backendUrl } : {},
      })
    }
    return Promise.resolve(rows)
  }

  /**
   * Provision and connect one target's remote backend: detect or install
   * Node.js, ship the matching dsh runtime when absent or stale, launch the
   * remote `dsh web`, and open an `ssh -L` tunnel to its port. Concurrent
   * calls for one target join the same in-flight provisioning.
   * @param request - target to ensure.
   * @param signal - caller cancellation; aborts waiting and provisioning.
   * @returns the local tunnel URL carrying the remote launch token.
   */
  @Remote('ensure')
  async remoteEnsure(request: SshEnsureRequest, signal: AbortSignal): Promise<SshEnsureResult> {
    const target = this.requireTarget(request.targetId)
    const existing = this.backends.get(target.id)
    if (existing?.phase === 'ready' && existing.backendUrl !== undefined) {
      return { targetId: target.id, backendUrl: existing.backendUrl }
    }
    if (existing?.inflight !== undefined) return existing.inflight
    const inflight = this.ensure(target, signal)
      .finally(() => {
        const entry = this.backends.get(target.id)
        /* v8 ignore next 1 -- the entry is always present: remoteEnsure writes it before ensure() can settle. */
        if (entry !== undefined) delete entry.inflight
      })
    const entry = this.backends.get(target.id) ?? { phase: 'idle' }
    entry.inflight = inflight
    this.backends.set(target.id, entry)
    return inflight
  }

  /**
   * Tear down one target's tunnel, leaving the remote backend process
   * running for a later reconnect.
   * @param request - target to disconnect.
   */
  @Remote('disconnect')
  remoteDisconnect(request: SshDisconnectRequest): Promise<void> {
    const entry = this.backends.get(request.targetId)
    entry?.tunnel?.kill()
    this.setPhase(request.targetId, 'idle')
    return Promise.resolve()
  }

  private async ensure(target: SshTarget, signal: AbortSignal): Promise<SshEnsureResult> {
    const id = target.id
    try {
      const workDir = targetWorkDir(this.config.stateDir, target.alias)
      await mkdir(workDir, { recursive: true })
      const info = await ensureRemoteBackend(
        this.runner,
        target.alias,
        workDir,
        {
          remoteRoot: this.config.remoteRoot,
          minimumNodeMajor: this.config.minimumNodeMajor,
          nodeInstallVersion: this.config.nodeInstallVersion,
          commandTimeoutMs: this.config.commandTimeoutMs,
          launchTimeoutMs: this.config.launchTimeoutMs,
        },
        this.packager,
        (phase) => { this.setPhase(id, phase) },
      )
      this.setPhase(id, 'tunneling')
      const localPort = await freePort()
      const tunnel = this.runner.startTunnel(target.alias, localPort, info.remotePort)
      tunnel.exited.catch((error: unknown) => {
        const entry = this.backends.get(id)
        if (entry?.phase === 'ready') this.setPhase(id, 'error', { error: String(error) })
      })
      const backendUrl = `http://127.0.0.1:${localPort}/?token=${info.token}`
      await this.probe(`http://127.0.0.1:${localPort}/`, this.config.launchTimeoutMs, signal)
      this.setPhase(id, 'ready', { backendUrl, tunnel })
      return { targetId: id, backendUrl }
    } catch (error) {
      this.setPhase(id, 'error', { error: error instanceof Error ? error.message : String(error) })
      throw error
    }
  }
}

export default SshRemoteController
