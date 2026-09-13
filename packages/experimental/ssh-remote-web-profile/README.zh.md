---
description: "把 SSH 远程 Host 控制器与浏览器面板作为一个 opt-in bundle 组合起来的实验性 Web profile 层。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-ssh-remote-web-profile

[English](README.md) | 中文

## 概述

`dsh-experimental-ssh-remote-web-profile` 是 SSH 远程工作区的 opt-in 组合层：它的 bundle patch 在出厂 Web 层之后插入 [`ssh-remote`](../ssh-remote/README.zh.md) Host 控制器和 [`client-ui-ssh-remote`](../client-ui-ssh-remote/README.zh.md) 浏览器面板。在自定义 profile 中作为 bundle 应用（或作为 `--patch` 覆盖层）即可启用该特性；出厂 profile 不受影响。

## 目录

- [开发备注](#dev-note)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="model-experience"></a>
## 模型体验

Indirectly, through the host controller and browser panel it mounts, which own every model-facing registration they make visible.

#### KV Cache effect

本层自身不向模型请求发送任何内容，provider 缓存复用不受影响。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 继承两个被组合包的限制；本层自身不增加限制。
- 不发布运行时 invariant 伴随包：本层只插入组合行，不拥有任何可被独立观察检验的运行时关系。

<a id="dev-note"></a>
### 开发备注

patch 的两个组合行按名引用两个包，本包的 `dependencies` 携带它们，以便 profile 启动时解析裸名。
