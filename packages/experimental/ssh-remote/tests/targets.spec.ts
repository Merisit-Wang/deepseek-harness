import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { listSshTargets, parseSshConfig } from '../src/targets.ts'

/** Narrow a possibly-undefined value under noUncheckedIndexedAccess. */
function mustGet<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`expected ${what} to be defined`)
  return value
}

describe('parseSshConfig', () => {
  it('parses concrete Host blocks with their fields', () => {
    const targets = parseSshConfig(`
Host dev-box
  HostName 10.0.0.8
  User deploy
  Port 2222

Host bastion
  HostName bastion.example.com
`)
    expect(targets).toHaveLength(2)
    const first = mustGet(targets[0], 'target')
    const second = mustGet(targets[1], 'target')
    expect(first).toMatchObject({ alias: 'dev-box', hostName: '10.0.0.8', user: 'deploy', port: 2222 })
    expect(first.id).toContain('#dev-box')
    expect(second).toMatchObject({ alias: 'bastion', hostName: 'bastion.example.com' })
    expect(second.user).toBeUndefined()
    expect(second.port).toBeUndefined()
  })

  it('skips wildcard and multi-pattern Host blocks', () => {
    const targets = parseSshConfig(`
Host *
  ServerAliveInterval 30

Host *.internal
  User ops

Host dev prod staging
  User batch

Host one
  HostName 1.2.3.4
`)
    expect(targets.map(target => target.alias)).toEqual(['one'])
  })

  it('keeps the first value per keyword, matching OpenSSH semantics', () => {
    const targets = parseSshConfig(`
Host dup
  User first
  User second
  HostName a.example
  HostName b.example
`)
    expect(mustGet(targets[0], 'target')).toMatchObject({ user: 'first', hostName: 'a.example' })
  })

  it('supports keyword=value syntax and strips comments', () => {
    const targets = parseSshConfig(`
# a comment line
Host=equals-host   # trailing comment
  HostName=eq.example
  User=eq
`)
    expect(targets).toHaveLength(1)
    expect(mustGet(targets[0], 'target')).toMatchObject({ alias: 'equals-host', hostName: 'eq.example', user: 'eq' })
  })

  it('drops invalid ports but keeps the target', () => {
    const targets = parseSshConfig(`
Host bad-port
  Port not-a-number
Host high-port
  Port 99999
`)
    expect(targets).toHaveLength(2)
    expect(mustGet(targets[0], 'target').port).toBeUndefined()
    expect(mustGet(targets[1], 'target').port).toBeUndefined()
  })
  it('ignores bare words and valueless Host lines without failing', () => {
    const targets = parseSshConfig(`
JustAWord
Host=
Host box
`)
    expect(targets.map(target => target.alias)).toEqual(['box'])
  })
})

describe('listSshTargets', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-ssh-targets-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('returns an empty list when the config file is absent', async () => {
    await expect(listSshTargets(join(dir, 'missing'))).resolves.toEqual([])
  })

  it('rethrows read failures other than a missing file', async () => {
    // A directory is not a readable config file: readFile fails with EISDIR.
    await expect(listSshTargets(dir)).rejects.toThrow()
  })

  it('reads targets from the given config path', async () => {
    const configPath = join(dir, 'config')
    await writeFile(configPath, 'Host box\n  HostName box.example\n')
    const targets = await listSshTargets(configPath)
    expect(targets.map(target => target.alias)).toEqual(['box'])
  })
})
