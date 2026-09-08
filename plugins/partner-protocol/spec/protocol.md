# 接入协议 v1

网关地址由部署方提供，形如 `https://agent.example.com`。对话 API 在 `/v1` 下，对话页面在 `/chat`；请求与响应体一律 `application/json; charset=utf-8`（SSE 与 HTML 页面除外）。

每个 JSON 响应都带 `x-partner-protocol: 1`。版本号在路径里；不在白名单内的路径一律 `404`，不做兼容降级。

## 1. 职责边界与两种鉴权

网关是甲方业务系统与后端之间的**桥梁**，只做两件事：

1. **建数字员工**：接住你服务端的建员工请求，调后端建项目、授权技能、写人格。
2. **提供对话页面**：直接下发一个内嵌的对话页面（会话上下文区 + 输入框），对话阶段完全由网关负责，你的业务系统不再参与。

登录、数字员工列表、会话列表这些都归**你自己的业务系统**维护，网关不提供、也不代管（见 §9）。你与网关只有两个接触点：建员工、以及为某次对话换取一个页面入口。

因此有**两种鉴权**，分别服务两类调用方：

| 鉴权方式       | 谁用             | 覆盖端点                                                               | 凭据                                   |
| -------------- | ---------------- | ---------------------------------------------------------------------- | -------------------------------------- |
| **合作方签名** | 你的**服务端**   | `POST /v1/assemble`、`POST /v1/chat-sessions`                          | HMAC 共享密钥（永不下发到浏览器）      |
| **对话会话**   | 用户的**浏览器** | `GET /chat`、`POST /v1/turn`、`GET /v1/events`、`GET /v1/sessions/:id` | 签名令牌 / HttpOnly cookie（网关下发） |

典型接入流程：

```
你的服务端 --HMAC--> POST /v1/assemble         建员工，拿到 scopeId（请持久化）
你的服务端 --HMAC--> POST /v1/chat-sessions    {scopeId, conversationId} → 返回 chatUrl
浏览器     --跳转--> GET  chatUrl (/chat?token=…)  网关验票 → 下发 cookie → 返回对话页面
浏览器     --cookie-> POST /v1/turn / GET /v1/events / GET /v1/sessions/:id
```

浏览器**永远不持有** HMAC 密钥：它只拿到一个由 `chat-sessions` 签发、绑定到该用户的限时令牌，用它换 cookie，之后的对话请求都靠 cookie。

### 1.1 合作方签名（HMAC）

部署方发放一对凭据：`partnerId`（合 `^[a-z][a-z0-9-]{0,31}$`，**不含下划线**）与 `secret`（≥32 字符）。`secret` 只在你的服务端与网关之间共享，永不上行、永不下发到浏览器。同一个实例内两个 `partnerId` 不得共用一个 `secret`（网关启动时会拒给）。

每个签名请求带三个头：

| 头             | 值               |
| -------------- | ---------------- |
| `x-partner-id` | 你的 `partnerId` |
| `x-timestamp`  | Unix 秒（整数）  |
| `x-signature`  | 见下             |

签名逐字定义：

```
canonical = METHOD "\n" PATH_WITH_QUERY "\n" RAW_BODY
signature = "v0=" + hex( HMAC_SHA256( secret, "v0:" + TIMESTAMP + ":" + canonical ) )
```

- `METHOD` 大写，如 `POST`。
- `PATH_WITH_QUERY` 是 HTTP request-target：路径加查询串，不含协议与主机，如 `/v1/chat-sessions`。网关签的是**它实际收到的那一串字节**，所以你的 HTTP 客户端发什么你就得签什么：不要签名后再重排参数，也不要依赖客户端帮你规范化路径。推荐做法：先把最终的 request-target 字符串固定下来，用它签名、也用它发请求。
- `RAW_BODY` 是实际发出的请求体字节解码为 UTF-8 的字符串。`POST` 必须签名你真正发出的那串 JSON（建议先 `JSON.stringify` 一次，签它、也发它）。

