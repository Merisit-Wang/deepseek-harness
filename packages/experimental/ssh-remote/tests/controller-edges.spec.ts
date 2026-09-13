import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveConfig, SshRemoteController, waitForTunnel } from '../src/index.ts'
import type { RuntimePackager } from '../src/runtime.ts'
import type { SshRunner, SshRunResult, SshSpawnedProcess } from '../src/ssh.ts'

const PACKAGER: RuntimePackager = {
  version: () => Promise.resolve('1.2.3'),
  pack: workDir => Promise.resolve(`${workDir}/dsh-runtime-1.2.3.tar.gz`),
}

function ok(stdout: string): SshRunResult {
  return { code: 0, stdout, stderr: '' }
}

function healthyRunner(tunnel: SshSpawnedProcess): SshRunner {
  return {
    run(_alias: string, script: string) {
      if (/^command -v node/.test(script)) return Promise.resolve(ok('v22.20.0\n'))
      if (/dsh" --version/.test(script)) return Promise.resolve(ok('1.2.3\n'))
      if (/kill -0/.test(script)) return Promise.resolve(ok('alive'))
      if (/grep -m1/.test(script)) return Promise.resolve(ok('dsh web: http://127.0.0.1:4100/?token=tok123'))
      return Promise.resolve(ok(''))
    },
    upload: () => Promise.resolve(),
    startTunnel: () => tunnel,
  }
}

function fakeTunnel(): SshSpawnedProcess & { kill: ReturnType<typeof vi.fn> } {
  return {
    exited: new Promise<number | null>(() => {}),
    kill: vi.fn((): void => {}),
  }
}

/** Narrow a possibly-undefined value under noUncheckedIndexedAccess. */
function mustGet<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`expected ${what} to be defined`)
  return value
}

describe('resolveConfig', () => {
  it('rejects unknown keys', () => {
    expect(() => resolveConfig({ bogus: true } as never)).toThrow('unknown key(s) bogus')
  })

  it('rejects non-positive numeric fields', () => {
    expect(() => resolveConfig({ commandTimeoutMs: 0 })).toThrow('commandTimeoutMs must be a positive number')
    expect(() => resolveConfig({ launchTimeoutMs: -1 })).toThrow('launchTimeoutMs must be a positive number')
    expect(() => resolveConfig({ minimumNodeMajor: Number.NaN })).toThrow('minimumNodeMajor must be a positive number')
  })

  it('accepts a complete valid config', () => {
    expect(resolveConfig({ remoteRoot: '.x', minimumNodeMajor: 22 })).toEqual({ remoteRoot: '.x', minimumNodeMajor: 22 })
  })
})

describe('waitForTunnel', () => {
  let server: Server | undefined
  afterEach(async () => {
    if (server !== undefined) await new Promise(resolve => server?.close(resolve))
    server = undefined
  })

  async function serve(status: number): Promise<string> {
    server = createServer((_req, res) => {
      res.writeHead(status).end()
    })
    await new Promise<void>(resolve => server?.listen(0, '127.0.0.1', resolve))
    const { port } = server?.address() as AddressInfo
    return `http://127.0.0.1:${port}/`
  }

  it('resolves on any HTTP answer, including an auth-fence 401', async () => {
    const url = await serve(401)
    await expect(waitForTunnel(url, 2000, new AbortController().signal)).resolves.toBeUndefined()
  })

  it('fails after the deadline when nothing answers', async () => {
    await expect(waitForTunnel('http://127.0.0.1:1/', 1200, new AbortController().signal))
      .rejects.toThrow('did not reach the remote backend')
  }, 10000)

  it('aborts with the caller signal', async () => {
    const controller = new AbortController()
    const waiting = waitForTunnel('http://127.0.0.1:1/', 60_000, controller.signal)
    controller.abort()
    await expect(waiting).rejects.toThrow()
  })
})

