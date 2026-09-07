# 模块实现方案

前提结论：02 的七条链路全部用 core **现有端点**即可闭合，**core 零改动**（D1/D2 已定，见末尾）。

按 02 的模块编号逐个给出实现细节：输入输出、关键逻辑、依赖的 core 契约、失败处理。所有 core 契约均已对过代码。

## G2 `src/config.ts`

env → 强类型配置 + `bootProblems(cfg): string[]`，问题非空则由 G1 拒启（fail-closed，不降级运行）。

| env                          | 必需 | 校验                                                                                                                                                                                                  |
| ---------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                       | 否   | 默认 8211；非整数或负数回落默认（不像 chassis `portFromEnv` 那样把 `NaN` 交给 listen）                                                                                                                |
| `CORE_API_URL`               | 否   | 回落 chassis 默认 `http://localhost:8080`；去尾斜杠；显式配成空值（如 `/`）则拒启                                                                                                                     |
| `CORE_SIGNING_SECRET`        | 是   | 非空（chassis 已解析为 `string \| undefined`）                                                                                                                                                        |
| `PORTAL_IDENTITY_SECRET`     | 否   | 缺省依次回落 chassis 的 `PORTAL_IDENTITY_SECRET` → 本次解析出的 `signingSecret`（与 chassis 行为一致）                                                                                                |
| `PARTNER_CREDENTIALS`        | 是   | `<partnerId>=<secret>[,…]`；id 合 `^[a-z][a-z0-9-]{0,31}$`（**不含 `_`**，理由见 G3）、secret ≥32 字符、id 不重复、**secret 也不得重复**（两个 partner 共用一把密钥就能互换 `x-partner-id` 冒充对方） |
| `PARTNER_RATE_LIMIT_PER_MIN` | 否   | 整数 ≥0，默认 120，`0` = 关闭                                                                                                                                                                         |

导出 `PartnerConfig { coreApiUrl, signingSecret, identitySecret, partners: Map<string,string>, ratePerMin }`。密钥只进内存，任何日志/banner 只打 `partnerId`。

## G3 `src/auth.ts`

两个纯函数，无 IO，可单测穷举。

**`verifySignedRequest({partners, method, pathWithQuery, raw, headers})`**

```
canonical = `${method}\n${pathWithQuery}\n${raw}`        // GET 的 raw 为 ""，pathWithQuery 含 query
expected  = signRequest(secret, timestampSec, canonical) // = "v0=" + HMAC_SHA256_hex(secret, `v0:${ts}:${canonical}`)
```

- 头：`x-partner-id`、`x-timestamp`、`x-signature`。
- 校验顺序（每步失败即返回 401 + 具体 reason）：partner 缺失/未知 → 缺签名 → 时间戳非有限 → `|now - ts| > 300s`（reason：`timestamp outside the 300s freshness window`）→ 常量时间比对不符。
- 常量时间比对：对两侧各做一次 HMAC 再 `timingSafeEqual`（避免长度泄露）。
- **时间窗不是重放防护**：网关无状态，不存 nonce/用过的签名，300s 内逐字重放识别不出来。真要防重放就得入库记 nonce，与 D4（无状态、可水平扩展）相冲；代价写进 `spec/protocol.md` §1，去重责任归调用方。
- `signRequest` / `canonicalPayload` 从 `plugins/chassis/src/source-auth-sign.ts` import，**验签逻辑本身留在本插件**：chassis 属 core，改它会在每次 upstream 同步时冲突，且波及全部插件。

**`principalFor(partnerId, rawUserId)`**

- `userId` 必须合 `^[A-Za-z0-9_-]{1,64}$` → 否则 400（**禁冒号**：scope id 与 threadRef 都按首个 `:` 切分，带冒号会破坏归属判定）。
- 返回 `principalId = ${partnerId}_${userId}`。
- **派生必须是单射**：`partnerId` 的字符集刻意不含 `_`（G2），所以第一个 `_` 就是唯一分隔符。若两边都允许 `_`，`acme` + `x_y` 与 `acme_x` + `y` 会得到同一个 `principalId`——两个持不同密钥的合作方共享同一份员工/会话/记忆，签名校验拦不住（它只证明「请求来自某个持密钥方」）。
- 入站体里出现的 `principalId` 字段一律忽略，杜绝自报身份。

**身份模型：没有登录，也没有注册**

