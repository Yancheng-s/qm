import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { canonicalPayload, signRequest } from "../../chassis/src/source-auth-sign.ts";
import type { HttpMethod } from "../../chassis/src/core-client.ts";
import { CHAT_COOKIE, mintChatToken } from "../src/auth.ts";
import type { CoreCall, CoreOutcome } from "../src/core-client.ts";
import { createHandler } from "../src/routes/index.ts";

export const ROOT = join(import.meta.dirname, "..");
export const READY_TIMEOUT_MS = 20_000;
export const PARTNER_ID = "acme";
export const PARTNER_SECRET = "partner-secret-0123456789abcdef0123456789";
export const PARTNERS: ReadonlyMap<string, string> = new Map([[PARTNER_ID, PARTNER_SECRET]]);
export const USER_ID = "u1";
export const PRINCIPAL_ID = `${PARTNER_ID}_${USER_ID}`;
export const SIGNING_SECRET = "gateway-test-signing-secret-0123456789";
export const IDENTITY_SECRET = "gateway-test-identity-secret-0123456789";
export const CREDENTIALS = `${PARTNER_ID}=${PARTNER_SECRET}`;
export const LIBRARY_KEY = "xhs";
export const LIBRARY_SCOPE = "group:web-project-lib";
export const LIBRARY_PRINCIPAL = "lib-admin";
export const LIBRARIES: ReadonlyMap<string, string> = new Map([[LIBRARY_KEY, LIBRARY_SCOPE]]);

export const VALID_ENV = {
  CORE_API_URL: "http://127.0.0.1:9",
  CORE_SIGNING_SECRET: SIGNING_SECRET,
  PORTAL_IDENTITY_SECRET: IDENTITY_SECRET,
  PARTNER_CREDENTIALS: CREDENTIALS,
  LIBRARY_SCOPES: `${LIBRARY_KEY}=${LIBRARY_SCOPE}`,
  LIBRARY_PRINCIPAL: LIBRARY_PRINCIPAL,
};

export function partnerHeaders(method: string, pathWithQuery: string, raw = ""): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000);
  return {
    "content-type": "application/json",
    "x-partner-id": PARTNER_ID,
    "x-timestamp": String(timestamp),
    "x-signature": signRequest(PARTNER_SECRET, timestamp, canonicalPayload(method, pathWithQuery, raw)),
  };
}

export function chatToken(principalId = PRINCIPAL_ID): string {
  return mintChatToken(principalId, IDENTITY_SECRET);
}

export function chatHeaders(principalId = PRINCIPAL_ID): Record<string, string> {
  return { cookie: `${CHAT_COOKIE}=${chatToken(principalId)}` };
}

export interface RecordedCall {
  principalId: string;
  method: HttpMethod;
  path: string;
  body: unknown;
}

export type CoreScript = (call: RecordedCall) => CoreOutcome;

export function ok(status: number, json: unknown): CoreOutcome {
  return { ok: true, status, json };
}

export function unreachable(): CoreOutcome {
  return { ok: false, problem: { status: 502, body: { error: "upstream_error", message: "core unreachable" } } };
}

export interface RecordingCore {
  calls: RecordedCall[];
  factory: (principalId: string) => CoreCall;
}

export function recordingCore(script?: CoreScript): RecordingCore {
  const calls: RecordedCall[] = [];
  return {
    calls,
    factory: (principalId) => async (method, path, body) => {
      const call: RecordedCall = { principalId, method, path, body };
      calls.push(call);
      return script ? script(call) : ok(200, {});
    },
  };
}

export interface Gateway {
  base: string;
  close: () => Promise<void>;
}

