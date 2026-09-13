/**
 * Remote runtime provisioning: detect or install Node.js and a matching dsh
 * build on the SSH target, then launch the remote `dsh web` backend and
 * learn its loopback port and launch token from its startup output.
 *
 * Every step runs as a remote bash script through {@link SshRunner}, and the
 * local runtime payload comes from {@link RuntimePackager}; both seams are
 * substituted in unit tests, so the flow needs neither sshd nor a real dsh
 * install to verify.
 *
 * @module
 */

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SshRunner } from './ssh.ts'

/** Facts about a ready remote backend process. */
export interface RemoteBackendInfo {
  /** Loopback port on the remote machine the backend listens on. */
  readonly remotePort: number
  /** Launch token minted by the remote backend for browser authentication. */
  readonly token: string
  /** dsh version running remotely, equal to the local one by construction. */
  readonly version: string
}

/** Provisioning knobs with production defaults. */
export interface RemoteRuntimeOptions {
  /** Remote home-relative directory holding node, runtime, logs, and pid files. */
  readonly remoteRoot: string
  /** Minimum acceptable Node.js major version on the remote. */
  readonly minimumNodeMajor: number
  /** Node.js version installed on the remote when absent or too old. */
  readonly nodeInstallVersion: string
  /** Hard deadline for one remote script, in milliseconds. */
  readonly commandTimeoutMs: number
  /** Deadline for the remote backend's startup line, in milliseconds. */
  readonly launchTimeoutMs: number
}

/** Production defaults; the controller's Config overrides each field. */
export const DEFAULT_RUNTIME_OPTIONS: RemoteRuntimeOptions = {
  remoteRoot: '.dsh-ssh',
  minimumNodeMajor: 22,
  nodeInstallVersion: '22.20.0',
  commandTimeoutMs: 30_000,
  launchTimeoutMs: 60_000,
}

/** Lifecycle phases the provisioning flow reports. */
export type ProvisioningPhase = 'checking' | 'installing-node' | 'installing-dsh' | 'starting'

/**
 * Local dsh runtime payload seam. The default packs the running CLI's
 * install tree with `tar`; tests substitute a fixture.
 */
export interface RuntimePackager {
  /**
   * The dsh version this packager ships, compared against the remote's.
   * @returns exact local dsh version string.
   */
  version(): Promise<string>
  /**
   * Produce the runtime tarball under `workDir`.
   * @param workDir - local scratch directory.
   * @returns the tarball path.
   */
  pack(workDir: string): Promise<string>
}

/** The startup line printed by `dsh web`; supervisors treat it as readiness. */
const WEB_URL_LINE = /^dsh web: (http:\/\/\S+)$/m

/** Run one remote script and fail loud on a non-zero exit. */
async function must(
  runner: SshRunner,
  alias: string,
  script: string,
  timeoutMs: number,
  what: string,
): Promise<string> {
  const result = await runner.run(alias, script, timeoutMs)
  if (result.code !== 0) {
    throw new Error(`${what} failed on ${alias} (${result.code}): ${result.stderr.trim() || result.stdout.trim()}`)
  }
  return result.stdout.trim()
}

/** Parse a `node -v` answer into a major version, or null when absent. */
function nodeMajorOf(text: string): number | null {
  const match = /^v?(\d+)\./.exec(text.trim())
  return match === null ? null : Number(match[1])
}

/**
 * Ensure a usable Node.js on the remote. A sufficient system node wins; a
 * previously provisioned one is reused; otherwise the official binary
 * tarball is downloaded on the remote into the remote root. The
 * `installing-node` phase fires only in the third case.
 * @returns the remote PATH prefix that makes node resolvable, empty for system node.
 */
