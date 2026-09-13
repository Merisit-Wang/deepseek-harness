# Agent Note: Multi-backend Web Client

Status: proposed

[English](2026-09-12-multi-backend-web-client.md) | 中文

## Problem

Web Client 目前只绑定一个 dsh Host：页面由该 Host 提供，所有 Remote 调用和流都走同源 `/api` 载体，一个 Connection 代只监视一条 `$events` 流，`ctx.remote.<namespace>` 只挂载一个 Host 生成的描述符，`ClientSessions` 和 Workspace 模型各自只镜像一个 Host 的状态。浏览器认证边界进一步固化了这一点：签名 cookie 绑定在提供页面的 authority 上，请求信任栅栏假设页面与 API 同源（[browser request trust](../../implemented/architecture/2026-07-28-api-browser-trust-boundary.zh.md)、[browser token authentication](../../implemented/architecture/2026-08-24-browser-token-authentication.zh.md)）。

因此，远程工作区部署——最典型的场景是一台 SSH 目标机运行自己的 dsh Host——无法加入一个已经打开的页面。操作者必须打开第二个 URL（远程自己的服务器，可能经转发端口到达），这会割裂导航状态、每次切换丢失进行中的 UI 状态，并且永远无法同时看到两个 Host。SSH 生命周期本身（目标发现、远程安装、隧道、本地代理）属于外部插件，不是本笔记的主题；本笔记拥有的是这类插件所需要的 Client 侧能力：**一个页面驱动多个 dsh Host，且不刷新**。

## Proposal

引入 **Backend** 作为 Client 侧概念：页面可驱动的一个可达 dsh Host。提供页面的 Host 是内置的 `local` Backend；插件在运行时注册更多 Backend。Backend 描述符携带一个稳定的品牌化 `BackendId`、一个同源 `apiBase` 路径、一个显示名和一个用于 UI 分组的 kind 标签。同源是硬规则：远程 Host 必须通过本地 webserver 委托给注册插件的代理路由到达（对 SSH 而言是 `ssh -L` 隧道端点），绝不通过第二个浏览器源，这样[请求信任栅栏](../../implemented/architecture/2026-07-28-api-browser-trust-boundary.zh.md)和面向操作者的 cookie 模型保持原设计不变。

本提案由四部分组成，每一部分都能在保持现有单后端行为的前提下交付：

1. **按 Backend 的 Connection。** `ConnectionController` 的代机制（[continuous recovery](../../implemented/bug-fix/2026-09-05-continuous-client-recovery.zh.md)）改为按 `apiBase` 参数化，不再使用写死的 `API_PATH` 常量。每个已注册 Backend 针对自己的基路径运行自己的 `$events` 流、就绪握手和重试计划；本地 Backend 逐位保持今日行为。
2. **Backend 作用域上下文树。** 每个已连接 Backend 在客户端挂载一个 Cordis 子上下文，其中挂载该 Backend 生成的 `remote` 命名空间、`ClientSessions` 和 Workspace 模型实例。Session 作用域变为两级——先 Backend 后 Session——因此 `agentCtx.remote.<namespace>` 和作用域 waterfall 都按 Session 所属的 Backend 解析。注入根 `remote` 面的功能插件继续寻址本地 Backend，行为不变；一个功能要感知 Backend，就改为注入 Backend 作用域的面，这是一次逐插件的显式迁移。
3. **Backend 注册表与 UI 聚合。** 一个新的轻量 client 包拥有注册表：注册、销毁、按 Backend 的恢复状态可观察量，以及版本握手。UI 适配器在标准源层聚合各 Backend 的源，使工作区区域**同时**展示每一个已连接 Backend，并按区域分组：`local` 区域在前，之后每个远程 Backend 一个区域。区域标题渲染 Backend 的显示名——对 SSH Backend 而言是 `~/.ssh/config` 里的 `Host` 别名，没有别名时回退为 `user@host`；凭据永远不渲染到 UI 的任何位置，而且 agent/密钥认证意味着大多数 SSH Backend 本来就没有密码可显示。会话外壳绑定一个 `(Backend, SessionBinding)` 对，方式与今天绑定一个 Session 完全相同（[Conversation assembly](../../implemented/architecture/2026-08-09-client-conversation-node-assembly.zh.md) 不变，只是绑定的来源变宽）。
4. **版本握手。** `$events` 就绪帧的 host 事实增加 Host 的客户端构建版本。构建版本先于或后于页面构建的 Backend 注册失败并给出可操作的错误，因为生成的 Typert 描述符只在同一构建内兼容。SSH 的分发模型（把本地运行时 tarball 下发到远程）使这项检查成为兜底，而不是常规失败。

让远程 Host 同源的代理由注册插件自己完成对该 Host 的认证：插件带外执行启动令牌交换（对 SSH 而言，令牌从它自己拥有的远程启动输出中读取），缓存远程签发的 cookie，并在每个转发请求上附带它，同时把 `Host` 头改写为隧道 authority。远程 Host 的令牌和 cookie 永远不进入浏览器。