- qm 侧不存在「用户账号」：`identity.classify(externalId)` 默认返回 `internal`，只有被显式停用或标记 external guest 才是 `guest`（`src/identity/identity-service.ts:41-44`），而 `createProject` 只检查这一点（`src/api/app-sessions.ts:305-307`）→ **一个从未出现过的 `principalId` 第一次调用就能建员工**。
- 没有用户表：`directory_members` 只在有人调 `POST /v1/directory` 或 Slack 同步时才有数据。本协议不同步 → 这些人不在花名册里，但项目/技能/会话/run 全按 `principalId` 与 scope 归属，照常工作（代价：AI 只见 id、不解析显示名）。
- 没有会话态：每个请求自带签名，验签即得身份，无 token 交换、无 cookie、无登录/登出端点。
- **责任转移**：qm 不验 `userId` 真伪——签名有效即等于调用方断言「这个 userId 是我自己的用户」。网关只保证三件事：只有持密钥者能断言、`(partnerId, userId) → principalId` 是单射、`userId` 字符集受限（不破坏 scope/threadRef 解析）。因此 **`userId` 的稳定性与不可伪造性是调用方的责任**：若它由前端直接传、或用户能改自己的 id，就等于能占用别人的 `principalId`、拿到别人的员工与会话。
- 无生命周期管理：同一个 `userId` 再来，员工/记忆/会话都跟着回来；换 `userId` 就是换人。v1 不提供停用、注销、改名。

## G4 `src/transport.ts`

| 导出                               | 行为                                                                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `sendJson(res, status, body)`      | 头带 `cache-control: no-store`、`x-content-type-options: nosniff`                                                         |
| `readJsonBody(req, maxBytes)`      | 用 chassis `readBody`；超上限捕获 `PayloadTooLargeError` → `413 payload_too_large`；非对象 → `400 bad_json`               |
| `createRateLimiter(perMin)`        | 每 partner 固定 60s 窗口计数（`Map<partnerId, {windowStart, count}>`）；`perMin=0` 直通；超限返回剩余秒数供 `retry-after` |
| `sseEvent(res, name, data)`        | 写 `event: <name>\ndata: <json>\n\n`                                                                                      |
| `sleep(ms)`                        | `setTimeout` + `unref()`                                                                                                  |
| `errorBody(code, message, extra?)` | 统一 `{error, message, …}`                                                                                                |

限流计数是**每实例内存态**：可丢弃、可重算，属「durable by default」的缓存例外，不入库；多实例时配额按实例独立计算（有意的取舍，写进 `spec/protocol.md`）。

## G5 `src/core-client.ts`

**每个出站调用都带两把凭据**（core 的 `src/api/server.ts:270-286` 对 user-scoped 路由与 `surface:"web"` 的 turn 强制要求 portal 身份，且身份里的 principal 必须被识别为 internal）：

```
coreFetch(deps, method, pathWithQuery, rawBody, principalId)
  ① path = withSourceAuthNonce(pathWithQuery, CORE_SIGNING_SECRET)      // 追加 _sourceAuthNonce
  ② headers = signedHeaders(CORE_SIGNING_SECRET, method, path, rawBody)  // x-timestamp / x-signature
            + { "x-portal-identity": mintPortalIdentity({p: principalId, exp: now + 60_000}, identitySecret) }
  ③ fetch(coreApiUrl + path, {method, headers, body?, redirect:"manual", signal: AbortSignal.timeout(15s)})
```

配套：`coreJson(...)`（解析 JSON，形状异常抛 `upstream_error`）、`relayResponse(res, upstream)`（流式回传，剔除 hop-by-hop 头）、`UpstreamError{status, body}`。G5 不理解任何端点语义，只做「签名 + 发送 + 回流」。

## G6 `src/routes/index.ts`

固定管线，顺序不可换（体参与签名，所以**先读体后验签**）。验签基准是 `req.url` 原文（HTTP request-target），**不是** `new URL(...)` 规范化后的 `pathname + search`：WHATWG URL 会吃掉尾部 `?`、折叠 `.`/`..` 段、改写百分号编码大小写，而调用方签的是它发出去的字节，两者一旦不一致就是 fail-closed 的 401。`new URL` 只用于路由匹配与参数解析，解析不了就 400 `malformed request target`：

```
① findRoute(routes, method, pathname)      // 只为取该路由的 body 上限；未命中的 404 留到最后
② readJsonBody(req, limit ?? 512_000)      → 413 / 400
③ verifySignedRequest(...)                 → 401
④ principalFor(partnerId, userId)          → 400      // userId：POST 取 body，GET 取 query
⑤ rateLimiter.take(partnerId)              → 429 + retry-after
⑥ 路由未命中                                → 404      // 排在鉴权之后，不向未认证者泄露路由表
⑦ route.handle(Ctx)
```

`Ctx = { req, res, url, params, partnerId, userId, principalId, body, core }`——**只放派生好的身份**与一个按本次 `principalId` 绑定的出站调用 `core(method, pathWithQuery, body?)`，接口模块拿不到原始 header，也拿不到裸 `fetch`，物理上无法各自重做鉴权或绕过签名。路由表是一维数组，一行一接口：

