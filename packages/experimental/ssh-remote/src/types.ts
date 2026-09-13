/**
 * Types for the SSH remote workspace host plugin: discovered connection
 * targets, backend lifecycle state, and the wire vocabulary of the
 * `sshRemote` Remote namespace. Types only — no runtime code.
 *
 * @module @deepseek-ai/dsh-experimental-ssh-remote/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Opaque identity of one discovered SSH target. */
export type SshTargetId = Branded<'SshTargetId'>

/**
 * One SSH connection target discovered from `~/.ssh/config`. `alias` is the
 * `Host` name used for every ssh invocation; the remaining fields are
 * display fallbacks parsed from the same block.
 */
export interface SshTarget {
  readonly id: SshTargetId
  /** The `Host` alias from `~/.ssh/config`, also the zone title in the UI. */
  readonly alias: string
  /** `HostName` value when the block declares one. */
  readonly hostName?: string
  /** `User` value when the block declares one; combined with hostName for the `user@host` fallback title. */
  readonly user?: string
  /** `Port` value when the block declares one. */
  readonly port?: number
}

/** Lifecycle of one target's remote backend, observed by the UI. */
export type SshBackendPhase =
  | 'idle'
  | 'checking'
  | 'installing-node'
  | 'installing-dsh'
  | 'starting'
  | 'tunneling'
  | 'ready'
  | 'error'

/** Current lifecycle snapshot of one target's backend. */
export interface SshBackendStatus {
  readonly targetId: SshTargetId
  readonly phase: SshBackendPhase
  /** Human-readable failure detail when `phase` is `error`; absent otherwise. */
  readonly error?: string
  /** The local loopback URL of the established tunnel; present only in `ready`. */
  readonly backendUrl?: string
}

/** Result of a successful `ensure` call: the backend is reachable locally. */
export interface SshEnsureResult {
  readonly targetId: SshTargetId
  /** Local loopback base URL (including the remote's authenticated path) to open. */
  readonly backendUrl: string
}

/** Request payload of the `ensure` Remote method. */
export interface SshEnsureRequest {
  readonly targetId: SshTargetId
}

/** Request payload of the `disconnect` Remote method. */
export interface SshDisconnectRequest {
  readonly targetId: SshTargetId
}
