# SSH 远程工作区 — 交接与验证指南

> 本文档面向在**没有对话上下文**的机器上接手验证的人，读完即可独立完成端到端验证。最后更新：2026-09-13（分支 `feat/ssh-remote-workspace`，提交 `a767a0dd9f` 之后）

## 1. 这件事是什么

给 dsh（DeepSeek Harness）加 **SSH 远程工作区**能力（类比 VS Code Remote-SSH）：

1. 本地运行 `dsh web`，打开网页；
2. 侧栏 SSH 面板列出 `~/.ssh/config` 中的 Host 别名；
3. 点"连接"后，本地插件通过系统 `ssh` 在远程机器上检查并（必要时）安装 Node.js 和与本地**同版本**的 dsh，拉起远程 `dsh web` 后端；
4. 建立 `ssh -L` 隧道把远程后端的回环端口转发到本地回环端口；
5. 浏览器跳转到隧道 URL（URL 内已带远程启动令牌），直接使用远程 dsh 的完整 Web UI——会话在**远程机器**上执行，与本地会话并行。

终态设计（单页多后端、工作区同屏分区 local/remote、不刷新切换）见 RFC：[.agents/notes/proposed/architecture/2026-09-12-multi-backend-web-client.md](../../../.agents/notes/proposed/architecture/2026-09-12-multi-backend-web-client.md)（[中文版](../../../.agents/notes/proposed/architecture/2026-09-12-multi-backend-web-client.zh.md)）。当前完成的是 **Phase 1（整页跳转形态）**。

## 2. 仓库与分支

- 上游（只读同步用）：`origin` = `https://github.com/deepseek-ai/deepseek-harness.git`
- 开发 fork（推送用）：`fork` = `git@github.com:Merisit-Wang/deepseek-harness.git`
- 开发分支：`feat/ssh-remote-workspace`（所有 SSH 工作都在这里）
- `master` 只跟踪上游，**不要在 master 上提交**。同步上游：`git checkout master && git pull origin master && git push fork master`，回开发分支后 `git merge master`。

克隆后继续开发：

```sh
git clone git@github.com:Merisit-Wang/deepseek-harness.git
cd deepseek-harness
git checkout feat/ssh-remote-workspace
git remote rename origin fork
git remote add origin https://github.com/deepseek-ai/deepseek-harness.git   # 可选，同步上游用
```

## 3. 代码结构（全部在 `packages/experimental/` 下）

| 包 | 角色 | 关键文件 |
|---|---|---|
| `ssh-remote` | Host 插件 | `src/targets.ts`（ssh config 解析）、`src/ssh.ts`（系统 ssh/scp/隧道封装）、`src/runtime.ts`（node/dsh 检测安装、远程启动）、`src/index.ts`（`ctx.sshRemote` 控制器，Typert Remote：`targets`/`status`/`ensure`/`disconnect`） |
| `client-ui-ssh-remote` | 浏览器面板 | `src/client/index.ts`（挂载 Remote、注册面板）、`src/client/SshRemotePanel.tsx`（目标列表 UI） |
| `ssh-remote-web-profile` | opt-in 组合层 | `cordis.patch.yml`（插入上述两行） |

远程目录布局（目标机上）：`~/.dsh-ssh/node/`（自动安装的 Node）、`~/.dsh-ssh/runtime/`（下发的 dsh）、`~/.dsh-ssh/run/web.log`（后端日志）、`~/.dsh-ssh/run/web.pid`。

## 4. 构建与启用

```sh
pnpm install
pnpm run build
```

**已知坑**：如果 `pnpm install` 莫名报 "Already up to date" 但锁文件明显没更新（新包没进去），删除 `node_modules/.pnpm-workspace-state-v1.json` 后重装。这是 pnpm 11 的工作区状态缓存问题。

启用（不修改任何 profile，用 patch 覆盖层）：

```sh
pnpm dsh --profile web --patch packages/experimental/ssh-remote-web-profile/cordis.patch.yml
```

确认插件已加载：`pnpm dsh --profile web --patch packages/experimental/ssh-remote-web-profile/cordis.patch.yml --dump-config | grep ssh-remote` 应看到两行。

**前提**：目标机能密钥/agent 免密登录（`ssh <别名> true` 可通）。密码交互式登录按设计直接报错（`BatchMode=yes`）。

## 5. 端到端验证清单

