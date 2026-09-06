# H5 网关接口对接文档

面向甲方 H5 应用后端。甲方 H5 前端不直接调用本文档接口，而是由**甲方后端**统一签名后调用本网关；网关再把请求翻译成内部数字员工服务（web-ui server）能识别的身份，转发并流式回传结果。

- 网关基址（dev）：`http://192.168.2.12:8193`
- 所有接口均为 HTTP/JSON（除两个 SSE 流式接口与文件下载外）。
- 除 `GET /healthz` 外，**所有接口都要求 HMAC 签名**（见第二节）。

---

## 一、接口总览

### A. 网关自有接口（身份与装配）

| # | 方法 | 路径 | 用途 |
|---|---|---|---|
| A1 | POST | `/login` | 员工登录 / 注册，返回 `principalId`，并同步名册 |
| A2 | POST | `/assemble` | 为员工装配数字员工（建项目 + 授库域技能 + 写入人格） |
| A3 | GET | `/healthz` | 探活（**唯一免签名**接口） |

### B. 数字员工对话接口（透传 web-ui server）

> 以下接口路径与 web-ui server 完全一致，调用时**必须带 `?principalId=<id>` 查询参数**（参与签名，见第二节）。

**身份**

| # | 方法 | 路径 | 用途 |
|---|---|---|---|
| B1 | GET | `/me` | 校验身份透传是否成功，返回当前用户与权限 |

**对话核心（发消息 / 收回复）**

| # | 方法 | 路径 | 用途 |
|---|---|---|---|
| B2 | POST | `/api/turn` | 发一条消息，触发一次 agent 运行，返回 `runId` |
| B3 | GET | `/api/runs/:id/events` | **SSE** 流式接收该次运行的增量回复与活动 |
| B4 | GET | `/api/runs/:id` | 轮询单次运行状态与结果（非流式） |
| B5 | GET | `/api/runs/active` | 查询某会话当前是否有进行中的运行 |
| B6 | POST | `/api/runs/:id/signal` | 向进行中的运行发信号（如追加输入） |
| B7 | POST | `/api/runs/:id/withdraw` | 撤回 / 取消一次运行 |
| B8 | GET | `/api/deliveries/events` | **SSE** 接收数字员工主动推送的消息 |

**会话（对话线程）**

| # | 方法 | 路径 | 用途 |
|---|---|---|---|
| B9 | GET | `/api/sessions` | 列出当前用户的全部会话 |
| B10 | GET | `/api/sessions/:id` | 取单个会话详情（含消息条目，可分页） |
| B11 | GET | `/api/sessions/:id/entries/:seq` | 取会话中某一条消息 |
| B12 | POST | `/api/sessions/:id` | 改会话属性（标题 / 归档 / 置顶 / 颜色） |
| B13 | POST | `/api/sessions/:id/title` | 让 agent 依据内容自动生成会话标题 |
| B14 | POST | `/api/sessions/:id/fork` | 从某条消息处分叉出新会话 |
| B15 | GET | `/api/sessions/:id/approvals` | 列出会话中待处理的审批 |
| B16 | GET | `/api/sessions/:id/background` | 列出会话中的后台进程 |
| B17 | GET | `/api/sessions/:id/background/:pid/output` | 取后台进程输出（游标分页） |
| B18 | GET | `/api/search` | 全文搜索历史会话 |

**项目（数字员工工作区）**

| # | 方法 | 路径 | 用途 |
|---|---|---|---|
| B19 | POST | `/api/projects` | 新建项目（裸项目，**不含技能**，装配请用 A2） |
| B20 | PATCH | `/api/projects/:id` | 重命名项目 |
| B21 | POST | `/api/projects/:id/members` | 添加项目成员 |
| B22 | DELETE | `/api/projects/:id/members/:memberId` | 移除项目成员 |
| B23 | PUT | `/api/projects/:id/slack-channel` | 绑定项目到 Slack 频道 |
| B24 | DELETE | `/api/projects/:id/slack-channel` | 解绑 Slack 频道 |

