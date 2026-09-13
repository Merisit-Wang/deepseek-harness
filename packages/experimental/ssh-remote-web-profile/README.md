---
description: "Experimental Web profile layer composing the SSH remote host controller and browser panel as one opt-in bundle."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-ssh-remote-web-profile

English | [中文](README.zh.md)

## Summary

`dsh-experimental-ssh-remote-web-profile` is the opt-in composition layer for SSH remote workspaces: its bundle patch inserts the [`ssh-remote`](../ssh-remote/README.md) host controller and the [`client-ui-ssh-remote`](../client-ui-ssh-remote/README.md) browser panel after the shipped Web layers. Apply it as a bundle in a custom profile (or as a `--patch` overlay) to enable the feature; the shipped profiles stay untouched.

## Table of Contents

- [Dev Note](#dev-note)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

## Model Experience

Indirectly, through the host controller and browser panel it mounts, which own every model-facing registration they make visible.

#### KV Cache effect

The layer itself sends nothing to a model request, so provider cache reuse is unaffected.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Tracks the limitations of the two composed packages; the layer itself adds none.
- No runtime invariant companion is published: the layer inserts rows and owns no runtime relationship an independent observation could test.

<a id="dev-note"></a>
### Dev Note

The patch's two rows name both packages, and this package's `dependencies` carries them so profile boot can resolve the bare names.
