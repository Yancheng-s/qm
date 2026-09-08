# 接入协议 v1

网关地址由部署方提供，形如 `https://agent.example.com`。所有端点都在 `/v1` 下，请求与响应体一律 `application/json; charset=utf-8`（SSE 除外）。

每个响应都带 `x-partner-protocol: 1`。版本号在路径里；不在白名单内的路径一律 `404`，不做兼容降级。

## 1. 凭据与签名

部署方发放一对凭据：`partnerId`（合 `^[a-z][a-z0-9-]{0,31}$`，**不含下划线**）与 `secret`（≥32 字符）。`secret` 只在签发方与网关之间共享，永不上行。同一个实例内两个 `partnerId` 不得共用一个 `secret`（网关启动时会拒给）。

每个请求带三个头：

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
- `PATH_WITH_QUERY` 是 HTTP request-target：路径加查询串，不含协议与主机，如 `/v1/turn` 或 `/v1/events?userId=u1&runId=r1`。网关签的是**它实际收到的那一串字节**，所以你的 HTTP 客户端发什么你就得签什么：不要签名后再重排参数，也不要依赖客户端帮你规范化路径（`.` / `..` 段、尾部 `?`、百分号编码的大小写都可能被改写）。推荐做法：先把最终的 request-target 字符串固定下来，用它签名、也用它发请求。
- `RAW_BODY` 是实际发出的请求体字节解码为 UTF-8 的字符串。`GET` 没有体，用空字符串 `""`；`POST` 必须签名你真正发出的那串 JSON（建议先 `JSON.stringify` 一次，签它、也发它）。

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

**时间窗不是重放防护。** 网关无状态，不记录用过的签名或 nonce，所以在一个 300 秒窗口内拿到一个已签请求（日志、中间代理、报文抓取）就能逐字重放它，网关识别不出来。对非幂等端点（`POST /v1/turn`、`POST /v1/assemble`）的去重请在你自己那一侧做，见 §7。请把 `secret` 当作与 TLS 同级的机密：全程走 HTTPS，不要把它或已签请求写进日志。

密钥轮换：网关可同时登记多个 `partnerId`。换新密钥时申请一个新 `partnerId`（配一个不同的 `secret`），双跑一段时间，再让部署方摘掉旧的；旧密钥被摘除后其签名立即 `401`。

## 2. 身份

网关**没有登录，也没有注册**。身份由每个请求的签名与 `userId` 派生：

```
principalId = partnerId + "_" + userId
```

- `userId` 必填，合 `^[A-Za-z0-9_-]{1,64}$`。**不允许冒号、斜杠、空格与非 ASCII 字符**（这些字符会破坏内部的归属解析）。
- `POST` 从请求体的 `userId` 取，`GET` 从查询参数 `userId` 取。
- 请求体里出现的任何 `principalId` 字段**一律被忽略**，无法自报身份。
- 一个从未出现过的 `userId` 第一次调用即可创建数字员工，不需要预先开通。同一个 `userId` 再来，它的员工、记忆、会话都在。换 `userId` 就是换一个人。

**`userId` 的真实性是接入方的责任。** 网关只保证三件事：只有持密钥者能断言身份、`(partnerId, userId) → principalId` 是单射（`partnerId` 不含 `_`，所以第一个 `_` 就是分隔符，不同合作方、不同用户永远撞不到同一个 `principalId`）、字符集受限。它**不保证**你给的 `userId` 真是你的那个用户：如果你的前端能直接决定 `userId`，用户就能占用别人的 `principalId` 并读到别人的员工与会话。请在你自己的服务端签发 `userId`。

## 3. 数字员工与 scope

「数字员工」= 一个项目 scope。创建后你会拿到：

- `employee.id`：内部标识，仅用于回显。
- `employee.scopeId`：形如 `group:web-project-<id>`，**这是后续所有调用的句柄，请你持久化保存**。