校验顺序与拒绝原因（全部 `401 {"error":"unauthorized","message":<reason>}`）：

| reason                                        | 含义                                      |
| --------------------------------------------- | ----------------------------------------- |
| `missing x-partner-id header`                 | 没带 `x-partner-id`                       |
| `unknown partner`                             | `partnerId` 未登记                        |
| `missing signature (unsigned request)`        | 没带 `x-signature`                        |
| `invalid timestamp`                           | `x-timestamp` 不是数字                    |
| `timestamp outside the 300s freshness window` | 与网关时钟相差超过 **300 秒**（前后都算） |
| `signature mismatch`                          | 签名不符                                  |

签名比对是常量时间的，且方法、request-target、请求体全部参与签名，所以改任何一样都会失败。

**时间窗不是重放防护。** 网关无状态，不记录用过的签名或 nonce，所以在一个 300 秒窗口内拿到一个已签请求就能逐字重放它。对非幂等端点（`POST /v1/assemble`）的去重请在你自己那一侧做，见 §7。请把 `secret` 当作与 TLS 同级的机密：全程走 HTTPS，不要把它或已签请求写进日志。

密钥轮换：网关可同时登记多个 `partnerId`。换新密钥时申请一个新 `partnerId`（配一个不同的 `secret`），双跑一段时间，再让部署方摘掉旧的；旧密钥被摘除后其签名立即 `401`。

### 1.2 对话令牌与 cookie

`POST /v1/chat-sessions`（HMAC 鉴权）为一次对话签发一个**签名令牌**：它绑定 `principalId`、带 **12 小时**过期，放进返回的 `chatUrl` 里。浏览器打开 `chatUrl`（即 `GET /chat?token=…`）时，网关验证令牌，把它落成一个 cookie 再下发对话页面：

```
set-cookie: partner_chat=<令牌>; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200[; Secure]
```

- `HttpOnly`：脚本读不到，降低 XSS 窃取面。
- `SameSite=Strict`：只有从网关自身页面发起的同站请求会带上它。
- `Secure`：仅在部署方开启（生产 HTTPS）时附加。

之后对话页面里的 `POST /v1/turn`、`GET /v1/events`、`GET /v1/sessions/:id` 都靠这个 cookie 鉴权，请求里**不需要也不接受** `userId`——身份从令牌解出。`EventSource` 不能设自定义头，正好靠 cookie 透明携带，这也是对话走 cookie 而非签名的原因。

令牌/cookie 缺失或失效时：

| reason                            | 含义                                 |
| --------------------------------- | ------------------------------------ |
| `missing chat session`            | 没带 cookie（或 `/chat` 没带 token） |
| `chat session invalid or expired` | 令牌被篡改、签发方不符，或已过期     |

令牌过期（12 小时）后，让浏览器重新走一次 `chat-sessions → chatUrl` 即可换新的。令牌只承载身份，不承载 `scopeId`；每次对话的 `scopeId`/`conversationId` 由 `chatUrl` 的查询参数带入页面。

## 2. 身份

网关**没有登录，也没有注册**。身份由 `partnerId` 与 `userId` 派生：

```
principalId = partnerId + "_" + userId
```

- `userId` 必填，合 `^[A-Za-z0-9_-]{1,64}$`。**不允许冒号、斜杠、空格与非 ASCII 字符**。
- HMAC 端点：`POST` 从请求体的 `userId` 取。`chat-sessions` 用它 + `partnerId` 派生 `principalId`，签进令牌。
- 对话端点：`principalId` 从令牌/cookie 解出，**请求里任何 `userId`/`principalId` 字段一律被忽略**，无法自报或篡改身份。
- 一个从未出现过的 `userId` 第一次调用即可创建数字员工，不需要预先开通。换 `userId` 就是换一个人。