async function ensureNode(
  runner: SshRunner,
  alias: string,
  options: RemoteRuntimeOptions,
  onPhase: (phase: ProvisioningPhase) => void,
): Promise<string> {
  const { remoteRoot, minimumNodeMajor, nodeInstallVersion, commandTimeoutMs } = options
  const existing = await runner.run(alias, 'command -v node >/dev/null 2>&1 && node -v || true', commandTimeoutMs)
  const major = nodeMajorOf(existing.stdout)
  if (major !== null && major >= minimumNodeMajor) return ''
  const provisioned = await runner.run(
    alias,
    `[ -x "${remoteRoot}/node/bin/node" ] && "${remoteRoot}/node/bin/node" -v || true`,
    commandTimeoutMs,
  )
  const provisionedMajor = nodeMajorOf(provisioned.stdout)
  if (provisionedMajor !== null && provisionedMajor >= minimumNodeMajor) {
    return `${remoteRoot}/node/bin:`
  }
  onPhase('installing-node')
  const platform = await must(
    runner,
    alias,
    'echo "$(uname -s) $(uname -m)"',
    commandTimeoutMs,
    'detecting the remote platform',
  )
  const [osName, machine] = platform.split(' ')
  const os = osName === 'Linux' ? 'linux' : osName === 'Darwin' ? 'darwin' : undefined
  const arch = machine === 'x86_64' || machine === 'amd64' ? 'x64'
    : machine === 'aarch64' || machine === 'arm64' ? 'arm64' : undefined
  if (os === undefined || arch === undefined) {
    throw new Error(`cannot auto-install Node.js on ${alias}: unsupported platform "${platform}"`)
  }
  const tarball = `node-v${nodeInstallVersion}-${os}-${arch}`
  await must(
    runner,
    alias,
    [
      `set -e`,
      `mkdir -p "${remoteRoot}/tmp"`,
      `cd "${remoteRoot}/tmp"`,
      `if command -v curl >/dev/null 2>&1; then curl -fsSLO "https://nodejs.org/dist/v${nodeInstallVersion}/${tarball}.tar.gz";`,
      `elif command -v wget >/dev/null 2>&1; then wget -q "https://nodejs.org/dist/v${nodeInstallVersion}/${tarball}.tar.gz";`,
      `else echo 'neither curl nor wget is available on the remote' >&2; exit 1; fi`,
      `rm -rf "${remoteRoot}/node" "${tarball}"`,
      `tar -xzf "${tarball}.tar.gz"`,
      `mv "${tarball}" "${remoteRoot}/node"`,
      `rm -f "${tarball}.tar.gz"`,
      `"${remoteRoot}/node/bin/node" -v`,
    ].join('\n'),
    Math.max(commandTimeoutMs, 300_000),
    'installing Node.js',
  )
  return `${remoteRoot}/node/bin:`
}

/** Local dsh install facts used to build the runtime tarball. */
interface LocalInstall {
  readonly payloadRoot: string
  readonly version: string
}

/**
 * Resolve the local dsh CLI install as a self-contained payload. When the
 * CLI package lives inside a `node_modules` tree, that whole tree is the
 * payload; a source checkout without one fails loud instead of shipping a
 * broken runtime.
 */
