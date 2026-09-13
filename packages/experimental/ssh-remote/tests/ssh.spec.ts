import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSystemSshRunner } from '../src/ssh.ts'

interface FakeChild {
  child: ChildProcess
  finish(code: number): void
  stdinText(): Promise<string>
}

/** A ChildProcess stand-in: streams for stdio, EventEmitter for lifecycle. */
function makeFakeChild(stdout: string, stderr: string, exitCode: number): FakeChild & { argvSeen: string[] } {
  const emitter = new EventEmitter()
  const inStream = new PassThrough()
  const outStream = new PassThrough()
  const errStream = new PassThrough()
  const stdinChunks: Buffer[] = []
  inStream.on('data', chunk => stdinChunks.push(chunk as Buffer))
  const child = Object.assign(emitter, {
    stdout: outStream,
    stderr: errStream,
    stdin: inStream,
    kill: () => true,
  }) as unknown as ChildProcess
  const finished = new Promise<string>((resolve) => {
    inStream.on('end', () => resolve(Buffer.concat(stdinChunks).toString('utf8')))
  })
  queueMicrotask(() => {
    outStream.end(stdout)
    errStream.end(stderr)
    emitter.emit('close', exitCode)
  })
  return {
    child,
    argvSeen: [],
    finish: () => {},
    stdinText: () => finished,
  }
}

describe('createSystemSshRunner', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-ssh-runner-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  function spawnReturning(fake: FakeChild, argvLog: string[][]): typeof import('node:child_process').spawn {
    return ((command: string, args: readonly string[]) => {
      argvLog.push([command, ...args])
      return fake.child
    }) as unknown as typeof import('node:child_process').spawn
  }

  it('runs a remote script over ssh stdin with BatchMode and control sharing', async () => {
    const fake = makeFakeChild('out', '', 0)
    const argvLog: string[][] = []
    const runner = createSystemSshRunner(dir, spawnReturning(fake, argvLog))
    const result = await runner.run('dev-box', 'echo hi', 5000)
    expect(result).toEqual({ code: 0, stdout: 'out', stderr: '' })
    const [argv] = argvLog
    expect(argv[0]).toBe('ssh')
    expect(argv.join(' ')).toContain('BatchMode=yes')
    expect(argv.join(' ')).toContain('ControlMaster=auto')
    expect(argv.slice(-3)).toEqual(['dev-box', 'bash', '-s'])
    await expect(fake.stdinText()).resolves.toBe('echo hi')
  })

  it('fails upload loudly with the scp stderr', async () => {
    const fake = makeFakeChild('', 'Permission denied', 1)
    const argvLog: string[][] = []
    const runner = createSystemSshRunner(dir, spawnReturning(fake, argvLog))
    await expect(runner.upload('dev-box', '/tmp/a.tgz', '.dsh-ssh/tmp/a.tgz', 5000))
      .rejects.toThrow('Permission denied')
    expect(argvLog[0][0]).toBe('scp')
    expect(argvLog[0].slice(-2)).toEqual(['/tmp/a.tgz', 'dev-box:.dsh-ssh/tmp/a.tgz'])
  })

  it('starts a tunnel with the forward mapping and resolves a clean kill', async () => {
    const fake = makeFakeChild('', '', 0)
    const argvLog: string[][] = []
    const runner = createSystemSshRunner(dir, spawnReturning(fake, argvLog))
    const tunnel = runner.startTunnel('dev-box', 5001, 4100)
    const [argv] = argvLog
    expect(argv).toContain('-N')
    expect(argv).toContain('ExitOnForwardFailure=yes')
    expect(argv.join(' ')).toContain('127.0.0.1:5001:127.0.0.1:4100')
    tunnel.kill()
    await expect(tunnel.exited).resolves.toBe(0)
  })
})
