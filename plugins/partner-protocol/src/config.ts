import { CORE_API_URL, CORE_SIGNING_SECRET, PORTAL_IDENTITY_SECRET } from "../../chassis/src/env.ts";

const PARTNER_ID = /^[a-z][a-z0-9-]{0,31}$/;
const MIN_SECRET_CHARS = 32;
const DEFAULT_RATE_PER_MIN = 120;
const DEFAULT_PORT = 8211;
const DEFAULT_PORTAL_URL = "http://localhost:8129";
const DEFAULT_PARTNER_WEB_REDIRECT_URL = "http://localhost:5175/chat/";
const LIBRARY_KEY = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SCOPE_ID = /^[a-z]+:.+$/;

export interface PartnerConfig {
  port: number;
  coreApiUrl: string;
  signingSecret: string | undefined;
  identitySecret: string;
  partners: ReadonlyMap<string, string>;
  libraries: ReadonlyMap<string, string>;
  libraryPrincipalId: string;
  ratePerMin: number;
  portalUrl: string;
  partnerWebRedirectUrl: string;
  credentialProblems: readonly string[];
  libraryProblems: readonly string[];
}

function trimmed(value: string | undefined): string | undefined {
  const candidate = value?.trim();
  return candidate ? candidate : undefined;
}

function partnerWebRedirectUrl(env: NodeJS.ProcessEnv): string {
  return trimmed(env.PARTNER_WEB_REDIRECT_URL) ?? DEFAULT_PARTNER_WEB_REDIRECT_URL;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): PartnerConfig {
  const partners = new Map<string, string>();
  const holders = new Map<string, string>();
  const credentialProblems: string[] = [];
  for (const entry of (env.PARTNER_CREDENTIALS ?? "").split(",")) {
    const candidate = entry.trim();
    if (!candidate) continue;
    const separator = candidate.indexOf("=");
    const id = (separator < 0 ? candidate : candidate.slice(0, separator)).trim();
    const secret = separator < 0 ? "" : candidate.slice(separator + 1).trim();
    if (!PARTNER_ID.test(id)) {
      credentialProblems.push(`PARTNER_CREDENTIALS id "${id}" must match ${PARTNER_ID.source}`);
      continue;
    }
    if (partners.has(id)) {
      credentialProblems.push(`PARTNER_CREDENTIALS binds "${id}" twice`);
      continue;
    }
    if (secret.length < MIN_SECRET_CHARS) {
      credentialProblems.push(`PARTNER_CREDENTIALS secret for "${id}" must be at least ${MIN_SECRET_CHARS} characters`);
      continue;
    }
    const twin = holders.get(secret);
    if (twin) {
      credentialProblems.push(`PARTNER_CREDENTIALS gives "${id}" the same secret as "${twin}"`);
      continue;
    }
    partners.set(id, secret);
    holders.set(secret, id);
  }

  const libraries = new Map<string, string>();
  const scopeOwners = new Map<string, string>();
  const libraryProblems: string[] = [];
  for (const entry of (env.LIBRARY_SCOPES ?? "").split(",")) {
    const candidate = entry.trim();
    if (!candidate) continue;
    const separator = candidate.indexOf("=");
    const key = (separator < 0 ? candidate : candidate.slice(0, separator)).trim();
    const scopeId = separator < 0 ? "" : candidate.slice(separator + 1).trim();
    if (!LIBRARY_KEY.test(key)) {
      libraryProblems.push(`LIBRARY_SCOPES key "${key}" must match ${LIBRARY_KEY.source}`);
      continue;
    }
    if (libraries.has(key)) {
      libraryProblems.push(`LIBRARY_SCOPES binds "${key}" twice`);
      continue;
    }
    if (!SCOPE_ID.test(scopeId)) {
      libraryProblems.push(`LIBRARY_SCOPES binding "${key}" needs a scope id like group:<project scope>`);
      continue;
    }
    const owner = scopeOwners.get(scopeId);
    if (owner) {
      libraryProblems.push(`LIBRARY_SCOPES binds "${key}" and "${owner}" to the same scope ${scopeId}`);
      continue;
    }
    libraries.set(key, scopeId);
    scopeOwners.set(scopeId, key);
  }
  const libraryPrincipalId = trimmed(env.LIBRARY_PRINCIPAL) ?? "";

  const rateRaw = (env.PARTNER_RATE_LIMIT_PER_MIN ?? "").trim();
  const rateParsed = rateRaw === "" ? DEFAULT_RATE_PER_MIN : Number(rateRaw);
  const ratePerMin = Number.isInteger(rateParsed) && rateParsed >= 0 ? rateParsed : -1;
  const portParsed = Number(env.PORT ?? DEFAULT_PORT);
  const signingSecret = trimmed(env.CORE_SIGNING_SECRET) ?? CORE_SIGNING_SECRET;

  return {
    port: Number.isInteger(portParsed) && portParsed >= 0 ? portParsed : DEFAULT_PORT,
    coreApiUrl: (env.CORE_API_URL ?? CORE_API_URL).replace(/\/+$/, ""),
    signingSecret,
    identitySecret: trimmed(env.PORTAL_IDENTITY_SECRET) ?? PORTAL_IDENTITY_SECRET ?? signingSecret ?? "",
    partners,
    libraries,
    libraryPrincipalId,
    ratePerMin,
    portalUrl: trimmed(env.PORTAL_URL)?.replace(/\/+$/, "") ?? DEFAULT_PORTAL_URL,
    partnerWebRedirectUrl: partnerWebRedirectUrl(env),
    credentialProblems,
    libraryProblems,
  };
}

export function bootProblems(cfg: PartnerConfig): string[] {
  const problems: string[] = [...cfg.credentialProblems, ...cfg.libraryProblems];
  if (!cfg.coreApiUrl) problems.push("CORE_API_URL is required (core base url, e.g. http://localhost:8081)");
  if (!cfg.signingSecret) problems.push("CORE_SIGNING_SECRET is required");
  if (!cfg.identitySecret) problems.push("PORTAL_IDENTITY_SECRET or CORE_SIGNING_SECRET is required");
  if (cfg.partners.size === 0 && cfg.credentialProblems.length === 0)
    problems.push("PARTNER_CREDENTIALS is required (<partnerId>=<secret>, comma separated)");
  if (cfg.libraries.size === 0 && cfg.libraryProblems.length === 0)
    problems.push("LIBRARY_SCOPES is required (<key>=<scopeId>, comma separated)");
  if (!cfg.libraryPrincipalId) problems.push("LIBRARY_PRINCIPAL is required");
  if (cfg.ratePerMin < 0) problems.push("PARTNER_RATE_LIMIT_PER_MIN must be an integer >= 0 (0 disables limiting)");
  return problems;
}
