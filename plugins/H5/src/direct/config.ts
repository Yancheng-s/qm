import { CORE_API_URL, CORE_ORG_ID, CORE_SIGNING_SECRET, PORTAL_IDENTITY_SECRET } from "../../../chassis/src/env.ts";

export interface DirectConfig {
  coreApiUrl: string;
  orgId: string;
  signingSecret: string | undefined;
  identitySecret: string;
}

export function readConfig(): DirectConfig {
  return {
    coreApiUrl: CORE_API_URL.replace(/\/+$/, ""),
    orgId: CORE_ORG_ID,
    signingSecret: CORE_SIGNING_SECRET,
    identitySecret: PORTAL_IDENTITY_SECRET ?? "",
  };
}

export function bootProblems(cfg: DirectConfig): string[] {
  const problems: string[] = [];
  if (!cfg.coreApiUrl) problems.push("CORE_API_URL is required (core base url, e.g. http://localhost:8081)");
  return problems;
}