**`userId` 的真实性是接入方的责任。** 网关只保证：只有持密钥者能断言身份、`(partnerId, userId) → principalId` 是单射、字符集受限、令牌不可伪造。它**不保证**你给的 `userId` 真是你的那个用户。请在**你自己的服务端**签发 `userId` 并调用 `chat-sessions`；不要把 HMAC 密钥或签发令牌的能力暴露到浏览器，否则用户就能占用别人的 `principalId`、读到别人的员工与会话。

## 3. 数字员工与 scope

「数字员工」= 一个项目 scope。`assemble` 成功后你会拿到：

- `employee.id`：内部标识，仅用于回显。
- `employee.scopeId`：形如 `group:web-project-<id>`，**这是后续所有调用的句柄，请你持久化保存**。

网关不保存任何映射表，也不做幂等去重，且**不提供员工列表端点**——员工清单归你自己的业务系统维护。`scopeId` 一旦丢失，协议内没有找回手段，请务必落库。

## 4. 端点

白名单共 **6** 个：`assemble`、`chat-sessions`（HMAC）；`chat` 页面、`turn`、`events`、`sessions/:id`（对话会话）。

### `POST /v1/assemble` （HMAC）

一次调用建好一个数字员工：项目 + 从技能库授权的技能 + 人格。

技能**不由你上送内容**。部署方预先建好一个或多个「技能库」（org 级的库 scope，里面装着已导入的技能包），并把库标识（`library` key）发给你。装配时你只传库标识、可选地传想要的技能名子集，网关据此给新员工的项目 scope 建立**只读授权引用**——引用库里的技能，而不是把技能内容复制进员工。库的建立与技能导入由部署方运营侧负责，不在本协议内（见 §8）。

请求（上限 **128,000 字节**）：

```json
{
  "userId": "u1",
  "name": "客服",
  "library": "xhs",
  "skills": ["space-xhs-writer", "space-xhs-title"],
  "soul": "语气克制，先给结论。",
  "standingOrders": "你的名字叫小红，对外身份是甲方派驻的数字员工。被问及名字或身份时一律以此为准。"
}
```

| 字段             | 约束                                                                                                                                                                               |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `userId`         | 必填，见 §2                                                                                                                                                                        |
| `name`           | 必填，去空格后非空，≤ **200** 字符                                                                                                                                                 |
| `library`        | 可选字符串，部署方发放的库标识。**实例只绑定一个库时可省略**（自动用它）；绑定了多个库则必填，缺失或未知都会 `400`                                                                 |
| `skills`         | 可选字符串数组，≤ **50** 条，是库内技能名的子集，同一请求内不得重名。**省略 = 授权该库的全部可用技能**；传了则只授权列出的这几个                                                   |
| `skills[]`       | 每个元素是技能名，合 `^[a-z0-9][a-z0-9_-]{0,63}$`，且必须真实存在于该库中（否则 `400`，**不建项目**）                                                                              |
| `soul`           | 可选字符串，≤ **8KB**（8,192 字节）。该员工的**人格**：语气、行事风格、价值观                                                                                                      |
| `standingOrders` | 可选字符串，≤ **20,000** 字符。该员工的**对外形象/身份**。每回合随唤醒信封注入且标注「必须照做」，能压过平台默认自称；仅对非 DM 会话生效（本协议建出的员工均为 group scope，生效） |

响应：

```
201 {
  "employee": {"id":"web-project-1","scopeId":"group:web-project-1","name":"客服"},
  "granted":  ["space-xhs-writer","space-xhs-title"],
  "grantFailures": [{"name":"space-xhs-cover","error":"core replied 403"}],
  "soul":     true,
  "soulError":"core replied 403",
  "standingOrders": true,
  "standingOrdersError": "core replied 403"
}
```

`granted` 是成功授权的技能名列表；`grantFailures`、`soulError`、`standingOrdersError` 只在对应步骤失败时才出现。

失败语义（**请务必按这个处理**）：

