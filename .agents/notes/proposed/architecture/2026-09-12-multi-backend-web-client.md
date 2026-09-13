# Agent Note: Multi-backend Web Client

Status: proposed

English | [中文](2026-09-12-multi-backend-web-client.zh.md)

## Problem

The Web Client binds to exactly one dsh Host. The page is served by that Host, every Remote call and stream rides the same-origin `/api` carrier, one Connection generation watches one `$events` stream, `ctx.remote.<namespace>` mounts one Host's generated descriptors, and `ClientSessions` plus the Workspace model each mirror one Host's state. The browser-auth boundary reinforces this: the signed cookie is bound to the serving authority, and the request-trust fence assumes the page and the API share an origin ([browser request trust](../../implemented/architecture/2026-07-28-api-browser-trust-boundary.md), [browser token authentication](../../implemented/architecture/2026-08-24-browser-token-authentication.md)).

A remote-workspace deployment — the motivating case is an SSH target where the remote machine runs its own dsh Host — therefore cannot participate in an already-open page. The operator must open a second URL (the remote's own server, possibly reached through a forwarded port), which splits navigation state, loses in-flight UI state on every switch, and can never show two Hosts at once. The SSH lifecycle itself (target discovery, remote install, tunnel, local proxy) belongs to an external plugin and is not this note's subject; this note owns the Client-side capability that such a plugin needs: one page driving several dsh Hosts without a reload.

## Proposal

Introduce the **Backend** as a Client-side concept: one reachable dsh Host the page may drive. The serving Host is the built-in `local` Backend; plugins register further Backends at runtime. A Backend descriptor carries a stable branded `BackendId`, a same-origin `apiBase` path, a display name, and a kind tag for UI grouping. Same-origin is a hard rule: a remote Host is reached through a proxy route the local webserver delegates to the registering plugin (for SSH, an `ssh -L` tunnel endpoint), never through a second browser origin, so the [request-trust fence](../../implemented/architecture/2026-07-28-api-browser-trust-boundary.md) and the operator-facing cookie model stay exactly as designed.

The proposal lands in four pieces, each shippable behind the existing single-backend behavior:

1. **Per-backend Connection.** `ConnectionController`'s generation machinery ([continuous recovery](../../implemented/bug-fix/2026-09-05-continuous-client-recovery.md)) parameterizes on `apiBase` instead of the fixed `API_PATH` constant. Each registered Backend runs its own `$events` stream, readiness handshake, and retry schedule against its own base path; the local Backend keeps today's behavior bit-for-bit.
2. **Backend-scoped context tree.** For each connected Backend the client mounts one Cordis child context in which that Backend's generated `remote` namespaces, `ClientSessions`, and Workspace model instances live. Session scoping becomes two-level — Backend, then Session — so `agentCtx.remote.<namespace>` and scoped waterfalls resolve against the Session's owning Backend. Feature plugins that inject root `remote` faces keep addressing the local Backend unchanged; a feature becomes Backend-aware by injecting the Backend-scoped face instead, which is an explicit per-plugin migration.
3. **Backend registry and UI aggregation.** A new thin client package owns the registry: registration, disposal, per-Backend recovery observables, and a version handshake. UI adapters aggregate per-Backend sources at the standard-source layer so the workspace area shows every connected Backend **simultaneously**, grouped into zones: the `local` zone first, then one zone per remote Backend. A zone title renders the Backend's display name — for an SSH Backend that is the `Host` alias from `~/.ssh/config`, falling back to `user@host` when no alias exists; credentials never render anywhere in the UI, and agent/key auth means most SSH Backends have no password to begin with. The conversation shell binds one `(Backend, SessionBinding)` pair exactly as it binds one Session today ([Conversation assembly](../../implemented/architecture/2026-08-09-client-conversation-node-assembly.md) is unchanged; only the binding's provenance widens).
4. **Version handshake.** The `$events` ready frame's host facts gain the Host's client-build version. A Backend whose build predates or postdates the page's build fails registration with an actionable error, because generated Typert descriptors are only compatible within one build. The SSH distribution model (ship the local runtime tarball to the remote) makes this check a guardrail, not a routine failure.

The proxy that makes a remote Host same-origin authenticates to that Host itself: the registering plugin performs the launch-token exchange out-of-band (for SSH it reads the token from the remote launch output it owns), caches the remote-issued cookie, and attaches it to every forwarded request with the `Host` header rewritten to the tunnel authority. The remote Host's token and cookie never reach the browser.