网关不保存任何映射表，也不做幂等去重。丢了 `scopeId` 只能靠 `GET /v1/employees` 按名字找回。

## 4. 端点

### `GET /v1/employees?userId=`

列出该用户名下的全部数字员工。

```
200 {"employees":[{"id":"web-project-1","name":"客服","scopeId":"group:web-project-1","createdAt":1700000000000}]}
```

`createdAt` 为毫秒时间戳。列表按 core 的返回顺序，未排序；`archived`、成员名单等内部字段不透出。

### `POST /v1/assemble`

一次调用建好一个数字员工：项目 + 技能 + 人格。

请求（上限 **512,000 字节**）：

```json
{
  "userId": "u1",
  "name": "客服",
  "skills": [{ "name": "triage", "description": "把工单分类", "body": "# triage\n\n步骤……\n" }],
  "soul": "语气克制，先给结论。",
  "standingOrders": "你的名字叫小红，对外身份是甲方派驻的数字员工。被问及名字或身份时一律以此为准。"
}
```

| 字段                   | 约束                                                                                                                                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `name`                 | 必填，去空格后非空，≤ **200** 字符                                                                                                                                                                           |
| `skills`               | 可选数组，≤ **20** 条，同一请求内不得重名                                                                                                                                                                    |
| `skills[].name`        | 必填，合 `^[a-z0-9][a-z0-9_-]{0,63}$`                                                                                                                                                                        |
| `skills[].description` | 必填，非空，≤ **500** 字符。这是模型选技能时唯一看到的说明，请写清「什么时候用」                                                                                                                             |
| `skills[].body`        | 必填，去空格后非空，≤ **128KB**（131,072 字节）。markdown，可内联代码                                                                                                                                        |
| `soul`                 | 可选字符串，≤ **8KB**（8,192 字节）。该员工的**人格**：语气、行事风格、价值观                                                                                                                                |
| `standingOrders`       | 可选字符串，≤ **20,000** 字符。该员工的**对外形象/身份**：名字、职务、自我介绍口径。每回合随唤醒信封注入且标注「必须照做」，能压过平台默认自称；仅对非 DM 会话生效（本协议建出的员工均为 group scope，生效） |

响应：

```
201 {
  "employee": {"id":"web-project-1","scopeId":"group:web-project-1","name":"客服"},
  "skills":   [{"name":"triage","ok":true},{"name":"dup","ok":false,"error":"exists"}],
  "soul":     true,
  "soulError":"core replied 403",
  "standingOrders": true,
  "standingOrdersError": "core replied 403"
}
```

失败语义（**请务必按这个处理**）：

| 情况         | 结果                                                      | 你能做什么                                                          |
| ------------ | --------------------------------------------------------- | ------------------------------------------------------------------- |
| 项目没建成   | `502 {"error":"upstream_error",…}`                        | **员工可能已经建了一半**，重试前先用 `GET /v1/employees` 按名字核对 |
| 某条技能失败 | 仍 `201`；`skills[i].ok=false` 带 `error`；后续技能继续建 | 用 `POST /v1/skills` 补建失败的那几条                               |
| 人格写入失败 | 仍 `201`；`soul:false` + `soulError`                      | 员工可用；v1 没有单独重写人格的端点，只能重建员工                   |
| 形象写入失败 | 仍 `201`；`standingOrders:false` + `standingOrdersError`  | 员工可用但自称回落平台默认；重建员工或请运营侧补写 context policy   |

**这个接口不是幂等的**：重复调用会创建多个员工（多个不同 `scopeId`）。

关于 `502`：它覆盖两种无法区分的情况——请求根本没到后端（确实什么都没产生），以及请求到了、后端已提交但响应在回路上丢了或形状异常（员工已经存在）。网关分不出这两者，所以**不要把 `502` 当作「可以盲重」的信号**：先 `GET /v1/employees` 看有没有多出同名员工，没有再重试。`201` 之后的任何局部失败都不得整体重试。