| 情况               | 结果                                                            | 你能做什么                                                        |
| ------------------ | --------------------------------------------------------------- | ----------------------------------------------------------------- |
| 库解析失败         | `400 {"error":"bad_request",…}`，**不建项目**                   | 检查 `library` 是否为部署方发放的标识；多库实例必须显式传         |
| 技能名不在库里     | `400 {"error":"bad_request",…}`，**不建项目**                   | 用部署方提供的库内技能名；拼错或技能已下架都会命中                |
| 库里没有可授权技能 | `400 {"error":"bad_request",…}`，**不建项目**                   | 联系部署方确认库已导入技能                                        |
| 项目没建成         | `502 {"error":"upstream_error",…}`                              | **员工可能已建了一半**；协议内没有列表端点可对账，见下            |
| 某条技能授权失败   | 仍 `201`；该技能进 `grantFailures` 带 `error`；其余技能继续授权 | v1 没有单独补授权的端点，只能重建员工，或请运营侧在库侧补 grant   |
| 人格写入失败       | 仍 `201`；`soul:false` + `soulError`                            | 员工可用；v1 没有单独重写人格的端点，只能重建员工                 |
| 形象写入失败       | 仍 `201`；`standingOrders:false` + `standingOrdersError`        | 员工可用但自称回落平台默认；重建员工或请运营侧补写 context policy |

**这个接口不是幂等的**：重复调用会创建多个员工（多个不同 `scopeId`）。

关于 `502`：它覆盖两种无法区分的情况——请求根本没到后端（什么都没产生），以及后端已提交但响应在回路上丢了（员工已存在）。网关分不出这两者，且**协议内没有员工列表端点可供对账**，所以**不要把 `502` 当作「可以盲重」的信号**：盲重可能建出重复员工。稳妥做法是把这次装配标记为「未知」，交由你侧的运营流程人工核对后再决定是否重试。`201` 之后的任何局部失败都不得整体重试。

### `POST /v1/chat-sessions` （HMAC）

为一次对话签发页面入口。你的服务端调用它，拿到 `chatUrl` 后把浏览器**跳转**过去。

请求（上限 **4,000 字节**）：

```json
{ "userId": "u1", "scopeId": "group:web-project-1", "conversationId": "ticket-42" }
```

| 字段             | 约束                                                                                                        |
| ---------------- | ----------------------------------------------------------------------------------------------------------- |
| `userId`         | 必填，见 §2                                                                                                 |
| `scopeId`        | 必填，`group:…`（员工的 scope）                                                                             |
| `conversationId` | 可选，合 `^[A-Za-z0-9._-]{1,120}$`，缺省 `"default"`。它就是会话标识，由你自己选（见 §4 `turn` 的会话语义） |

响应：

```
200 {"chatUrl":"/chat?token=<签名令牌>&scopeId=group:web-project-1&conversationId=ticket-42&sessionId=s1"}
```

- `chatUrl` 是**相对路径**（相对网关源）。把它拼上网关的浏览器可达源（部署方提供）再交给浏览器跳转。
- `token` 是 12 小时的签名令牌，等价于入场票，**不要写进日志**。
- `sessionId` 只在后端已存在与该 `conversationId` 对应的会话时才出现，供对话页面预载历史；新会话没有它。
- 网关**不校验** `scopeId` 是否属于该用户；越权的 `scopeId` 会在后续 `turn`/`events` 被后端拦下（`403 refused`）。

拿到 `chatUrl` 后无需再调用其它 HMAC 端点——接下来的对话全在浏览器与网关之间用 cookie 完成。

### `GET /chat?token=&scopeId=&conversationId=[&sessionId=]` （对话页面入口）

浏览器跳转的目标，**通常不由你的服务端直接调用**。网关验票（`token`）→ 下发 `partner_chat` cookie（见 §1.2）→ 返回内嵌的对话页面 HTML。页面里已注入 `scopeId`/`conversationId`/`sessionId`，加载后自动：有 `sessionId` 就拉历史渲染上下文区，然后用户输入 → `POST /v1/turn` → `GET /v1/events` 流式显示回复。