**文件与附件**

| # | 方法 | 路径 | 用途 |
|---|---|---|---|
| B25 | POST | `/api/blobs` | 上传附件二进制，返回 `blobId`（供 `/api/turn` 引用） |
| B26 | POST | `/api/files/upload` | 上传文件到某 scope |
| B27 | GET | `/api/files` | 列出文件（分页 / 按 scope） |
| B28 | GET | `/api/files/:id/content` | 下载文件内容（二进制流） |

**记忆**

| # | 方法 | 路径 | 用途 |
|---|---|---|---|
| B29 | GET | `/api/memory` | 读取当前用户的记忆笔记本 |
| B30 | PUT | `/api/memory` | 覆写记忆笔记本 |
| B31 | GET | `/api/memory/history` | 记忆修订历史 |
| B32 | POST | `/api/memory/restore` | 回滚到某个记忆修订版本 |

**技能**

| # | 方法 | 路径 | 用途 |
|---|---|---|---|
| B33 | GET | `/api/skills` | 列出可用技能 |
| B34 | GET | `/api/skills/:id` | 取单个技能详情 |
| B35 | POST | `/api/skills` | 新建技能 |
| B36 | PUT | `/api/skills/:id` | 修改技能 |
| B37 | DELETE | `/api/skills/:id` | 删除技能 |
| B38 | POST | `/api/skills/:id/restore` | 恢复已删除技能 |

**审批**

| # | 方法 | 路径 | 用途 |
|---|---|---|---|
| B39 | POST | `/api/approvals/:requestId` | 批准 / 拒绝一次工具调用审批 |

**连接器与钥匙串（第三方授权与凭证）**

| # | 方法 | 路径 | 用途 |
|---|---|---|---|
| B40 | GET | `/api/connectors` | 查询各连接器 OAuth 状态 |
| B41 | POST | `/api/connectors/:provider/start` | 发起某连接器的 OAuth 授权 |
| B42 | POST | `/api/connectors/revoke` | 撤销连接器授权 |
| B43 | GET | `/api/keychain/credentials` | 列出钥匙串凭证 |
| B44 | GET | `/api/keychain/overview` | 钥匙串总览 |
| B45 | POST | `/api/keychain/drops` | 投递凭证 |
| B46 | POST | `/api/keychain/grants/:id/revoke` | 撤销凭证授权 |
| B47 | DELETE | `/api/keychain/credentials/:id` | 删除凭证 |

**部署（数字员工发布的网页 / 应用）**

| # | 方法 | 路径 | 用途 |
|---|---|---|---|
| B48 | GET | `/api/deployments` | 列出部署 |
| B49 | GET | `/api/deployments/:id` | 取部署详情 |
| B50 | GET | `/api/deployments/:id/owner-url` | 取部署的属主访问 URL |
| B51 | POST | `/api/deployments/:id/display-name` | 改部署显示名 |
| B52 | POST | `/api/deployments/:id/name` | 改部署名 |
| B53 | POST | `/api/deployments/:id/archive` | 归档部署 |
| B54 | POST | `/api/deployments/:id/restore` | 恢复部署 |

**Webhook（外部事件触发数字员工）**

| # | 方法 | 路径 | 用途 |
|---|---|---|---|
| B55 | GET | `/api/webhooks` | 列出 webhook |
| B56 | POST | `/api/webhooks` | 新建 webhook |
| B57 | POST | `/api/webhooks/:id/enable` | 启用 |
| B58 | POST | `/api/webhooks/:id/disable` | 停用 |

**定时任务（Cron）**

