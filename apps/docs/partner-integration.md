# QM Partner 对接说明（技术部）

## 一、公共约定（Card / PMOS 相同）

### 1.1 环境地址

| 用途 | 配置项 | 当前联调值 |
|------|--------|------------|
| 服务端调 Partner API | `PARTNER_GATEWAY_URL` | `http://192.168.2.12:8209` |
| 浏览器打开聊天链接的前缀 | `PARTNER_PUBLIC_URL` | `http://192.168.2.12:8209`（与网关同域；手机必须用局域网 IP，不能写 `localhost`） |
| 伙伴 ID | `PARTNER_ID` | `zhiqu` |
| 签名密钥 | `PARTNER_SECRET` | `zhiqu-partner-integration-secret-a9f3e7c2b8d10456`（仅服务端保存，≥32 字符；与 QM 侧 `PARTNER_CREDENTIALS` 中 `zhiqu=` 后取值一致） |

所有 Partner 接口基址：`{PARTNER_GATEWAY_URL}`，例如 `POST http://192.168.2.12:8209/v1/assemble`。

### 1.2 用户标识

| 字段 | 规则 |
|------|------|
| `userId` | 贵司用户唯一 ID，字符串，正则 `^[A-Za-z0-9_-]{1,64}$` |
| QM 内部主键 | `zhiqu_{userId}`（网关根据 `partnerId` + `userId` 生成，贵司只需传 `userId`） |

同一 `userId` 下可创建多个数字员工（多次 assemble，多个 `scopeId`）。

### 1.3 请求签名（每个 Partner 接口必带）

**请求头：**

| Header | 说明 |
|--------|------|
| `x-partner-id` | `zhiqu` |
| `x-timestamp` | Unix 秒级时间戳，与服务器误差 ≤ **300 秒** |
| `x-signature` | 见下 |
| `Content-Type` | 有 JSON body 时为 `application/json` |

**算法（与 `apps/backend/src/partner-client.ts` 一致）：**

```
canonical = METHOD + "\n" + pathWithQuery + "\n" + rawBody
```

- `pathWithQuery`：路径 + 查询串，例如 `/v1/chat-sessions?userId=u1&scopeId=group%3Aabc`
- GET 无 body 时 `rawBody` 为空字符串 `""`
- body 为 JSON 时 `rawBody` 为**实际发送的字符串**（不要二次格式化，否则签名校验失败）

```
signature = "v0=" + HMAC_SHA256_HEX(partnerSecret, "v0:" + timestamp + ":" + canonical)
```

**Node 示例：**

```javascript
const ts = Math.floor(Date.now() / 1000);
const raw = body === undefined ? "" : JSON.stringify(body);
const pathWithQuery = "/v1/assemble"; // GET 时带 ?userId=...
const canonical = `POST\n${pathWithQuery}\n${raw}`;
const sig =
  "v0=" +
  createHmac("sha256", partnerSecret)
    .update(`v0:${ts}:${canonical}`)
    .digest("hex");
```

### 1.4 响应与错误

- 成功/失败均为 JSON；响应头含 `x-partner-protocol: 1`。
- 失败体一般为：`{ "error": "<代码>", "message": "<说明>" }`。
- 常见 HTTP：`401` 签名/伙伴错误，`400` 参数错误，`404` 路径错误，`413` body 过大，`429` 限流（读 `retry-after` 秒数后重试），`502` 上游不可用。

### 1.5 对接流程（贵司后端）

```
1) （建议）贵司自查 MCP 凭证仍有效 → 见 1.9
2) POST /v1/assemble     → 落库 employee.scopeId、name 等
3) POST /v1/chat-sessions → 得到 chatUrl，浏览器跳转 PARTNER_PUBLIC_URL + chatUrl
4) 凭证轮换时 PUT /v1/connectors → 覆盖 QM 侧存储，无需重新 assemble
5) （可选）GET /v1/chat-sessions → 拉会话列表、标题
```

聊天页在 QM Portal 的 **`/chat/`**（Web-UI），由 `chatUrl` 经 `/auth/login` 带 assertion 进入，贵司**不需要**自己实现对话接口。

