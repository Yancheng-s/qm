# Partner Gateway 对接说明

本文描述通过 Partner Gateway 接入 QM 数字员工能力的方式：服务端调用 Partner API 装配助手、获取对话入口，用户在浏览器或小程序 `web-view` 中打开聊天页完成交互。

## 架构概览

```
接入方服务端（持有 partnerId / partnerSecret）
    │  HMAC 签名
    ▼
Partner Gateway          /v1/assemble、/v1/chat-sessions
    │
    │  chatUrl（相对路径）
    ▼
用户浏览器 / web-view
    │  打开 {GATEWAY_URL}/auth/login?...
    ▼
静默登录（Gateway → H5 authorize → Gateway callback）
    ▼
Partner 聊天页（partner-ui）
```

- **服务端**：仅调用 Partner Gateway 的 `/v1/*` 接口，负责签名与业务参数。
- **客户端**：打开接口返回的 `chatUrl`（需拼上网关公网/局域网根地址），不持有 `partnerSecret`。
- **无回调**：QM 不会向接入方服务端发起 HTTP 回调；登录跳转均在 QM 侧完成。

## 接入前准备

### QM 侧提供（接入方写入服务端配置）

以下参数由 QM 运维签发；**QM Gateway 与接入方服务端必须配置为同一套值**（`PARTNER_ID` + `PARTNER_SECRET` 用于验签）。接入方只需写在**自己的服务端**，不要写入小程序或前端。

| 配置项 | 环境变量建议名 | 说明 | 智渠名片对接值 |
|---|---|---|---|
| 网关地址 | `PARTNER_GATEWAY_URL` | Partner API 根地址；`chatUrl` 也用它拼接绝对地址 | `http://192.168.2.12:8209` |
| 合作方 ID | `PARTNER_ID` | 签名请求头 `x-partner-id` | `zhiqu-card` |
| 签名密钥 | `PARTNER_SECRET` | HMAC 密钥，与 QM 侧 `PARTNER_CREDENTIALS` 中该 ID 的 secret 一致 | `zqcard_8f3a9c2e1b7d4f6a0e5c8b2d9a1f4e7c` |

QM 侧对应环境变量示例：

```
PARTNER_CREDENTIALS=zhiqu-card=zqcard_8f3a9c2e1b7d4f6a0e5c8b2d9a1f4e7c
```

上线前由 QM 运维轮换密钥并同步给接入方；联调密钥勿用于生产环境。

### 名片场景固定业务参数（接入方请求体直接使用）

产品库与技能已在 QM 侧绑定，接入方按下列常量调用即可，无需再申请库 ID 或技能 ID。

