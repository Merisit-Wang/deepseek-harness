import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createTarRuntimePackager, ensureRemoteBackend, resolveLocalInstall, DEFAULT_RUNTIME_OPTIONS,
} from '../src/runtime.ts'
import type { SshRunner, SshRunResult, SshSpawnedProcess } from '../src/ssh.ts'

function ok(stdout: string): SshRunResult {
  return { code: 0, stdout, stderr: '' }
}

describe('resolveLocalInstall', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-ssh-install-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  async function plantCli(nodeModules: string, manifest: object): Promise<string> {
    const pkgDir = join(nodeModules, '@deepseek-ai', 'dsh')
    await mkdir(pkgDir, { recursive: true })
    await writeFile(join(pkgDir, 'package.json'), JSON.stringify(manifest))
    return pkgDir
  }

  it('resolves a node_modules install to the tree root and version', async () => {
    const pkgDir = await plantCli(join(dir, 'node_modules'), { name: '@deepseek-ai/dsh', version: '0.1.5', bin: { dsh: 'bin/dsh.js' } })
    await expect(resolveLocalInstall(pkgDir)).resolves.toEqual({ payloadRoot: join(dir, 'node_modules'), version: '0.1.5' })
  })

  it('fails loud when the CLI package does not live in node_modules', async () => {
    const pkgDir = join(dir, 'cli')
    await mkdir(pkgDir, { recursive: true })
    await writeFile(join(pkgDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.5', bin: { dsh: 'bin/dsh.js' } }))
    await expect(resolveLocalInstall(pkgDir)).rejects.toThrow('does not live in a node_modules tree')
  })

  it('fails loud when the CLI package has no version', async () => {
    const pkgDir = await plantCli(join(dir, 'node_modules'), { name: '@deepseek-ai/dsh', bin: { dsh: 'bin/dsh.js' } })
    await expect(resolveLocalInstall(pkgDir)).rejects.toThrow('has no version')
  })

  it('fails loud when no dsh CLI package exists above the start directory', async () => {
    await expect(resolveLocalInstall(dir)).rejects.toThrow('cannot locate the dsh CLI package')
  })

  it('walks up from a nested start directory', async () => {
    const pkgDir = await plantCli(join(dir, 'node_modules'), { name: '@deepseek-ai/dsh', version: '9.9.9', bin: { dsh: 'bin/dsh.js' } })
    const nested = join(pkgDir, 'lib', 'deep')
    await mkdir(nested, { recursive: true })
    await expect(resolveLocalInstall(nested)).resolves.toEqual({ payloadRoot: join(dir, 'node_modules'), version: '9.9.9' })
  })

  it('resolves an unscoped package directly inside node_modules', async () => {
    const pkgDir = join(dir, 'node_modules', 'dsh')
    await mkdir(pkgDir, { recursive: true })
    await writeFile(join(pkgDir, 'package.json'), JSON.stringify({ name: 'dsh', version: '1.0.0', bin: { dsh: 'bin/dsh.js' } }))
    await expect(resolveLocalInstall(pkgDir)).resolves.toEqual({ payloadRoot: join(dir, 'node_modules'), version: '1.0.0' })
  })

  it('rethrows manifest read failures that are not missing files', async () => {
    const pkgDir = await plantCli(join(dir, 'node_modules'), { name: '@deepseek-ai/dsh', version: '0.1.5', bin: { dsh: 'bin/dsh.js' } })
    await writeFile(join(pkgDir, 'package.json'), 'not json at all')
    await expect(resolveLocalInstall(pkgDir)).rejects.toThrow()
  })

  it('rejects a scoped package whose grandparent is not node_modules', async () => {
    const pkgDir = join(dir, 'elsewhere', '@deepseek-ai', 'dsh')
    await mkdir(pkgDir, { recursive: true })
    await writeFile(join(pkgDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.5', bin: { dsh: 'bin/dsh.js' } }))
    await expect(resolveLocalInstall(pkgDir)).rejects.toThrow('does not live in a node_modules tree')
  })

  it('stops the upward search at the depth cap and reports the miss', async () => {
    let nested = dir
    for (let depth = 0; depth < 14; depth += 1) {
      nested = join(nested, `d${depth}`)
    }
    await mkdir(nested, { recursive: true })
    await expect(resolveLocalInstall(nested)).rejects.toThrow('cannot locate the dsh CLI package')
  })
})

describe('createTarRuntimePackager', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-ssh-pack-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('reports the resolved version and packs a readable tarball', async () => {
    const pkgDir = join(dir, 'node_modules', '@deepseek-ai', 'dsh')
    await mkdir(join(pkgDir, 'bin'), { recursive: true })
    await writeFile(join(pkgDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.5', bin: { dsh: 'bin/dsh.js' } }))
    await writeFile(join(pkgDir, 'bin', 'dsh.js'), '#!/usr/bin/env node\n')
    const packager = createTarRuntimePackager(pkgDir)
    await expect(packager.version()).resolves.toBe('0.1.5')
    const tarball = await packager.pack(dir)
    expect(tarball).toBe(join(dir, 'dsh-runtime-0.1.5.tar.gz'))
    const { spawnSync } = await import('node:child_process')
    const listing = spawnSync('tar', ['-tzf', tarball], { encoding: 'utf8' })
    expect(listing.status).toBe(0)
    expect(listing.stdout).toContain('package.json')
  })

  it('rejects when tar cannot read the payload tree', async () => {
    const pkgDir = join(dir, 'node_modules', '@deepseek-ai', 'dsh')
    await mkdir(pkgDir, { recursive: true })
    await writeFile(join(pkgDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.5', bin: { dsh: 'bin/dsh.js' } }))
    const packager = createTarRuntimePackager(pkgDir)
    const { chmod } = await import('node:fs/promises')
    // Execute-only: known paths still resolve for readFile, but tar cannot
    // list the directory's entries and exits non-zero.
    await chmod(join(dir, 'node_modules'), 0o111)
    try {
      await expect(packager.pack(dir)).rejects.toThrow('tar failed')
    } finally {
      await chmod(join(dir, 'node_modules'), 0o755)
    }
  })
})

describe('ensureRemoteBackend startup deadline', () => {
  it('fails with the log tail when the backend never reports its URL', async () => {
    const scripts: string[] = []
    const runner: SshRunner = {
      run(_alias: string, script: string) {
        scripts.push(script)
        if (/^command -v node/.test(script)) return Promise.resolve(ok('v22.20.0\n'))
        if (/dsh" --version/.test(script)) return Promise.resolve(ok('1.2.3\n'))
        if (/tail -n 20/.test(script)) return Promise.resolve(ok('boom: stacktrace'))
        return Promise.resolve(ok(''))
      },
      upload: () => Promise.resolve(),
      startTunnel: (): SshSpawnedProcess => ({ exited: new Promise(() => {}), kill: () => {} }),
    }
    await expect(ensureRemoteBackend(
      runner,
      'dev-box',
      '/tmp/work',
      { ...DEFAULT_RUNTIME_OPTIONS, launchTimeoutMs: 250 },
      { version: () => Promise.resolve('1.2.3'), pack: workDir => Promise.resolve(`${workDir}/x.tgz`) },
    )).rejects.toThrow('boom: stacktrace')
  }, 15000)

  it('rejects an unparsable startup line', async () => {
    const runner: SshRunner = {
      run(_alias: string, script: string) {
        if (/^command -v node/.test(script)) return Promise.resolve(ok('v22.20.0\n'))
        if (/dsh" --version/.test(script)) return Promise.resolve(ok('1.2.3\n'))
        if (/kill -0/.test(script)) return Promise.resolve(ok('alive'))
        if (/grep -m1/.test(script)) return Promise.resolve(ok('dsh web: not-a-url'))
        return Promise.resolve(ok(''))
      },
      upload: () => Promise.resolve(),
      startTunnel: (): SshSpawnedProcess => ({ exited: new Promise(() => {}), kill: () => {} }),
    }
    await expect(ensureRemoteBackend(
      runner,
      'dev-box',
      '/tmp/work',
      DEFAULT_RUNTIME_OPTIONS,
      { version: () => Promise.resolve('1.2.3'), pack: workDir => Promise.resolve(`${workDir}/x.tgz`) },
    )).rejects.toThrow('unparsable remote startup line')
  })
})
