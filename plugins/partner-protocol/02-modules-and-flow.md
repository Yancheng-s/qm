# 模块与流程闭环

本文只讲 qm 侧：有哪些模块、模块之间怎么串、每条链路如何闭环。模块的具体写法见 03。

## 一、模块清单

### 网关（`plugins/partner-protocol`，单进程、无自有存储）

| #   | 模块       | 文件                  | 职责                                                          | 依赖                                        |
| --- | ---------- | --------------------- | ------------------------------------------------------------- | ------------------------------------------- |
| G1  | 入口       | `src/index.ts`        | 起单端口、boot 校验、`/healthz`、把其余请求交给 G6、500 兜底  | G2 G6                                       |
| G2  | 配置       | `src/config.ts`       | env → 强类型配置；不合法则返回问题清单让 G1 拒启              | chassis/env                                 |
| G3  | 入站认证   | `src/auth.ts`         | 验协议凭据签名；从 `partnerId + userId` 派生 `principalId`    | chassis/source-auth-sign                    |
| G4  | 传输       | `src/transport.ts`    | 读体（限长）、JSON 写出、SSE 写出、限流计数、错误码           | chassis/http                                |
| G5  | 出站客户端 | `src/core-client.ts`  | 给每个 core 调用加 source-auth 签名 + portal 身份头；回流响应 | chassis/core-client chassis/portal-identity |
| G6  | 分发管线   | `src/routes/index.ts` | 固定顺序串起 G4→G3→G4→白名单→接口模块，产出统一 `Ctx`         | G3 G4 G7–G12                                |
| G7  | 员工列表   | `routes/employees.ts` | `GET /v1/employees`                                           | G5                                          |
| G8  | 建员工     | `routes/assemble.ts`  | `POST /v1/assemble`：项目 → 技能 → 人格 三步编排              | G5                                          |
| G9  | 补技能     | `routes/skills.ts`    | `POST /v1/skills`                                             | G5                                          |
| G10 | 发消息     | `routes/turn.ts`      | `POST /v1/turn`：构造会话坐标并提交 turn                      | G5                                          |
| G11 | 事件流     | `routes/events.ts`    | `GET /v1/events`：运行态轮询 → SSE                            | G5 G4                                       |
| G12 | 会话       | `routes/sessions.ts`  | `GET /v1/sessions[/:id]`                                      | G5                                          |

### core（被串起来的 qm 内部模块，本插件不改它们）

| #   | 模块       | 位置                                                                         | 在链路里的作用                                                                                                                                    |
| --- | ---------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | HTTP 门面  | `src/api/server.ts` + `routes/*`                                             | 验 source-auth 签名、验 portal 身份头、路由到处理器                                                                                               |
| C2  | 项目       | `src/projects/project-store.ts`                                              | 建项目 = 建 group scope；owner 同时写进 `memberIds`                                                                                               |
| C3  | 技能       | `src/api/app-skills.ts`、`src/skills/skill-store.ts`                         | 技能行落库（scope 归属）；按 scope 链推导可见性                                                                                                   |
| C4  | 人格       | `POST /v1/soul`（`routes/surface.ts`）                                       | 写 scope 级 SOUL，装配上下文的身份层                                                                                                              |
| C5  | Turn / Run | `src/api/routes/turns.ts`、`src/api/app-turn.ts`、`src/core/orchestrator.ts` | 收 turn → 建 session → 起 run → 驱动 agent                                                                                                        |
| C6  | 会话       | `GET /v1/sessions[/:id]`、`sessions.getOrCreateByThread`                     | 会话列表与历史条目；**没有「建空会话」的入口**，会话由 turn 惰性 get-or-create                                                                    |
| C7  | 持久化     | `src/persistence/durable-map.ts` + Postgres                                  | 项目/技能/会话/run 的真相源                                                                                                                       |
| C8  | 沙箱       | `src/sandbox/*`、`src/skills/materialize.ts`                                 | 按 scope 提供容器与磁盘；把技能 body 物化成 `SKILL.md`；执行 AI 现写的代码                                                                        |
| C9  | MCP 出站   | `src/mcp/*`                                                                  | agent 调外部业务 MCP：org 全局工具（无 `scopeId`、admin 登记、默认 `readOnly`），部署在调用方客户端、由 core 直接出站，不经网关、不按终端用户鉴权 |