| 参数 | 取值 | 用于接口 |
|---|---|---|
| `library` | `card` | `POST /v1/assemble` |
| `skills` | `["zhiqu-card-create"]` | `POST /v1/assemble` |
| `name` | `智渠名片助手`（可改显示名） | `POST /v1/assemble` |
| `soul` | 见 [名片推荐参数](#名片场景推荐参数) | `POST /v1/assemble` |
| `standingOrders` | 见 [名片推荐参数](#名片场景推荐参数) | `POST /v1/assemble` |

### 接入方自行维护（业务侧生成或持久化）

QM 不签发下列字段；由接入方业务系统产生并在库中保存。

| 参数 | 来源 | 说明 |
|---|---|---|
| `userId` | 接入方用户体系 | 稳定用户标识，格式 `^[A-Za-z0-9_-]{1,64}$`；`assemble` 与 `chat-sessions` 须一致 |
| `scopeId` | `assemble` 响应 | `employee.scopeId`（形如 `group:web-project-…`），**必须落库**，开对话时传入 |
| `conversationId` | 接入方会话管理 | 新对话生成新 ID；续聊复用原 ID；省略时默认为 `default` |

### 接入方不需要提供

| 项 | 说明 |
|---|---|
| 接入方服务端 IP / 端口 | 无回调，QM 不会主动访问接入方 |
| 接入方域名 / 白名单 | 对话链路由 QM 侧 Gateway、H5、partner-ui 完成 |
| `partnerSecret` 给前端 | 密钥仅服务端签名使用；小程序只打开 `GATEWAY_URL + chatUrl` |

### 配置检查

联调前确认：

1. 服务端能访问 `PARTNER_GATEWAY_URL`（如 `GET {GATEWAY_URL}/healthz` 返回 `{"ok":true}`）
2. `PARTNER_ID` / `PARTNER_SECRET` 与 QM 签发一致
3. 用户首次使用前已调用 `assemble` 并保存 `scopeId`
4. 小程序 `web-view` 可打开 `http://192.168.2.12:8209`（开发阶段需在微信开发者工具勾选「不校验合法域名」）

## 协议版本

成功响应携带响应头：

```
x-partner-protocol: 1
```

## 鉴权

除 `GET /healthz` 外，所有 `/v1/*` 请求必须携带以下请求头：

| Header | 说明 |
|---|---|
| `x-partner-id` | 合作方 ID |
| `x-timestamp` | Unix 时间戳（秒），与服务器时差不超过 **300 秒** |
| `x-signature` | HMAC-SHA256 签名 |
| `content-type` | `POST` 请求为 `application/json` |

### 签名算法

```
canonical = METHOD + "\n" + pathWithQuery + "\n" + rawBody
signature = "v0=" + HMAC_SHA256(secret, "v0:" + timestamp + ":" + canonical)
```

注意：

- `pathWithQuery` 含完整查询字符串，例如 `/v1/chat-sessions?userId=u1&scopeId=group%3Axxx`
- `GET` 请求的 `rawBody` 为空字符串 `""`
- `POST` 的 body 必须与签名时使用的字节完全一致（不要签名后再重新格式化 JSON）

### 用户标识

请求中的 `userId` 规则：`^[A-Za-z0-9_-]{1,64}$`。建议使用接入方业务系统的稳定用户 ID。

网关内部映射为 `principalId = {partnerId}_{userId}`，同一 `userId` 在不同 `partnerId` 下数据隔离。

## 接口列表

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/healthz` | 健康检查，无需签名 |
| `POST` | `/v1/assemble` | 创建/装配数字员工 |
| `POST` | `/v1/chat-sessions` | 获取对话入口 URL |
| `GET` | `/v1/chat-sessions` | 列出用户的对话 |

默认限流：每个 `partnerId` **120 次/分钟**，超出返回 `429` 及 `retry-after` 头。

---

### GET /healthz

无需鉴权。

**响应** `200`：

```json
{ "ok": true }
```

---

### POST /v1/assemble

创建一名数字员工：建项目、授予技能库技能、可选写入人设与常驻指令、可选导入文件。

**请求体上限**：128 KB。**成功** `201`。

#### 请求体

```json
{
  "userId": "card_user_10001",
  "name": "智渠名片助手",
  "library": "card",
  "skills": ["zhiqu-card-create"],
  "soul": "你是智渠 AI 名片的创建向导……",
  "standingOrders": "你的名字叫「小智」……"
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `userId` | 是 | 接入方用户 ID |
| `name` | 是 | 助手名称，trim 后 1–200 字符 |
| `library` | 名片场景必填 | 固定 `"card"` |
| `skills` | 建议填写 | 名片场景为 `["zhiqu-card-create"]`；省略则授予该库全部技能。每项匹配 `^[a-z0-9][a-z0-9_-]{0,63}$`，最多 50 项，不可重复 |
| `soul` | 建议填写 | 人设文本，UTF-8 不超过 8 KB |
| `standingOrders` | 建议填写 | 常驻指令，不超过 20 000 字符 |
| `files` | 否 | 远程文件列表，见下文 |

#### 可选文件 `files`

网关从接入方提供的 **HTTPS** 地址拉取文件并导入员工工作区：

```json
{
  "files": [
    {
      "url": "https://cdn.example.com/card.pdf",
      "name": "名片.pdf",
      "mimetype": "application/pdf",
      "sha256": "64位小写十六进制",
      "sizeBytes": 12345
    }
  ]
}
```

- 最多 20 个文件，单文件不超过 100 MB
- `url` 必须为 `https`，且网关能够访问（不可为内网不可达地址）

#### 成功响应 `201`

```json
{
  "employee": {
    "id": "web-project-1",
    "scopeId": "group:web-project-1",
    "name": "智渠名片助手"
  },
  "granted": ["zhiqu-card-create"],
  "soul": true,
  "standingOrders": true,
  "files": []
}
```

**必须持久化** `employee.scopeId`（形如 `group:...`），后续开对话依赖此字段。

部分步骤失败时仍可能返回 `201`，并附带：

- `grantFailures` — 技能授予失败
- `soulError` / `standingOrdersError` — 人设或指令写入失败
- `fileFailures` — 文件导入失败

#### 名片场景推荐参数

```json
{
  "userId": "<业务用户ID>",
  "name": "智渠名片助手",
  "library": "card",
  "skills": ["zhiqu-card-create"],
  "soul": "你是智渠 AI 名片的创建向导。先了解用户要创建的名片，再按 zhiqu-card-create 技能与 zhiqu-card MCP 工具逐步完成；不编造姓名、公司、职位或文件。",
  "standingOrders": "你的名字叫「小智」，身份是智渠 AI 名片创建助手。被问及名字或身份时以此为准。创建名片时严格按 MCP 的 next_action 推进；正式提交前必须经用户确认预览；不得自动清空草稿、消耗激活码或提交名片。"
}
```

---

### POST /v1/chat-sessions

获取用户打开对话页的入口地址。

**请求体上限**：4 KB。**成功** `200`。

#### 请求体

```json
{
  "userId": "card_user_10001",
  "scopeId": "group:web-project-1",
  "conversationId": "c1"
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `userId` | 是 | 须与 `assemble` 时一致 |
| `scopeId` | 是 | `assemble` 返回的 `employee.scopeId` |
| `conversationId` | 否 | `^[A-Za-z0-9._-]{1,120}$`；省略默认为 `"default"`。新对话使用新 ID，续聊使用原 ID |

#### 成功响应 `200`

```json
{
  "chatUrl": "/auth/login?returnTo=%2Fchat%2F%3FscopeId%3Dgroup%3Aweb-project-1%26conversationId%3Dc1&assertion=..."
}
```

#### 打开对话

`chatUrl` 为**相对路径**。接入方拼成绝对地址：

```
openUrl = GATEWAY_URL + chatUrl
```

示例：

```
http://192.168.2.12:8209/auth/login?returnTo=...&assertion=...
```

在小程序中可通过 `web-view` 打开 `openUrl`。`assertion` 有效期约 **120 秒**，获取后应尽快打开，不宜缓存。

浏览器将依次经过 Gateway 登录代理、H5 静默授权，最终进入 Partner 聊天页（partner-ui）。**不是**直接打开聊天页端口；但用户感知为一次跳转后进入对话界面。

---

### GET /v1/chat-sessions

列出用户已有对话。

```
GET /v1/chat-sessions?userId=card_user_10001
GET /v1/chat-sessions?userId=card_user_10001&scopeId=group%3Aweb-project-1
```

`userId` 放在查询参数中；签名时 `pathWithQuery` 须包含完整 query。

#### 成功响应 `200`

```json
{
  "conversations": [
    {
      "conversationId": "c1",
      "scopeId": "group:web-project-1",
      "title": "创建张三名片"
    }
  ]
}
```

`title` 可能为 `null`。

---

## 推荐调用流程（名片）

1. **首次使用**：`POST /v1/assemble`（`library=card`），保存返回的 `scopeId` 到业务库（关联用户或名片记录）。
2. **进入对话**：`POST /v1/chat-sessions`，将 `GATEWAY_URL + chatUrl` 交给前端 `web-view` 或浏览器打开。
3. **新会话**：使用新的 `conversationId`；**续聊**：复用原 `conversationId`。
4. **历史列表**（可选）：`GET /v1/chat-sessions`。

同一用户可多次 `assemble` 创建多名员工，每名员工有独立 `scopeId`。不要为每次对话重复 `assemble`。

---

## 错误响应

错误体格式：

```json
{
  "error": "unauthorized",
  "message": "signature mismatch"
}
```

| HTTP | `error` | 常见原因 |
|---|---|---|
| 400 | `bad_request` | 缺少或非法的 `userId`、`name`、`scopeId` 等 |
| 400 | `bad_json` | 请求体不是 JSON 对象 |
| 401 | `unauthorized` | 缺少请求头、未知 partner、时间戳过期、签名错误 |
| 404 | `not_found` | 路径不存在 |
| 413 | `payload_too_large` | 请求体超限 |
| 429 | `rate_limited` | 超过配额，见 `retryAfter` |
| 502 | `upstream_error` | QM 内部服务异常 |
| 500 | `internal_error` | 网关未预期错误 |

---

## 签名示例（Node.js）

```javascript
import { createHmac } from "node:crypto";

const GATEWAY_URL = process.env.PARTNER_GATEWAY_URL;
const PARTNER_ID = process.env.PARTNER_ID;
const SECRET = process.env.PARTNER_SECRET;

function signedHeaders(method, pathWithQuery, rawBody) {
  const ts = Math.floor(Date.now() / 1000);
  const canonical = `${method}\n${pathWithQuery}\n${rawBody}`;
  const signature =
    "v0=" + createHmac("sha256", SECRET).update(`v0:${ts}:${canonical}`).digest("hex");
  return {
    "x-partner-id": PARTNER_ID,
    "x-timestamp": String(ts),
    "x-signature": signature,
    ...(rawBody ? { "content-type": "application/json" } : {}),
  };
}

async function callPartner(method, pathWithQuery, body) {
  const raw = body === undefined ? "" : JSON.stringify(body);
  const res = await fetch(`${GATEWAY_URL}${pathWithQuery}`, {
    method,
    headers: signedHeaders(method, pathWithQuery, raw),
    ...(raw ? { body: raw } : {}),
  });
  const json = await res.json();
  if (!res.ok) throw Object.assign(new Error(json.message || res.status), { status: res.status, json });
  return json;
}

const assembled = await callPartner("POST", "/v1/assemble", {
  userId: "card_user_10001",
  name: "智渠名片助手",
  library: "card",
  skills: ["zhiqu-card-create"],
  soul: "你是智渠 AI 名片的创建向导……",
  standingOrders: "你的名字叫「小智」……",
});

const { chatUrl } = await callPartner("POST", "/v1/chat-sessions", {
  userId: "card_user_10001",
  scopeId: assembled.employee.scopeId,
  conversationId: "c1",
});

const openUrl = `${GATEWAY_URL}${chatUrl}`;
```

仓库内可参考：`plugins/partner-protocol/spec/partner-client.mjs`。

---

## 安全要求

- `partnerSecret` **不得**写入小程序、移动 App 或前端代码；签名逻辑仅放在接入方服务端。
- 生产环境使用 HTTPS 网关地址。
- `userId` 由接入方自行生成与校验，网关按 `partnerId` + `userId` 隔离数据。

---

## 联调说明

本地开发时 Gateway 默认端口为 `8209`（具体以运维提供的 `GATEWAY_URL` 为准）。局域网联调时，接入方只需能访问该地址；无需向 QM 登记接入方自身的 IP 或端口。

聊天页由 partner-ui 提供；用户通过 `chatUrl` 经 Gateway 登录后自动进入，接入方无需单独对接聊天 API。