| # | 方法 | 路径 | 用途 |
|---|---|---|---|
| B59 | GET | `/api/crons` | 列出定时任务 |
| B60 | GET | `/api/crons/:id/runs` | 取某定时任务的运行历史 |
| B61 | PATCH | `/api/crons/:id` | 修改定时任务 |
| B62 | POST | `/api/crons/:id/enable` | 启用 |
| B63 | POST | `/api/crons/:id/disable` | 停用 |
| B64 | POST | `/api/crons/:id/run` | 立即触发一次 |
| B65 | DELETE | `/api/crons/:id` | 删除 |

**配置与界面状态**

| # | 方法 | 路径 | 用途 |
|---|---|---|---|
| B66 | GET | `/api/contexts` | 列出上下文（个人 / 频道 / 群组） |
| B67 | GET | `/api/contexts/:scope/ambient-policy` | 取某上下文的主动策略 |
| B68 | PUT | `/api/contexts/:scope/ambient-policy` | 改主动策略 |
| B69 | GET | `/api/runtime-config` | 取运行时配置（模型 / harness 等） |
| B70 | PUT | `/api/runtime-config` | 改运行时配置 |
| B71 | GET | `/api/ui-state` | 取界面状态（按键） |
| B72 | PUT | `/api/ui-state` | 存界面状态 |
| B73 | GET | `/api/channel-header-pin` | 取频道头部置顶 |
| B74 | PUT | `/api/channel-header-pin` | 改频道头部置顶 |
| B75 | GET | `/api/scope-resources` | 取某 scope 的资源 |
| B76 | GET | `/api/surface-config` | 取 surface 配置 |
| B77 | GET | `/api/directory/resolve` | 按关键词解析人员目录 |

---

## 二、鉴权对接

### 2.1 两道信任边界

```
甲方后端 ──[HMAC 签名 + principalId]──> H5 网关 ──[内部身份头]──> web-ui server ──> core
```

甲方只需关心**第一道**：用共享密钥 `CORE_SIGNING_SECRET` 对每个请求做 HMAC 签名。第二道（网关→web-ui 的身份头）由网关自动完成，甲方无需感知。

### 2.2 签名算法

对每个请求，构造规范串并计算签名：

```
canonical = method + "\n" + pathWithQuery + "\n" + rawBody
signature = "v0=" + HMAC_SHA256_hex(secret, "v0:" + timestampSec + ":" + canonical)
```

放入两个请求头：

```
x-timestamp: <unix 秒>
x-signature: v0=<hex>
```

要点：

- `method`：大写 HTTP 方法（`GET` / `POST` / `PUT` / `PATCH` / `DELETE`）。
- `pathWithQuery`：**含查询串**的路径，例如 `/api/turn?principalId=U123`。查询参数参与签名，因此 `principalId` 不可被中途篡改。
- `rawBody`：请求体原文。**无体的请求（如 GET）用空字符串 `""`**，不要省略这一行。
- `secret`：`CORE_SIGNING_SECRET`，由我方提供给甲方，需妥善保管（一旦泄露等同身份泄露）。
- `timestampSec`：当前 unix 秒。服务端校验 `|now - timestamp| ≤ 300` 秒，超时判为过期（防重放）。

### 2.3 principalId 的两种携带方式

| 接口 | principalId 位置 | 说明 |
|---|---|---|
| `/login` | **请求体** `{id}` | 登录时用它建立 / 定位员工身份 |
| `/assemble` | **请求体** `{principalId}` | 为哪个员工装配 |
| `/me`、`/api/*` | **查询参数** `?principalId=<id>` | 代表哪个员工操作；参与签名 |

> 对话类接口（`/me`、`/api/*`）的 `principalId` 必须放在查询串里，因为它要参与签名防篡改；放在请求体或自定义头里都不生效。

### 2.4 签名示例（Node.js）

