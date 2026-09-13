import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSystemSshRunner } from '../src/ssh.ts'

/** A ChildProcess stand-in whose lifecycle the test drives explicitly. */
function makeFakeChild(): {
  child: ChildProcess
  finish(stdout: string, stderr: string, code: number | null): void
  fail(error: Error): void
} {
  const emitter = new EventEmitter()
  const child = Object.assign(emitter, {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    kill: () => true,
  }) as unknown as ChildProcess
  // Lifecycle emissions may arrive before the runner's mkdir-await lets it
  // attach listeners; hold each one until its listener exists.
  const pendings = new Map<string, unknown[][]>()
  emitter.on('newListener', (event: string) => {
    const held = pendings.get(event)
    if (held === undefined) return
    pendings.delete(event)
    for (const args of held) queueMicrotask(() => { emitter.emit(event, ...args) })
  })
  const emit = (event: string, ...args: unknown[]): void => {
    if (emitter.listenerCount(event) > 0) queueMicrotask(() => { emitter.emit(event, ...args) })
    else {
      const held = pendings.get(event) ?? []
      held.push(args)
      pendings.set(event, held)
    }
  }
  return {
    child,
    finish(stdout, stderr, code) {
      ;(child.stdout as PassThrough).end(stdout)
      ;(child.stderr as PassThrough).end(stderr)
      emit('close', code)
    },
    fail(error) {
      emit('error', error)
    },
  }
}

describe('createSystemSshRunner process edges', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-ssh-proc-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  function runnerOn(child: ChildProcess): ReturnType<typeof createSystemSshRunner> {
    return createSystemSshRunner(dir, (() => child) as unknown as typeof import('node:child_process').spawn)
  }

  it('rejects with a timeout diagnostic when the process never settles', async () => {
    const fake = makeFakeChild()
    const runner = runnerOn(fake.child)
    await expect(runner.run('dev-box', 'sleep 60', 50)).rejects.toThrow('timed out after 50ms')
  })

  it('rejects when the process itself errors', async () => {
    const fake = makeFakeChild()
    const runner = runnerOn(fake.child)
    const running = runner.run('dev-box', 'true', 5000)
    fake.fail(new Error('spawn ssh ENOENT'))
    await expect(running).rejects.toThrow('spawn ssh ENOENT')
  })

  it('maps a signal exit (null code) to -1', async () => {
    const fake = makeFakeChild()
    const runner = runnerOn(fake.child)
    const running = runner.run('dev-box', 'true', 5000)
    fake.finish('', '', null)
    await expect(running).resolves.toEqual({ code: -1, stdout: '', stderr: '' })
  })

  it('uploads successfully when scp exits zero', async () => {
    const fake = makeFakeChild()
    const runner = runnerOn(fake.child)
    const uploading = runner.upload('dev-box', '/tmp/a.tgz', '.dsh-ssh/tmp/a.tgz', 5000)
    fake.finish('', '', 0)
    await expect(uploading).resolves.toBeUndefined()
  })

  it('rejects a tunnel that dies on its own with its stderr', async () => {
    const fake = makeFakeChild()
    const runner = runnerOn(fake.child)
    const tunnel = runner.startTunnel('dev-box', 5001, 4100)
    fake.finish('', 'channel open failed', 255)
    await expect(tunnel.exited).rejects.toThrow('channel open failed')
  })

  it('resolves a tunnel killed before its non-zero exit', async () => {
    const fake = makeFakeChild()
    const runner = runnerOn(fake.child)
    const tunnel = runner.startTunnel('dev-box', 5001, 4100)
    tunnel.kill()
    fake.finish('', 'terminated', 1)
    await expect(tunnel.exited).resolves.toBe(1)
  })

  it('resolves a tunnel that exits cleanly without an explicit kill', async () => {
    const fake = makeFakeChild()
    const runner = runnerOn(fake.child)
    const tunnel = runner.startTunnel('dev-box', 5001, 4100)
    fake.finish('', '', 0)
    await expect(tunnel.exited).resolves.toBe(0)
  })
})
