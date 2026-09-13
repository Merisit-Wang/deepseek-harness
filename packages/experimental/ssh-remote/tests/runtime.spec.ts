import { describe, expect, it } from 'vitest'
import { ensureRemoteBackend, DEFAULT_RUNTIME_OPTIONS, type ProvisioningPhase, type RuntimePackager } from '../src/runtime.ts'
import type { SshRunner, SshRunResult, SshSpawnedProcess } from '../src/ssh.ts'

const OPTIONS = { ...DEFAULT_RUNTIME_OPTIONS, launchTimeoutMs: 5000 }
const ALIAS = 'dev-box'

function ok(stdout: string): SshRunResult {
  return { code: 0, stdout, stderr: '' }
}

/** A runner answering scripts by ordered regex handlers and recording everything. */
class ScriptedRunner implements SshRunner {
  readonly scripts: string[] = []
  readonly uploads: Array<{ localPath: string; remotePath: string }> = []
  constructor(private readonly handlers: Array<[RegExp, SshRunResult]>) {}
  run(_alias: string, script: string): Promise<SshRunResult> {
    this.scripts.push(script)
    for (const [pattern, result] of this.handlers) {
      if (pattern.test(script)) return Promise.resolve(result)
    }
    return Promise.resolve(ok(''))
  }
  upload(_alias: string, localPath: string, remotePath: string): Promise<void> {
    this.uploads.push({ localPath, remotePath })
    return Promise.resolve()
  }
  startTunnel(): SshSpawnedProcess {
    throw new Error('runtime provisioning never starts tunnels')
  }
}

const PACKAGER: RuntimePackager = {
  version: () => Promise.resolve('1.2.3'),
  pack: workDir => Promise.resolve(`${workDir}/dsh-runtime-1.2.3.tar.gz`),
}

const READY_PID: [RegExp, SshRunResult] = [/kill -0/, ok('alive')]
const READY_URL: [RegExp, SshRunResult] = [/grep -m1/, ok('dsh web: http://127.0.0.1:4100/?token=tok123')]

describe('ensureRemoteBackend', () => {
  it('reuses a healthy node, matching dsh, and live backend', async () => {
    const runner = new ScriptedRunner([
      [/node -v/, ok('v22.20.0')],
      [/dsh" --version/, ok('1.2.3')],
      READY_PID,
      READY_URL,
    ])
    const phases: ProvisioningPhase[] = []
    const info = await ensureRemoteBackend(runner, ALIAS, '/tmp/work', OPTIONS, PACKAGER, phase => phases.push(phase))
    expect(info).toEqual({ remotePort: 4100, token: 'tok123', version: '1.2.3' })
    expect(runner.uploads).toEqual([])
    expect(phases).toEqual(['checking', 'starting'])
  })

  it('installs node when the remote has none and uses its PATH prefix afterwards', async () => {
    const runner = new ScriptedRunner([
      [/^command -v node/, ok('')],
      [/node\/bin\/node" -v/, ok('')],
      [/uname -s/, ok('Linux x86_64')],
      [/dsh" --version/, ok('1.2.3')],
      READY_PID,
      READY_URL,
    ])
    const phases: ProvisioningPhase[] = []
    await ensureRemoteBackend(runner, ALIAS, '/tmp/work', OPTIONS, PACKAGER, phase => phases.push(phase))
    const installScript = runner.scripts.find(script => script.includes('nodejs.org'))
    expect(installScript).toBeDefined()
    expect(installScript).toContain('node-v22.20.0-linux-x64.tar.gz')
    const dshCheck = runner.scripts.find(script => script.includes('dsh" --version'))
    expect(dshCheck).toContain('.dsh-ssh/node/bin:')
    expect(phases).toContain('installing-node')
  })

  it('uploads and installs the runtime when the remote version differs', async () => {
    const runner = new ScriptedRunner([
      [/node -v/, ok('v22.20.0')],
      [/dsh" --version/, ok('1.0.0')],
      READY_PID,
      READY_URL,
    ])
    const phases: ProvisioningPhase[] = []
    const info = await ensureRemoteBackend(runner, ALIAS, '/tmp/work', OPTIONS, PACKAGER, phase => phases.push(phase))
    expect(info.version).toBe('1.2.3')
    expect(runner.uploads).toEqual([
      { localPath: '/tmp/work/dsh-runtime-1.2.3.tar.gz', remotePath: '.dsh-ssh/tmp/dsh-runtime-1.2.3.tar.gz' },
    ])
    expect(runner.scripts.some(script => script.includes('runtime.new'))).toBe(true)
    expect(phases).toContain('installing-dsh')
  })

  it('launches the backend when no live pid exists and parses its URL line', async () => {
    const runner = new ScriptedRunner([
      [/node -v/, ok('v22.20.0')],
      [/dsh" --version/, ok('1.2.3')],
      [/kill -0/, ok('')],
      [/grep -m1/, ok('dsh web: http://127.0.0.1:4300/?token=tok999')],
    ])
    const info = await ensureRemoteBackend(runner, ALIAS, '/tmp/work', OPTIONS, PACKAGER)
    expect(info).toEqual({ remotePort: 4300, token: 'tok999', version: '1.2.3' })
    expect(runner.scripts.some(script => script.includes('nohup') && script.includes('--port 0 --no-open'))).toBe(true)
  })

  it('fails loud on an unsupported remote platform during node install', async () => {
    const runner = new ScriptedRunner([
      [/^command -v node/, ok('')],
      [/node\/bin\/node" -v/, ok('')],
      [/uname -s/, ok('SunOS sun4u')],
    ])
    await expect(ensureRemoteBackend(runner, ALIAS, '/tmp/work', OPTIONS, PACKAGER))
      .rejects.toThrow('unsupported platform')
  })

  it('fails loud when the startup line carries no launch token', async () => {
    const runner = new ScriptedRunner([
      [/node -v/, ok('v22.20.0')],
      [/dsh" --version/, ok('1.2.3')],
      READY_PID,
      [/grep -m1/, ok('dsh web: http://127.0.0.1:4100/')],
    ])
    await expect(ensureRemoteBackend(runner, ALIAS, '/tmp/work', OPTIONS, PACKAGER))
      .rejects.toThrow('no launch token')
  })

  it('fails loud when a remote script exits non-zero', async () => {
    const runner = new ScriptedRunner([
      [/node -v/, ok('v22.20.0')],
      [/dsh" --version/, ok('1.0.0')],
      [/mkdir -p ".dsh-ssh\/tmp"/, { code: 1, stdout: '', stderr: 'permission denied' }],
    ])
    await expect(ensureRemoteBackend(runner, ALIAS, '/tmp/work', OPTIONS, PACKAGER))
      .rejects.toThrow('permission denied')
  })
})