```js
const crypto = require("node:crypto");

function signedHeaders(secret, method, pathWithQuery, body = "") {
  const ts = Math.floor(Date.now() / 1000);
  const canonical = `${method}\n${pathWithQuery}\n${body}`;
  const sig =
    "v0=" + crypto.createHmac("sha256", secret).update(`v0:${ts}:${canonical}`).digest("hex");
  return { "x-timestamp": String(ts), "x-signature": sig };
}

// 例：代表员工 U123 发一条消息
const BASE = "http://192.168.2.12:8193";
const secret = process.env.CORE_SIGNING_SECRET;
const principalId = "U123";
const pathWithQuery = `/api/turn?principalId=${principalId}`;
const body = JSON.stringify({ text: "帮我写一封请假邮件", threadRef: `web:${principalId}:default` });

const res = await fetch(`${BASE}${pathWithQuery}`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    ...signedHeaders(secret, "POST", pathWithQuery, body),
  },
  body,
});
```

> 注意：`body` 变量既要用于计算签名，也要原样作为请求体发送，两者必须是**同一份字符串**（同样的 JSON 序列化结果）。

### 2.5 鉴权错误形状

签名 / 身份类错误统一为 JSON：

| HTTP | `error` | 触发条件 |
|---|---|---|
| 401 | `unauthorized` | `message` ∈ `source authentication is not configured` / `missing signature (unsigned request)` / `invalid timestamp` / `stale timestamp (replay protection)` / `signature mismatch` |
| 400 | `bad_request` | 缺 `principalId` 查询参数（`message: "principalId query parameter is required"`）等 |
| 400 | `bad_json` | 请求体不是合法 JSON |
| 413 | `payload_too_large` | 请求体超限（`/login`、`/assemble` 上限 8KB；`/api/*` 上限 25MB） |
| 502 | `bad_gateway` | 网关无法连通上游 web-ui server |

---

## 三、接口详情

### A1. POST /login — 员工登录 / 注册

建立一个员工身份并同步到人员名册。幂等：同一 `id` 重复调用只更新名字，不会重复创建。

**请求体**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string | 是 | 员工唯一标识（甲方侧的用户 ID）。受 `IDLOGIN_ALLOWED_IDS` 白名单约束（若配置） |
| `name` | string | 否 | 显示名。缺省时回退到上次的名字，再回退到 `id` |

**响应 200**

```json
{ "ok": true, "principalId": "U123", "displayName": "张三", "created": true }
```

| 字段 | 说明 |
|---|---|
| `principalId` | 员工 ID（等于请求的 `id`），后续所有对话接口都用它 |
| `displayName` | 最终采用的显示名 |
| `created` | `true` = 本次新建；`false` = 已存在，仅更新 |

**错误**：400 `bad_request`（字段校验失败）、403 `id_not_allowed`（不在白名单）、502 `directory_sync_failed`（名册同步失败）。

> 登录**不返回 token**。身份靠后续每个请求的 HMAC 签名 + `principalId` 携带。

---

### A2. POST /assemble — 装配数字员工

为员工创建一个项目、授予某个技能库、并写入人格设定（SOUL）。这是"给员工配一个数字员工"的一站式接口。带 `externalId` 时幂等。

**请求体**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `library` | string | 是 | 技能库标识，须匹配库命名规则；须是网关已配置的库 |
| `name` | string | 是 | 项目名（≤200 字符） |
| `principalId` | string | 是 | 为员工装配（≤200 字符） |
| `externalId` | string | 否 | 幂等键（≤200 字符）；相同 `externalId` 重复调用返回同一结果 |
| `soul` | string | 否 | 人格 / 系统提示设定 |

**响应 200（成功）**

```json
{
  "status": "assembled",
  "library": "default",
  "projectId": "proj_abc",
  "projectScopeId": "project:proj_abc",
  "granted": ["skill-1", "skill-2"],
  "reused": false
}
```

| 字段 | 说明 |
|---|---|
| `projectId` | 新建（或复用）的项目 ID |
| `projectScopeId` | 项目作用域 ID，可用作 `/api/turn` 的 `scopeId` |
| `granted` | 实际授予的技能 ID 列表 |
| `reused` | `true` = 命中幂等，复用了已有装配 |

**响应（失败）**