export async function startGateway(factory: (principalId: string) => CoreCall, ratePerMin = 0): Promise<Gateway> {
  const handler = createHandler({
    coreApiUrl: "http://core.invalid",
    signingSecret: "test-signing-secret-not-used-outbound",
    identitySecret: IDENTITY_SECRET,
    partners: PARTNERS,
    libraries: LIBRARIES,
    libraryPrincipalId: LIBRARY_PRINCIPAL,
    ratePerMin,
    chatCookieSecure: false,
    core: factory,
  });
  const server: Server = createServer((req, res) => {
    void handler(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      if (!res.writableEnded) res.end(JSON.stringify({ error: "internal_error" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return listenOn(server);
}

export interface SseEvent {
  event: string;
  data: unknown;
}

export function parseSse(text: string): SseEvent[] {
  const events: SseEvent[] = [];
  for (const block of text.split("\n\n")) {
    let event = "message";
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice("event: ".length);
      else if (line.startsWith("data: ")) data += line.slice("data: ".length);
    }
    if (data) events.push({ event, data: JSON.parse(data) as unknown });
  }
  return events;
}

export async function readSse(base: string, pathWithQuery: string): Promise<SseEvent[]> {
  const response = await fetch(`${base}${pathWithQuery}`, { headers: chatHeaders() });
  if (response.status !== 200) throw new Error(`events replied ${response.status}: ${await response.text()}`);
  return parseSse(await response.text());
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface StubCoreCall {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
}

export interface StubCore {
  url: string;
  calls: StubCoreCall[];
  close: () => Promise<void>;
}

function readRequest(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function listenOn(server: Server): Gateway {
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export async function startStubCore(): Promise<StubCore> {
  const calls: StubCoreCall[] = [];
  let runPolls = 0;
  let projects = 0;
  const server: Server = createServer((req, res) => {
    const { pathname } = new URL(req.url ?? "/", "http://core.local");
    void readRequest(req).then(() => {
      calls.push({
        method: req.method ?? "GET",
        path: pathname,
        headers: {
          "x-timestamp": req.headers["x-timestamp"] as string | undefined,
          "x-signature": req.headers["x-signature"] as string | undefined,
          "x-portal-identity": req.headers["x-portal-identity"] as string | undefined,
        },
      });
      const reply = (status: number, body: unknown): void => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (pathname === "/v1/projects" && req.method === "POST") {
        projects += 1;
        return reply(201, {
          project: { id: `web-project-${projects}`, scopeId: `group:web-project-${projects}`, name: "Support" },
        });
      }
      if (pathname === "/v1/projects") {
        return reply(200, {
          projects: [
            {
              id: "web-project-1",
              name: "Support",
              scopeId: "group:web-project-1",
              ownerId: PRINCIPAL_ID,
              memberIds: [PRINCIPAL_ID],
              createdAt: 1,
            },
          ],
        });
      }
      if (pathname === "/v1/skills") {
        return reply(200, {
          skills: [
            { id: "skill-writer", name: "space-xhs-writer", scopeId: LIBRARY_SCOPE, status: "active" },
            { id: "skill-title", name: "space-xhs-title", scopeId: LIBRARY_SCOPE, status: "active" },
            { id: "skill-old", name: "retired", scopeId: LIBRARY_SCOPE, status: "archived" },
            { id: "skill-elsewhere", name: "elsewhere", scopeId: "group:other", status: "active" },
          ],
        });
      }
      if (pathname === "/v1/grants") return reply(200, { ok: true });
      if (pathname === "/v1/soul") return reply(200, { ok: true, version: 1 });
      if (pathname === "/v1/turns") return reply(202, { status: "queued", runId: "run-1" });
      if (pathname === "/v1/runs/run-1") {
        runPolls += 1;
        if (runPolls === 1) return reply(200, { status: "running", partial: "", activity: [], alive: true });
        return reply(200, {
          status: "done",
          partial: "Hello back",
          result: { text: "Hello back" },
          activity: [],
          alive: false,
          replyComplete: true,
          startedAt: 1,
          finishedAt: 2,
        });
      }
      if (pathname === "/v1/sessions") {
        return reply(200, {
          sessions: [
            {
              id: "s1",
              type: "group",
              scopeId: "group:web-project-1",
              threadRef: `web:${PRINCIPAL_ID}:c1`,
              title: "First",
              createdAt: 1,
              lastActivityAt: 2,
              archived: true,
            },
          ],
        });
      }
      if (pathname === "/v1/sessions/s1") {
        return reply(200, {
          session: {
            id: "s1",
            type: "group",
            scopeId: "group:web-project-1",
            threadRef: `web:${PRINCIPAL_ID}:c1`,
            title: "First",
            createdAt: 1,
          },
          entries: [{ seq: 1, type: "user", payload: { text: "hi" } }],
        });
      }
      return reply(404, { error: "not_found" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const bound = listenOn(server);
  return { url: bound.base, calls, close: bound.close };
}

export function gatewayEnv(overrides: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PORT: "0" };
  for (const key of Object.keys(VALID_ENV)) delete env[key];
  delete env.PARTNER_RATE_LIMIT_PER_MIN;
  return { ...env, ...overrides };
}

export function bootGateway(overrides: Record<string, string>): { child: ReturnType<typeof spawn>; output: string[] } {
  const child = spawn(process.execPath, [join(ROOT, "src", "index.ts")], {
    cwd: ROOT,
    env: gatewayEnv(overrides),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output: string[] = [];
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => output.push(chunk));
  child.stderr?.on("data", (chunk: string) => output.push(chunk));
  return { child, output };
}

export async function stopGateway(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

export function without(env: Record<string, string>, ...keys: string[]): Record<string, string> {
  const copy = { ...env };
  for (const key of keys) delete copy[key];
  return copy;
}

export async function exitOutput(overrides: Record<string, string>): Promise<{ code: number | null; logged: string }> {
  const { child, output } = bootGateway(overrides);
  const code = await new Promise<number | null>((resolve) => child.once("exit", (exitCode) => resolve(exitCode)));
  return { code, logged: output.join("") };
}

export async function withGateway(
  overrides: Record<string, string>,
  run: (base: string, banner: string) => Promise<void>,
): Promise<void> {
  const { child, output } = bootGateway({ ...VALID_ENV, ...overrides });
  let base: string;
  try {
    base = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`gateway never listened: ${output.join("")}`)), READY_TIMEOUT_MS);
      const ready = (): void => {
        const match = /http:\/\/localhost:(\d+)/.exec(output.join(""));
        if (!match) return;
        clearTimeout(timer);
        resolve(`http://127.0.0.1:${match[1]}`);
      };
      child.stdout?.on("data", ready);
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`gateway exited ${code}: ${output.join("")}`));
      });
    });
  } catch (e) {
    await stopGateway(child);
    throw e;
  }
  try {
    await run(base, output.join(""));
  } finally {
    await stopGateway(child);
  }
}