### 1.6 接口清单

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/v1/assemble` | 创建数字员工 |
| POST | `/v1/chat-sessions` | 换取聊天入口 |
| GET | `/v1/chat-sessions?userId=…&scopeId=…` | 列举会话（`scopeId` 查询参数可选） |
| PUT | `/v1/connectors` | 更新单个 connector 凭证 |

### 1.7 `soul` / `standingOrders`（assemble 可选）

二者均为**纯文本**，由贵司按业务自行撰写；Partner 在创建员工时会把非空内容合并后，写入该 `scopeId` 下入口 Agent 的策略指令（与所选 `library` 插件自带说明叠加），用于约束对话中的角色、能力与操作习惯。**不要求固定文案**，联调可参考 `apps/backend/src/libraries.ts` 中的示例。

| 字段 | 必填 | 限制 | 用途 |
|------|------|------|------|
| `soul` | 否 | 字符串，UTF-8 不超过 **8192 字节** | 角色与能力说明：该数字员工是谁、负责什么业务、应优先使用哪些能力/技能、哪些事实不得臆造等 |
| `standingOrders` | 否 | 字符串，不超过 **20000 字符** | 长期行为规范：对外称呼、身份表述、关键操作前的确认、与业务 API/MCP 交互时的参数习惯与合规要求等 |

- 可只传其一，也可都传；都省略时仅使用插件默认策略（能否满足业务由贵司联调判断）。
- 响应里 `standingOrders: true` 表示策略已成功写入；`soul` 在响应中为协议兼容字段，不表示单独存储了一份「soul 文档」。

### 1.8 `files`（assemble 可选）

在创建数字员工时，把贵司托管的**参考文件**挂到该 `scopeId` 下：Partner 网关按 URL **HTTPS 拉取**后写入 QM 文件库，供该员工在对话/技能中引用（如产品资料、模板、说明文档等）。不传则跳过，不影响 assemble 成功。

| 限制 | 说明 |
|------|------|
| 数组长度 | 最多 **20** 项 |
| 单文件大小 | 不超过 **100 MB**（`sizeBytes` 与下载结果均受此限） |
| URL | 必须为 **`https://`**，且解析到**公网**地址（内网 IP、`localhost` 等会被拒绝） |
| 下载 | 超时 **30 秒**，最多 **5** 次重定向 |

**数组元素：**

| 字段 | 必填 | 说明 |
|------|------|------|
| `url` | 是 | 文件下载地址（贵司 OSS/CDN 等需对网关可达） |
| `name` | 否 | 展示用文件名；省略时从 URL 或响应头推断 |
| `mimetype` | 否 | MIME 类型；省略时从响应 `Content-Type` 推断 |
| `sha256` | 否 | 64 位小写十六进制，用于下载后校验内容 |
| `sizeBytes` | 否 | 预期字节数，可与响应 `Content-Length` / 实际大小比对 |

**响应：** `files` 为成功入库项（含 `id`、`name`、`mimetype`、`sizeBytes`）；若有单项失败，另附 `fileFailures`（含 `url`、错误原因），**整次 assemble 仍可能为 `201`**，贵司需根据业务判断是否重试或补传。

### 1.9 MCP 调用凭证（贵司维护）

`assemble` 中的 `connectors[].accessToken` 与 **`PUT /v1/connectors`** 传入的凭证，会由 Partner 网关写入 QM **连接器密钥库**（按 `userId` 对应的 `principalId` + `host` 保存）。对话里 Agent 调用 Card/PMOS 的 MCP 时，QM 从该密钥库取出 token，以 Bearer 形式发给对应 MCP（`host` 与 MCP 注册的 `credentialHost` 一致：Card 为 `zhiqu`，PMOS 为 `pmos`）。

**贵司责任：**

| 事项 | 说明 |
|------|------|
| 签发与续期 | Card JWT、PMOS API Key 等由贵司（或 PMOS 平台）签发、刷新、吊销；**QM 不会**替贵司向 Card/PMOS 登录或自动换新 |
| 调用前自查 | 在 **`POST /v1/assemble`**（带 `connectors`）及用户**进入聊天前**，贵司后端应判断凭证是否仍有效（过期时间、主动探活等，策略自定） |
| 失效后更新 | 先在贵司侧拿到新 JWT/Key，再调 Partner **`PUT /v1/connectors`**（带 Partner 签名），**覆盖** QM 密钥库中该用户该 `host` 的记录；**一般不必重新 assemble** |
| 失效后果 | 密钥缺失、过期或被吊销时，MCP `tools/call` 会失败，对话中相关业务工具不可用；网关不会因凭证问题自动降级为无鉴权调用 |

