---
description: "SSH remote workspace panel for the dsh web client: sidebar panel listing ssh-config targets with provisioning progress and one-click backend handoff."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-ssh-remote

English | [中文](README.zh.md)

## Summary

`dsh-experimental-client-ui-ssh-remote` contributes the SSH workspace panel to the web client: a sidebar panel that lists the operator's `~/.ssh/config` Host aliases with their backend lifecycle (checking, installing, starting, tunneling, ready, error), connects a target through the host controller's `ensure`, and navigates to the established tunnel URL. The panel renders only what the host reports — all provisioning authority stays in [`dsh-experimental-ssh-remote`](../ssh-remote/README.md).

## Use this package

Compose through the [SSH remote Web profile layer](../ssh-remote-web-profile/README.md), which mounts this panel beside the host controller. The panel mounts the generated `sshRemote` Remote namespace itself (`ctx.remote.$mount`), so no release-package assembly changes are needed.

## Model Experience

None: browser presentation and navigation only; nothing reaches a model request.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

- Backend handoff reloads the page onto the tunnel URL; the zone-based simultaneous local/remote workspace area follows the [multi-backend Agent Note](../../../.agents/notes/proposed/architecture/2026-09-12-multi-backend-web-client.md).
- Progress during `ensure` is point-in-time (refresh after settle), not streamed; forwarded host progress events are deferred.
- No runtime invariant companion is published: the panel's observable mirrors the host status endpoint through one owner, so no independent observation can diverge.

## Dev Note

The panel registers a `sidebar.panellist` row and the matching `main` keyed seat under one id (`ssh-remote`). Panel state is a registrant-private observable in the inject `hooks` compartment; tests drive the store and callbacks directly per the client testing rules.
