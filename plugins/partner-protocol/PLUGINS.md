# Partner 项目插件装配

此功能只由 partner 适配 QM 现有接口，不需要修改 QM 核心或引擎。`plugin.json` 是 partner 的清单，不是 QM 原生插件格式。

## 配置

partner 进程读取 `LIBRARY_URLS`，值是 JSON 对象：

```dotenv
LIBRARY_URLS={"pmos":{"url":"https://example.com/pmos-skills.git","ref":"main"},"card":{"url":"https://example.com/card-skills.git","ref":"main"}}
LIBRARY_PRINCIPAL=your-admin-principal
```

`LIBRARY_PRINCIPAL` 必须是当前组织中已有管理员授权的身份；设置环境变量本身不会产生管理员权限。管理员请求使用服务端签名与 `x-admin-actor`，不携带普通用户的 portal identity。用户不会获得管理员角色。

本地开发可把 URL 换成绝对 Git 仓库路径。QM 与 partner 必须能访问同一目录，QM 的部署配置必须允许本地 Git 导入。只读取已提交内容，不读取工作区未提交的文件。partner 的本地 `.env` 已被 Git 忽略；开发 supervisor 会从这个目录加载它。直接启动时使用 `node --env-file-if-exists=.env src/index.ts`，并提供其他必需的服务端环境配置。

HTTPS 私有仓库需要 partner 运行账户的 Git 凭证，以及 QM 拉取端可用的 Git 凭证。不要把令牌写入 URL、清单或提交到仓库。本实现不转发 partner 的 Git 凭证给 QM。

`LIBRARY_URLS` 是项目装配的唯一技能来源。MCP 服务及其权限仍由现有配置负责，本清单不自动注册 MCP 或发放 MCP 凭证。

## 清单

```json
{
  "schemaVersion": 1,
  "id": "pmos",
  "entryAgent": "lead",
  "delegation": { "enabled": true, "provider": "qm" },
  "agents": {
    "lead": {
      "instructions": "AGENT.md",
      "members": ["writer"],
      "skills": ["article"]
    },
    "writer": {
      "instructions": "agents/writer.md",
      "skills": ["article"]
    }
  }
}
```

角色文档放在技能目录之外，作为 QM Skill Pack 的共享附件。每个技能必须存在唯一的同名目录及 `SKILL.md`，其 frontmatter 名称必须匹配清单。只有入口角色可以委派，成员不能再次委派。当前仅支持 `provider: qm`。

## 装配

1. 根据 Apps 传入的 `library` 选择服务端配置的 Git 源，解析清单及角色文档，并解析出固定提交 SHA。
2. 使用该 SHA 注册 QM Skill Pack，预检技能和共享角色文档，再以普通用户身份创建项目。
3. 使用管理员接口把完整插件技能导入新项目 scope，并核对每个技能的来源、提交和发布状态。
4. 如果开启委派，为实际用户的 `personal:<principalId>` 开启 `persistent_subagents`。关闭委派的插件不会撤销该用户在其他项目需要的能力。
5. 把主理人文档、调用方补充要求和 QM 工具适配规则写入项目常驻指令。插件模式下传入的 `soul` 作为主理人补充要求，不写入所有员工都会继承的项目 SOUL。

插件模式须安装完整角色技能集合：通常省略 `skills`；若显式传入，必须等于清单声明的完整集合。编译后的常驻指令必须不超过 QM 现有的 20000 字符上限，超限会在创建项目前拒绝，不截断文档。

`201` 响应增加 `plugin: { id, commit, packId, entryAgent, delegation }`。`granted` 保持兼容，插件模式下表示已导入项目的技能名称。

安装中途失败返回 `502`，附 `incomplete: true` 和已创建的 `employee`；不得当成装配成功。不会自动删除已创建项目，也不会自动重试创建项目。创建操作沿用现有非幂等语义，重复提交会创建另一个项目。已注册但未使用的技能包可在管理员端清理。

## 角色和权限边界

员工文档不会同时变成主理人的身份。主理人读取员工文档后通过 QM `session open` 传递任务；如果主会话不可执行文件读取，则要求员工先读取指定技能，取得当轮 `Pack files` 路径，再加载自己的文档。员工最终结果通过 QM 回传。源文档中的 TeamCreate、Agent 和 SendMessage 按生成的适配规则转换，不调用引擎原生代理。

`delegation.enabled`、成员名单、角色技能名单是行为约定，不是项目级工具权限隔离。同项目的员工仍继承该用户的项目权限和可见技能。现有项目不会因更新仓库或重启 partner 而自动重新装配。角色执行是否稳定，需要在实际模型和项目权限下验收。

## 验证

```text
node --test plugins/partner-protocol/test/plugin.test.ts plugins/partner-protocol/test/assemble.test.ts plugins/partner-protocol/test/gateway.test.ts
node node_modules/typescript/bin/tsc -p plugins/partner-protocol/tsconfig.json --noEmit
```
