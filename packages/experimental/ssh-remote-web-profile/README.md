---
description: "Experimental Web profile layer composing the SSH remote host controller and browser panel as one opt-in bundle."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-ssh-remote-web-profile

English | [中文](README.zh.md)

## Summary

`dsh-experimental-ssh-remote-web-profile` is the opt-in composition layer for SSH remote workspaces: its bundle patch inserts the [`ssh-remote`](../ssh-remote/README.md) host controller and the [`client-ui-ssh-remote`](../client-ui-ssh-remote/README.md) browser panel after the shipped Web layers. Apply it as a bundle in a custom profile (or as a `--patch` overlay) to enable the feature; the shipped profiles stay untouched.

## Model Experience

None: composition only.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

Tracks the limitations of the two composed packages. No runtime invariant companion is published: the layer inserts rows and owns no runtime relationship an independent observation could test.

## Dev Note

The patch's two rows name both packages, and this package's `dependencies` carries them so profile boot can resolve the bare names.