### `POST /v1/skills`

给一个已存在的员工补技能。

请求（上限 **160,000 字节**）：

```json
{
  "userId": "u1",
  "scopeId": "group:web-project-1",
  "name": "refund",
  "description": "处理退款",
  "body": "# refund\n\n……\n"
}
```

字段约束同 `assemble` 的单条技能规则；`scopeId` 必须以 `group:` 开头。

```
201 {"skill":{"id":"skill-…","name":"refund"}}
409 {"error":"exists","message":"a skill of that name already exists here — edit it instead"}
403 {"error":"forbidden", …}      该 scope 不属于这个 userId，或 scope 不存在
400 {"error":"bad_request", …}    字段校验失败
```

技能写进员工 scope 后**立即生效**（下一轮对话就能看到），不需要额外授权或重启。

### `GET /v1/runtime?userId=&scopeId=`

拉取该员工可用的模型与 harness 选择器。返回的是**当前实际生效的候选集**（运营侧在后台配置的），直接用它渲染下拉框即可：

```
200 {
  "scopeId": "group:web-project-1",
  "harnesses": ["pi", "codex"],
  "modelsByHarness": {"pi": ["gpt-x", "glm-y"], "codex": ["gpt-x"]},
  "modelCatalog": {"gpt-x": {"name": "GPT X", "provider": "openai"}, …},
  "effective": {"harnessId": "pi", "modelId": "gpt-x"}
}
```

| 字段              | 含义                                       |
| ----------------- | ------------------------------------------ |
| `harnesses`       | 可选 harness 列表                          |
| `modelsByHarness` | 每个 harness 下可选的 `modelId` 列表       |
| `modelCatalog`    | `modelId` → `{name, provider}`，用于展示名 |
| `effective`       | 不带 `model`/`harness` 发 turn 时的默认值  |

把选中的值随 `POST /v1/turn` 的 `model`/`harness` 字段传回即可（见下）。不传则用 `effective`。`403 {"error":"refused",…}` 表示该员工 scope 不属于这个 `userId`。

### `POST /v1/turn`

发一条消息。

请求（上限 **64,000 字节**）：

