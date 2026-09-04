import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { json } from "../../chassis/src/http.ts";
import { errMessage } from "../../chassis/src/errors.ts";
import { CORE_SIGNING_SECRET, PORTAL_IDENTITY_SECRET, portFromEnv } from "../../chassis/src/env.ts";
import { bootIdLogin, bootProblems as idLoginBootProblems, readConfig as readIdLoginConfig } from "./idlogin/server.ts";
import { bootProfiles } from "./profiles/server.ts";
import { bootProblems as profilesBootProblems, readConfig as readProfilesConfig } from "./profiles/config.ts";
import { bootBridge } from "./bridge/server.ts";
import { bootProblems as bridgeBootProblems, readConfig as readBridgeConfig } from "./bridge/config.ts";

const PORT = portFromEnv(8193);

const env = process.env;
const idLoginConfig = readIdLoginConfig(env);
const profilesConfig = readProfilesConfig(env);
const bridgeConfig = readBridgeConfig(env);
const problems = [
  ...idLoginBootProblems(idLoginConfig),
  ...profilesBootProblems(profilesConfig),
  ...bridgeBootProblems(bridgeConfig),
  ...(CORE_SIGNING_SECRET ? [] : ["CORE_SIGNING_SECRET is required"]),
];
if (problems.length) {
  for (const item of problems) console.error(`[h5] FATAL: ${item}`);
  throw new Error(`h5 refusing to start: ${problems.length} misconfiguration(s)`);
}

const idLogin = await bootIdLogin(idLoginConfig, env.DATABASE_URL);
const profiles = await bootProfiles(profilesConfig, env.DATABASE_URL);
const bridge = bootBridge({
  webUiApiUrl: bridgeConfig.webUiApiUrl,
  signingSecret: CORE_SIGNING_SECRET,
  identitySecret: PORTAL_IDENTITY_SECRET ?? "",
});

const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
  const method = req.method ?? "GET";
  const { pathname } = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  if (method === "GET" && pathname === "/healthz") return json(res, 200, { ok: true });
  if (method === "POST" && pathname === "/assemble") return profiles(req, res);
  if (pathname === "/me" || pathname.startsWith("/api/")) return bridge.handle(req, res);
  return idLogin.handle(req, res);
};

const server = createServer((req, res) => {
  void handle(req, res).catch((err: unknown) => {
    console.error("[h5] 500 %s %s: %s", req.method ?? "?", (req.url ?? "?").split("?")[0], errMessage(err));
    if (!res.headersSent) json(res, 500, { error: "internal_error" });
    else res.end();
  });
});

server.listen(PORT, () => {
  const port = (server.address() as AddressInfo).port;
  const libraries = profilesConfig.libraries.map((binding) => `${binding.key}=${binding.scopeId}`).join(", ");
  console.log(
    `[h5] gateway on http://localhost:${port} (id sign-in issuer ${idLoginConfig.issuer}, key ${idLogin.kid}; assemble libraries ${libraries})`,
  );
});