async function resolveLocalInstall(): Promise<LocalInstall> {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 12; depth += 1) {
    let manifest: { version?: string; bin?: Record<string, string> } | undefined
    try {
      manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (manifest?.bin !== undefined && Object.keys(manifest.bin).includes('dsh')) {
      const payloadRoot = dirname(dir).split('/').pop() === 'node_modules' ? dirname(dir) : dir
      if (payloadRoot === dir) {
        throw new Error(
          'cannot pack the dsh runtime: the CLI does not live in a node_modules tree. '
          + 'Install dsh from a package manager so the runtime payload is self-contained.',
        )
      }
      if (typeof manifest.version !== 'string') {
        throw new Error(`cannot pack the dsh runtime: ${join(dir, 'package.json')} has no version`)
      }
      return { payloadRoot, version: manifest.version }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error('cannot locate the dsh CLI package from this process; is dsh installed?')
}

/**
 * Create the production packager: tar the local CLI's install tree,
 * dereferencing symlinks so pnpm and global-link layouts become plain files.
 * @returns the packager.
 */
export function createTarRuntimePackager(): RuntimePackager {
  return {
    async version() {
      return (await resolveLocalInstall()).version
    },
    async pack(workDir) {
      const install = await resolveLocalInstall()
      const tarballPath = join(workDir, `dsh-runtime-${install.version}.tar.gz`)
      const { spawn } = await import('node:child_process')
      await new Promise<void>((resolve, reject) => {
        const child = spawn('tar', ['-chzf', tarballPath, '-C', install.payloadRoot, '.'], { stdio: ['ignore', 'ignore', 'pipe'] })
        let stderr = ''
        child.stderr?.setEncoding('utf8').on('data', chunk => { stderr += chunk })
        child.on('error', reject)
        child.on('close', code => code === 0 ? resolve() : reject(new Error(`tar failed (${code}): ${stderr.trim()}`)))
      })
      return tarballPath
    },
  }
}

/**
 * Ensure the remote runs a dsh build identical to the local one, packing and
 * uploading the local runtime when the remote is missing or on another
 * version.
 * @returns the version now installed remotely.
 */
async function ensureDsh(
  runner: SshRunner,
  alias: string,
  nodePathPrefix: string,
  workDir: string,
  options: RemoteRuntimeOptions,
  packager: RuntimePackager,
  onPhase: (phase: ProvisioningPhase) => void,
): Promise<string> {
  const { remoteRoot, commandTimeoutMs } = options
  const remoteVersion = await runner.run(
    alias,
    `export PATH="${nodePathPrefix}$PATH"; [ -x "${remoteRoot}/runtime/bin/dsh" ] && "${remoteRoot}/runtime/bin/dsh" --version 2>/dev/null || true`,
    commandTimeoutMs,
  )
  const localVersion = await packager.version()
  if (remoteVersion.stdout.trim() === localVersion) return localVersion
  onPhase('installing-dsh')
  const tarballPath = await packager.pack(workDir)
  const remoteTarball = `${remoteRoot}/tmp/dsh-runtime-${localVersion}.tar.gz`
  await must(runner, alias, `mkdir -p "${remoteRoot}/tmp"`, commandTimeoutMs, 'preparing the remote directory')
  await runner.upload(alias, tarballPath, remoteTarball, Math.max(commandTimeoutMs, 600_000))
  await must(
    runner,
    alias,
    [
      'set -e',
      `rm -rf "${remoteRoot}/runtime.new"`,
      `mkdir -p "${remoteRoot}/runtime.new"`,
      `tar -xzf "${remoteTarball}" -C "${remoteRoot}/runtime.new"`,
      `rm -rf "${remoteRoot}/runtime.old"`,
      `[ -d "${remoteRoot}/runtime" ] && mv "${remoteRoot}/runtime" "${remoteRoot}/runtime.old" || true`,
      `mv "${remoteRoot}/runtime.new" "${remoteRoot}/runtime"`,
      `rm -f "${remoteTarball}"`,
    ].join('\n'),
    Math.max(commandTimeoutMs, 300_000),
    'installing the dsh runtime',
  )
  return localVersion
}

/**
 * Ensure the remote backend process is running and return its connection
 * facts. A live prior launch with a reported URL is reused; otherwise a new
 * `dsh web` launches on the remote loopback with an OS-assigned port.
 */
async function ensureRunning(
  runner: SshRunner,
  alias: string,
  nodePathPrefix: string,
  options: RemoteRuntimeOptions,
): Promise<Omit<RemoteBackendInfo, 'version'>> {
  const { remoteRoot, commandTimeoutMs, launchTimeoutMs } = options
  const readUrl = `grep -m1 '^dsh web: ' "${remoteRoot}/run/web.log" 2>/dev/null || true`
  const existingPid = (await runner.run(
    alias,
    `[ -f "${remoteRoot}/run/web.pid" ] && kill -0 "$(cat "${remoteRoot}/run/web.pid")" 2>/dev/null && echo alive || true`,
    commandTimeoutMs,
  )).stdout.trim()
  let urlLine = ''
  if (existingPid === 'alive') {
    urlLine = (await runner.run(alias, readUrl, commandTimeoutMs)).stdout.trim()
  }
  if (urlLine === '') {
    await must(
      runner,
      alias,
      [
        'set -e',
        `mkdir -p "${remoteRoot}/run"`,
        `export PATH="${nodePathPrefix}$PATH"`,
        `nohup "${remoteRoot}/runtime/bin/dsh" --profile web -- --host 127.0.0.1 --port 0 --no-open > "${remoteRoot}/run/web.log" 2>&1 &`,
        `echo $! > "${remoteRoot}/run/web.pid"`,
      ].join('\n'),
      commandTimeoutMs,
      'launching the remote backend',
    )
    const deadline = Date.now() + launchTimeoutMs
    for (;;) {
      urlLine = (await runner.run(alias, readUrl, commandTimeoutMs)).stdout.trim()
      if (urlLine !== '') break
      if (Date.now() > deadline) {
        const tail = (await runner.run(alias, `tail -n 20 "${remoteRoot}/run/web.log" 2>/dev/null || true`, commandTimeoutMs)).stdout
        throw new Error(`the remote backend did not report its URL within ${launchTimeoutMs}ms; last log lines:\n${tail}`)
      }
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
  }
  const match = WEB_URL_LINE.exec(urlLine)
  if (match === null) throw new Error(`unparsable remote startup line: ${urlLine}`)
  const url = new URL(match[1])
  const token = url.searchParams.get('token')
  if (token === null) throw new Error(`remote startup line carries no launch token: ${urlLine}`)
  return { remotePort: Number(url.port), token }
}

/**
 * Provision everything the SSH target needs and return a ready backend's
 * facts.
 *
 * @param runner - ssh execution seam.
 * @param alias - ssh `Host` alias to provision.
 * @param workDir - local scratch directory for the runtime tarball.
 * @param options - provisioning knobs.
 * @param packager - local runtime payload seam; production uses the tar packager.
 * @param onPhase - lifecycle notification for UI progress.
 * @returns connection facts of the ready remote backend.
 */
export async function ensureRemoteBackend(
  runner: SshRunner,
  alias: string,
  workDir: string,
  options: RemoteRuntimeOptions = DEFAULT_RUNTIME_OPTIONS,
  packager: RuntimePackager = createTarRuntimePackager(),
  onPhase: (phase: ProvisioningPhase) => void = () => {},
): Promise<RemoteBackendInfo> {
  onPhase('checking')
  const nodePathPrefix = await ensureNode(runner, alias, options, onPhase)
  const version = await ensureDsh(runner, alias, nodePathPrefix, workDir, options, packager, onPhase)
  onPhase('starting')
  const info = await ensureRunning(runner, alias, nodePathPrefix, options)
  return { ...info, version }
}

/** Stable content hash of an alias, used for per-target work directories. */
export function targetWorkDir(base: string, alias: string): string {
  return join(base, createHash('sha256').update(alias).digest('hex').slice(0, 16))
}
