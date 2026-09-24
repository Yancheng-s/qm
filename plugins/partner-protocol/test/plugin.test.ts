import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { createAdminCoreCall, type CoreCall } from "../src/core-client.ts";
import {
  loadPluginPackage,
  parsePluginManifest,
  parsePluginSources,
  pluginOrders,
  type PluginPackage,
} from "../src/plugin-package.ts";
import { assembleEmployee } from "../src/routes/partner/assemble.ts";
import { readConfig, bootProblems } from "../src/config.ts";

const manifest = {
  schemaVersion: 1,
  id: "pmos",
  entryAgent: "lead",
  delegation: { enabled: true, provider: "qm" },
  agents: {
    lead: { instructions: "AGENT.md", skills: ["writer"], members: ["worker"] },
    worker: { instructions: "agents/worker.md", skills: ["writer"] },
  },
};

function fixture(): PluginPackage {
  return {
    source: { url: "https://example.com/skills.git" },
    commit: "a".repeat(40),
    manifest: parsePluginManifest(manifest),
    documents: { "AGENT.md": "你是主理人", "agents/worker.md": "你是专员" },
    skills: ["writer"],
  };
}

test("manifest refuses missing roles, traversal, unsupported provider and recursive delegation", () => {
  assert.throws(() => parsePluginManifest({ ...manifest, entryAgent: "missing" }));
  assert.throws(() => parsePluginManifest({ ...manifest, delegation: { enabled: true, provider: "native" } }));
  assert.throws(() =>
    parsePluginManifest({
      ...manifest,
      agents: { ...manifest.agents, lead: { ...manifest.agents.lead, instructions: "../secret.md" } },
    }),
  );
  assert.throws(() =>
    parsePluginManifest({
      ...manifest,
      agents: { ...manifest.agents, worker: { ...manifest.agents.worker, members: ["lead"] } },
    }),
  );
});

test("sources require trusted server configuration and permit URL-only boot", () => {
  assert.throws(() => parsePluginSources('{"pmos":"https://user:secret@example.com/repo"}'));
  assert.throws(() => parsePluginSources('{"pmos":"http://example.com/repo"}'));
  const config = readConfig({
    LIBRARY_URLS: '{"pmos":"https://example.com/repo"}',
    LIBRARY_PRINCIPAL: "admin",
    PARTNER_CREDENTIALS: `dev=${"s".repeat(40)}`,
    CORE_SIGNING_SECRET: "s".repeat(40),
  });
  assert.deepEqual(bootProblems(config), []);
  assert.equal(config.pluginSources.get("pmos")?.url, "https://example.com/repo");
});