```json
{ "status": "error", "code": "unknown_library", "message": "..." }
```

`code` 为 `unknown_library` 时 HTTP 400，其余上游失败为 502（可能带 `upstream`、`projectId`、`granted` 字段）。

> **装配不返回会话 / threadRef**。会话在员工发第一条消息（B2 `/api/turn`）时自然诞生，见 B2 的 threadRef 约定。

---

### A3. GET /healthz — 探活

**唯一免签名**接口。

**响应 200**：`{ "ok": true }`

---

### B1. GET /me — 校验身份透传

确认签名与 `principalId` 被正确翻译为内部身份。对接联调时**建议第一个调用**。

**请求**：`GET /me?principalId=U123`（需签名，body 为空串）

**响应 200**

```json
{
  "user": "U123",
  "org": "acme",
  "mode": "portal",
  "slackWorkspaceUrl": null,
  "impersonatedBy": null,
  "permissions": []
}
```

| 字段 | 说明 |
|---|---|
| `user` | 当前生效的用户（= 传入的 `principalId`） |
| `mode` | 认证模式；经本网关透传时为 `portal`，表明身份头生效 |
| `permissions` | 该用户的管理权限（普通员工通常为空） |

---

### B2. POST /api/turn — 发消息（核心）

发一条消息并触发一次数字员工运行。**这是对话的入口**，会话由此诞生。

**请求**：`POST /api/turn?principalId=U123`

**请求体**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `text` | string | 否* | 消息文本 |
| `threadRef` | string | 否 | 会话线程标识，见下方约定。缺省 `web:<principalId>:default` |
| `scopeId` | string | 否 | 作用域（如 A2 返回的 `projectScopeId`，或 `personal:<id>` / `channel:<ref>` / `group:<ref>`） |
| `channelName` | string | 否 | 频道名（≤200 字符） |
| `attachments` | array | 否 | 附件列表，元素 `{name, mimetype?, sizeBytes?, blobId}`，`blobId` 来自 B25 |
| `model` | string | 否 | 指定模型 |
| `harness` | string | 否 | 指定执行 harness |
| `thinkingLevel` | string | 否 | 思考强度 |
| `fastMode` | boolean | 否 | 快速模式 |
| `timezone` | string | 否 | 时区（≤64 字符） |
| `approval` | object | 否 | `{requestId, approved, scope?}`，用于在审批后续跑 |
| `proactiveOpener` | boolean | 否 | 主动开场白标记 |

\* `text`、`attachments`、`approval`、`proactiveOpener` 至少提供其一，否则 400 `empty message`。

**threadRef 约定（重要）**

- 必须以 `web:` 开头，且以 `web:<principalId>:` 为前缀，否则 **403 `forbidden_thread`**。
- **同一 `threadRef` = 同一会话**；换一个后缀（如 `web:U123:<uuid>`）即开启**新会话**。
- 没有"建空会话"接口——会话在第一条 turn 被处理时诞生。
- 例外：当 `scopeId` 以 `channel:` 或 `group:` 开头时，允许非本人前缀的 `threadRef`（共享上下文）。

**响应 200**

```json
{ "status": "queued", "runId": "run_xyz" }
```

拿到 `runId` 后，用 B3（SSE 流式）或 B4（轮询）获取回复。

**错误**：400 `empty message`、403 `forbidden_thread`、403 `forbidden_scope`。

---

### B3. GET /api/runs/:id/events — 流式接收回复（SSE）

**请求**：`GET /api/runs/run_xyz/events?principalId=U123`（需签名，body 空串）

响应为 `text/event-stream`。事件类型：

| 事件 | 数据 | 含义 |
|---|---|---|
| `partial` | `{partial}` | 回复文本增量（累积全量） |
| `activity` | `{activity, startedAt}` | 运行活动（工具调用等） |
| `stale` | `{stale}` | 运行变为 / 脱离陈旧状态 |
| `alive` | `{at}` | 心跳，运行仍存活 |
| `done` | `{status, result, partial, activity, replyComplete, startedAt, finishedAt}` | **运行结束**，`result` 为最终结果 |
| `failed` | `{reason}` | 运行失败（如 `upstream_unreachable`、`HTTP <code>`） |

