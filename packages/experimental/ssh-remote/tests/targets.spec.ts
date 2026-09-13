import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { listSshTargets, parseSshConfig } from '../src/targets.ts'

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
    expect(targets[0]).toMatchObject({ alias: 'dev-box', hostName: '10.0.0.8', user: 'deploy', port: 2222 })
    expect(targets[0].id).toContain('#dev-box')
    expect(targets[1]).toMatchObject({ alias: 'bastion', hostName: 'bastion.example.com' })
    expect(targets[1].user).toBeUndefined()
    expect(targets[1].port).toBeUndefined()
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
    expect(targets[0]).toMatchObject({ user: 'first', hostName: 'a.example' })
  })

  it('supports keyword=value syntax and strips comments', () => {
    const targets = parseSshConfig(`
# a comment line
Host=equals-host   # trailing comment
  HostName=eq.example
  User=eq
`)
    expect(targets).toHaveLength(1)
    expect(targets[0]).toMatchObject({ alias: 'equals-host', hostName: 'eq.example', user: 'eq' })
  })

  it('drops invalid ports but keeps the target', () => {
    const targets = parseSshConfig(`
Host bad-port
  Port not-a-number
Host high-port
  Port 99999
`)
    expect(targets).toHaveLength(2)
    expect(targets[0].port).toBeUndefined()
    expect(targets[1].port).toBeUndefined()
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

  it('reads targets from the given config path', async () => {
    const configPath = join(dir, 'config')
    await writeFile(configPath, 'Host box\n  HostName box.example\n')
    const targets = await listSshTargets(configPath)
    expect(targets.map(target => target.alias)).toEqual(['box'])
  })
})
