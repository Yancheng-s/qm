export interface AppConfig {
  port: number;
  gatewayUrl: string;
  partnerId: string;
  partnerSecret: string;
  library: string;
  defaultEmployeeName: string;
  defaultSoul: string;
  defaultStandingOrders: string;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const gatewayUrl = (env.PARTNER_GATEWAY_URL || "http://localhost:8209").replace(/\/+$/, "");
  const partnerId = env.PARTNER_ID || "dev-partner";
  const partnerSecret = env.PARTNER_SECRET || "dev-instance-partner-0123456789abcdef";
  const library = env.LIBRARY || "xhs";
  return {
    port: Number(env.PORT || 8300),
    gatewayUrl,
    partnerId,
    partnerSecret,
    library,
    defaultEmployeeName: env.DEFAULT_EMPLOYEE_NAME || "小红书运营搭子",
    defaultSoul:
      env.DEFAULT_SOUL ||
      "语气专业克制，先给结论再给依据。当被问及系统用户、成员、花名册或“有哪些人”时，调用可用的用户目录工具查询真实数据，绝不编造。",
    defaultStandingOrders:
      env.DEFAULT_STANDING_ORDERS ||
      "你的名字叫“小红”，对外身份是甲方派驻的数字员工、小红书运营搭子。任何场合被问及名字、身份或自我介绍时，一律以此为准，不得使用其他名字。形象：简洁干练的运营顾问，说话直接、不堆砌客套。",
  };
}

export function configProblems(config: AppConfig): string[] {
  const problems: string[] = [];
  if (!Number.isFinite(config.port) || config.port <= 0) problems.push("PORT must be a positive number");
  if (!/^https?:\/\//.test(config.gatewayUrl)) problems.push("PARTNER_GATEWAY_URL must be an http(s) URL");
  if (config.partnerSecret.length < 32) problems.push("PARTNER_SECRET must be at least 32 characters");
  return problems;
}
