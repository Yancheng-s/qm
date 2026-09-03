import { join } from "node:path";
import type { ChildSpec, SlotPorts } from "../lib/types.ts";

export interface SpecInputs {
  worktree: string;
  ports: SlotPorts;
  baseEnv: Record<string, string>;
  watch: boolean;
  webUiBasePath: string;
  slack?: { botToken: string; appToken: string };
  sessionStore: string;
  runStore: string;
  databaseUrl: string;
  adminGrantsSeed: string;
  coreSigningSecret: string;
  portalSessionSecret: string;
  sandboxEnv: Record<string, string>;
}

const IDLOGIN_CLIENT_ID = "qm-portal";
const IDLOGIN_CLIENT_SECRET = "dev-instance-idlogin-0123456789abcdef";
const PROFILES_DEV_ASSEMBLE_KEY = "dev-instance-profiles-0123456789abcdef";
const PROFILES_DEV_LIBRARY_PRINCIPAL = "dev-admin";

export function buildChildSpecs(i: SpecInputs): ChildSpec[] {
  const watchArgs = i.watch ? ["--watch"] : [];
  const orgId = i.baseEnv.DEV_INSTANCE_ORG_ID || "acme";
  const base = { ...i.baseEnv, ...i.sandboxEnv, CORE_ORG_ID: orgId };
  const signing: Record<string, string> = i.coreSigningSecret ? { CORE_SIGNING_SECRET: i.coreSigningSecret } : {};
  return [
    {
      name: "core",
      cwd: i.worktree,
      argv: ["node", "--env-file-if-exists=.env", ...watchArgs, "src/index.ts"],
      env: {
        ...base,
        ORG_ID: orgId,
        SESSION_STORE: i.sessionStore,
        RUN_STORE: i.runStore,
        PORT: String(i.ports.core),
        ...(i.databaseUrl ? { DATABASE_URL: i.databaseUrl } : {}),
        ...(i.adminGrantsSeed ? { ADMIN_GRANTS: i.adminGrantsSeed } : {}),
        PUBLIC_WEB_URL: `http://localhost:${i.ports.portal}`,
        ...(i.slack
          ? {
              SLACK_BOT_TOKEN: i.slack.botToken,
              SLACK_APP_TOKEN: i.slack.appToken,
              DEV_INTROSPECTION: "1",
              DEV_HEALTH_PORT: String(i.ports.slackHealth),
            }
          : {}),
        SHUTDOWN_DRAIN_MS: "2000",
      },
      port: i.ports.core,
      readiness: { kind: "log", pattern: `listening on :${i.ports.core}` },
      health: { kind: "tcp", port: i.ports.core },
      stopGraceMs: 15_000,
    },
    {
      name: "web",
      cwd: join(i.worktree, "plugins/web-ui"),
      argv: ["node", "--env-file-if-exists=.env", "server/index.ts"],
      env: {
        ...base,
        ...signing,
        PORT: String(i.ports.web),
        CORE_API_URL: `http://localhost:${i.ports.core}`,
        WEB_UI_BASE: i.webUiBasePath,
        ...(i.watch ? { WEB_UI_DEV: "1" } : {}),
        WEB_UI_PRINCIPALS: "",
        WEB_UI_PUBLIC_URL: `http://localhost:${i.ports.portal}`,
      },
      port: i.ports.web,
      readiness: { kind: "log", pattern: `surface on http://localhost:${i.ports.web}` },
      health: { kind: "tcp", port: i.ports.web },
      stopGraceMs: 5_000,
    },
    {
      name: "admin",
      cwd: join(i.worktree, "plugins/admin"),
      argv: ["node", `--env-file-if-exists=${join(i.worktree, ".env")}`, ...watchArgs, "src/index.ts"],
      env: {
        ...base,
        ...signing,
        PORT: String(i.ports.admin),
        CORE_API_URL: `http://localhost:${i.ports.core}`,
        ADMIN_BASE_PATH: "/admin",
      },
      port: i.ports.admin,
      readiness: { kind: "log", pattern: `http://localhost:${i.ports.admin}` },
      health: { kind: "tcp", port: i.ports.admin },
      stopGraceMs: 5_000,
    },
    {
      name: "h5",
      cwd: join(i.worktree, "plugins/H5"),
      argv: ["node", ...watchArgs, "src/index.ts"],
      env: {
        ...base,
        ...signing,
        PORT: String(i.ports.h5),
        CORE_API_URL: `http://localhost:${i.ports.core}`,
        ...(i.databaseUrl ? { DATABASE_URL: i.databaseUrl } : {}),
        IDLOGIN_ISSUER: `http://localhost:${i.ports.h5}`,
        IDLOGIN_CLIENT_ID,
        IDLOGIN_CLIENT_SECRET,
        IDLOGIN_REDIRECT_URI: `http://localhost:${i.ports.portal}/auth/callback`,
        PROFILES_ASSEMBLE_KEY: i.baseEnv.PROFILES_ASSEMBLE_KEY || PROFILES_DEV_ASSEMBLE_KEY,
        PROFILES_LIBRARY_SCOPE: i.baseEnv.PROFILES_LIBRARY_SCOPE || `org:${orgId}`,
        PROFILES_LIBRARY_PRINCIPAL: i.baseEnv.PROFILES_LIBRARY_PRINCIPAL || PROFILES_DEV_LIBRARY_PRINCIPAL,
      },
      port: i.ports.h5,
      readiness: { kind: "log", pattern: `gateway on http://localhost:${i.ports.h5}` },
      health: { kind: "tcp", port: i.ports.h5 },
      stopGraceMs: 5_000,
    },
    {
      name: "portal",
      cwd: join(i.worktree, "plugins/portal"),
      argv: ["node", ...watchArgs, "src/index.ts"],
      env: {
        ...base,
        ...signing,
        PORT: String(i.ports.portal),
        PORTAL_PUBLIC_URL: `http://localhost:${i.ports.portal}`,
        CORE_API_URL: `http://localhost:${i.ports.core}`,
        WEB_UI_UPSTREAM: `http://localhost:${i.ports.web}`,
        ADMIN_UPSTREAM: `http://localhost:${i.ports.admin}`,
        PORTAL_SESSION_SECRET: i.portalSessionSecret,
        NODE_ENV: "development",
        OIDC_CLIENT_ID: IDLOGIN_CLIENT_ID,
        OIDC_CLIENT_SECRET: IDLOGIN_CLIENT_SECRET,
        OIDC_AUTH_ENDPOINT: `http://localhost:${i.ports.h5}/authorize`,
        OIDC_TOKEN_ENDPOINT: `http://localhost:${i.ports.h5}/token`,
        OIDC_USERINFO_ENDPOINT: `http://localhost:${i.ports.h5}/userinfo`,
        OIDC_ISSUER: `http://localhost:${i.ports.h5}`,
        OIDC_JWKS_URI: `http://localhost:${i.ports.h5}/.well-known/jwks.json`,
        OIDC_PRINCIPAL_CLAIM: "sub",
      },
      port: i.ports.portal,
      readiness: { kind: "log", pattern: `public front door on http://localhost:${i.ports.portal}` },
      health: { kind: "tcp", port: i.ports.portal },
      stopGraceMs: 5_000,
    },
  ];
}