收到 `done` 或 `failed` 后流结束。长时间无进展会因空闲超时自动断开，可重连或改用 B4 轮询。

> 仅运行的属主（`principalId` 匹配）可订阅，否则 404 / 502。

---

### B4. GET /api/runs/:id — 轮询运行状态

**请求**：`GET /api/runs/run_xyz?principalId=U123`

**响应 200**：透传运行对象，含 `status`（`queued` / `running` / `done` / `failed`）、`result`、`partial`、`activity` 等字段。`status` 为 `done` / `failed` 即终态。

---

### B5. GET /api/runs/active — 查询进行中运行

**请求**：`GET /api/runs/active?principalId=U123&threadRef=web:U123:default`

`threadRef` 必须以 `web:` 开头，否则 404。

**响应 200**

```json
{ "runId": "run_xyz", "run": { "status": "running" }, "queued": [] }
```

无进行中运行时：`{ "runId": null, "run": null }`。

---

### B6. POST /api/runs/:id/signal — 向运行发信号

**请求体**：`{ "kind": "<string>", "text": "<可选>" }`。透传至运行，用于中途追加输入等。

---

### B7. POST /api/runs/:id/withdraw — 撤回运行

无请求体。成功后该运行从活动列表移除。响应透传上游结果。

---

### B8. GET /api/deliveries/events — 主动推送流（SSE）

**请求**：`GET /api/deliveries/events?principalId=U123`

响应为 `text/event-stream`，接收数字员工**主动**投递给该用户的消息（非某次 turn 的回复）。含 `: ping` 心跳。

---

### B9. GET /api/sessions — 会话列表

**请求**：`GET /api/sessions?principalId=U123`

**响应 200**：`{ "sessions": [ ... ] }`，每项含会话 ID、`threadRef`、标题、更新时间等。新用户为空数组。

---

### B10. GET /api/sessions/:id — 会话详情

**请求**：`GET /api/sessions/:id?principalId=U123`

**查询参数（均可选）**：`tailTurns`（只取末尾 N 轮）、`sinceSeq`（取序号 > N 的条目）、`beforeSeq`（取序号 < N 的条目）。

**响应 200**：会话对象 + 消息条目。仅会话可见者（viewer = `principalId`）可取。

---

### B11. GET /api/sessions/:id/entries/:seq — 单条消息

`:seq` 必须为纯数字，否则 404。响应透传该条目。

---

### B12. POST /api/sessions/:id — 改会话属性

**请求体**（至少一项）：`{ "title"?: string|null, "archived"?: boolean, "pinned"?: boolean, "color"?: string|null }`。全缺则 400。

---

### B13. POST /api/sessions/:id/title — 自动生成标题

无请求体。让 agent 依据会话内容生成标题。响应透传。

---

### B14. POST /api/sessions/:id/fork — 分叉会话

**请求体**：`{ "upToSeq"?: number }`（从第几条消息处分叉，缺省为全部）。响应含新会话信息。

---

### B15. GET /api/sessions/:id/approvals — 待审批列表

响应透传该会话中待处理的审批请求列表。

---

### B16. GET /api/sessions/:id/background — 后台进程列表

响应透传会话中的后台进程。

---

### B17. GET /api/sessions/:id/background/:pid/output — 后台进程输出

**查询参数**：`sinceCursor`（缺省 `0`）。响应含输出片段与新游标。

---

### B18. GET /api/search — 搜索历史会话

**查询参数**：`q`（关键词，必填）、`limit`（可选）。响应透传搜索结果。

---

### B19. POST /api/projects — 新建项目

**请求体**：`{ "name": string }`（≤200 字符，必填，否则 400）。