## 二、模块串联

```
                 ┌──────────────── 网关（单进程） ────────────────┐
入站请求 ───────► G1 index ──/healthz──► 200
                    │
                    └─► G6 routes/index 分发管线
                          ① 白名单匹配（只为取该端点的体上限，未命中的 404 排到最后）
                          ② G4 读体（端点级上限，超限 413）
                          ③ G3 验签 + 派生 principalId（失败 401 / 400）
                          ④ G4 限流（超限 429 + retry-after）
                          ⑤ 路由未命中 → 404（鉴权之后才告知，不向未认证者泄露路由表）
                          ⑥ 产出 Ctx{url,params,partnerId,userId,principalId,body,core} → 接口模块
                                     │
             ┌───────────┬───────────┼───────────┬────────────┬────────────┐
             G7          G8          G9          G10          G11          G12
             │           │           │           │            │            │
             └───────────┴─────┬─────┴───────────┴────────────┴────────────┘
                               ▼
                     G5 core-client（source-auth 签名 + portal 身份头）
                               ▼
   ┌───────────────────────── core ─────────────────────────┐
   C1 门面（验签/验身份）→ C2 项目 → C3 技能 → C4 人格        │
                        → C5 turn/run → C8 沙箱 → C9 MCP     │
                        → C6 会话        全部落 C7 Postgres   │
   └────────────────────────────────────────────────────────┘
                               ▼
              回流：JSON（接口模块收窄字段）／ SSE（G11 轮询 C5 后转流）
```

**依赖方向是单向的**：接口模块（G7–G12）只认 G5 与 `Ctx`，不碰 G3/G4；G3/G4 不知道任何业务；G5 不知道任何端点语义。新增一个接口 = 加一个 G 模块 + 在 G6 挂一行，其余不动。

## 三、闭环链路

### 闭环 1：建员工（G8）

```
G6 → G8 → G5 → C1 → C2 建项目（scope=group:web-project-<id>，owner 进 memberIds）
                 → C3 逐条建技能（scopeId=该项目 scope，body 内含可运行代码）
                 → C4 写人格（scopeId 同上）
      ← 201 {employee:{id,scopeId}, skills:[{name,ok,error?}], soul}
```

- 顺序不可换：C3/C4 对非 personal scope 要求「调用者是当前成员」，而成员身份由 C2 建立。
- 落库状态：1 行项目 + N 行技能 + 1 份 SOUL，全在 C7。
- 局部失败：项目建成后技能失败**不回滚**，逐条报 `ok:false`，由闭环 2 补。
- 无幂等表：同一入参重复调用产生多个项目——这是设计取舍，句柄 `scopeId` 一旦返回即由调用方保管。

### 闭环 2：补技能（G9）

```
G6 → G9 → G5 → C1 → C3（scopeId 必须是该 principal 的项目 scope，否则 core 判 403；同名 409）
      ← 201 {skill:{id,name}}
```

技能落进项目 scope 即完成，**不需要任何授权引用**；生效由闭环 4 保证。

### 闭环 3：对话（G10 → G11 → G12）

```
① G6 → G10 → G5 → C1 → C5：POST /v1/turns?async=1
        会话坐标由 G10 构造：threadRef = web:<userId>:<conversationId>
                            conversation = {kind:"group", channelRef:<项目 ref>, threadRef}
     ← 202 {status:"queued", runId, threadRef}
        （C5 惰性 get-or-create session：threadRef 没见过就新建一行落 C7；
          但 **202 返回的那一刻该行可能还没落库**，要等 worker 跑到 getOrCreateByThread）

② G6 → G11：轮询 C5 的 GET /v1/runs/:id（无 runId 时先 GET /v1/runs?threadRef= 找 active）
     ⇒ SSE：partial（累计全文）/ activity（工具活动）/ stale / alive / done / failed / idle
     终态或客户端断开 → 关流，循环退出

③ G6 → G12 → C6：GET /v1/sessions?principalId=[&scope 本地过滤] 列表；GET /v1/sessions/:id?viewer= 历史
     ⇒ 流断了也能把最终回复读回来（历史来自 C7，不依赖 SSE 是否收全）
```