test("Git loader uses committed documents, validates skills and does not execute package files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "partner-plugin-test-"));
  const run = promisify(execFile);
  const git = (args: string[]) => run("git", ["-C", dir, ...args], { windowsHide: true });
  try {
    await mkdir(join(dir, "agents"));
    await mkdir(join(dir, "skills/writer"), { recursive: true });
    await writeFile(join(dir, "plugin.json"), JSON.stringify(manifest));
    await writeFile(join(dir, "AGENT.md"), "committed lead");
    await writeFile(join(dir, "agents/worker.md"), "committed worker");
    await writeFile(join(dir, "skills/writer/SKILL.md"), "---\nname: writer\ndescription: write\n---\nWrite.");
    await git(["init"]);
    await git(["add", "."]);
    await git(["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "fixture"]);
    await writeFile(join(dir, "AGENT.md"), "uncommitted lead");
    const pkg = await loadPluginPackage("pmos", { url: dir });
    assert.equal(pkg.documents["AGENT.md"], "committed lead");
    assert.deepEqual(pkg.skills, ["writer"]);
    assert.match(pkg.commit, /^[a-f0-9]{40,64}$/);
    await assert.rejects(loadPluginPackage("card", { url: dir }), /id must match/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("compiled orders distinguish lead and workers and bound instruction size", () => {
  const pkg = fixture();
  const orders = pluginOrders(pkg, "pack-1", "项目要求");
  assert.match(orders, /subagent-task/);
  assert.match(orders, /session.*open/);
  assert.match(orders, /agents\/worker.md/);
  assert.match(orders, /项目要求/);
  assert.ok(!orders.includes("你是专员"));
  pkg.manifest.delegation.enabled = false;
  assert.match(pluginOrders(pkg, "pack-1"), /本插件关闭委派/);
  assert.throws(() => pluginOrders(pkg, "pack-1", "x".repeat(20000)), /20000/);
});

function scenario(options: { enabled?: boolean; fail?: string; partial?: boolean; missingBundle?: boolean } = {}) {
  const pkg = fixture();
  if (options.enabled === false) pkg.manifest.delegation.enabled = false;
  const calls: { identity: string; path: string; body: unknown }[] = [];
  const make =
    (identity: string): CoreCall =>
    async (_method, path, body) => {
      calls.push({ identity, path, body });
      if (path === options.fail) return { ok: true, status: 403, json: { error: "denied" } };
      let json: unknown = {};
      let status = 200;
      if (path.endsWith("/canonical")) json = { canonicalId: "dev_user@test" };
      else if (path === "/v1/admin/skill-packs") json = { pack: { id: "pack-1" } };
      else if (path.endsWith("/catalog"))
        json = {
          bundlePaths: options.missingBundle ? [] : ["AGENT.md", "agents/worker.md"],
          candidates: [{ upstreamName: "writer", eligible: true, normalized: { manifest: { name: "writer" } } }],
        };
      else if (path === "/v1/projects") {
        status = 201;
        json = { project: { id: "project-1", scopeId: "group:project-1" } };
      } else if (path.startsWith("/v1/skills?"))
        json = {
          skills: options.partial
            ? []
            : [
                {
                  name: "writer",
                  scopeId: "group:project-1",
                  status: "published",
                  pack: { packId: "pack-1", commit: pkg.commit },
                },
              ],
        };
      return { ok: true, status, json };
    };
  return {
    calls,
    deps: {
      core: make("user"),
      libraryCore: make("legacy"),
      libraries: new Map<string, string>(),
      libraryPrincipalId: "admin",
      pluginInstaller: {
        sources: new Map([["pmos", pkg.source]]),
        admin: make("admin"),
        orgId: "test",
        load: async () => pkg,
      },
    },
  };
}

const input = { principalId: "dev_user", name: "PMOS" };

test("plugin assembly imports into the new scope, enables the user and persists lead instructions", async () => {
  const { calls, deps } = scenario();
  const result = await assembleEmployee(deps, input);
  assert.equal(result.status, "assembled");
  if (result.status !== "assembled") return;
  assert.equal(result.plugin?.entryAgent, "lead");
  assert.equal(result.standingOrders, true);
  assert.ok(!calls.some((call) => call.path === "/v1/grants" || call.path === "/v1/soul"));
  assert.deepEqual(calls.find((call) => call.path.endsWith("/import"))?.body, {
    selected: ["writer"],
    scopeIds: ["group:project-1"],
  });
  assert.deepEqual(calls.find((call) => call.path.endsWith("/feature-flags"))?.body, {
    featureName: "persistent_subagents",
    scopeId: "personal:dev_user@test",
    on: true,
  });
  assert.ok(calls.filter((call) => call.path.startsWith("/v1/admin/")).every((call) => call.identity === "admin"));
  assert.equal(calls.find((call) => call.path === "/v1/contexts/policy")?.identity, "user");
});

test("disabled delegation never revokes a user's capability needed by another project", async () => {
  const { calls, deps } = scenario({ enabled: false });
  assert.equal((await assembleEmployee(deps, input)).status, "assembled");
  assert.ok(!calls.some((call) => call.path.endsWith("/feature-flags")));
});

test("preflight rejects incomplete plugin assets before creating a project", async () => {
  const { calls, deps } = scenario({ missingBundle: true });
  assert.equal((await assembleEmployee(deps, input)).status, "failed");
  assert.ok(!calls.some((call) => call.path === "/v1/projects"));
});

test("partial import, flag failure and instruction failure report the incomplete project", async () => {
  for (const options of [
    { partial: true },
    { fail: "/v1/admin/scopes/org%3Atest/feature-flags" },
    { fail: "/v1/contexts/policy" },
    { fail: "/v1/principals/dev_user/canonical" },
  ]) {
    const { deps } = scenario(options);
    const result = await assembleEmployee(deps, input);
    assert.equal(result.status, "failed");
    if (result.status !== "failed") return;
    assert.equal(result.problem.body.incomplete, true);
    assert.deepEqual(result.problem.body.employee, { id: "project-1", scopeId: "group:project-1", name: "PMOS" });
  }
});

test("admin transport uses signed admin identity without a portal user token", async () => {
  let received: Record<string, unknown> = {};
  const server = createServer((req, res) => {
    received = req.headers;
    res.setHeader("content-type", "application/json");
    res.end("{}");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const core = createAdminCoreCall(
      {
        coreApiUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        signingSecret: "s".repeat(40),
        identitySecret: "i".repeat(40),
      },
      "admin",
      "test",
    );
    assert.equal((await core("GET", "/v1/admin/whoami")).ok, true);
    assert.equal(received["x-admin-actor"], "admin@test");
    assert.equal(received["x-portal-identity"], undefined);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("plugin soul input becomes lead-only supplemental orders", async () => {
  const { calls, deps } = scenario();
  const result = await assembleEmployee(deps, { ...input, soul: "Caller identity", standingOrders: "Caller style" });
  assert.equal(result.status, "assembled");
  assert.ok(!calls.some((call) => call.path === "/v1/soul"));
  const orders = (calls.find((call) => call.path === "/v1/contexts/policy")?.body as { orders: string }).orders;
  assert.match(orders, /Caller identity/);
  assert.match(orders, /Caller style/);
});

test("oversized instructions fail before project creation", async () => {
  const { calls, deps } = scenario();
  assert.equal((await assembleEmployee(deps, { ...input, standingOrders: "x".repeat(20000) })).status, "failed");
  assert.ok(!calls.some((call) => call.path === "/v1/projects"));
});
