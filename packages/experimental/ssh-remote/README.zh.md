---
description: "SSH 远程工作区 Host 插件：从 ~/.ssh/config 发现目标，经 ssh  provisioning 匹配的 dsh 运行时，拉起远程后端并把端口隧道回本地回环。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-ssh-remote

[English](README.md) | 中文

## 概述

`dsh-experimental-ssh-remote` 让本地的 `dsh web` 驱动一台 SSH 目标机上的 dsh 后端。它从 `~/.ssh/config` 发现连接目标；`ensure` 流程完成目标机所需的全部 provisioning——足够新的 Node.js、与本地逐位一致的 dsh 运行时、运行中的 `dsh web`——然后打开 `ssh -L` 隧道，把远程后端的回环端口带回本地回环端口。浏览器打开返回的隧道 URL（已携带远程后端的启动令牌），远程浏览器认证的表现与后端在本地完全一致。

## 目录

- [使用本包](#use-this-package)
- [Dev Note](#dev-note)
- [Model Experience](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

把控制器作为 opt-in 行组合进 Host profile：

```yaml
- id: ssh-remote
  name: '@deepseek-ai/dsh-experimental-ssh-remote'
```

客户端调用生成的 Remote 命名空间：`sshRemote.targets()` 列出 ssh config 中的具体 `Host` 别名；`sshRemote.ensure({ targetId })` 完成 provisioning 与连接并返回 `backendUrl`；`sshRemote.status()` 报告每个目标的生命周期供进度展示；`sshRemote.disconnect({ targetId })` 拆除隧道，远程后端进程保留以便复用。

凭据从不进入本包：系统 `ssh`/`scp` 二进制拥有 `~/.ssh/config`、ssh-agent 和密钥，`BatchMode=yes` 把任何交互式提示变成显式错误。远程 `~/.dsh-ssh/` 目录下有 `node/`（自动安装时）、`runtime/`（下发的 dsh 构建）和 `run/`（pid 与启动日志）。

### 配置

所有字段均可选，默认值为生产取值。

| 字段 | 默认 | 含义 |
|---|---|---|
| `sshConfigPath` | `~/.ssh/config` | 目标发现来源文件 |
| `remoteRoot` | `.dsh-ssh` | 远程家目录下的 provisioning 目录 |
| `minimumNodeMajor` | `22` | 远程 Node.js 最低主版本 |
| `nodeInstallVersion` | `22.20.0` | 检查失败时远程安装的 Node.js 版本 |
| `commandTimeoutMs` | `30000` | 单条远程脚本的硬时限 |
| `launchTimeoutMs` | `60000` | 远程后端启动行的等待时限 |
| `stateDir` | `$TMPDIR/dsh-ssh-<uid>` | 本地控制套接字与运行时 tarball 目录 |

<a id="model-experience"></a>
## 模型体验

None, as the controller provisions and tunnels a remote backend and registers no prompt section, tool, or session event; the remote backend's own model behavior is the local build's, bit for bit.

#### KV Cache effect

Provisioning 与隧道流量从不进入模型请求，provider 缓存复用不受影响。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 运行时打包器下发本地 CLI 的 `node_modules` 安装树；从源码检出运行会显式报错并给出指引，而不是打出坏包。更瘦的载荷（裁剪依赖的 bundle）延后。
- 切换到远程后端会把页面整页跳转到隧道 URL。消除刷新的多后端客户端架构见[多后端 Agent Note](../../../.agents/notes/proposed/architecture/2026-09-12-multi-backend-web-client.zh.md)。
- 隧道死亡目前只呈现为错误状态；隧道自动重启与远程进程看护延后。
- 按设计不支持密码提示（`BatchMode=yes`）；目标必须用 agent 或密钥认证。
- 不发布运行时 invariant 伴随包：控制器的状态表只经由同一个服务写入和读取，独立观察不可能与实现产生分歧。

<a id="dev-note"></a>
### 开发备注

`SshRunner`（系统 ssh）与 `RuntimePackager`（本地载荷 tar）是两个测试 seam；单元测试对两者做脚本化替身，既不需要 sshd 也不需要 dsh 安装。`parseSshConfig` 是纯函数。远程后端启动时打印 `dsh web: <url>?token=…`，`ensure` 把该行作为就绪信号——与既有 supervisor 依赖的契约相同。
