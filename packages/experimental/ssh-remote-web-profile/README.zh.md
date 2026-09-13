---
description: "把 SSH 远程 Host 控制器与浏览器面板作为一个 opt-in bundle 组合起来的实验性 Web profile 层。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-ssh-remote-web-profile

[English](README.md) | 中文

## Summary

`dsh-experimental-ssh-remote-web-profile` 是 SSH 远程工作区的 opt-in 组合层：它的 bundle patch 在出厂 Web 层之后插入 [`ssh-remote`](../ssh-remote/README.md) Host 控制器和 [`client-ui-ssh-remote`](../client-ui-ssh-remote/README.md) 浏览器面板。在自定义 profile 中作为 bundle 应用（或作为 `--patch` 覆盖层）即可启用该特性；出厂 profile 不受影响。

## Model Experience

无：纯组合。

#### KV Cache 影响

无。

## 已知限制与延后工作

继承两个被组合包的限制。不发布运行时 invariant 伴随包：本层只插入组合行，不拥有任何可被独立观察检验的运行时关系。

## Dev Note

patch 的两个组合行按名引用两个包，本包的 `dependencies` 携带它们，以便 profile 启动时解析裸名。