**与接口的关系：**

- **首次写入**：`POST /v1/assemble` 的 `connectors`（创建员工时必填有效 token，否则可能 assemble 失败或员工可用但工具不可用）。
- **后续轮换**：`PUT /v1/connectors`，body 含 `userId`、`host`、`accessToken`（PMOS 可选 `expiresAt`）；成功仅返回 `{ "host": "…" }`，**响应中不回显 token**。

贵司宜在自有库中维护 `userId` ↔ 当前凭证状态（及可选过期时间），并与 QM 侧通过上述更新接口保持同步。

---

## 二、智渠 Card 对接

### 2.1 业务参数

| 项 | 值 |
|----|-----|
| `library` | `card` |
| 默认助手名 `name` | `智渠名片助手` |
| `connectors[].host` | `zhiqu` |
| `connectors[].accessToken` | **Card 用户 JWT**（调 Card API 的 `Authorization: Bearer` 同一串） |

**JWT 来源：**

- 生产：用户微信登录后贵司下发的 access token。
- 本地联调 Card API：`POST http://127.0.0.1:8080/api/v1/dev/login`，body `{"code":"qm-dev"}`（或 `{"user_id":123}`），取响应中的 token 填入 `accessToken`。

### 2.2 创建员工 — `POST /v1/assemble`

**Body 示例：**