- `token` 缺失/失效 → `401`（`missing chat session` / `chat session invalid or expired`）。
- `scopeId` 非 `group:` 或 `conversationId` 非法 → `400`。
- 这个页面是网关自带的极简对话界面（只有上下文区 + 输入框，没有登录/员工/会话列表）。它跑在网关自己的源上，所有对话请求都是同源、cookie 自动携带。

### `POST /v1/turn` （cookie）

发一条消息。身份来自 cookie，**不需要 `userId`**。

请求（上限 **64,000 字节**）：

```json
{
  "scopeId": "group:web-project-1",
  "conversationId": "ticket-42",
  "text": "帮我查一下这个订单",
  "model": "…",
  "harness": "…",
  "thinkingLevel": "…",
  "timezone": "Asia/Shanghai",
  "approval": { "requestId": "…", "approved": true, "scope": "session" }
}
```

| 字段                                               | 约束                                                       |
| -------------------------------------------------- | ---------------------------------------------------------- |
| `scopeId`                                          | 必填，`group:…`                                            |
| `conversationId`                                   | 可选，合 `^[A-Za-z0-9._-]{1,120}$`，缺省 `"default"`       |
| `text`                                             | 与 `approval` 至少有一个；只有 `approval` 时 `text` 可为空 |
| `model` / `harness` / `thinkingLevel` / `timezone` | 可选字符串，原样透传                                       |
| `approval.scope`                                   | 可选，`once` \| `session` \| `always`                      |

其它字段（包括 `userId`、`attachments`、`principalId`）一律丢弃。

```
202 {"status":"queued","runId":"run-…","threadRef":"web:acme_u1:ticket-42"}
200 {…}                            命中去重，直接返回终态
403 {"error":"refused","message":"<原因>"}     该 scope 不属于此身份，或消息被安全策略拦下
401 {"error":"unauthorized",…}                 cookie 缺失/失效
400 {"error":"bad_request","message":"<原因>"}
```

**会话语义**：`conversationId` 就是会话标识，由你自己选。

- 用同一个 `conversationId` → 继续那条会话，带全部历史。
- 换一个新的 `conversationId` → 就是在同一个员工下**新建一条会话**。
- 会话在第一条消息送达时惰性创建；拿到 `202` 的那一刻会话行可能还没落库。你的「会话列表」应在自己业务系统里以 `conversationId` 为准维护。

`threadRef` 是内部坐标，仅供对账；不要自己拼它。

### `GET /v1/events` （cookie）

订阅一次运行的流式输出（SSE）。身份来自 cookie。两种入口：

```
/v1/events?runId=<runId>
/v1/events?scopeId=group:web-project-1&conversationId=ticket-42
```

入口二先查该会话当前有没有在跑的运行：没有就发一个 `idle` 事件后关流；有就等价于入口一。`runId` 合 `^[A-Za-z0-9_-]{1,64}$`。用浏览器 `EventSource` 时 cookie 会自动携带。

响应头 `content-type: text/event-stream; charset=utf-8`、`cache-control: no-cache, no-transform`、`x-accel-buffering: no`。开流先写一行注释 `: open`。

| 事件       | 何时发                  | 载荷                                                                                |
| ---------- | ----------------------- | ----------------------------------------------------------------------------------- |
| `partial`  | 已生成文本变长          | `{"partial":"<到目前为止的全文>"}`                                                  |
| `activity` | 工具活动数组变长        | `{"activity":[…],"startedAt":<ms>}`                                                 |
| `stale`    | 运行卡住的布尔状态翻转  | `{"stale":true\|false}`                                                             |
| `alive`    | 15 秒无事件且运行仍在跑 | `{"at":<ms>}`                                                                       |
| `done`     | 终态                    | `{"status","result","partial","activity","replyComplete","startedAt","finishedAt"}` |
| `failed`   | 连续两次取不到运行状态  | `{"reason":"upstream_unreachable"\|"HTTP <status>"}`                                |
| `idle`     | 入口二没有在跑的运行    | `{}`                                                                                |

