/**
 * Thin wrapper over the system `ssh`/`scp` binaries. Using the system tools
 * keeps `~/.ssh/config`, ssh-agent, and key handling entirely with OpenSSH —
 * the plugin never touches credentials. `BatchMode=yes` makes any interactive
 * prompt (password, host-key confirmation failure) a loud error instead of a
 * hang. Control sockets multiplex repeated connections to one target.
 *
 * The {@link SshRunner} interface is the test seam: unit tests substitute a
 * scripted runner and never spawn a process.
 *
 * @module
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Process-spawning seam; production passes node's `spawn`. */
export type SshSpawn = typeof spawn

/** Outcome of one finished remote command. */
export interface SshRunResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/** Process handle for a long-running ssh invocation (a tunnel). */
export interface SshSpawnedProcess {
  /** Rejects when the process exits; resolves only for a clean intentional stop. */
  readonly exited: Promise<number | null>
  /** Terminate the process and settle {@link SshSpawnedProcess.exited}. */
  kill(): void
}

/**
 * Execution seam for ssh operations. The default implementation spawns the
 * system binaries; tests substitute a scripted fake.
 */
export interface SshRunner {
  /**
   * Run a remote shell script over stdin and collect its output.
   * @param alias - ssh `Host` alias naming config, user, and keys.
   * @param script - shell script fed to `bash -s` on the remote.
   * @param timeoutMs - hard deadline; expiry kills the ssh process and rejects.
   * @returns exit code and captured streams.
   */
  run(alias: string, script: string, timeoutMs: number): Promise<SshRunResult>
  /**
   * Upload one local file to a remote path with `scp`.
   * @param alias - ssh `Host` alias.
   * @param localPath - local source file.
   * @param remotePath - remote destination path.
   * @param timeoutMs - hard deadline for the transfer.
   */
  upload(alias: string, localPath: string, remotePath: string, timeoutMs: number): Promise<void>
  /**
   * Start a local port forward and keep it open until killed.
   * @param alias - ssh `Host` alias.
   * @param localPort - loopback port on this machine.
   * @param remotePort - loopback port on the remote machine.
   * @returns the tunnel process handle.
   */
  startTunnel(alias: string, localPort: number, remotePort: number): SshSpawnedProcess
}

/** Options shared by ssh invocations; BatchMode and connection sharing. */
function baseSshArgs(controlDir: string): string[] {
  return [
    '-o', 'BatchMode=yes',
    '-o', 'ControlMaster=auto',
    '-o', `ControlPath=${join(controlDir, '%r@%h:%p')}`,
    '-o', 'ControlPersist=600',
    '-o', 'StrictHostKeyChecking=accept-new',
  ]
}

function spawnCollect(
  spawnImpl: SshSpawn,
  command: string,
  args: string[],
  input: string | undefined,
  timeoutMs: number,
): Promise<SshRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`ssh command timed out after ${timeoutMs}ms: ${command} ${args.join(' ')}`))
    }, timeoutMs)
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr })
    })
    if (input !== undefined) {
      child.stdin.write(input)
    }
    child.stdin.end()
  })
}

/** Process uid for per-user state directories; 0 on platforms without getuid. */
export function localUid(): number {
  const getuid = process.getuid
  /* v8 ignore next 2 -- Windows has no process.getuid. */
  if (getuid === undefined) return 0
  return getuid.call(process)
}

/**
 * Create the production runner spawning system `ssh`/`scp`.
 * @param controlDir - directory for ControlMaster sockets; created on demand.
 * @param spawnImpl - process-spawning seam, substituted by tests.
 * @returns the runner.
 */
export function createSystemSshRunner(
  controlDir: string = join(tmpdir(), `dsh-ssh-${localUid()}`),
  spawnImpl: SshSpawn = spawn,
): SshRunner {
  const ready = mkdir(controlDir, { recursive: true, mode: 0o700 })
  return {
    async run(alias, script, timeoutMs) {
      await ready
      const result = await spawnCollect(
        spawnImpl,
        'ssh',
        [...baseSshArgs(controlDir), alias, 'bash', '-s'],
        script,
        timeoutMs,
      )
      return result
    },
    async upload(alias, localPath, remotePath, timeoutMs) {
      await ready
      const result = await spawnCollect(
        spawnImpl,
        'scp',
        [...baseSshArgs(controlDir), localPath, `${alias}:${remotePath}`],
        undefined,
        timeoutMs,
      )
      if (result.code !== 0) {
        throw new Error(`scp to ${alias} failed (${result.code}): ${result.stderr.trim()}`)
      }
    },
    startTunnel(alias, localPort, remotePort) {
      const child: ChildProcess = spawnImpl('ssh', [
        ...['-N', '-T'],
        '-o', 'BatchMode=yes',
        '-o', 'ExitOnForwardFailure=yes',
        '-o', 'ServerAliveInterval=15',
        '-o', 'ServerAliveCountMax=3',
        '-L', `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
        alias,
      ], { stdio: ['ignore', 'ignore', 'pipe'] })
      let stderr = ''
      child.stderr?.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
      let intentional = false
      const exited = new Promise<number | null>((resolve, reject) => {
        child.on('error', reject)
        child.on('close', (code) => {
          if (intentional || code === 0) resolve(code)
          else reject(new Error(`ssh tunnel to ${alias} exited (${code}): ${stderr.trim()}`))
        })
      })
      return {
        exited,
        kill() {
          intentional = true
          child.kill('SIGTERM')
        },
      }
    },
  }
}