```
{ method:"GET",  path:"/v1/employees",      limit: 0,       handle: handleEmployees }
{ method:"POST", path:"/v1/assemble",       limit: 512_000, handle: handleAssemble }
{ method:"POST", path:"/v1/skills",         limit: 160_000, handle: handleSkillCreate }
{ method:"POST", path:"/v1/turn",           limit: 64_000,  handle: handleTurn }
{ method:"GET",  path:"/v1/events",         limit: 0,       handle: handleEvents }
{ method:"GET",  path:"/v1/sessions",       limit: 0,       handle: handleSessions }
{ method:"GET",  path:"/v1/sessions/:id",   limit: 0,       handle: handleSessionById }
```

版本策略：版本在路径（`/v1`），未匹配一律 404；响应统一附 `x-partner-protocol: 1`。

## G7 `routes/employees.ts`

```
core: GET /v1/projects?principalId=<principalId>   → 200 {projects:[ProjectView]}
出参: 200 {employees:[{id, name, scopeId, createdAt}]}
```

`ProjectView` 含成员名单等内部结构（`src/api/app-helpers.ts:221-…`），**必须收窄**后透出，不做原样转发。core 非 200 → `502 upstream_error` 附 `upstream.status`。

## G8 `routes/assemble.ts`

三步串行编排，**顺序由 core 的成员判定决定**：

| 步  | core 调用                                                              | 契约（已核实）                                                                                                                                                                                                                                                                    |
| --- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `POST /v1/projects {principalId, name}`                                | `201 {project:{id, name, scopeId, …}}`；`auth:"either"`，source 签名即可，不需 admin（`routes/projects.ts:22-32`）。`projects.create` 把 `ownerId=principalId` 且 `memberIds=[ownerId]`（`projects/project-store.ts:170-180`）→ 创建者立即成为该 group scope 成员                 |
| 2   | 逐条 `POST /v1/skills {principalId, scopeId, name, description, body}` | `201 {skill:{id,name,…}}`；同 scope 同名 `409 {error:"exists"}`；`scopeId` 非本人 personal 时要求 `managesScope(principalId, scopeId)` = **当前成员**（`routes/surface.ts:904-962`）；`org:`/`team:` 一律 403；**无 `files` 字段**（`app-skills.ts:381-413`）→ 只有 markdown body |
| 3   | `POST /v1/soul {scopeId, content, actorId: principalId}`               | `200`；`auth:"either"`；非 personal scope 同样要求 `managesScope`（`surface.ts:1360-1386`）                                                                                                                                                                                       |

入参校验（进 core 之前全部挡掉）：`name` 非空 ≤200；`skills` ≤20 条、请求内不得重名、每条 `name` 合 `^[a-z0-9][a-z0-9_-]{0,63}$`、`description` 非空 ≤500、`body` 非空 ≤128KB；`soul` ≤8KB。

失败语义：

- 步 1 失败 → `502`。**不要把它当作「无状态、可盲重」**：502 同时覆盖「请求根本没到 core」与「core 已提交但响应在回路上丢了/超时」，而 `createCoreCall` 的 15s 超时分不出这两者；另外 `201` 但响应里缺 `id`/`scopeId` 也走 502，此时项目已经存在。spec §4/§7 因此要求调用方重试前先 `GET /v1/employees` 核对。
- 步 2 单条失败 → 记 `{name, ok:false, error}`，**继续下一条**（串行而非并发，避免同名竞态），项目不回滚。
- 步 3 失败 → `soul:false` + `error`，employee 仍有效。
- 只要项目建成 → `201 {employee:{id, scopeId, name}, skills:[…], soul}`。

**无登记表、无幂等**：不查已有项目、不复用 scope；重复调用产生多个项目。`scopeId` 是返回给调用方保管的句柄，补技能走 G9。

## G9 `routes/skills.ts`

```
入参: {userId, scopeId, name, description, body}     // 校验同 G8 的单条规则
网关: 只校验 scopeId 以 "group:" 开头（格式校验，不自建授权表）
core: POST /v1/skills {principalId, scopeId, name, description, body}
出参: 201 {skill:{id, name}} / 409 exists / 403 forbidden（core 的成员判定原样透出，不泄露 scope 是否存在）
```

core 回 4xx 时走 `relayProblem`：优先用 core 自己的 `error`/`message`，缺失时按状态码回落到协议已声明的码（400→`bad_request`、403→`forbidden`、404→`not_found`、409→`exists`）——**不得造出 spec 错误表以外的码**。

技能写进项目 scope 即生效路径就绪：core 每 turn 按 scope 链实时推导可见性（`core/orchestrator.ts` → `skills.visibleFor`，`skills/skill-store.ts:230-240`），不是存储态 → 无需授权、无需重启。