```json
{
  "userId": "10001",
  "name": "智渠名片助手",
  "library": "card",
  "connectors": [
    { "host": "zhiqu", "accessToken": "eyJhbGciOiJIUzI1NiIs..." }
  ],
  "soul": "（贵司自拟：名片助手角色与能力边界）",
  "standingOrders": "（贵司自拟：称呼、流程确认、工具使用规范等）",
  "files": []
}
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `userId` | 是 | |
| `name` | 是 | 非空字符串，最长 **200** 字符；该数字员工在 QM 中的展示名称（Card 常用 `智渠名片助手`） |
| `library` | 是 | 固定 `card` |
| `connectors` | 是 | 一项，`host=zhiqu`，`accessToken` 最长 4096 |
| `soul` / `standingOrders` | 否 | 含义与限制见 **1.7**；Card 场景通常用于限定「名片创建向导」职责与 MCP 调用纪律 |
| `files` | 否 | 见 **1.8**；名片创建多依赖 Card MCP，多数场景可不传 |

**成功 `201` 示例（字段需落库）：**

```json
{
  "employee": {
    "id": "proj_xxx",
    "scopeId": "group:yyyy",
    "name": "智渠名片助手"
  },
  "plugin": {
    "id": "card",
    "commit": "…",
    "packId": "…",
    "entryAgent": "card-assistant",
    "delegation": false
  },
  "granted": ["zhiqu-card-create"],
  "standingOrders": true,
  "files": [], # 写入 QM 文件库，供该员工在对话/技能中引用（如产品资料、模板、说明文档等）
  "connectors": [{ "host": "zhiqu" }]
}
```

**贵司至少持久化：** `userId` ↔ `employee.scopeId`（及可选 `employee.id`、`name`）。后续开聊天只用 `scopeId`。

### 2.3 打开聊天 — `POST /v1/chat-sessions`

**Body：**

```json
{
  "userId": "10001",
  "scopeId": "group:yyyy",
  "conversationId": "default"
}
```

| 字段 | 说明 |
|------|------|
| `scopeId` | assemble 返回的 `employee.scopeId`，必须以 `group:` 开头 |
| `conversationId` | 可选；不传时 Partner 侧为 `default`。贵司可自定（`[A-Za-z0-9._-]{1,120}`），用于区分多会话 |

**成功 `200`：**

```json
{
  "chatUrl": "/auth/login?returnTo=%2Fchat%2F%3FscopeId%3Dgroup%3Ayyyy%26conversationId%3Ddefault&assertion=eyJ..."
}
```

**前端跳转：**

```
完整 URL = PARTNER_PUBLIC_URL + chatUrl
例：http://192.168.2.12:8209/auth/login?returnTo=...
```

首次会走 Portal 登录；`assertion` 短时有效，不要长期缓存 `chatUrl`。

### 2.4 更新 JWT — `PUT /v1/connectors`

```json
{
  "userId": "10001",
  "host": "zhiqu",
  "accessToken": "eyJ...新token"
}
```

成功 `200`：`{ "host": "zhiqu" }`（不返回 token）。同一用户同一 `host` 为覆盖写。凭证生命周期与贵司维护义务见 **1.9**。

### 2.5 列举会话 — `GET /v1/chat-sessions`

```http
GET /v1/chat-sessions?userId=10001&scopeId=group%3Ayyyy
```

签名时 `pathWithQuery` 必须包含完整 query。成功 `200`：

```json
{
  "conversations": [
    { "conversationId": "default", "scopeId": "group:yyyy", "title": "…" }
  ]
}
```

### 2.6 参考实现

`apps/backend`：`POST /api/employees` → assemble，`POST /api/chat-sessions` → 拼 `gatewayPublicUrl + chatUrl`。Card 正式项目应在贵司服务端复刻该逻辑，前端/WebView 只做跳转。

---

## 三、PMOS 对接

### 3.1 业务参数

| 项 | 值 |
|----|-----|
| `library` | `pmos` |
| 默认助手名 | `PMOS 营销助手` |
| `connectors[].host` | `pmos` |
| `connectors[].accessToken` | 用户 **PMOS API Key**（`pmos_` 开头，平台签发） |

Key 在贵司或 PMOS 侧开通；通过 assemble 或 `PUT /v1/connectors` 写入，**不要**让用户去 QM 的 secret-drop 页面。

### 3.2 创建员工 — `POST /v1/assemble`

```json
{
  "userId": "10001",
  "name": "PMOS 营销助手",
  "library": "pmos",
  "connectors": [
    { "host": "pmos", "accessToken": "pmos_xxxxxxxx" }
  ],
  "soul": "（贵司自拟：营销助手角色、技能路由原则等）",
  "standingOrders": "（贵司自拟：称呼、ccid 传参、删改前确认等）",
  "files": []
}
```

规则与 Card 相同（`userId`、`name` 必填；`connectors` 必填、`accessToken` ≤4096 等）。`soul` / `standingOrders` 见 **1.7**，`files` 见 **1.8**（可用于预置品牌/产品资料等）。

**成功 `201` 需关注：**

- `employee.scopeId` — 同上，必存
- `plugin.id` = `pmos`，`entryAgent` = `pmos-team-lead`，`delegation` = `true`
- `granted` 含例如：`pmos-activate`、`pmos-product-onboarding`、`pmos-material-article`、`pmos-material-image`、`pmos-marketing-plan` 等（以实际响应为准）

### 3.3 打开聊天 — `POST /v1/chat-sessions`

与 **2.3** 完全相同，仅 `scopeId` 来自 PMOS 员工的 assemble 结果。

### 3.4 更新 Key — `PUT /v1/connectors`

```json
{
  "userId": "10001",
  "host": "pmos",
  "accessToken": "pmos_新密钥",
  "expiresAt": 1790000000000
}
```

`expiresAt` 可选（毫秒时间戳或 ISO 日期字符串）。成功 `200`：`{ "host": "pmos" }`。见 **1.9**。

### 3.5 列举会话

同 **2.5**，`userId` / `scopeId` 规则不变。

### 3.6 参考实现

`apps/backend` + 前端 `5175` 选「PMOS 营销素材」、填 API Key 后创建助手并「新对话」，等价于上述 Partner 调用。

---

## 四、Card 与 PMOS 对照

| 项目 | Card | PMOS |
|------|------|------|
| `library` | `card` | `pmos` |
| `connectors[].host` | `zhiqu` | `pmos` |
| `accessToken` | Card JWT | `pmos_` API Key |
| 默认 `name` | 智渠名片助手 | PMOS 营销助手 |
| Partner 签名 / 聊天流程 | 相同 | 相同 |
| MCP 凭证维护方 | 贵司（JWT） | 贵司（API Key） |

---

## 五、联调自检

1. 用 Postman/脚本调 `POST /v1/assemble`，`201` 且拿到 `group:` 开头的 `scopeId`。
2. 调 `POST /v1/chat-sessions`，浏览器打开 `http://192.168.2.12:8209` + `chatUrl`，能进入聊天页。
3. Card：对话里能走名片创建；PMOS：能 `whoami`/建项目（说明 connector 生效）。
4. 模拟 JWT/Key 过期：贵司换新凭证后只调 `PUT /v1/connectors`，再开聊，工具应恢复，且无需重新 assemble。

生产环境把表格里的 IP/密钥换成甲方正式下发值即可，正文结构不用改。