`partial` 是**累计全文**而非增量，直接覆盖渲染即可。`done` 是最后一个事件，之后网关关流。

时间参数：正常轮询 100ms（`stale` 时降到 1s）；15 秒无任何事件时发心跳；`stale` 之后有 10 分钟宽限。

**关流时机：网关不设绝对时长上限。** 空闲计时只在「后端不再报告运行存活」时起算：连续 6 分钟既无进展又不再存活，网关关流。请你自己设总时长上限并主动断开；断开后网关立即停止轮询，不留后台工作。

重连：流被关掉而运行还没结束时，重新发起同一个请求即可。不要在 `done` / `idle` 之后重连。

### `GET /v1/sessions/:id?tailTurns=&sinceSeq=&beforeSeq=` （cookie）

读一条会话的完整历史。身份（viewer）来自 cookie，**不需要 `userId`**。对话页面在 SSE 断流后靠它把最终回复取回来。

| 参数        | 约束                                   |
| ----------- | -------------------------------------- |
| `tailTurns` | 整数 ≥1，只取最后 N 轮                 |
| `sinceSeq`  | 整数 ≥0，只取 `seq >= sinceSeq` 的条目 |
| `beforeSeq` | 整数 ≥1，只取 `seq < beforeSeq` 的条目 |

都不传 = 取全部条目。

```
200 {"session":{…},"entries":[{"seq":1,"type":"user","payload":{…}}],"earlierEntries":3}
404 {"error":"not_found","message":"unknown session"}
401 {"error":"unauthorized",…}     cookie 缺失/失效
400 {"error":"bad_request","message":"tailTurns must be an integer >= 1"}
```

`earlierEntries` 只在被窗口截掉条目时出现。`:id` 含非法字符或跨路径时同样返回 `404`，不区分「不存在」与「格式不对」。

## 5. 错误码

所有错误统一 `{"error":"<code>","message":"<人类可读>"}`，`502` 额外带 `upstream`：

| HTTP | `error`             | 何时                                                                          | 可重试                        |
| ---- | ------------------- | ----------------------------------------------------------------------------- | ----------------------------- |
| 400  | `bad_request`       | 字段校验失败、`userId` 非法、`scopeId` 不是 `group:`、`library`/`skills` 无效 | 改参数后重试                  |
| 400  | `bad_json`          | 体不是合法 JSON 对象                                                          | 否                            |
| 401  | `unauthorized`      | 签名/凭据/时间戳问题，或对话令牌/cookie 缺失、失效、过期                      | 修签名 / 重新换 chatUrl       |
| 403  | `forbidden`         | 该 scope 不属于这个身份                                                       | 否                            |
| 403  | `refused`           | 消息被安全策略拦下                                                            | 否                            |
| 404  | `not_found`         | 路径不在白名单，或会话不存在                                                  | 否                            |
| 413  | `payload_too_large` | 体超过该端点上限                                                              | 拆小                          |
| 429  | `rate_limited`      | 超配额                                                                        | 按 `retry-after` 退避         |
| 500  | `internal_error`    | 网关自身异常                                                                  | 可重试                        |
| 502  | `upstream_error`    | 后端不可达、超时，或响应形状异常                                              | 先核对状态再重试，见 §4 与 §7 |

`502` 的形状：

```json
{ "error": "upstream_error", "message": "session read failed", "upstream": { "status": 403, "error": "forbidden" } }
```

## 6. 限流

按 `partnerId` 计，固定 60 秒窗口，默认 **120 请求/分钟**（部署方可调，`0` = 不限）。对话端点的 `partnerId` 从令牌/cookie 里的 `principalId` 前缀解出，所以同一合作方名下的浏览器对话与服务端调用**共享同一份配额**。超限返回：

```
429 {"error":"rate_limited","message":"partner quota exceeded, retry in 37s","retryAfter":37}
retry-after: 37
```