## G10 `routes/turn.ts`

会话坐标由网关构造，外部不接触规则：

```
threadRef    = `web:${userId}:${conversationId ?? "default"}`      // conversationId 合 ^[A-Za-z0-9._-]{1,120}$
conversation = { kind: "group", channelRef: <scopeId 去掉 "group:" 前缀>, threadRef }
core body    = { surface:"web", actor:{externalId: principalId}, conversation,
                 liveActor:true, deliveryTarget: threadRef, text, …白名单可选字段 }
core         = POST /v1/turns?async=1     （auth:"source"，routes/turns.ts:167）
出参         = 202 {status:"queued", runId, threadRef}             （app-turn.ts:441）
             / 200 终态（去重命中，原样回流 + threadRef）
             / 403 {error:"refused", message:<core 的 reason>}     （core 的 {status:"refused",reason} 映射成协议错误形状）
```

- `text` 非空必填；可选字段白名单透传：`model`、`harness`、`thinkingLevel`、`timezone`、`approval{requestId,approved,scope}`；未知字段丢弃。
- 附件、`proactiveOpener` 等 core 支持但本协议 v1 不开放。

**会话语义（不开「建会话」端点的依据）**

- core **没有「建空会话」这条路**：会话由 turn 惰性创建——orchestrator 拿到 `threadRef` 后调 `sessions.getOrCreateByThread(threadRef, "group", scopeId, …)`（`src/core/orchestrator.ts:967`，安检分支 L691 同理），有就复用、没有就建。判断依据是 **`threadRef`**，不是 `conversationId` 本身。
- 因此 **新会话 = 同一 `scopeId` 下一个新 `conversationId`**，不需要第七个端点；复用同一个 = 继续该会话并带上全部历史。
- core 唯一的显式建会话出口 `POST /v1/conversations` 对我们不可用：无 capability token 直接 `401 capability_required`（agent 自 API）+ 要 live-person capability，且**必须带 `text`**——它 `spawnSession` 后立刻 seed 一个 turn，被拒就 `discardSession`（`src/api/routes/surface.ts:90-137`）。也就是说 core 的会话诞生路径**永远带着第一条消息**。
- **时序坑**：`202 {runId}` 返回时 session 行**还没落库**，要等 worker 跑到 `getOrCreateByThread`。所以「发完第一条消息立即 `GET /v1/sessions` 回读」可能读不到；调用方应以自己发出的 `conversationId` 为准在本地渲染列表项（web-ui 就是这么做的：`addPendingSession` 造一条 `id:""` 的本地占位行，没发消息就 `dropPendingSession` 丢掉）。

## G11 `routes/events.ts`

两种入口，同一套轮询循环：

```
?userId=&runId=                     → 直接轮询该 run
?userId=&scopeId=&conversationId=   → 先 GET /v1/runs?threadRef=<构造> 取 {runId|null, queued?}
                                       runId 为 null → 发 idle 事件后关流
```

轮询 `GET /v1/runs/:id`（`auth:"source"`）读 `{status, partial, activity, alive, stale, result, replyComplete, startedAt, finishedAt}`：

| 事件       | 触发                                                             | 载荷                                                                        |
| ---------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `partial`  | `partial` 变长（发累计全文）                                     | `{partial}`                                                                 |
| `activity` | `activity` 数组变长                                              | `{activity, startedAt}`                                                     |
| `stale`    | `stale` 布尔翻转（初值 `false`，所以开流不会白发一次）           | `{stale}`                                                                   |
| `alive`    | 心跳窗口到点且 `alive===true`                                    | `{at}`                                                                      |
| `done`     | `status ∈ {done, failed}` 或 `result != null` 或 `replyComplete` | `{status, result, partial, activity, replyComplete, startedAt, finishedAt}` |
| `failed`   | 两次取上游都失败，或非 2xx                                       | `{reason}`                                                                  |
| `idle`     | 入口二找不到 active run                                          | `{}`                                                                        |

参数：正常轮询 100ms、`stale` 时 1s；心跳 15s（无事件时写 `: ping` 注释行，穿透代理空闲断连）；`stale` 后宽限 10min。响应头 `text/event-stream; charset=utf-8`、`cache-control: no-cache, no-transform`、`x-accel-buffering: no`；开流先写 `: open`。退出条件是 `req.on("close")` 置的标志 **或** `res.destroyed / res.writableEnded`（只看 `req` 的 close 在某些代理下不够），每轮取上游前后各查一次，命中即 `return`，避免泄漏轮询与写已关闭的流。

