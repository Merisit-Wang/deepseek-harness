import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SshRemoteController } from '../src/index.ts'
import type { SshRunner, SshRunResult, SshSpawnedProcess } from '../src/ssh.ts'

function ok(stdout: string): SshRunResult {
  return { code: 0, stdout, stderr: '' }
}

function fakeTunnel(): SshSpawnedProcess & { kill: ReturnType<typeof vi.fn> } {
  return {
    exited: new Promise<number | null>(() => {}),
    kill: vi.fn(),
  }
}

/** Runner whose scripts all succeed with canned answers for the healthy path. */
function healthyRunner(tunnel: SshSpawnedProcess): SshRunner & { scripts: string[] } {
  const scripts: string[] = []
  return {
    scripts,
    run(_alias: string, script: string) {
      scripts.push(script)
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

describe('SshRemoteController', () => {
  let dir: string
  let ctx: Context
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-ssh-controller-'))
    ctx = new Context()
  })
  afterEach(async () => {
    await ctx.scope?.dispose?.().catch(() => {})
    await rm(dir, { recursive: true, force: true })
  })

  async function writeConfig(text: string): Promise<string> {
    const configPath = join(dir, 'config')
    await writeFile(configPath, text)
    return configPath
  }

  it('lists discovered targets over the Remote method', async () => {
    const configPath = await writeConfig('Host dev-box\n  HostName 10.0.0.8\n')
    const controller = new SshRemoteController(ctx, { sshConfigPath: configPath, stateDir: dir }, healthyRunner(fakeTunnel()))
    const targets = await controller.remoteTargets()
    expect(targets.map(target => target.alias)).toEqual(['dev-box'])
  })

  it('ensures a backend end to end and short-circuits a second ensure', async () => {
    const configPath = await writeConfig('Host dev-box\n  HostName 10.0.0.8\n')
    const tunnel = fakeTunnel()
    const runner = healthyRunner(tunnel)
    const controller = new SshRemoteController(
      ctx,
      { sshConfigPath: configPath, stateDir: dir },
      runner,
      () => Promise.resolve(),
    )
    await controller.remoteTargets()
    const target = (await controller.remoteTargets())[0]
    const result = await controller.remoteEnsure({ targetId: target.id }, new AbortController().signal)
    expect(result.backendUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?token=tok123$/)
    const status = await controller.remoteStatus()
    expect(status).toEqual([{ targetId: target.id, phase: 'ready', backendUrl: result.backendUrl }])
    const scriptsBefore = runner.scripts.length
    const again = await controller.remoteEnsure({ targetId: target.id }, new AbortController().signal)
    expect(again).toEqual(result)
    expect(runner.scripts.length).toBe(scriptsBefore)
  })

  it('marks the target errored when provisioning fails', async () => {
    const configPath = await writeConfig('Host dev-box\n')
    const runner: SshRunner = {
      run: () => Promise.resolve({ code: 255, stdout: '', stderr: 'Connection refused' }),
      upload: () => Promise.resolve(),
      startTunnel: () => fakeTunnel(),
    }
    const controller = new SshRemoteController(ctx, { sshConfigPath: configPath, stateDir: dir }, runner)
    const [target] = await controller.remoteTargets()
    await expect(controller.remoteEnsure({ targetId: target.id }, new AbortController().signal))
      .rejects.toThrow()
    const [status] = await controller.remoteStatus()
    expect(status.phase).toBe('error')
    expect(status.error).toContain('Connection refused')
  })

  it('rejects an unknown target id', async () => {
    const configPath = await writeConfig('Host dev-box\n')
    const controller = new SshRemoteController(ctx, { sshConfigPath: configPath, stateDir: dir }, healthyRunner(fakeTunnel()))
    await controller.remoteTargets()
    await expect(controller.remoteEnsure({ targetId: 'nope' as never }, new AbortController().signal))
      .rejects.toThrow('unknown SSH target')
  })

  it('kills the tunnel on disconnect', async () => {
    const configPath = await writeConfig('Host dev-box\n')
    const tunnel = fakeTunnel()
    const controller = new SshRemoteController(
      ctx,
      { sshConfigPath: configPath, stateDir: dir },
      healthyRunner(tunnel),
      () => Promise.resolve(),
    )
    const [target] = await controller.remoteTargets()
    await controller.remoteEnsure({ targetId: target.id }, new AbortController().signal)
    await controller.remoteDisconnect({ targetId: target.id })
    expect(tunnel.kill).toHaveBeenCalledOnce()
    const [status] = await controller.remoteStatus()
    expect(status.phase).toBe('idle')
  })
})