配额计数是**每网关实例的内存态**：多实例部署时每个实例独立计数，实际总额约为 `配额 × 实例数`；网关重启会清零。不要把它当精确的账单依据。SSE 长连接在整个订阅期间只占用一次配额。

## 7. 重试与幂等

| 端点                     | 幂等   | 建议                                                                                                                              |
| ------------------------ | ------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/chat-sessions` | 是     | 只是签令牌 + 查会话，随便重试                                                                                                     |
| `GET /chat`              | 是     | 验票下发 cookie + 返回页面，可重复访问（令牌未过期时）                                                                            |
| `GET /v1/events`         | 是     | 断流后按 §4 重连                                                                                                                  |
| `GET /v1/sessions/:id`   | 是     | 随便重试                                                                                                                          |
| `POST /v1/turn`          | **否** | `502`/`500` 时重试可能产生两条消息；先 `GET /v1/sessions/:id` 看最后一条是不是你刚发的，不是再重发                                |
| `POST /v1/assemble`      | **否** | 任何 `502` 都无法在协议内对账（无列表端点），标记为「未知」交运营核对，勿盲重；`201` 之后的局部失败没有单独补写端点，只能重建员工 |

网络层请设**读超时**：普通请求 15 秒（网关调后端的超时就是 15 秒）；SSE 不设读超时，但要自己定总时长上限（见 §4 的 `GET /v1/events`）。

## 8. 技能形态与库

技能**不由接入方上送**，而是集中在部署方预先建好的「技能库」里，装配时按引用授权给员工：

- 库是 org 级的 scope，装着部署方导入的技能包。技能包可以是多文件、带脚本、带附件的完整目录（`SKILL.md` + `scripts/` + `references/` 等），不受本协议的 body 形态限制——这些内容不经过本协议上行，由部署方在库侧一次性导入。
- `assemble` 只做**只读授权引用**：网关给员工的项目 scope 建一条指向库内技能的 grant（`permission:"read"`），员工由此获得该技能的使用权，库里不产生 per-员工的物理副本。改库里的技能，所有引用它的员工下一轮即生效。
- 你在 `assemble` 里传的 `library` 是部署方发放的库标识，`skills` 是库内技能名的可选子集（省略 = 全库）。你无法、也不需要传技能的描述或正文。
- 单次 `assemble` 最多授权 **50** 条技能。授权越多，后端每轮要装载的技能上下文越大，请只授权当前员工真正需要的技能。
- **库的建立、技能包的导入、库内技能的增删改，全部由部署方运营侧负责，不在本协议白名单内**。协议侧没有任何写库、列库、删技能的端点；你能做的只是选库、选技能名、把它们授权给员工。

## 9. 不提供的能力

以下都不在 v1 白名单内，请求会得到 `404`：

- **员工列表 / 会话列表**：归你自己的业务系统维护（网关无状态、不代管）。网关只在 `assemble` 返回 `scopeId`、在 `chat-sessions` 返回 `sessionId`（若已存在）。
- **模型 / harness 选择器**（原 `runtime`）：对话页面用后端当前生效的默认值，不暴露候选集拉取端点。
- 幂等键 / 请求去重表
- 目录同步（花名册、显示名解析）
- 附件与文件上传下载
- 技能库管理（建库、导入技能包、增删改库内技能、维护授权）——归部署方运营侧，见 §8
- 删除类接口（删员工、删会话、清空历史）
- 会话整理（改标题、归档、置顶、分叉）
- 员工改名、用户停用/注销
- 管理面（admin / 凭据保管箱 / 部署 / 定时任务 / webhook）
- MCP 工具的按用户切分

**MCP 工具**由部署方在后端按 org 全局登记，对所有员工、所有用户可见同一批工具，**不携带也不区分终端用户身份**。如果你的业务需要按用户区分数据，请在你的 MCP 服务端用工具入参自行处理——注意入参由模型生成，不能当作可信的鉴权依据。