闭环点：`runId` 把 ① 与 ② 串起来，`threadRef` 把 ①②③ 串起来；三者都由网关生成或透传，外部不需要理解其构造规则。

**会话语义（四条，最容易被误解）**

1. **新会话 = 新 `conversationId`**（同一 `scopeId` 下），复用同一个 = 继续该会话并带上全部历史。**没有、也不需要独立的「建会话」接口**。
2. core 根本没有「空会话」这种东西：会话的诞生点只有四个（turn 路径、fork、delivery 收件人、`spawnSession`），对我们开放的只有 turn 路径；`spawnSession` 只挂在 `POST /v1/conversations`（agent 自 API，无 capability token 直接 401），而且**必须带 `text`**——建完立刻 seed 一个 turn，被拒就 discard。
3. 所以「新对话」是**调用方本地动作**：本地生成新 `conversationId` + 本地占位行，没发消息就本地丢掉，qm 侧无痕（web-ui 正是这么做的：`addPendingSession` 塞一条 `id:""` 的占位行，`dropPendingSession` 清理）。
4. **没发过消息的会话不会出现在 `GET /v1/sessions` 里**；发了第一条也要等 worker 落库后才读得到 → 调用方应以自己发出的 `conversationId` 为准渲染列表，不要依赖立即回读。

### 闭环 4：技能生效（C3 → C5 → C8）

```
下一轮 turn：C5 orchestrator 按 scope 链 + grant 实时推导可见技能（不读存储态）
   → 命中闭环 1/2 写入的项目 scope 技能
   → C8 沙箱：技能 body 物化为 SKILL.md（hash 命中则跳过重写），进 agent 上下文
   → agent 依 body 里的代码块在沙箱内**现生成代码文件并执行**（沙箱磁盘按 scope 持久，写一次可复用）
   → 结果融进本轮回复 → 回到闭环 3 的 SSE
```

闭环点：技能从「写入」到「生效」不需要重启、不需要授权、不需要第二次装配——可见性每轮重算。

### 闭环 4b：MCP 旁路（C9，**不经网关**）

```
① 登记（运营侧一次性）  PUT /v1/admin/mcp-servers/:id → authorizeAdmin → 存 mcp_servers 表
                        默认先 probe tools/list，出站不可达直接 400 unreachable
② 发现（core 自维护）    启动即刷新 + registry 变更 + 每 5 分钟定时
                        → 工具名命名空间化 <serverId>_<toolName>，每 server ≤64 个
③ 注入（每 turn）        唯一过滤是 readOnly → org 全局，所有员工看到同一批工具
④ 调用（模型决定）       core 直接出站（带 server 配置的 bearer / client-credentials）
                        → 结果 clamp 60,000 字符回模型；principalId **只进审计、不进 MCP 请求**
⑤ 回流协议面            工具活动/结果 → run.activity / partial → G11 的 SSE activity/partial/done
                        （strict 姿态下需人批的工具，审批请求也经 SSE 出来，回执走 G10 的 approval 字段）
```

闭环点：协议白名单里**没有任何 MCP 端点**，适配器也不需要 admin 身份——MCP 的登记与调用完全在 core 侧闭合，网关只负责把结果透出去。

### 闭环 5：身份与鉴权（G3 → G5 → C1）

```
入站：G3 用 partnerId 选密钥验签（时间窗 + 常量时间比对）→ 派生 principalId = <partnerId>_<userId>
出站：G5 每个 core 调用带 ① source-auth 签名（网关持有的 core 密钥，含 nonce）
                        ② x-portal-identity（p = principalId，短 TTL）
core：C1 验签 + 验身份，principal 必须是 internal 才放行 user-scoped 路由与 web turn
      → principalId 进审计与上下文（C9 的 MCP 调用只带 org 级凭据，principal 不透传给 MCP）
```