```json
{
  "userId": "u1",
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
| `model` / `harness` / `thinkingLevel` / `timezone` | 可选字符串，原样透传；候选集来自 `GET /v1/runtime`         |
| `approval.scope`                                   | 可选，`once` \| `session` \| `always`                      |

其它字段（包括 `attachments`、`principalId`、`proactiveOpener`）一律丢弃。

```
202 {"status":"queued","runId":"run-…","threadRef":"web:acme_u1:ticket-42"}
200 {…}                            命中去重，直接返回终态
403 {"error":"refused","message":"<原因>"}
400 {"error":"bad_request","message":"<原因>"}
```

**会话语义**：`conversationId` 就是会话标识，由你自己选。

- 用同一个 `conversationId` → 继续那条会话，带全部历史。
- 换一个新的 `conversationId` → 就是在同一个员工下**新建一条会话**。
- 因此**没有「创建空会话」这个端点**：会话在第一条消息送达时惰性创建。你的「新对话」按钮应该是本地动作，用你自己生成的 `conversationId` 占位，发出第一条消息后它才会出现在 `GET /v1/sessions` 里。
- 拿到 `202` 的那一刻会话行可能还没落库，**立刻回读列表可能读不到**，请以自己发出的 `conversationId` 为准在本地渲染。

`threadRef` 是内部坐标，仅供对账；不要自己拼它。

### `GET /v1/events`

订阅一次运行的流式输出（SSE）。两种入口：

```
/v1/events?userId=u1&runId=<runId>
/v1/events?userId=u1&scopeId=group:web-project-1&conversationId=ticket-42
```

入口二先查该会话当前有没有在跑的运行：没有就发一个 `idle` 事件后关流；有就等价于入口一。`runId` 合 `^[A-Za-z0-9_-]{1,64}$`。

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

时间参数：正常轮询 100ms（`stale` 时降到 1s）；15 秒无任何事件时发心跳（`alive` / `stale` / `: ping` 注释行）；`stale` 之后有 10 分钟宽限。

**关流时机：网关不设绝对时长上限。** 空闲计时只在「后端不再报告运行存活」时起算：连续 6 分钟既无进展又不再存活，网关关流。只要后端说运行还活着，即使长时间没有输出，流也会靠 15s 心跳一直挂着——运行多久由后端的存活判定说了算。因此**请你自己设总时长上限**（比如你自己的业务超时）并主动断开；断开后网关立即停止轮询。

重连：流被关掉而运行还没结束时，重新发起同一个请求即可——入口一按 `runId` 从头重放当前累计状态，入口二会重新找 active run。请不要在 `done` / `idle` 之后重连。

客户端断开后网关立即停止轮询，不会留下后台工作。

### `GET /v1/sessions?userId=&scopeId=`

列出该用户的会话。`scopeId` 可选，用来只看某个员工的会话（网关本地过滤）。

```
200 {"sessions":[{
  "id":"…","type":"group","scopeId":"group:web-project-1","threadRef":"web:acme_u1:ticket-42",
  "title":"…","createdAt":1700000000000,"lastActivityAt":1700000005000,
  "working":true,"awaitingInput":false
}]}
```

| 字段             | 说明                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------- |
| `title`          | 自动生成，可能为 `null`。**不保证符合你的命名习惯**，要自定义标题请自己存 `conversationId → title` 映射 |
| `createdAt`      | 创建时间（ms）                                                                                          |
| `lastActivityAt` | 最后活动时间（ms），可能缺失。**用它排序**                                                              |
| `working`        | 有运行在跑，可能缺失                                                                                    |
| `awaitingInput`  | 在等人批准工具调用，可能缺失                                                                            |

没有「更新时间」这个字段。`archived` / `pinned` / `color` 等属内部语义，不透出。没发过消息的会话不会出现在这里。

### `GET /v1/sessions/:id?userId=&tailTurns=&sinceSeq=&beforeSeq=`

读一条会话的完整历史。SSE 断流后靠它把最终回复取回来。

| 参数        | 约束                                   |
| ----------- | -------------------------------------- |
| `tailTurns` | 整数 ≥1，只取最后 N 轮                 |
| `sinceSeq`  | 整数 ≥0，只取 `seq >= sinceSeq` 的条目 |
| `beforeSeq` | 整数 ≥1，只取 `seq < beforeSeq` 的条目 |

都不传 = 取全部条目。

```
200 {"session":{…同列表…},"entries":[{"seq":1,"type":"user","payload":{…}}],"earlierEntries":3}
404 {"error":"not_found","message":"unknown session"}
400 {"error":"bad_request","message":"tailTurns must be an integer >= 1"}
```

`earlierEntries` 只在被窗口截掉条目时出现，表示前面还有多少条。`:id` 含非法字符或跨路径时同样返回 `404`，不区分「不存在」与「格式不对」。

## 5. 错误码

所有错误统一 `{"error":"<code>","message":"<人类可读>"}`，`502` 额外带 `upstream`：

| HTTP | `error`             | 何时                                                 | 可重试                        |
| ---- | ------------------- | ---------------------------------------------------- | ----------------------------- |
| 400  | `bad_request`       | 字段校验失败、`userId` 非法、`scopeId` 不是 `group:` | 改参数后重试                  |
| 400  | `bad_json`          | 体不是合法 JSON 对象                                 | 否                            |
| 401  | `unauthorized`      | 签名/凭据/时间戳问题                                 | 修签名后重试                  |
| 403  | `forbidden`         | 该 scope 不属于这个 `userId`                         | 否                            |
| 403  | `refused`           | 消息被安全策略拦下                                   | 否                            |
| 404  | `not_found`         | 路径不在白名单，或会话不存在                         | 否                            |
| 409  | `exists`            | 同 scope 下技能重名                                  | 换名字                        |
| 413  | `payload_too_large` | 体超过该端点上限                                     | 拆小                          |
| 429  | `rate_limited`      | 超配额                                               | 按 `retry-after` 退避         |
| 500  | `internal_error`    | 网关自身异常                                         | 可重试                        |
| 502  | `upstream_error`    | 后端不可达、超时，或响应形状异常                     | 先核对状态再重试，见 §4 与 §7 |

`502` 的形状：

```json
{ "error": "upstream_error", "message": "employee listing failed", "upstream": { "status": 403, "error": "forbidden" } }
```

## 6. 限流

按 `partnerId` 计，固定 60 秒窗口，默认 **120 请求/分钟**（部署方可调，`0` = 不限）。超限返回：

```
429 {"error":"rate_limited","message":"partner quota exceeded, retry in 37s","retryAfter":37}
retry-after: 37
```

配额按 `partnerId` 计，不按 `userId` 计——你所有用户共享同一份配额。

配额计数是**每网关实例的内存态**：网关多实例部署时每个实例独立计数，实际总额约为 `配额 × 实例数`；网关重启会清零。这是有意的取舍，不要把它当精确的账单依据。

SSE 长连接在整个订阅期间只占用一次配额。

## 7. 重试与幂等

| 端点                                                                      | 幂等             | 建议                                                                                                          |
| ------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------- |
| `GET /v1/employees` / `/v1/sessions` / `/v1/sessions/:id` / `/v1/runtime` | 是               | 随便重试                                                                                                      |
| `GET /v1/events`                                                          | 是               | 断流后按 §4 重连                                                                                              |
| `POST /v1/skills`                                                         | 是（重名 `409`） | 重试安全，`409` 当作已存在                                                                                    |
| `POST /v1/turn`                                                           | **否**           | `502`/`500` 时重试可能产生两条消息；先 `GET /v1/sessions/:id` 看最后一条是不是你刚发的，不是再重发            |
| `POST /v1/assemble`                                                       | **否**           | 任何 `502` 都先 `GET /v1/employees` 核对，确认没建出来再重试；`201` 之后的局部失败只能用 `POST /v1/skills` 补 |

网络层请设**读超时**：普通请求 15 秒（网关调后端的超时就是 15 秒）；SSE 不设读超时，但要自己定总时长上限（见 §4 的 `GET /v1/events`）。

## 8. 技能形态约束

技能只有 **markdown body** 一种形态：

- 没有附件、没有多文件、没有二进制、没有 zip 上传。
- 需要脚本时把代码**内联在 markdown 的代码块里**，运行时会在沙箱内按需生成文件再执行。
- 单条 ≤128KB、单次 `assemble` ≤20 条，是刻意的闸门：技能是按员工存物理副本的，员工数 × 技能数决定后端每轮的开销。请只放当前员工真正需要的技能。

## 9. 不提供的能力

以下都不在 v1 白名单内，请求会得到 `404`：

- 幂等键 / 请求去重表
- 目录同步（花名册、显示名解析）
- 附件与文件上传下载
- 删除类接口（删员工、删技能、删会话、清空历史）
- 会话整理（改标题、归档、置顶、分叉）
- 员工改名、用户停用/注销
- 管理面（admin / 凭据保管箱 / 部署 / 定时任务 / webhook）
- MCP 工具的按用户切分

**MCP 工具**由部署方在后端按 org 全局登记，对所有员工、所有用户可见同一批工具，**不携带也不区分终端用户身份**。如果你的业务需要按用户区分数据，请在你的 MCP 服务端用工具入参自行处理——注意入参由模型生成，不能当作可信的鉴权依据。