> **裸项目，不含技能与人格**。要给员工装配数字员工请用 **A2 `/assemble`**。此接口仅用于员工自行新建普通项目。

**响应 200**：透传新建项目对象（含项目 ID）。

---

### B20. PATCH /api/projects/:id — 重命名项目

**请求体**：`{ "name": string }`（≤200 字符，必填）。

---

### B21. POST /api/projects/:id/members — 添加成员

**请求体**：`{ "memberId": string }`（必填）。

---

### B22. DELETE /api/projects/:id/members/:memberId — 移除成员

无请求体。

---

### B23. PUT /api/projects/:id/slack-channel — 绑定 Slack 频道

**请求体**：`{ "channel": string }`（≤200 字符，必填）。

---

### B24. DELETE /api/projects/:id/slack-channel — 解绑 Slack 频道

无请求体。

---

### B25. POST /api/blobs — 上传附件

上传附件二进制，取得 `blobId`，随后在 B2 `/api/turn` 的 `attachments` 中引用。

**请求**：`POST /api/blobs?principalId=U123`，请求体为文件二进制（可带 `sha256` 查询参数做完整性校验）。上限 25MB。

**响应 200**：含 `blobId` 等字段。

---

### B26. POST /api/files/upload — 上传文件到 scope

**查询参数**：`scope`（可选）、`sha256`（可选）、`name`（可选，文件名）。请求体为文件二进制。

---

### B27. GET /api/files — 文件列表

**查询参数**：`limit`、`cursor`、`scope`（均可选）。响应透传文件列表（分页）。

---

### B28. GET /api/files/:id/content — 下载文件

响应为文件二进制流（`content-type` 按文件类型），非 JSON。带沙箱 CSP 头。404 = 不存在，502 = 上游错误。

---

### B29. GET /api/memory — 读取记忆

**请求**：`GET /api/memory?principalId=U123`。响应含记忆内容与 `revision`（修订号，用于 B30/B32）。

---

### B30. PUT /api/memory — 覆写记忆

**请求体**：`{ "content": string, "revision"?: string }`。`content` 必填且须为字符串，否则 400。`revision` 缺省时网关自动取当前修订号（乐观锁）。

---

### B31. GET /api/memory/history — 记忆修订历史

响应透传历史修订列表。

---

### B32. POST /api/memory/restore — 回滚记忆

**请求体**：`{ "revision": string, "expectedRevision": string }`。回滚到指定修订。

---

### B33. GET /api/skills — 技能列表

**查询参数**：`includeShadowed=1`（可选，含被遮蔽技能）。响应透传技能列表。

---

### B34. GET /api/skills/:id — 技能详情

响应透传技能对象。

---

### B35. POST /api/skills — 新建技能

**请求体**（字段均可选，按需）：`{ "name"?: string, "description"?: string, "body"?: string, "scopeId"?: string }`。

---

### B36. PUT /api/skills/:id — 修改技能

**请求体**：`{ "description"?: string, "body"?: string }`。

---

### B37. DELETE /api/skills/:id — 删除技能

无请求体。

---

### B38. POST /api/skills/:id/restore — 恢复技能

无请求体。

---

### B39. POST /api/approvals/:requestId — 处理审批

当数字员工要执行敏感工具调用时会挂起等待审批。用此接口批准或拒绝。

**请求体**

| 字段 | 类型 | 说明 |
|---|---|---|
| `approved` | boolean | `true` 批准，`false` 拒绝 |
| `scope` | string | 可选，`once`（仅本次）/ `session`（本会话）/ `always`（总是） |

**行为**：校验该审批确属当前 `principalId` 且 `threadRef` 以 `web:` 开头，随后以审批结果续跑该 turn。

**响应 200**：同 B2 `/api/turn`（`{status, runId}`），可继续用 B3/B4 跟踪。

**错误**：404 `not_found`（审批不存在 / 不属于该用户）。