describe('SshRemoteController lifecycle edges', () => {
  let dir: string
  let ctx: Context
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-ssh-edges-'))
    ctx = new Context()
    await writeFile(join(dir, 'config'), 'Host dev-box\n  HostName 10.0.0.8\n')
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  function controller(tunnel: SshSpawnedProcess): SshRemoteController {
    return new SshRemoteController(
      ctx,
      { sshConfigPath: join(dir, 'config'), stateDir: dir },
      healthyRunner(tunnel),
      () => Promise.resolve(),
      PACKAGER,
    )
  }

  it('joins concurrent ensure calls for one target', async () => {
    const instance = controller(fakeTunnel())
    const [target] = await instance.remoteTargets()
    const targetId = mustGet(target, 'target').id
    const signal = new AbortController().signal
    const [first, second] = await Promise.all([
      instance.remoteEnsure({ targetId }, signal),
      instance.remoteEnsure({ targetId }, signal),
    ])
    expect(first).toEqual(second)
  })

  it('ignores disconnect for a target that never connected', async () => {
    const instance = controller(fakeTunnel())
    await expect(instance.remoteDisconnect({ targetId: 'missing' as never })).resolves.toBeUndefined()
    await expect(instance.remoteStatus()).resolves.toEqual([{ targetId: 'missing', phase: 'idle' }])
  })

  it('marks a ready backend errored when its tunnel dies', async () => {
    let failTunnel!: (error: Error) => void
    const tunnel: SshSpawnedProcess = {
      exited: new Promise<number | null>((_resolve, reject) => { failTunnel = reject }),
      kill: vi.fn((): void => {}),
    }
    const instance = controller(tunnel)
    const [target] = await instance.remoteTargets()
    const ensured = mustGet(target, 'target')
    await instance.remoteEnsure({ targetId: ensured.id }, new AbortController().signal)
    failTunnel(new Error('ssh tunnel to dev-box exited (255): broken pipe'))
    await vi.waitFor(async () => {
      const [status] = await instance.remoteStatus()
      expect(mustGet(status, 'status').phase).toBe('error')
    })
    const [status] = await instance.remoteStatus()
    expect(mustGet(status, 'status').error).toContain('broken pipe')
  })

  it('keeps disconnect quiet while idle and exposes config defaults', async () => {
    const instance = new SshRemoteController(ctx, { sshConfigPath: join(dir, 'config'), stateDir: dir }, healthyRunner(fakeTunnel()))
    await expect(instance.remoteTargets()).resolves.toHaveLength(1)
  })

  it('applies production defaults and the default runner when nothing is configured', async () => {
    const instance = new SshRemoteController(ctx, {})
    // Default sshConfigPath resolves to the operator's ~/.ssh/config; a
    // missing file lists no targets without touching ssh.
    await expect(instance.remoteStatus()).resolves.toEqual([])
    await expect(instance.remoteTargets()).resolves.toBeInstanceOf(Array)
  })

  it('accepts a fully specified config', async () => {
    const instance = new SshRemoteController(ctx, {
      sshConfigPath: join(dir, 'config'),
      remoteRoot: '.custom',
      minimumNodeMajor: 20,
      nodeInstallVersion: '20.0.0',
      commandTimeoutMs: 5000,
      launchTimeoutMs: 9000,
      stateDir: dir,
    }, healthyRunner(fakeTunnel()), () => Promise.resolve(), PACKAGER)
    const [target] = await instance.remoteTargets()
    const result = await instance.remoteEnsure({ targetId: mustGet(target, 'target').id }, new AbortController().signal)
    expect(result.backendUrl).toContain('token=tok123')
  })

  it('reuses the existing entry when ensure is retried after a failure', async () => {
    let calls = 0
    const runner: SshRunner = {
      run: () => {
        calls += 1
        return Promise.resolve({ code: 255, stdout: '', stderr: 'Connection refused' })
      },
      upload: () => Promise.resolve(),
      startTunnel: () => fakeTunnel(),
    }
    const instance = new SshRemoteController(ctx, { sshConfigPath: join(dir, 'config'), stateDir: dir }, runner)
    const target = mustGet((await instance.remoteTargets())[0], 'target')
    const signal = new AbortController().signal
    await expect(instance.remoteEnsure({ targetId: target.id }, signal)).rejects.toThrow()
    await expect(instance.remoteEnsure({ targetId: target.id }, signal)).rejects.toThrow()
    expect(calls).toBeGreaterThan(2)
  })

  it('ignores a tunnel death that arrives before the backend is ready', async () => {
    let failTunnel!: (error: Error) => void
    const tunnel: SshSpawnedProcess = {
      exited: new Promise<number | null>((_resolve, reject) => { failTunnel = reject }),
      kill: vi.fn((): void => {}),
    }
    let releaseProbe!: () => void
    const instance = new SshRemoteController(
      ctx,
      { sshConfigPath: join(dir, 'config'), stateDir: dir },
      healthyRunner(tunnel),
      () => new Promise<void>((resolve) => { releaseProbe = resolve }),
      PACKAGER,
    )
    const target = mustGet((await instance.remoteTargets())[0], 'target')
    const ensuring = instance.remoteEnsure({ targetId: target.id }, new AbortController().signal)
    await vi.waitFor(() => {
      if (releaseProbe === undefined) throw new Error('probe not invoked yet')
    })
    failTunnel(new Error('early death'))
    releaseProbe()
    await expect(ensuring).resolves.toBeDefined()
    const [status] = await instance.remoteStatus()
    expect(mustGet(status, 'status').phase).toBe('ready')
  })

  it('formats non-Error provisioning failures with String()', async () => {
    const runner: SshRunner = {
      // Foreign non-Error rejections are the scenario under test.
      run: () => Promise.reject('plain string failure'), // oxlint-disable-line typescript/prefer-promise-reject-errors
      upload: () => Promise.resolve(),
      startTunnel: () => fakeTunnel(),
    }
    const instance = new SshRemoteController(ctx, { sshConfigPath: join(dir, 'config'), stateDir: dir }, runner)
    const target = mustGet((await instance.remoteTargets())[0], 'target')
    await expect(instance.remoteEnsure({ targetId: target.id }, new AbortController().signal)).rejects.toBe('plain string failure')
    const [status] = await instance.remoteStatus()
    expect(mustGet(status, 'status').error).toBe('plain string failure')
  })

  it('kills every tunnel when the plugin fiber disposes', async () => {
    const tunnel = fakeTunnel()
    const runner = healthyRunner(tunnel)
    const config = { sshConfigPath: join(dir, 'config'), stateDir: dir }
    let controller!: SshRemoteController
    const fiber = await ctx.plugin({
      inject: [],
      apply(innerCtx: Context) {
        controller = new SshRemoteController(innerCtx, config, runner, () => Promise.resolve(), PACKAGER)
      },
    })
    const target = mustGet((await controller.remoteTargets())[0], 'target')
    await controller.remoteEnsure({ targetId: target.id }, new AbortController().signal)
    await fiber.dispose()
    expect(tunnel.kill).toHaveBeenCalled()
  })
})
