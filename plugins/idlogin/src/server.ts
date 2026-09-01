import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
  SignJWT,
  jwtVerify,
  type JWTPayload,
  type JWK,
} from "jose";
import { readBody, PayloadTooLargeError, escapeHtml, serveEmojiFavicon } from "../../chassis/src/http.ts";
import { signedHeaders, withSourceAuthNonce } from "../../chassis/src/core-client.ts";
import { errMessage } from "../../chassis/src/errors.ts";
import { CORE_API_URL, CORE_SIGNING_SECRET, portFromEnv } from "../../chassis/src/env.ts";
import {
  createMemoryUserRegistry,
  createPostgresUserRegistry,
  type UserRegistry,
} from "./users.ts";

export interface IdLoginConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  allowedIds: readonly string[];
  brandName: string;
  requestTtlS: number;
  codeTtlS: number;
  accessTtlS: number;
}

export function readConfig(env: NodeJS.ProcessEnv): IdLoginConfig {
  return {
    issuer: (env.IDLOGIN_ISSUER ?? `http://localhost:${env.PORT ?? 8099}`).replace(/\/$/, ""),
    clientId: env.IDLOGIN_CLIENT_ID?.trim() ?? "",
    clientSecret: env.IDLOGIN_CLIENT_SECRET ?? "",
    redirectUri: env.IDLOGIN_REDIRECT_URI?.trim() ?? "",
    allowedIds: (env.IDLOGIN_ALLOWED_IDS ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
    brandName: env.IDLOGIN_BRAND_NAME?.trim() || "qm",
    requestTtlS: 900,
    codeTtlS: 120,
    accessTtlS: 120,
  };
}

export function bootProblems(cfg: IdLoginConfig): string[] {
  const problems: string[] = [];
  const require = (label: string, value: string): void => {
    if (!value.trim()) problems.push(`${label} is required`);
  };
  require("IDLOGIN_ISSUER", cfg.issuer);
  require("IDLOGIN_CLIENT_ID", cfg.clientId);
  require("IDLOGIN_REDIRECT_URI", cfg.redirectUri);
  if (!cfg.clientSecret.trim()) problems.push("IDLOGIN_CLIENT_SECRET is required");
  else if (cfg.clientSecret.trim().length < 32)
    problems.push("IDLOGIN_CLIENT_SECRET must be at least 32 characters");
  return problems;
}

const MAX_FORM_BYTES = 8 * 1024;
const MAX_ID_CHARS = 200;
const MAX_NAME_CHARS = 200;
const ID_TOKEN_TTL_S = 300;
const ID_TOKEN_ALG = "ES256";

interface AuthRequest {
  clientId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  codeChallenge: string;
}

interface CodeClaims {
  clientId: string;
  redirectUri: string;
  nonce: string;
  codeChallenge: string;
  id: string;
  name: string;
}

export interface DirectoryMemberPush {
  principalId: string;
  displayName: string;
  type: "internal";
}

type PrivateSigningKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

interface SigningKey {
  privateKey: PrivateSigningKey;
  publicJwk: JWK;
  kid: string;
}

async function createSigningKey(): Promise<SigningKey> {
  const { privateKey, publicKey } = await generateKeyPair(ID_TOKEN_ALG);
  const publicJwk = (await exportJWK(publicKey)) as JWK;
  const kid = await calculateJwkThumbprint(publicJwk, "sha256");
  return { privateKey, publicJwk: { ...publicJwk, kid, use: "sig", alg: ID_TOKEN_ALG }, kid };
}

function safeEqual(a: string, b: string): boolean {
  const left = createHash("sha256").update(a, "utf8").digest();
  const right = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(left, right);
}

function pkceMatches(codeVerifier: string, codeChallenge: string): boolean {
  if (codeVerifier.length < 43 || codeVerifier.length > 128 || !/^[A-Za-z0-9\-._~]+$/.test(codeVerifier)) return false;
  return safeEqual(createHash("sha256").update(codeVerifier).digest("base64url"), codeChallenge);
}

function idAllowed(cfg: IdLoginConfig, id: string): boolean {
  return !cfg.allowedIds.length || cfg.allowedIds.includes(id);
}

export interface IdLoginDeps {
  cfg: IdLoginConfig;
  signingKey: SigningKey;
  sealSecret: Uint8Array;
  users: UserRegistry;
  pushDirectory?: (members: DirectoryMemberPush[]) => Promise<void>;
}

const PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; base-uri 'none'; form-action *; frame-ancestors 'none'";

const STYLE = `<style>
  :root{ --bg:#ffffff; --surface:#ffffff; --text:#0a0a0a; --muted:#737373; --border:#e5e5e5; --secondary:#f5f5f5;
    --warn:#b42318; --warn-bg:#fdeceb; --shadow:0 1px 3px rgba(0,0,0,.05), 0 4px 12px rgba(0,0,0,.05);
    --radius-md:10px; --radius-lg:16px; }
  @media (prefers-color-scheme:dark){
    :root{ --bg:#0a0a0a; --surface:#171717; --text:#fafafa; --muted:#a3a3a3; --border:#2a2a2a; --secondary:#262626;
      --warn:#ff8a80; --warn-bg:#2a1a1a; --shadow:0 1px 3px rgba(0,0,0,.4), 0 8px 24px rgba(0,0,0,.4); } }
  *{ box-sizing:border-box; }
  html,body{ height:100%; }
  body{ margin:0; background:var(--bg); color:var(--text); display:flex; min-height:100%;
    font:14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    -webkit-font-smoothing:antialiased; }
  main{ margin:auto; padding:32px 20px; width:100%; display:grid; place-items:center; }
  .card{ width:100%; max-width:420px; background:var(--surface); border:1px solid var(--border);
    border-radius:var(--radius-lg); box-shadow:var(--shadow); padding:34px 32px 30px; text-align:center; }
  .icon{ width:52px; height:52px; margin:0 auto 18px; border-radius:var(--radius-md); background:var(--secondary);
    display:grid; place-items:center; }
  .icon svg{ width:26px; height:26px; stroke:var(--text); fill:none; stroke-width:1.8; stroke-linecap:round; stroke-linejoin:round; }
  .icon.warn{ background:var(--warn-bg); }
  .icon.warn svg{ stroke:var(--warn); stroke-width:2; }
  h1{ font-size:20px; font-weight:600; margin:0 0 8px; }
  .msg{ color:var(--muted); margin:0 auto 22px; max-width:40ch; font-size:14px; }
  .reason{ margin:0 auto 22px; font-size:13px; color:var(--text); background:var(--warn-bg);
    border:1px solid var(--border); border-radius:var(--radius-md); padding:11px 14px; text-align:left; word-break:break-word; }
  .reason strong{ display:block; color:var(--warn); font-size:11px; text-transform:uppercase; letter-spacing:.04em; margin-bottom:3px; }
  form{ display:grid; gap:10px; text-align:left; }
  label{ font-size:12.5px; font-weight:600; color:var(--muted); }
  input{ width:100%; min-height:44px; padding:0 14px; font:inherit; color:var(--text); background:var(--bg);
    border:1px solid var(--border); border-radius:var(--radius-md); }
  input:focus-visible{ outline:2px solid color-mix(in srgb, var(--text) 35%, transparent); outline-offset:1px; }
  .btn{ display:flex; align-items:center; justify-content:center; min-height:44px; padding:0 18px; width:100%;
    text-decoration:none; font:inherit; font-weight:600; border-radius:var(--radius-md); cursor:pointer;
    background:var(--text); color:var(--bg); border:1px solid var(--text); }
  .btn:hover{ opacity:.9; }
  .help{ color:var(--muted); font-size:12.5px; margin:20px 0 0; }
</style>`;

const ID_ICON = `<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 20c1.5-3.5 4.5-5 8-5s6.5 1.5 8 5"/></svg>`;
const ALERT_ICON = `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5M12 16h.01"/></svg>`;

function page(o: { title: string; brandName: string; icon: string; warn?: boolean; heading: string; msg: string; body?: string; help: string }): string {
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(o.title)} · ${escapeHtml(o.brandName)}</title>
${STYLE}
</head>
<body>
  <main>
    <section class="card" aria-labelledby="t">
      <div class="icon${o.warn ? " warn" : ""}" aria-hidden="true">${o.icon}</div>
      <h1 id="t">${escapeHtml(o.heading)}</h1>
      <p class="msg">${escapeHtml(o.msg)}</p>
      ${o.body ?? ""}
      <p class="help">${escapeHtml(o.help)}</p>
    </section>
  </main>
</body>
</html>`;
}

function idFormPage(o: {
  brandName: string;
  action: string;
  requestToken: string;
  id?: string;
  name?: string;
  problem?: string;
}): string {
  return page({
    title: "登录",
    brandName: o.brandName,
    icon: ID_ICON,
    heading: `登录 ${o.brandName}`,
    msg: "输入你的用户 id 即可进入。",
    body: `${o.problem ? `<p class="reason"><strong>请重试</strong>${escapeHtml(o.problem)}</p>` : ""}<form method="post" action="${escapeHtml(o.action)}">
        <input type="hidden" name="request" value="${escapeHtml(o.requestToken)}">
        <label for="id">用户 id</label>
        <input id="id" name="id" type="text" autocomplete="username" required autofocus
          spellcheck="false" maxlength="${MAX_ID_CHARS}" placeholder="app_u10086" value="${escapeHtml(o.id ?? "")}">
        <label for="name">显示名（可选）</label>
        <input id="name" name="name" type="text" autocomplete="name"
          maxlength="${MAX_NAME_CHARS}" placeholder="张三" value="${escapeHtml(o.name ?? "")}">
        <button class="btn" type="submit">进入</button>
      </form>`,
    help: "第一次使用的 id 会自动创建账号。",
  });
}

function problemPage(o: { brandName: string; heading: string; msg: string }): string {
  return page({
    title: "无法登录",
    brandName: o.brandName,
    icon: ALERT_ICON,
    warn: true,
    heading: o.heading,
    msg: o.msg,
    help: "请稍后重试，或联系管理员。",
  });
}

export function createIdLoginHandler(deps: IdLoginDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { cfg, signingKey, sealSecret, users } = deps;
  const now = (): number => Date.now();
  const used = new Map<string, number>();

  function keyFor(purpose: "request" | "code" | "access"): Uint8Array {
    return new Uint8Array(createHmac("sha256", sealSecret).update(`qm-idlogin.${purpose}.v1`).digest());
  }

  async function seal(purpose: "request" | "code" | "access", claims: Record<string, unknown>, ttlS: number): Promise<{ token: string; jti: string }> {
    const jti = randomBytes(18).toString("base64url");
    const issuedAt = Math.floor(now() / 1000);
    const token = await new SignJWT(claims)
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer(cfg.issuer)
      .setAudience(`qm-idlogin:${purpose}`)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + ttlS)
      .setJti(jti)
      .sign(keyFor(purpose));
    return { token, jti };
  }

  async function open(purpose: "request" | "code" | "access", token: string): Promise<JWTPayload | null> {
    try {
      const { payload } = await jwtVerify(token, keyFor(purpose), {
        issuer: cfg.issuer,
        audience: `qm-idlogin:${purpose}`,
        algorithms: ["HS256"],
        requiredClaims: ["jti", "iat", "exp"],
        currentDate: new Date(now()),
        clockTolerance: 5,
      });
      return payload;
    } catch {
      return null;
    }
  }

  function claimOnce(jti: string, expiresAtMs: number): boolean {
    if (used.size > 4096) {
      const cutoff = now();
      for (const [key, expiry] of used) if (expiry < cutoff) used.delete(key);
    }
    if (used.has(jti)) return false;
    used.set(jti, expiresAtMs);
    return true;
  }

  function sealRequest(request: AuthRequest): Promise<{ token: string; jti: string }> {
    return seal(
      "request",
      { cid: request.clientId, ru: request.redirectUri, st: request.state, no: request.nonce, cc: request.codeChallenge },
      cfg.requestTtlS,
    );
  }

  function readAuthRequest(payload: JWTPayload): AuthRequest | null {
    const { cid, ru, st, no, cc } = payload as Record<string, unknown>;
    if ([cid, ru, st, no, cc].some((value) => typeof value !== "string" || !value)) return null;
    return {
      clientId: cid as string,
      redirectUri: ru as string,
      state: st as string,
      nonce: no as string,
      codeChallenge: cc as string,
    };
  }

  async function openRequest(token: string): Promise<AuthRequest | null> {
    const payload = await open("request", token);
    return payload ? readAuthRequest(payload) : null;
  }

  async function openCode(token: string): Promise<{ claims: CodeClaims; jti: string; expiresAtMs: number } | null> {
    const payload = await open("code", token);
    if (!payload) return null;
    const { cid, ru, no, cc, id, nm } = payload as Record<string, unknown>;
    if ([cid, ru, no, cc, id].some((value) => typeof value !== "string" || !value)) return null;
    return {
      claims: {
        clientId: cid as string,
        redirectUri: ru as string,
        nonce: no as string,
        codeChallenge: cc as string,
        id: id as string,
        name: typeof nm === "string" ? nm : (id as string),
      },
      jti: String(payload.jti),
      expiresAtMs: Number(payload.exp) * 1000,
    };
  }

  async function openAccess(token: string): Promise<{ sub: string; name: string } | null> {
    const payload = await open("access", token);
    if (!payload || typeof payload.sub !== "string") return null;
    const name = (payload as Record<string, unknown>).nm;
    return { sub: payload.sub, name: typeof name === "string" ? name : "" };
  }

  function noStore(extra: Record<string, string> = {}): Record<string, string> {
    return {
      "cache-control": "no-store",
      pragma: "no-cache",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      ...extra,
    };
  }

  function sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, noStore({ "content-type": "application/json" }));
    res.end(JSON.stringify(body));
  }

  function sendHtml(res: ServerResponse, status: number, html: string): void {
    res.writeHead(
      status,
      noStore({
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": PAGE_CSP,
        "x-frame-options": "DENY",
        "x-robots-tag": "noindex, nofollow",
      }),
    );
    res.end(html);
  }

  function problem(res: ServerResponse, status: number, heading: string, msg: string): void {
    sendHtml(res, status, problemPage({ brandName: cfg.brandName, heading, msg }));
  }

  function readAuthorizeParams(params: URLSearchParams): { request: AuthRequest } | { problem: string } {
    const clientId = params.get("client_id") ?? "";
    const redirectUri = params.get("redirect_uri") ?? "";
    if (!clientId || !safeEqual(clientId, cfg.clientId)) return { problem: "未知的登录应用。" };
    if (!redirectUri || !safeEqual(redirectUri, cfg.redirectUri)) return { problem: "回调地址未注册。" };
    if ((params.get("response_type") ?? "") !== "code") return { problem: "仅支持授权码流程。" };
    if ((params.get("code_challenge_method") ?? "") !== "S256") return { problem: "必须使用 PKCE S256。" };
    const codeChallenge = params.get("code_challenge") ?? "";
    if (!/^[A-Za-z0-9\-_]{43}$/.test(codeChallenge)) return { problem: "PKCE 参数格式错误。" };
    const state = params.get("state") ?? "";
    const nonce = params.get("nonce") ?? "";
    if (!state || state.length > 512) return { problem: "缺少 state 参数。" };
    if (!nonce || nonce.length > 512) return { problem: "缺少 nonce 参数。" };
    const scope = params.get("scope") ?? "openid";
    if (!scope.split(/\s+/).includes("openid")) return { problem: "必须请求 openid 范围。" };
    return { request: { clientId, redirectUri, state, nonce, codeChallenge } };
  }

  async function authorizeForm(res: ServerResponse, params: URLSearchParams): Promise<void> {
    const parsed = readAuthorizeParams(params);
    if ("problem" in parsed) return problem(res, 400, "无法开始登录", parsed.problem);
    const sealed = await sealRequest(parsed.request);
    sendHtml(res, 200, idFormPage({ brandName: cfg.brandName, action: "/authorize", requestToken: sealed.token }));
  }

  async function authorizeSubmit(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let raw: string;
    try {
      raw = await readBody(req, MAX_FORM_BYTES);
    } catch (e) {
      if (e instanceof PayloadTooLargeError) return problem(res, 413, "无法登录", "表单数据过大。");
      throw e;
    }
    const form = new URLSearchParams(raw);
    const request = await openRequest(form.get("request") ?? "");
    if (!request) return problem(res, 400, "登录页已过期", "请从你刚才访问的页面重新开始。");
    const id = (form.get("id") ?? "").trim();
    if (!id || id.length > MAX_ID_CHARS) {
      const sealed = await sealRequest(request);
      return sendHtml(
        res,
        400,
        idFormPage({ brandName: cfg.brandName, action: "/authorize", requestToken: sealed.token, id, problem: "请输入有效的用户 id。" }),
      );
    }
    if (!idAllowed(cfg, id)) {
      const sealed = await sealRequest(request);
      return sendHtml(
        res,
        403,
        idFormPage({ brandName: cfg.brandName, action: "/authorize", requestToken: sealed.token, id, problem: "该 id 未被允许登录。" }),
      );
    }
    const submittedName = (form.get("name") ?? "").trim().slice(0, MAX_NAME_CHARS);
    const previous = await users.get(id);
    const displayName = submittedName || previous?.name || id;
    await users.put({ id, name: displayName });
    const code = await seal(
      "code",
      { cid: request.clientId, ru: request.redirectUri, no: request.nonce, cc: request.codeChallenge, id, nm: displayName },
      cfg.codeTtlS,
    );
    if (deps.pushDirectory) {
      void (async () => {
        try {
          const roster = await users.list();
          await deps.pushDirectory!(roster.map((u) => ({ principalId: u.id, displayName: u.name, type: "internal" })));
        } catch (e) {
          console.error(`[idlogin] directory push failed: ${errMessage(e)}`);
        }
      })();
    }
    const destination = new URL(request.redirectUri);
    destination.searchParams.set("code", code.token);
    destination.searchParams.set("state", request.state);
    res.writeHead(302, noStore({ location: destination.toString() }));
    res.end();
  }

  function basicCredentials(header: string | undefined): { id: string; secret: string } | null {
    if (!header || !/^basic /i.test(header)) return null;
    const decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator < 1) return null;
    return { id: decoded.slice(0, separator), secret: decoded.slice(separator + 1) };
  }

  async function token(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const credentials = basicCredentials(req.headers.authorization);
    const idOk = credentials !== null && safeEqual(credentials.id, cfg.clientId);
    const secretOk = credentials !== null && safeEqual(credentials.secret, cfg.clientSecret);
    if (!idOk || !secretOk) {
      res.writeHead(401, noStore({ "content-type": "application/json", "www-authenticate": `Basic realm="qm-idlogin"` }));
      return void res.end(JSON.stringify({ error: "invalid_client" }));
    }
    let raw: string;
    try {
      raw = await readBody(req, MAX_FORM_BYTES);
    } catch {
      return sendJson(res, 400, { error: "invalid_request" });
    }
    const form = new URLSearchParams(raw);
    if (form.get("grant_type") !== "authorization_code") return sendJson(res, 400, { error: "unsupported_grant_type" });
    const got = form.get("code") ?? "";
    const opened = await openCode(got);
    if (!opened) return sendJson(res, 400, { error: "invalid_grant" });
    const { claims: granted } = opened;
    const redirectUri = form.get("redirect_uri") ?? "";
    if (
      !safeEqual(granted.clientId, cfg.clientId) ||
      !safeEqual(granted.redirectUri, redirectUri) ||
      !safeEqual(redirectUri, cfg.redirectUri)
    ) {
      return sendJson(res, 400, { error: "invalid_grant" });
    }
    if (!claimOnce(`code:${opened.jti}`, opened.expiresAtMs)) return sendJson(res, 400, { error: "invalid_grant" });
    if (!pkceMatches(form.get("code_verifier") ?? "", granted.codeChallenge))
      return sendJson(res, 400, { error: "invalid_grant" });
    if (!idAllowed(cfg, granted.id)) return sendJson(res, 400, { error: "invalid_grant" });

    const nowMs = now();
    const issuedAt = Math.floor(nowMs / 1000);
    const idToken = await new SignJWT({ nonce: granted.nonce, azp: cfg.clientId, name: granted.name })
      .setProtectedHeader({ alg: ID_TOKEN_ALG, kid: signingKey.kid, typ: "JWT" })
      .setIssuer(cfg.issuer)
      .setSubject(granted.id)
      .setAudience(cfg.clientId)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + ID_TOKEN_TTL_S)
      .sign(signingKey.privateKey);
    const access = await seal("access", { sub: granted.id, nm: granted.name }, cfg.accessTtlS);
    return sendJson(res, 200, {
      access_token: access.token,
      token_type: "Bearer",
      expires_in: cfg.accessTtlS,
      id_token: idToken,
      scope: "openid profile",
    });
  }

  async function userinfo(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const header = req.headers.authorization ?? "";
    if (!/^bearer /i.test(header)) {
      res.writeHead(401, noStore({ "content-type": "application/json", "www-authenticate": "Bearer" }));
      return void res.end(JSON.stringify({ error: "invalid_token" }));
    }
    const opened = await openAccess(header.slice(7).trim());
    if (!opened) {
      res.writeHead(401, noStore({ "content-type": "application/json", "www-authenticate": `Bearer error="invalid_token"` }));
      return void res.end(JSON.stringify({ error: "invalid_token" }));
    }
    return sendJson(res, 200, { sub: opened.sub, name: opened.name });
  }

  function discovery(res: ServerResponse): void {
    sendJson(res, 200, {
      issuer: cfg.issuer,
      authorization_endpoint: `${cfg.issuer}/authorize`,
      token_endpoint: `${cfg.issuer}/token`,
      userinfo_endpoint: `${cfg.issuer}/userinfo`,
      jwks_uri: `${cfg.issuer}/.well-known/jwks.json`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: [ID_TOKEN_ALG],
      scopes_supported: ["openid", "profile"],
      claims_supported: ["sub", "iss", "aud", "exp", "iat", "nonce", "azp"],
      token_endpoint_auth_methods_supported: ["client_secret_basic"],
      code_challenge_methods_supported: ["S256"],
    });
  }

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", "http://idlogin.local");
    const path = url.pathname;

    if (method === "GET" && path === "/healthz") return sendJson(res, 200, { ok: true });
    if (method === "GET" && (path === "/favicon.ico" || path === "/favicon.svg")) {
      return serveEmojiFavicon(res, "🪪", "max-age=86400");
    }
    if (method === "GET" && path === "/.well-known/jwks.json") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "public, max-age=300" });
      return void res.end(JSON.stringify({ keys: [signingKey.publicJwk] }));
    }
    if (method === "GET" && path === "/.well-known/openid-configuration") return discovery(res);
    if (method === "GET" && path === "/authorize") return authorizeForm(res, url.searchParams);
    if (method === "POST" && path === "/authorize") return authorizeSubmit(req, res);
    if (method === "POST" && path === "/token") return token(req, res);
    if ((method === "GET" || method === "POST") && path === "/userinfo") return userinfo(req, res);
    return sendJson(res, 404, { error: "not_found" });
  };
}

const PORT = portFromEnv(8099);

function createDirectoryPusher(): ((members: DirectoryMemberPush[]) => Promise<void>) | undefined {
  if (!CORE_SIGNING_SECRET) {
    console.warn("[idlogin] CORE_SIGNING_SECRET unset — directory sync disabled");
    return undefined;
  }
  return async (members) => {
    const path = withSourceAuthNonce("/v1/directory", CORE_SIGNING_SECRET);
    const body = JSON.stringify({ members });
    const r = await fetch(`${CORE_API_URL}${path}`, {
      method: "POST",
      body,
      headers: signedHeaders(CORE_SIGNING_SECRET, "POST", path, body),
      signal: AbortSignal.timeout(5_000),
    });
    if (!r.ok) throw new Error(`core replied ${r.status}: ${await r.text().catch(() => "")}`);
  };
}

async function startServer(): Promise<void> {
  const cfg = readConfig(process.env);
  const problems = bootProblems(cfg);
  if (problems.length) {
    for (const item of problems) console.error(`[idlogin] FATAL: ${item}`);
    throw new Error(`idlogin refusing to start: ${problems.length} misconfiguration(s)`);
  }
  const users = process.env.DATABASE_URL
    ? await createPostgresUserRegistry(process.env.DATABASE_URL)
    : createMemoryUserRegistry();
  const signingKey = await createSigningKey();
  const handle = createIdLoginHandler({
    cfg,
    signingKey,
    sealSecret: randomBytes(32),
    users,
    pushDirectory: createDirectoryPusher(),
  });
  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      console.error("[idlogin] 500 %s %s: %s", req.method ?? "?", (req.url ?? "?").split("?")[0], String(err));
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "internal_error" }));
      } else res.end();
    });
  });
  server.listen(PORT, () => {
    console.log(`[idlogin] id sign-in broker on http://localhost:${PORT} (issuer ${cfg.issuer}, key ${signingKey.kid})`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await startServer();
}
