# SSH Remote

English | [中文](ssh-remote.zh.md)

`@deepseek-ai/dsh-experimental-ssh-remote` discovers SSH connection targets from `~/.ssh/config`, provisions a matching dsh runtime on the target, launches the remote `dsh web` backend, and tunnels its loopback port back to the local machine. This page declares the wire types of the `sshRemote` Remote namespace; the [package README](../../packages/experimental/ssh-remote/README.md) owns provisioning behavior and configuration.

Source: [`packages/experimental/ssh-remote/src/types.ts`](../../packages/experimental/ssh-remote/src/types.ts)

## Targets

```ts type-equiv
/** Opaque identity of one discovered SSH target. */
type SshTargetId = Branded<'SshTargetId'>
```

```ts type-equiv
/**
 * One SSH connection target discovered from `~/.ssh/config`. `alias` is the
 * `Host` name used for every ssh invocation; the remaining fields are
 * display fallbacks parsed from the same block.
 */
interface SshTarget {
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
```

## Backend lifecycle

```ts type-equiv
/** Lifecycle of one target's remote backend, observed by the UI. */
type SshBackendPhase =
  | 'idle'
  | 'checking'
  | 'installing-node'
  | 'installing-dsh'
  | 'starting'
  | 'tunneling'
  | 'ready'
  | 'error'
```

```ts type-equiv
/** Current lifecycle snapshot of one target's backend. */
interface SshBackendStatus {
  readonly targetId: SshTargetId
  readonly phase: SshBackendPhase
  /** Human-readable failure detail when `phase` is `error`; absent otherwise. */
  readonly error?: string
  /** The local loopback URL of the established tunnel; present only in `ready`. */
  readonly backendUrl?: string
}
```

## Remote payloads

```ts type-equiv
/** Result of a successful `ensure` call: the backend is reachable locally. */
interface SshEnsureResult {
  readonly targetId: SshTargetId
  /** Local loopback base URL (including the remote's authenticated path) to open. */
  readonly backendUrl: string
}
```

```ts type-equiv
/** Request payload of the `ensure` Remote method. */
interface SshEnsureRequest {
  readonly targetId: SshTargetId
}
```

```ts type-equiv
/** Request payload of the `disconnect` Remote method. */
interface SshDisconnectRequest {
  readonly targetId: SshTargetId
}
```

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxsshremote--sshremotecontroller"></a>

### `ctx.sshRemote` — `SshRemoteController`

`ctx.sshRemote`: target discovery, remote provisioning, and tunnel lifecycle for SSH remote workspaces. The browser opens the `backendUrl` an `ensure` call returns; the URL already carries the remote backend's launch token, so the remote's own browser-auth exchange issues its cookie against the tunnel authority with no proxy involvement.

```ts cordis-catalog
/**
 * List the SSH targets discovered from the operator's ssh config.
 * @returns targets in config-file order.
 */
@Remote('targets') async remoteTargets(): Promise<SshTarget[]>

/**
 * Read the current lifecycle of every backend this controller manages.
 * @returns one status row per target with non-idle state.
 */
@Remote('status') remoteStatus(): Promise<SshBackendStatus[]>

/**
 * Provision and connect one target's remote backend: detect or install
 * Node.js, ship the matching dsh runtime when absent or stale, launch the
 * remote `dsh web`, and open an `ssh -L` tunnel to its port. Concurrent
 * calls for one target join the same in-flight provisioning.
 * @param request - target to ensure.
 * @param signal - caller cancellation; aborts waiting and provisioning.
 * @returns the local tunnel URL carrying the remote launch token.
 */
@Remote('ensure') async remoteEnsure(request: SshEnsureRequest, signal: AbortSignal): Promise<SshEnsureResult>

/**
 * Tear down one target's tunnel, leaving the remote backend process
 * running for a later reconnect.
 * @param request - target to disconnect.
 */
@Remote('disconnect') remoteDisconnect(request: SshDisconnectRequest): Promise<void>
```

Source: [`packages/experimental/ssh-remote/src/index.ts`](../../packages/experimental/ssh-remote/src/index.ts)
<!-- END GENERATED cordis-surface -->