**6min 空闲关流的准确含义**：`run.alive === true` 会每轮刷新 `lastProgressAt`，所以 `IDLE_MS` 只在「core 不再说它活着」时才可能到点。这是有意的：长时间跑工具/思考的运行不应该被网关提前掐掉，存活与否的权威在 core（`src/sandbox/process-poll.ts`）。代价是**网关不设绝对时长上限**：若 core 因自身 bug 永远回 `alive:true`，这条流会以 100ms 间隔无限轮询直到客户端断开。因此 spec §4 明确要求调用方自设总时长上限，不得依赖网关关流。

## G12 `routes/sessions.ts`

```
GET /v1/sessions?userId=[&scopeId=]
                                  → core GET /v1/sessions?principalId=
                                    → **网关按 scopeId 本地过滤**（core 的 listSessions 只接 principalId，
                                      不支持 scope 过滤，见 surface.ts:459-463）
                                    出参收窄 {sessions:[{id, type, scopeId, threadRef, title,
                                                          createdAt, lastActivityAt, working, awaitingInput}]}
GET /v1/sessions/:id?userId=&tailTurns=&sinceSeq=&beforeSeq=
                                  → core GET /v1/sessions/:id?viewer=<principalId>&…
                                    （surface.ts:1402，auth:"source"）
```

只读。`:id` 先过 `^[A-Za-z0-9_-]{1,64}$`（core 的 session id 是 `randomUUID()`）；不合字符集与 core 回 404 **返回同一个** `{error:"not_found", message:"unknown session"}`，不区分「格式不对」与「不存在」，避免拿它探测 id 形状。含 `/` 的 id 段数与路由不匹配，chassis router 直接 404，走不到 handler。`tailTurns` / `sinceSeq` / `beforeSeq` 在网关侧按 core 的规则（整数，分别 ≥1 / ≥0 / ≥1）先校验再透传，都不传就是全量历史。历史来自 core 的持久化，SSE 断流后仍可取回最终回复。

字段依据 `Session` 类型（`src/types.ts:63-84`）：**没有 `updatedAt`**，时间只有 `createdAt` 与 `lastActivityAt`（排序用后者）；`working` / `awaitingInput` 让调用方不开 SSE 就能渲染「正在跑 / 等人批」。`archived` / `pinned` / `color` / `forkedFrom` 等属 core 人类面语义，不透出。

`scopeId` 过滤是必需的：调用方的 UI 是「左栏按员工分组列会话」，而 core 只能给「该用户的全部会话」。单用户会话量级很小，网关内存过滤成本可忽略。

**没发过消息的会话不在列表里**（会话由 turn 惰性创建，见 G10）——这是正确行为，不是缺陷；调用方的「新对话」应该是本地占位项。

**会话整理类能力一律不开**：core 有 `POST /v1/sessions/:id`（改 title/archived/pinned/color）、`POST /v1/sessions/:id/title`（让 AI 重生成标题）、`/fork`、discard，都不在白名单。调用方要自定义标题，自己存 `conversationId → title` 映射（core 的 `title` 是自动/AI 生成的，不保证符合调用方命名习惯）。

## G1 `src/index.ts`

```
cfg = readConfig(env); problems = bootProblems(cfg)
problems.length → 逐条 console.error("[partner-protocol] FATAL: …") 后 throw（拒启）
server = createServer(handler)
handler: GET /healthz → 200 {ok:true}（免签）
         其余 → G6 dispatch
         顶层 catch → 打日志（不含密钥）+ 500 internal_error；headersSent 时只 res.end()
listen(PORT) → banner 打印端口 + partnerId 列表
```

无 DB、无启动期外部依赖：进程可在 core 之前起，首次调用时才碰 core。

## 管理面（不经网关）

协议面没有登录，管理面照常用 qm 现成的三层，两条链互不相干：

1. **人类登录 = portal**（`plugins/portal`）：OIDC → 签名会话 cookie `portal_session` → 反代到 web-ui / admin，并给上游合成 `admin=<principal>` cookie + `x-portal-identity`。
2. **管理 UI = admin 插件**（`plugins/admin`，默认端口 8090）：自己不做登录，只信任 portal 合成的身份（先验 `x-portal-identity`，回落 `admin` cookie；`plugins/admin/src/index.ts:88-94`），再用 god-key 签名 + `x-admin-actor: <principal>@<org>` 转发 core `/v1/admin/*`（同文件 L112-129）。插件自身就警告：必须留在私网、只经 portal 访问。
3. **授权判定 = core**：查 `admin_grants` 表（`ADMIN_GRANTS` env 只在表空时种一次；生产不配 = 一个管理员都没有）→ 不命中 403。**能不能管，只看这个 principal 在不在表里，与登录方式无关。**

三条推论：

