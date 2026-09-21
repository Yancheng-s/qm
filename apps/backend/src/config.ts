import { LIBRARY_KEYS, resolveLibraryPreset } from "./libraries.ts";

export interface AppConfig {
  port: number;
  gatewayUrl: string;
  gatewayPublicUrl: string;
  partnerId: string;
  partnerSecret: string;
  defaultLibrary: string;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const port = Number(env.PORT || 8300);
  const gatewayUrl = (env.PARTNER_GATEWAY_URL || "http://localhost:8209").replace(/\/+$/, "");
  const gatewayPublicUrl = (env.PARTNER_PUBLIC_URL || gatewayUrl).replace(/\/+$/, "");
  const partnerId = env.PARTNER_ID || "dev-partner";
  const partnerSecret = env.PARTNER_SECRET || "dev-instance-partner-0123456789abcdef";
  const defaultLibrary = env.LIBRARY || "card";
  return {
    port,
    gatewayUrl,
    gatewayPublicUrl,
    partnerId,
    partnerSecret,
    defaultLibrary,
  };
}

export function configProblems(config: AppConfig): string[] {
  const problems: string[] = [];
  if (!Number.isFinite(config.port) || config.port <= 0) problems.push("PORT must be a positive number");
  if (!/^https?:\/\//.test(config.gatewayUrl)) problems.push("PARTNER_GATEWAY_URL must be an http(s) URL");
  if (!/^https?:\/\//.test(config.gatewayPublicUrl)) problems.push("PARTNER_PUBLIC_URL must be an http(s) URL");
  if (config.partnerSecret.length < 32) problems.push("PARTNER_SECRET must be at least 32 characters");
  if (!resolveLibraryPreset(config.defaultLibrary)) {
    problems.push(`LIBRARY must be one of: ${LIBRARY_KEYS.join(", ")}`);
  }
  return problems;
}
