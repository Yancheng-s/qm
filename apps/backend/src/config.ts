import { LIBRARY_KEYS, resolveLibraryPreset } from "./libraries.ts";

export interface AppConfig {
  port: number;
  gatewayUrl: string;
  gatewayPublicUrl: string;
  partnerId: string;
  partnerSecret: string;
  defaultLibrary: string;
}

function resolveGatewayPublicUrl(env: NodeJS.ProcessEnv, gatewayUrl: string): string {
  const explicit = env.PARTNER_PUBLIC_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const host = env.PARTNER_PUBLIC_HOST?.trim();
  if (host) {
    const parsed = new URL(gatewayUrl);
    const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
    return `${parsed.protocol}//${host}:${port}`;
  }
  return gatewayUrl;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const port = Number(env.APP_BACKEND_PORT ?? 8300);
  const gatewayUrl = (env.PARTNER_GATEWAY_URL || "http://localhost:8209").replace(/\/+$/, "");
  const gatewayPublicUrl = resolveGatewayPublicUrl(env, gatewayUrl);
  const partnerId = env.PARTNER_ID || "zhiqu-card";
  const partnerSecret = env.PARTNER_SECRET || "zqcard_8f3a9c2e1b7d4f6a0e5c8b2d9a1f4e7c";
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
