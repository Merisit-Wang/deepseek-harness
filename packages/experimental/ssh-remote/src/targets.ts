/**
 * Discovery of SSH connection targets from `~/.ssh/config`. The parser is a
 * pure function over file text; wildcard `Host` blocks (`*`/`?`) carry
 * defaults, not targets, and are skipped. First value wins per keyword,
 * matching OpenSSH semantics.
 *
 * @module
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SshTarget, SshTargetId } from './types.ts'

/** Default ssh config path, overridable in tests. */
export const DEFAULT_SSH_CONFIG_PATH = join(homedir(), '.ssh', 'config')

/**
 * Parse ssh config text into concrete connection targets.
 * @param text - raw `~/.ssh/config` content.
 * @param configPath - path used only for branded-id derivation.
 * @returns one target per non-wildcard `Host` block, in file order.
 */
export function parseSshConfig(text: string, configPath: string = DEFAULT_SSH_CONFIG_PATH): SshTarget[] {
  const targets: SshTarget[] = []
  let current: { alias: string; values: Map<string, string> } | undefined
  const flush = (): void => {
    if (current === undefined) return
    const id = brandString<SshTargetId>(`${configPath}#${current.alias}`)
    const portText = current.values.get('port')
    const port = portText === undefined ? undefined : Number(portText)
    const hostName = current.values.get('hostname')
    const user = current.values.get('user')
    targets.push({
      id,
      alias: current.alias,
      ...hostName !== undefined ? { hostName } : {},
      ...user !== undefined ? { user } : {},
      ...port !== undefined && Number.isInteger(port) && port > 0 && port <= 65535 ? { port } : {},
    })
    current = undefined
  }
  for (const rawLine of text.split('\n')) {
    // ssh config has no line continuations; strip comments and surrounding space.
    const line = rawLine.replace(/#.*$/, '').trim()
    if (line === '') continue
    const match = /^(\S+)\s+(.*)$/.exec(line) ?? /^(\S+)=(.*)$/.exec(line)
    if (match === null) continue
    /* v8 ignore start -- both patterns require \S+, so a successful match always has both groups. */
    const keyword = match[1]?.toLowerCase()
    if (keyword === undefined) continue
    const value = (match[2] ?? '').trim()
    /* v8 ignore stop */
    if (keyword === 'host') {
      flush()
      // A `Host` line may name several patterns; only a single concrete alias
      // becomes a target. Wildcard blocks restart accumulation with no target.
      const patterns = value.split(/\s+/).filter(pattern => pattern !== '')
      const first = patterns[0]
      const concrete = patterns.length === 1 && first !== undefined && !/[*?!]/.test(first) ? first : undefined
      current = concrete === undefined ? undefined : { alias: concrete, values: new Map() }
      continue
    }
    if (current === undefined) continue
    // First obtained value wins, per ssh_config(5).
    if (!current.values.has(keyword)) current.values.set(keyword, value)
  }
  flush()
  return targets
}

/**
 * Read the operator's ssh config and list concrete targets.
 * @param configPath - config file to read; a missing file means no targets.
 * @returns discovered targets in file order.
 */
export async function listSshTargets(configPath: string = DEFAULT_SSH_CONFIG_PATH): Promise<SshTarget[]> {
  let text: string
  try {
    text = await readFile(configPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  return parseSshConfig(text, configPath)
}