| 步骤 | 操作 | 预期 |
|---|---|---|
| 1 | 按第 4 节启动 dsh web 并打开网页 | 侧栏图标列出现终端样式的 SSH 图标 |
| 2 | 点开 SSH 面板 | 列出 `~/.ssh/config` 的 Host 别名；无别名主机显示 `user@host` 副标题 |
| 3 | 点"连接" | 徽标依次经过 checking →（installing-node）→（installing-dsh）→ starting → tunneling → ready；首次安装耗时较长 |
| 4 | ready 后自动跳转 | 地址栏变为 `http://127.0.0.1:<端口>/?token=...`，呈现完整的 dsh Web UI（这是远程后端） |
| 5 | 在远程 UI 里开会话，让它跑 `hostname && uname -a` | 输出是**远程机器**的信息 |
| 6 | 回本地（去掉端口路径或直接访问原本地端口）开本地会话 | 两端会话可并行执行、互不干扰 |
| 7 | 面板里点"断开" | 隧道关闭；远程后端进程保留，下次"连接"秒级复用 |

## 6. 排障指南

| 现象 | 排查 |
|---|---|
| 侧栏没有 SSH 图标 | `--dump-config` 确认两行在；前端需 `pnpm run build` 重新构建后刷新页面（强刷） |
| 报 "CLI does not live in a node_modules tree" | 设计行为：从源码检出（`pnpm dsh`）运行时无法打出自包含运行时包。绕过：先在远程手动装同版本 dsh 到 `~/.dsh-ssh/runtime/`（版本号须与本地 CLI `package.json` 的 `version` 一致，远程执行 `<runtime>/bin/dsh --version` 能被版本检查通过），或改用包管理器安装的 dsh 作为本地运行时 |
| 连接卡在 starting 后报错 | 看远程日志 `ssh <别名> tail -50 ~/.dsh-ssh/run/web.log`；常见是远程首次创建 `$DSH_HOME`/profile 较慢，加大 `launchTimeoutMs` 配置 |
| 跳转后 401 | 检查地址栏 `?token=` 是否完整；令牌解析自远程启动行 `dsh web: http://...`（同 web.log） |
| 面板状态不动 | 状态是 `ensure` 结束后刷新的一次性视图（Phase 1 不做流式进度）；手动点"刷新" |
| 想看后端状态机 | 本地 Host 的 `sshRemote/status` Remote 方法返回每个目标的 phase/error/backendUrl |

## 7. 当前验证状态（写本文时）

本地可自动化的检查**全部通过**：typecheck 0 错、lint 0 错、单元测试 87/87（两包 per-file 100% 覆盖）、`pnpm run build`（Typert 面正常生成）、`pnpm run test:gui` 5425、`pnpm run doc-sync` 34/34、`pnpm run hygiene` 16/16。

**但从未连过真实 SSH 主机**——所有测试用脚本化的 `SshRunner`/`RuntimePackager` 替身。真机首验最可能暴露问题的环节（按概率）：运行时打包下发（见排障表第 2 行）、远程 profile 首次初始化、隧道与令牌链路。

## 8. 验证完成后的路线

1. **Phase 1 特性 Agent Note**：仓库规则要求非平凡变更附带（`.agents/notes/proposed|implemented/` 规范见 [.agents/notes/README.md](../../../.agents/notes/README.md)）。
2. **Phase 2**（本仓库小 PR）：`client/connection` 支持从 boot 注入读 apiBase，同 tab 同源切换后端，不用记隧道端口。
3. **Phase 3**（核心改造）：评审 RFC 后实施单页多后端——工作区同屏分区、不刷新切换、并行会话的正式形态。

## 9. 关键设计约束（改代码前必读）

- **凭据永不进插件**：一律走系统 `ssh`/`scp` + `~/.ssh/config` + agent；`BatchMode=yes` 把任何交互提示变成显式错误。
- **远程后端认证复用原生机制**：隧道 URL 带 `?token=`，浏览器自己完成远程的 token→cookie 交换，不需要代理插手 cookie。
- **版本必须严格一致**：远程 dsh 与本地不同版本时 ensure 会重新下发；Typert 生成面只在同一构建内兼容。
- 仓库工程规范见根 [AGENTS.md](../../../AGENTS.md)；改 `packages/` 前读 [docs/architecture.md](../../../docs/architecture.md)。