- 协议派生的 `<partnerId>_<userId>` **永远不是 admin**（不在 `admin_grants` 表），且白名单没有 admin 路径 → 双重挡死。
- 适配器**从不出示 `x-admin-actor`**：`CORE_SIGNING_SECRET` 只用于 source 签名调那 6 类端点（D3 砍掉 pack import 的直接收益）。
- 运营侧看数据不需要协议配合：员工/会话/技能/文件都在 core Postgres，admin UI 的 scopes / sessions / skills / files 视图直接可见；差别只是用户名显示为 `<partnerId>_<userId>` 而非人名（不做目录同步）。

## MCP（不经网关）

登记走 core 的 admin API，调用走 core 直接出站；协议白名单里没有任何 MCP 端点。

```
① 登记（运营侧一次性）
   PUT /v1/admin/mcp-servers/:id {name,url,auth,bearerToken|clientId+clientSecret,readOnly,enabled,validate}
   → authorizeAdmin（查 admin_grants）→ 存 mcp_servers 表
   → 默认先 probe：对该 url 调 tools/list，不可达直接 400 unreachable（= D2「出站可达」的验收点）
② 工具发现（core 自维护快照）
   启动即 refresh；之后 registry onChange + 每 5 分钟定时
   → 每个 enabled server 调 listTools()，每 server ≤64 个；工具名命名空间化 <serverId>_<toolName>，重名第一个 server 赢
③ 注入 agent（每 turn）
   mcpDefs.filter(d => !readOnly姿态 || d.readOnly) —— 唯一过滤就是 readOnly
   → org 全局，所有员工/所有 scope 看到同一批工具，无法按员工或按用户收窄
④ 调用（模型决定）
   callMcpTool(name,args) → mcp.call(name,args,principalId) → 出站 HTTP（bearer / client-credentials）
   → 结果 clamp 60,000 字符回模型；审计记 mcp.call，principalId **只进日志、不进 MCP 请求**（D1 的代码依据）
⑤ 回流协议面
   工具活动/结果 → run.activity / partial → G11 的 SSE activity/partial/done
   （strict 姿态下需人批的工具，审批请求也经 SSE 出来，回执走 G10 的 approval 字段）
```

出处：`src/api/routes/admin/mcp-servers.ts`、`src/mcp/mcp-server-store.ts`、`src/mcp/mcp-tool-service.ts`、`src/harness/pi-tools.ts:2758-2760`、`src/tools/primitives.ts:902-909`。

坑（均已核实）：

| 坑                        | 事实                                                                                          |
| ------------------------- | --------------------------------------------------------------------------------------------- |
| **默认只读**              | `readOnly: b.readOnly !== false` → 不显式传 `readOnly:false` 就是只读                         |
| **放开写是全局的**        | 一旦 `readOnly:false`，对全实例所有员工生效，无法按员工/用户收窄                              |
| **admin UI 里没有这一页** | admin 插件的 `WRITES`/`READS` 白名单不含 `mcp-servers` → 经它转发 404，只能用 curl/脚本调 API |
| **登记即验证**            | 默认 `validate` → tools/list 打不通就 400，不会存下半个坏配置（跳过传 `validate:false`）      |
| **改配置最多 5 分钟生效** | 快照靠 onChange + 5 分钟定时；重新 PUT 一次触发 onChange 立即刷新                             |
| **url 形状**              | 不得带凭据/query/fragment；`id` 合 `^[a-z][a-z0-9-]{1,39}$`                                   |
| **密钥不出 core**         | bearerToken/clientSecret 只存 `mcp_servers` 表，永不注入沙箱                                  |
| **`enabled:false`**       | 工具仍在快照里，调用时报 `MCP server <id> is not available`                                   |

登记示例（god-key 签名 + `x-admin-actor`）：

```
PUT /v1/admin/mcp-servers/acme-crm
{ "name": "ACME CRM", "url": "https://mcp.acme.example/mcp",
  "auth": "client-credentials", "clientId": "…", "clientSecret": "…",
  "readOnly": false, "enabled": true }
→ 200 { ok:true, server:{…已脱敏…}, tools:["query_customer", …] }
```

## spec/

- **`protocol.md`**：凭据与签名算法（含 canonical 逐字定义、时间窗、头名）、`principalId` 派生规则与 `userId` 字符集、6 个端点的请求/响应/错误形状、错误码表、限流与配额表（含「配额按实例计」）、SSE 事件表与重连方式、版本策略、非幂等与重试约束、技能形态约束（只有 markdown body、代码内联、无附件/多文件/二进制）。
- **`partner-client.mjs`**：零依赖可跑示例（`node spec/partner-client.mjs`）——`headers()` 生成三个签名头 → `assemble` → `turn` → `events`（裸 `fetch` 流读 + 按 `\n\n` 切块）→ `sessions` 列表与历史 → `employees`；配置只从四个环境变量读：`PARTNER_BASE_URL` / `PARTNER_ID` / `PARTNER_SECRET` / `PARTNER_USER_ID`，缺 `PARTNER_SECRET` 直接退 1。它由 `test/client.test.ts` 端到端跑过，不是写完就烂的样例。

