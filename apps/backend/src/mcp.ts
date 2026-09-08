import type { FastifyInstance } from "fastify";

export interface SystemUser {
  id: string;
  name: string;
  role: string;
  department: string;
  email: string;
  status: "active" | "inactive";
}

export const SYSTEM_USERS: readonly SystemUser[] = [
  { id: "u1001", name: "张三", role: "运营", department: "内容部", email: "zhangsan@acme.test", status: "active" },
  { id: "u1002", name: "李四", role: "客服", department: "支持部", email: "lisi@acme.test", status: "active" },
  { id: "u1003", name: "王五", role: "数据分析", department: "增长部", email: "wangwu@acme.test", status: "active" },
  { id: "u1004", name: "赵六", role: "运营", department: "内容部", email: "zhaoliu@acme.test", status: "inactive" },
  { id: "u1005", name: "钱七", role: "管理员", department: "平台部", email: "qianqi@acme.test", status: "active" },
  { id: "u1006", name: "孙八", role: "客服", department: "支持部", email: "sunba@acme.test", status: "active" },
];

export const MCP_TOOL = {
  name: "list_system_users",
  description:
    "获取甲方系统的用户列表。返回每个用户的 id、姓名、角色、部门、邮箱与状态；可按 role/department/status 过滤，limit 限制条数。",
  inputSchema: {
    type: "object",
    properties: {
      role: { type: "string", description: "按角色过滤，如 运营 / 客服 / 数据分析 / 管理员" },
      department: { type: "string", description: "按部门过滤，如 内容部 / 支持部 / 增长部 / 平台部" },
      status: { type: "string", enum: ["active", "inactive"], description: "按状态过滤" },
      limit: { type: "integer", description: "最多返回条数，默认全部" },
    },
    additionalProperties: false,
  },
} as const;

interface CallArgs {
  role?: unknown;
  department?: unknown;
  status?: unknown;
  limit?: unknown;
}

export function listSystemUsers(args: CallArgs): { count: number; users: readonly SystemUser[] } {
  let users = [...SYSTEM_USERS];
  if (typeof args.role === "string") users = users.filter((u) => u.role === args.role);
  if (typeof args.department === "string") users = users.filter((u) => u.department === args.department);
  if (typeof args.status === "string") users = users.filter((u) => u.status === args.status);
  if (Number.isInteger(args.limit) && (args.limit as number) >= 0) users = users.slice(0, args.limit as number);
  return { count: users.length, users };
}

interface JsonRpcMessage {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

export function registerMcpRoutes(app: FastifyInstance, serverInfo: { name: string; version: string }): void {
  app.post<{ Body: JsonRpcMessage }>("/mcp", async (req) => {
    const msg = (req.body ?? {}) as JsonRpcMessage;
    const id = msg.id;
    const method = typeof msg.method === "string" ? msg.method : "";
    const params = (msg.params ?? {}) as { name?: unknown; arguments?: CallArgs };

    if (method === "initialize")
      return rpcResult(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo,
      });
    if (method === "ping") return rpcResult(id, {});
    if (method === "tools/list") return rpcResult(id, { tools: [MCP_TOOL] });
    if (method === "tools/call") {
      if (params.name !== MCP_TOOL.name)
        return rpcResult(id, {
          content: [{ type: "text", text: `unknown tool: ${String(params.name ?? "")}` }],
          isError: true,
        });
      const out = listSystemUsers(params.arguments ?? {});
      return rpcResult(id, { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] });
    }
    return rpcError(id, -32601, `method not found: ${method}`);
  });
}
