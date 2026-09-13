---
description: "SSH remote workspaces host plugin: discover targets from ~/.ssh/config, provision a matching dsh runtime over ssh, launch the remote backend, and tunnel its port back to local loopback."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-ssh-remote

English | [中文](README.zh.md)

## Summary

`dsh-experimental-ssh-remote` lets one local `dsh web` drive a dsh backend on an SSH target. It discovers connection targets from `~/.ssh/config`, and its `ensure` flow provisions everything the target needs — a sufficient Node.js, a dsh runtime build identical to the local one, and a running `dsh web` — then opens an `ssh -L` tunnel that brings the remote backend's loopback port to a local one. The browser opens the returned tunnel URL, which carries the remote backend's launch token, so remote browser authentication behaves exactly as if the backend were local.

## Table of Contents

- [Use this package](#use-this-package)
- [Dev Note](#dev-note)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Compose the controller into a host profile as an opt-in row:

```yaml
- id: ssh-remote
  name: '@deepseek-ai/dsh-experimental-ssh-remote'
```

Call the generated Remote namespace from a client: `sshRemote.targets()` lists concrete `Host` aliases from the operator's ssh config; `sshRemote.ensure({ targetId })` provisions and connects, returning `backendUrl`; `sshRemote.status()` reports per-target lifecycle for progress display; `sshRemote.disconnect({ targetId })` tears down the tunnel and leaves the remote backend running for reuse.

Credentials never enter this package: the system `ssh`/`scp` binaries own `~/.ssh/config`, ssh-agent, and keys, and `BatchMode=yes` turns any interactive prompt into a loud error. The remote layout under `~/.dsh-ssh/` holds `node/` (when auto-installed), `runtime/` (the shipped dsh build), and `run/` (pid and startup log).

### Configuration

Every field is optional; defaults are production values.

| Field | Default | Meaning |
|---|---|---|
| `sshConfigPath` | `~/.ssh/config` | file targets are discovered from |
| `remoteRoot` | `.dsh-ssh` | remote home-relative provisioning directory |
| `minimumNodeMajor` | `22` | minimum accepted remote Node.js major |
| `nodeInstallVersion` | `22.20.0` | Node.js version installed remotely when the check fails |
| `commandTimeoutMs` | `30000` | hard deadline for one remote script |
| `launchTimeoutMs` | `60000` | deadline for the remote backend startup line |
| `stateDir` | `$TMPDIR/dsh-ssh-<uid>` | local control sockets and runtime tarballs |

## Model Experience

None, as the controller provisions and tunnels a remote backend and registers no prompt section, tool, or session event; the remote backend's own model behavior is the local build's, bit for bit.

#### KV Cache effect

Provisioning and tunnel traffic never reaches a model request, so provider cache reuse is unaffected.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The runtime packager ships the local CLI's `node_modules` install tree; running from a source checkout fails loud with guidance instead of packing. A slimmer payload (dependency-pruned bundle) is deferred.
- Switching to a remote backend reloads the page onto the tunnel URL. The multi-backend client architecture that removes the reload is proposed in the [multi-backend Agent Note](../../../.agents/notes/proposed/architecture/2026-09-12-multi-backend-web-client.md).
- A dead tunnel is surfaced as an error state; automatic tunnel restart and remote process supervision are deferred.
- Password prompts are unsupported by design (`BatchMode=yes`); targets must authenticate with an agent or key.
- No runtime invariant companion is published: the controller's state map is written and read through the same service, so an independent observation cannot diverge from the implementation.

<a id="dev-note"></a>
### Dev Note

`SshRunner` (system ssh) and `RuntimePackager` (local payload tar) are the two test seams; unit tests script both and need neither sshd nor a dsh install. `parseSshConfig` is pure. The remote backend prints `dsh web: <url>?token=…` on startup, and `ensure` treats that line as readiness — the same contract supervisors already rely on.