## test/

| 文件               | 覆盖                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth.test.ts`     | 正确签名通过；体/查询/方法任一被改 → `signature mismatch`；缺 `x-partner-id`/`x-signature`、未知 partner、时间戳非数字、超 300s → 401 且 reason 逐字正确；`userId` 带冒号/超字符集/超长/非字符串 → 400；派生结果 = `partnerId_userId`；**派生单射**（穷举 partner×user 组合无碰撞，且首个 `_` 的位置等于 partnerId 长度）；body 里的 `principalId` 被忽略                                                                                                                                                                                                                                           |
| `assemble.test.ts` | 假 core client 断言**调用顺序与每个 body**（projects → skills 逐条 → soul）；技能 409 时仍 201 且 `skills[].ok=false`、后续技能继续建；soul 失败 → `soul:false`；projects 失败 → 502 且**未调用** skills/soul；连调两次得到两个不同 `scopeId`（非幂等）；超 20 条/超 128KB/请求内重名 → 400                                                                                                                                                                                                                                                                                                         |
| `routes.test.ts`   | 白名单外 404、错方法 404、缺 `userId` 400；**签名盖的是 wire 上的 request-target**（用 `node:http` 发一个带 `..` 段的路径，签原文 → 200；签另一个 target → 401）；`turn` 构造的 `threadRef`/`conversation`/`deliveryTarget` 正确、未知字段被丢弃；`scopeId` 非 `group:` → 400；**relay 兜底码**（core 不带 `error` 时 403→`forbidden`、409→`exists`、400→`bad_request`）；`events` 在假 core 上产出 `partial → activity → done` 并关流、无 active run 产出 `idle`、上游 500 两次产出 `failed`、客户端断开后停止轮询；`employees`/`sessions` 字段收窄                                                |
| `gateway.test.ts`  | 直接跑 `readConfig`/`bootProblems`（默认端口 8211、默认配额 120、去尾斜杠、多 partner 共存、identity 密钥回落签名密钥、`CORE_API_URL=/` 拒启）；再起子进程 + 假 core HTTP：缺 `PARTNER_CREDENTIALS` / `CORE_SIGNING_SECRET`、id 非法（大写、**含 `_`**）、secret <32、id 重复、**secret 重复** → 拒启且日志逐条有 FATAL；`/healthz` 免签 200；未签名 401；白名单外 404；出站带 source-auth 签名 + `x-portal-identity`（验签后 `p` = 派生 principal）且从不碰 admin 路径；banner 不含 secret；配额 1 时第二个请求 429 + `retry-after`；完整链路 assemble → turn → events(SSE) → sessions → employees |
| `support.ts`       | 共用夹具（不是测试文件，`node --test "test/*.test.ts"` 不会拾到它）：签名头生成、假 core 记录器（按 `principalId` 注入 `Ctx.core`，记下每次调用的 method/path/body）、进程内网关、子进程网关 + 假 core HTTP、SSE 解析                                                                                                                                                                                                                                                                                                                                                                               |
| `client.test.ts`   | 起子进程网关 + 假 core，真跑 `spec/partner-client.mjs`：退 0、输出里依次出现 employee/skills/soul/turn/partial/done/sessions/history/employees、对 core 的调用序列正好是 projects→skills→soul→turns→runs×2→sessions→sessions/:id→projects；缺 `PARTNER_SECRET` 时退 1 并提示                                                                                                                                                                                                                                                                                                                        |

拒启类用例不靠环境变量传空字符串（Windows 上空值环境变量会被丢弃），而是直接把键从 env 里删掉；默认值与回落链则直接调 `readConfig`/`bootProblems` 验，不起子进程。

验证顺序：本插件 `typecheck` + `node --test "test/*.test.ts"`（当前 47 例全绿）+ 仓库 `oxlint --deny-warnings` / `eslint` / `prettier --check` / `knip`，再起 dev 实例对真 core 跑一遍闭环 1–4。

## 规模成本与迁移路径

技能行是**物理副本**：表行数 = 员工数 × 每员工技能数。而每 turn 的可见性推导走 `skills.all()`，`DurableMap.all()` 每次 `structuredClone` 整表进堆（`persistence/durable-map.ts:160-174`，15s 版本缓存只省磁盘 IO、不省克隆）→ **每轮成本 ≈ 克隆整张 skills 表的字节数**，与本轮可见几条无关。

量级：10–30 员工无感；上百员工 × 十几条技能（body 内联大段代码时更明显）→ 每轮数十 MB 级堆拷贝，延迟可感；上千员工不可持续。

迁移路径（**零代码改动**）：清掉各项目 scope 的副本行 → 在一个库域 scope 留母本 → 按项目插 grant 行。可见性每 turn 重算，插完下一轮即生效。所以直建不是单向门；协议侧上限（128KB/条、20 条/次）就是给这个成本加的闸。

## 部署与运维约束

| #   | 约束                                                                       | 不遵守的后果                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **该实例不得开启目录同步**（不接 Slack 花名册、不调 `POST /v1/directory`） | `POST /v1/directory` 是**全量替换**语义：替换后不在新名单里的旧 principal 会被**停用**（`src/api/app-messaging.ts:343-349` → `recordDirectorySync`）。而 `isActiveMember = isInternal(classify(id))`（`src/wiring.ts:908`）一旦为 false，`projects.members()` 返回空、`membership` false、`listForMember` 直接过滤 → **所有数字员工的写入/turn 变 403、员工列表变空**，一次同步打死全部。若将来必须开，要把网关派生的全部 `principalId` 纳入同步名单 |
| 2   | 首次部署配好 `ADMIN_GRANTS=<运营 principal>:org_admin`                     | 生产无内置 admin；表空 = 没人能登记 MCP、没人能进管理面                                                                                                                                                                                                                                                                                                                                                                                              |
| 3   | core → MCP 端点出站可达（D2）                                              | 登记时 probe 就 400 `unreachable`；工具永远注入不进来                                                                                                                                                                                                                                                                                                                                                                                                |
| 4   | `CORE_SIGNING_SECRET` / `PARTNER_CREDENTIALS` 齐备且 secret ≥32            | G1 拒启（fail-closed）                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 5   | 管理面（portal + admin 插件）留在私网                                      | admin 插件信任 portal 合成的身份 cookie，公网暴露等于把管理面交出去                                                                                                                                                                                                                                                                                                                                                                                  |
| 6   | 密钥轮换：`PARTNER_CREDENTIALS` 可配多个 partner                           | 轮换时新旧两把共存一段，避开硬切；旧密钥删除后其签名立即 401                                                                                                                                                                                                                                                                                                                                                                                         |

## 边界（v1 不实现）

| 不实现                                                | 后果与兜底                                                                                                           |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 登记表 / 幂等映射                                     | `assemble` 每次新建项目；`scopeId` 由调用方保管，补建走 G9                                                           |
| 技能库域 / grant 引用 / pack import                   | 技能只有直建一条路；因此**不需要 admin 身份**，`CORE_SIGNING_SECRET` 只用于 source 签名                              |
| 目录同步（花名册）                                    | core 只见 `principalId`，不解析显示名、无「找人」；将来要则新增一个 G 模块，注意 core `/v1/directory` 是全量替换语义 |
| 附件 / 二进制上传                                     | `POST /v1/skills` 无 `files` 字段，技能只有 markdown body，代码靠内联 + 沙箱现生成                                   |
| 删除类接口（员工 / 技能 / 会话）                      | 只增不删，清理是运营动作，走 core 的 admin 面                                                                        |
| admin / keychain / 部署 / cron / webhook 等 core 能力 | 不在白名单，一律 404                                                                                                 |
| MCP 按用户切分                                        | 已定不做（D1）：MCP 只提供 org 级业务；需要按用户区分的数据由 MCP 侧自行处理，协议不透传用户身份                     |

## 已定决策

| #   | 事项                   | 决定                                     | 由此确定的约束                                                                                                                                                                                                                                                                                                                                                                                                |
| --- | ---------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | MCP 是否按终端用户鉴权 | ✅ **走 org 全局，不按用户鉴权**         | ①**core 零改动**，全链在插件内闭合，不需要在 MCP 调用链注入用户上下文；②网关仍照常带 `x-portal-identity`（core 的 user-scoped 路由与 web turn 强制要它，同时进审计），但该身份**不透传给 MCP**；③MCP 只能提供 org 级业务：同一实例内所有用户经同一工具看到同一数据视图，若某工具需按用户区分数据，由 MCP 侧自行处理（入参里不带可信用户身份，且工具参数由模型生成，存在 confused deputy，不能拿它当鉴权依据） |
| D2  | MCP 部署位置与认证     | ✅ **部署在调用方客户端**，core 出站直连 | ①部署时必须保证 **core → 该 MCP 端点的出站可达**（公网 TLS 或专线），这是开实例前的检查项；②认证用 `bearer` 或 `client-credentials` + TLS，**禁 `none`**；③端点由运营侧以 admin 登记（org 全局、无 `scopeId`、默认 `readOnly`；需写操作时显式放开，放开即对全实例生效，无法按员工或按用户收窄）；④MCP 不经网关，所以它的可用性/限流/审计都在 core 与 MCP 两侧，网关无法介入                                   |
