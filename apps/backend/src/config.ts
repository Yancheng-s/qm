export interface AppConfig {
  port: number;
  gatewayUrl: string;
  gatewayPublicUrl: string;
  partnerId: string;
  partnerSecret: string;
  library: string;
  defaultEmployeeName: string;
  defaultSoul: string;
  defaultStandingOrders: string;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const port = Number(env.PORT || 8300);
  const gatewayUrl = (env.PARTNER_GATEWAY_URL || "http://localhost:8209").replace(/\/+$/, "");
  const gatewayPublicUrl = (env.PARTNER_PUBLIC_URL || gatewayUrl).replace(/\/+$/, "");
  const partnerId = env.PARTNER_ID || "dev-partner";
  const partnerSecret = env.PARTNER_SECRET || "dev-instance-partner-0123456789abcdef";
  const library = env.LIBRARY || "card";
  return {
    port,
    gatewayUrl,
    gatewayPublicUrl,
    partnerId,
    partnerSecret,
    library,
    defaultEmployeeName: env.DEFAULT_EMPLOYEE_NAME || "智渠名片助手",
    defaultSoul:
      env.DEFAULT_SOUL ||
      "你是智渠 AI 名片的创建向导。先了解用户要创建的名片，再按 zhiqu-card-create 技能与 zhiqu-card MCP 工具逐步完成；不编造姓名、公司、职位或文件。",
    defaultStandingOrders:
      env.DEFAULT_STANDING_ORDERS ||
      "你的名字叫「小智」，身份是智渠 AI 名片创建助手。被问及名字或身份时以此为准。创建名片时严格按 MCP 的 next_action 推进；正式提交前必须经用户确认预览；不得自动清空草稿、消耗激活码或提交名片。",
  };
}

export function configProblems(config: AppConfig): string[] {
  const problems: string[] = [];
  if (!Number.isFinite(config.port) || config.port <= 0) problems.push("PORT must be a positive number");
  if (!/^https?:\/\//.test(config.gatewayUrl)) problems.push("PARTNER_GATEWAY_URL must be an http(s) URL");
  if (!/^https?:\/\//.test(config.gatewayPublicUrl)) problems.push("PARTNER_PUBLIC_URL must be an http(s) URL");
  if (config.partnerSecret.length < 32) problems.push("PARTNER_SECRET must be at least 32 characters");
  return problems;
}