**Parallel execution is structural, not a feature.** Every Backend's Host owns its agent loops, session logs, and tool pipelines, so a turn on the remote Backend and a turn on the local Backend execute concurrently by construction — the same way two Sessions on one Host already run independently. The Client's obligation is concurrent observation, not scheduling: each Backend's `$events` stream, control stream, and per-Session follow streams stay open at the same time, so both workspace zones render live session status while the user works in either one, and a turn keeps running on its Host regardless of which Backend the user is currently viewing.

## Alternatives considered

**Full-page navigation to a per-Backend URL (Phase 1/2 stepping stone).** Each Backend serves or is proxied under its own path and switching reloads the page. This is the planned incremental delivery and stays as the fallback, but a reload drops composer drafts, panel layout, and scroll position, and two Hosts can never be visible together — so it cannot be the final state.

**Direct cross-origin connection to the tunnel port.** The page would fetch `http://127.0.0.1:<port>/api` on a second origin. That collides with the same-origin design of the trust fence, requires CORS on the remote server, and strands the remote's authority-bound cookie (the browser would need the remote's launch token). It widens the browser attack surface for zero capability gain over same-origin proxying.

**Remote execution world instead of a remote Host.** E2B-style `fs`/`subprocess` providers already move tool execution to a remote sandbox while the agent loop, session logs, and LLM traffic stay local. That answers "run tools over there", not "drive the dsh Host over there": no remote session list, no remote Workspaces, no offload of the loop itself.

**iframe the remote Host's own page.** Two nested applications share nothing — sidebar, workspace navigation, keyboard focus, and clipboard each duplicate — and the composition still cannot present one merged session list.

**One merged global session/workspace model across Backends.** Merging at the model layer would force every model invariant (identity stability, stream/unary race resolution, generation replacement) to reason about interleaved Hosts. Per-Backend models with aggregation at the UI-source layer keep each model single-Host and its invariants intact.

## Acceptance criteria

- With only the `local` Backend registered, every existing behavior is bit-identical: GUI suites, the keyless assembled Web snapshot replay, and connection-recovery tests pass unchanged.
- With a second Backend registered through a loopback fixture Host, the workspace area shows a `local` zone and the remote Backend's zone at the same time, the remote zone titled by its SSH config alias (or `user@host` fallback), and no credential string appears in any rendered surface. The page opens a Session on each Backend without reload, streams both conversations concurrently, and resolves a scoped waterfall (approval or ask-user) issued by the remote Host in the same UI.
- A turn started on the remote Backend continues executing and emitting events while the user prompts a Session on the local Backend (and vice versa); both zones reflect live status with no cross-Backend blocking, and per-Backend recovery (one tunnel dropping) never interrupts the other Backend's streams.
- Backend registration and disposal mid-session tear down exactly that Backend's contexts, streams, and models; the HMR-safety disposal test pattern covers the registry.
- A build-version mismatch between page and Backend refuses registration with an error naming both versions; no Remote call is dispatched to a mismatched Backend.
- The remote Host's launch token and signed cookie never appear in any browser-visible surface (no cookie write, no response header, no boot payload row); a test asserts the proxy attaches them only on forwarded requests.
- `pnpm run test:gui` and `DSH_SNAPSHOT=replay pnpm run test:web` cover the multi-backend composition; the SSH plugin itself needs no changes to ride the registry.

## Risks

- **Scope.** This is the largest Client architecture change so far: connection generations, the remotes assembly, both controller Client models, the `ui-session` scope adapter, and the conversation binding all gain a dimension. Landing behind the unchanged single-backend path limits blast radius but does not shrink the review surface.
- **Silent local capture.** Feature plugins that closed over root `ctx.remote.<namespace>` will keep acting on the local Backend even when the user is looking at a remote Session. The per-plugin migration to Backend-scoped faces must be audited package by package, and the slots `inject` typing should make the wrong choice unrepresentable where feasible.
- **Proxy amplification.** Every Backend adds one WebSocket through the local proxy plus its `$events` traffic; proxy backpressure and teardown become part of the Client's recovery story even though the proxy lives in a Host-side plugin.
- **Two-level scoping complexity.** Backend→Session scoping adds a second context dimension that every future Session-scoped feature must consider; the registry package's README must own the decision rule for when a feature belongs at Backend scope versus root.
- **Deferred to the SSH plugin, not this change:** target discovery, remote install, tunnel lifetime, and the `/ssh/<id>/` proxy route. This note's registry accepts any same-origin Backend, so those land independently.

## Related

- [Domain KV storage and workspace](../architecture/2026-07-24-domain-kv-storage-and-workspace.md) proposes multiple *Host-side* storage backends mounted simultaneously; that axis is orthogonal — a Backend here is a whole remote dsh Host, and both designs can ship independently. No active note is superseded.
