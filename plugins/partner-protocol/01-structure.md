# 目录结构

```
plugins/partner-protocol/
├── 01-structure.md               本文：最终目录树
├── 02-modules-and-flow.md        模块划分 + 模块串联 + 流程闭环
├── 03-module-implementation.md   每个模块的具体实现
│
├── spec/                         对外契约交付物
│   ├── protocol.md               协议正文：凭据 / 签名 / 端点 / 错误码 / 限流 / SSE / 版本
│   └── partner-client.mjs        可运行示例客户端：签名 → 建员工 → 发消息 → 收 SSE
│
├── package.json                  插件包 qm-partner-protocol（无运行时依赖）
├── tsconfig.json
│
├── src/
│   ├── index.ts                  入口：单端口 + boot 校验 + /healthz + 交路由表
│   ├── config.ts                 env 解析 + bootProblems（缺配置拒启）
│   ├── auth.ts                   入站验签 + principalId 派生
│   ├── transport.ts              JSON/SSE 写出 + body 读取 + 限流 + 错误码
│   ├── core-client.ts            出站 source-auth 签名 + portal 身份头调 core /v1
│   │
│   └── routes/
│       ├── index.ts              路由表与分发管线：读体 → 验签 → 限流 → 白名单 → 执行
│       ├── employees.ts          GET  /v1/employees       数字员工列表
│       ├── assemble.ts           POST /v1/assemble        建员工：项目 + 技能 + 人格
│       ├── skills.ts             POST /v1/skills          给已有员工补技能
│       ├── turn.ts               POST /v1/turn            发消息，取 runId
│       ├── events.ts             GET  /v1/events          运行态轮询转 SSE
│       └── sessions.ts           GET  /v1/sessions[/:id]  会话列表与历史
│
└── test/
    ├── support.ts                共用：签名头 / 假 core 记录器 / 进程内网关 / 子进程网关 + 假 core / SSE 解析
    ├── auth.test.ts              验签 / 派生 / 拒冒充 / 拒重放 / 拒非法 id
    ├── assemble.test.ts          建项目→建技能→写人格 的顺序、非幂等、局部失败
    ├── routes.test.ts            白名单、turn 构造、events 事件序列、sessions 收窄
    ├── gateway.test.ts           子进程 + 假 core：boot 校验 / 401 / 404 / 429 / 端到端
    └── client.test.ts            真跑 spec/partner-client.mjs，验示例客户端可用
```