**并行执行是结构性的，不是一个功能。** 每个 Backend 的 Host 各自拥有自己的 agent loop、会话日志和工具管线，因此远程 Backend 上的一个 turn 和本地 Backend 上的一个 turn 天然并发执行——与同一 Host 上两个 Session 早已相互独立同理。Client 的义务是并发观察，而不是调度：每个 Backend 的 `$events` 流、控制流和按 Session 的 follow 流同时保持打开，因此用户在任意一个区域工作时，两个工作区区域都渲染实时的会话状态；无论用户当前在看哪个 Backend，turn 都在它所属的 Host 上持续运行。

## Alternatives considered

**整页跳转到按 Backend 的 URL（Phase 1/2 的过渡形态）。** 每个 Backend 在自己的路径下被提供或被代理，切换时刷新页面。这是计划中的增量交付并保留为回退方案，但刷新会丢失草稿、面板布局和滚动位置，且两个 Host 永远无法同屏——所以它不能是终态。

**直接跨源连接隧道端口。** 页面将向第二个源 `http://127.0.0.1:<port>/api` 发请求。这与信任栅栏的同源设计冲突，要求远程服务器开 CORS，并且远程的 authority 绑定 cookie 无法使用（浏览器将需要远程的启动令牌）。相比同源代理，它扩大了浏览器攻击面却零收益。

**远程执行环境而非远程 Host。** E2B 式 `fs`/`subprocess` provider 已能把工具执行移到远程沙箱，而 agent loop、会话日志和 LLM 流量留在本地。那回答的是"在那边跑工具"，不是"驱动那边的 dsh Host"：没有远程会话列表、没有远程 Workspaces，loop 本身也没有卸载。

**iframe 嵌入远程 Host 自己的页面。** 两个嵌套应用互不相同——侧栏、工作区导航、键盘焦点、剪贴板各自重复——而且组合后仍然无法呈现一个合并的会话列表。

**跨 Backend 合并成一个全局会话/工作区模型。** 在模型层合并会迫使每个模型不变量（身份稳定、流/单发竞态消解、代替换）去推理交错的多个 Host。按 Backend 建模、在 UI 源层聚合，能让每个模型保持单 Host，其不变量原样保留。

## Acceptance criteria

- 只注册 `local` Backend 时，所有现有行为逐位一致：GUI 测试套件、无密钥的组装 Web 快照回放、连接恢复测试全部原样通过。
- 通过 loopback 固定装置 Host 注册第二个 Backend 后，工作区区域同时展示 `local` 区域和该远程 Backend 的区域，远程区域以 SSH config 别名（或 `user@host` 回退）为标题，且任何渲染表面上都不出现凭据字符串。页面无需刷新即可在两个 Backend 上各打开一个 Session，两个会话并发流式输出，并且远程 Host 发起的作用域 waterfall（审批或提问）在同一 UI 中被应答。
- 在远程 Backend 上启动的 turn，在用户向本地 Backend 的 Session 发消息时持续执行并发出事件（反之亦然）；两个区域都反映实时状态且不存在跨 Backend 阻塞，单个 Backend 的恢复（如某条隧道断开）绝不打断另一个 Backend 的流。
- 会话中途注册和销毁 Backend，恰好拆除该 Backend 的上下文、流和模型；注册表覆盖 HMR 安全的销毁测试模式。
- 页面与 Backend 的构建版本不匹配时拒绝注册，错误中指明双方版本；不匹配的 Backend 不会被分发任何 Remote 调用。
- 远程 Host 的启动令牌和签名 cookie 不出现在任何浏览器可见表面（不写 cookie、不出现在响应头、不出现在 boot 载荷行）；测试断言代理只在转发请求上附带它们。
- `pnpm run test:gui` 与 `DSH_SNAPSHOT=replay pnpm run test:web` 覆盖多后端组合；SSH 插件自身无需改动即可接入注册表。

## Risks

- **范围。** 这是迄今最大的 Client 架构变更：连接代、remotes 组装、两个 controller 的 Client 模型、`ui-session` 作用域适配器和会话绑定都增加了一个维度。藏在不变的单后端路径之后交付能限制爆炸半径，但不会缩小评审面。
- **静默的本地捕获。** 在根 `ctx.remote.<namespace>` 上闭包的功能插件，即使用户正在看远程 Session，也会继续作用于本地 Backend。到 Backend 作用域面的逐插件迁移必须逐包审计，并且在可行处让 slots 的 `inject` 类型使错误选择无法表达。
- **代理放大。** 每个 Backend 都增加一条穿过本地代理的 WebSocket 及其 `$events` 流量；代理的背压和拆除成为 Client 恢复故事的一部分，尽管代理本体住在 Host 侧插件里。
- **两级作用域的复杂度。** Backend→Session 作用域增加了第二个上下文维度，未来每个 Session 作用域的功能都必须考虑它；注册表包的 README 必须拥有"功能该放 Backend 作用域还是根"的判定规则。
- **明确推给 SSH 插件、不属于本次变更：** 目标发现、远程安装、隧道生命周期和 `/ssh/<id>/` 代理路由。本笔记的注册表接受任何同源 Backend，因此那些部分可以独立落地。

## Related

- [Domain KV storage and workspace](../architecture/2026-07-24-domain-kv-storage-and-workspace.zh.md) 提议的是同时挂载多个 **Host 侧**存储后端；那条轴与本提案正交——这里的 Backend 是一个完整的远程 dsh Host，两个设计可以独立交付。没有任何活跃笔记被取代。
