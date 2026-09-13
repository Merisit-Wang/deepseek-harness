---
description: "dsh web 客户端的 SSH 远程工作区面板：侧栏面板列出 ssh-config 目标、展示 provisioning 进度并一键接管后端。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-ssh-remote

[English](README.md) | 中文

## 概述

`dsh-experimental-client-ui-ssh-remote` 向 web 客户端贡献 SSH 工作区面板：一个侧栏面板，列出操作者 `~/.ssh/config` 中的 Host 别名及其后端生命周期（检查、安装、启动、建隧道、就绪、错误），通过 Host 控制器的 `ensure` 连接目标，并跳转到建立好的隧道 URL。面板只渲染 Host 上报的内容——全部 provisioning 权限都在 [`dsh-experimental-ssh-remote`](../ssh-remote/README.zh.md)。

## 目录

- [使用本包](#use-this-package)
- [Dev Note](#dev-note)
- [Model Experience](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

通过 [SSH 远程 Web profile 层](../ssh-remote-web-profile/README.zh.md)组合，该层把本面板与 Host 控制器一起挂载。面板自行挂载生成的 `sshRemote` Remote 命名空间（`ctx.remote.$mount`），因此不需要改动任何 release 包的组装。

<a id="model-experience"></a>
## 模型体验

None, as the panel renders host-reported backend state and registers nothing model-facing.

#### KV Cache effect

此处没有任何内容进入模型请求，provider 缓存复用不受影响。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 接管后端会把页面整页跳转到隧道 URL；本地/远程工作区同屏分区的形态见[多后端 Agent Note](../../../.agents/notes/proposed/architecture/2026-09-12-multi-backend-web-client.zh.md)。
- `ensure` 期间的进度是时间点式的（结束后刷新），不是流式的；转发 Host 进度事件延后。
- 不发布运行时 invariant 伴随包：面板的可观察状态经由单一所有者镜像 Host 状态端点，独立观察不可能产生分歧。

<a id="dev-note"></a>
### 开发备注

面板以同一个 id（`ssh-remote`）注册一行 `sidebar.panellist` 和对应的 `main` keyed 座位。面板状态是 inject `hooks` 隔间里的注册者私有可观察量；测试按客户端测试规则直接驱动 store 与回调。