闭环点：外部只能提供 `userId`，身份在 G3 单向派生、在 C1 二次校验；越权访问他人 scope 由 C2/C3 的成员判定挡回 403。派生是**单射**的：`partnerId` 字符集不含 `_`，所以第一个 `_` 就是分隔符（若两边都允许 `_`，`acme`+`x_y` 与 `acme_x`+`y` 会撞成同一个 principal、共享员工与会话，而签名校验拦不住）。时间窗只保证**新鲜度**、不防重放（网关无状态、不存 nonce），非幂等端点的去重归调用方。

**没有登录，也没有注册**：qm 侧不存在「用户账号」——`identity.classify` 默认返回 `internal`（只有被显式停用或标记 external guest 才不是），而 `createProject` 只检查这一点 → **一个从未出现过的 `principalId` 第一次调用就能建员工**。也没有用户表：本协议不同步目录，这些人不在花名册里，但项目/技能/会话/run 全按 `principalId` 与 scope 归属，照常工作。代价是「这个 `userId` 是谁」完全由签名背书 → **`userId` 的稳定性与不可伪造性是调用方的责任**。

**管理面是另一条链，不在协议内**：portal 登录（OIDC → 签名会话 cookie）→ admin 插件（自己不做登录，只信任 portal 合成的身份）→ core 查 `admin_grants` 表判定。协议派生的 `<partnerId>_<userId>` 不在该表里、白名单也没有 admin 路径 → **永远进不了管理面**；反过来适配器也从不出示 `x-admin-actor`。

### 闭环 6：失败与配额（G4 / G3 / G5）

| 产出模块 | 状态 | 场景                                              | 是否可重试                                                          |
| -------- | ---- | ------------------------------------------------- | ------------------------------------------------------------------- |
| G4       | 413  | 体超端点上限（读体阶段，先于验签）                | 缩小请求                                                            |
| G3       | 401  | 缺头 / 未知 partner / 时间戳非法或过期 / 签名不符 | 修签名后重试                                                        |
| G3       | 400  | `userId` 非法（含冒号、超字符集）                 | 否                                                                  |
| G4       | 429  | 每 partner 每分钟配额耗尽（带 `retry-after`）     | 退避重试                                                            |
| G6       | 404  | 路径不在白名单 / 版本前缀不识别                   | 否                                                                  |
| G8/G9    | 409  | 同一 scope 内技能重名                             | 换名或走新员工                                                      |
| C1→G5    | 403  | scope 不属于该 principal                          | 否                                                                  |
| G5       | 502  | core 不可达或响应形状异常（附 `upstream.status`） | 可重试，但 `POST /v1/assemble` 不可盲重（会建重复项目），改用 G9 补 |
| G1       | 500  | 网关自身异常（顶层 catch，日志不含密钥）          | 可重试                                                              |

统一形状 `{error, message}`；限流计数是每实例内存态（可丢弃、可重算），不入 C7。

## 四、闭环总览

```
建员工 ──scopeId──► 补技能 ──技能行──► 对话 ──runId──► 事件流 ──终态──► 会话历史
   │                   │                │                              ▲
   └── 人格写入 ────────┴── 下一轮可见性推导 ── 沙箱物化/执行 ── MCP 出站 ┘
                    （身份派生贯穿全链：入站验签 → portal 身份头 → core 校验/审计）
```

七条链路共用同一套横切件（G2–G6），任何一条断了都能从 C7 的持久化状态重新接续：项目/技能/人格/会话/run 全在 Postgres，网关自身无状态，可水平扩展与蓝绿替换。

另有两条**旁路**不经过网关，只在部署与运维时打交道：管理面（portal + admin 插件 + `admin_grants`）与 MCP（core admin 登记 + core 直接出站）。细节与坑见 03 的对应两节。
