import test from "node:test";
import assert from "node:assert/strict";
import {
  adminActorHeader,
  bootstrapLibrary,
  parseBootstrapArgs,
  type BootstrapInput,
  type CoreClient,
  type CoreResponse,
} from "../bootstrap/bootstrap-library.ts";

interface Recorded {
  method: string;
  path: string;
  body?: unknown;
}

interface FakeCore {
  client: CoreClient;
  calls: Recorded[];
}

function createFakeCore(opts: {
  projects: Array<{ id: string; name: string; scopeId: string }>;
  packs: Array<{ id: string; url: string }>;
  packListStatus?: number;
  importStatus?: number;
}): FakeCore {
  const calls: Recorded[] = [];
  const client: CoreClient = {
    async call(method, path, body): Promise<CoreResponse> {
      calls.push({ method, path, ...(body === undefined ? {} : { body }) });
      if (method === "GET" && path.startsWith("/v1/projects?principalId="))
        return { status: 200, json: { projects: opts.projects } };
      if (method === "POST" && path === "/v1/projects")
        return {
          status: 201,
          json: { project: { id: "lib-new-project", name: "图书馆", scopeId: "group:lib-new-project" } },
        };
      if (method === "GET" && path === "/v1/admin/skill-packs") {
        if (opts.packListStatus !== undefined && opts.packListStatus !== 200)
          return { status: opts.packListStatus, json: { error: "forbidden" } };
        return { status: 200, json: { packs: opts.packs } };
      }
      if (method === "POST" && path === "/v1/admin/skill-packs")
        return { status: 200, json: { pack: { id: "pack-new", url: "https://git.example/skills.git" } } };
      if (method === "POST" && path.includes("/import")) {
        if (opts.importStatus !== undefined && opts.importStatus !== 200)
          return { status: opts.importStatus, json: { error: "boom" } };
        return { status: 200, json: { imported: ["space-xhs-title"], updated: [], skipped: [] } };
      }
      return { status: 404, json: { error: "not_found" } };
    },
  };
  return { client, calls };
}

function createDeps(opts: Parameters<typeof createFakeCore>[0]): { core: FakeCore; adminCore: FakeCore } {
  return { core: createFakeCore(opts), adminCore: createFakeCore(opts) };
}

const input: BootstrapInput = {
  adminPrincipalId: "dev-admin",
  projectName: "技能图书馆",
  packUrl: "https://git.example/skills.git",
};

test("bootstraps a fresh library: project, pack, and import into the project scope", async () => {
  const deps = createDeps({ projects: [], packs: [] });
  const outcome = await bootstrapLibrary({ core: deps.core.client, adminCore: deps.adminCore.client }, input);
  assert.equal(outcome.status, "bootstrapped");
  if (outcome.status !== "bootstrapped") return;
  assert.equal(outcome.projectId, "lib-new-project");
  assert.equal(outcome.projectScopeId, "group:lib-new-project");
  assert.equal(outcome.packId, "pack-new");
  assert.equal(outcome.projectCreated, true);
  assert.equal(outcome.packRegistered, true);
  assert.deepEqual(outcome.importResult, { imported: ["space-xhs-title"], updated: [], skipped: [] });

  assert.deepEqual(deps.core.calls.find((c) => c.path === "/v1/projects")?.body, {
    principalId: "dev-admin",
    name: "技能图书馆",
  });
  assert.deepEqual(deps.adminCore.calls.find((c) => c.method === "POST" && c.path === "/v1/admin/skill-packs")?.body, {
    url: "https://git.example/skills.git",
    subset: "all",
    trustTier: "internal",
  });
  const imported = deps.adminCore.calls.find((c) => c.path === "/v1/admin/skill-packs/pack-new/import");
  assert.deepEqual(imported?.body, { selected: "all", scopeIds: ["group:lib-new-project"] });
});

test("replays are idempotent: existing project and pack are reused, import still reconciles", async () => {
  const deps = createDeps({
    projects: [{ id: "lib-existing", name: "技能图书馆", scopeId: "group:lib-existing" }],
    packs: [{ id: "pack-existing", url: "https://git.example/skills.git" }],
  });
  const outcome = await bootstrapLibrary(
    { core: deps.core.client, adminCore: deps.adminCore.client },
    { ...input, selected: ["space-xhs-title"] },
  );
  assert.equal(outcome.status, "bootstrapped");
  if (outcome.status !== "bootstrapped") return;
  assert.equal(outcome.projectCreated, false);
  assert.equal(outcome.packRegistered, false);
  assert.equal(outcome.projectScopeId, "group:lib-existing");
  assert.equal(outcome.packId, "pack-existing");
  assert.equal(
    deps.core.calls.some((c) => c.method === "POST" && c.path === "/v1/projects"),
    false,
  );
  assert.equal(
    deps.adminCore.calls.some((c) => c.method === "POST" && c.path === "/v1/admin/skill-packs"),
    false,
  );
  const imported = deps.adminCore.calls.find((c) => c.path === "/v1/admin/skill-packs/pack-existing/import");
  assert.deepEqual(imported?.body, { selected: ["space-xhs-title"], scopeIds: ["group:lib-existing"] });
});

test("a missing admin grant surfaces as pack_list_failed", async () => {
  const deps = createDeps({ projects: [], packs: [], packListStatus: 403 });
  const outcome = await bootstrapLibrary({ core: deps.core.client, adminCore: deps.adminCore.client }, input);
  assert.equal(outcome.status, "error");
  if (outcome.status !== "error") return;
  assert.equal(outcome.code, "pack_list_failed");
  assert.equal(outcome.upstream?.status, 403);
});

test("a rejected import surfaces as pack_import_failed", async () => {
  const deps = createDeps({ projects: [], packs: [], importStatus: 500 });
  const outcome = await bootstrapLibrary({ core: deps.core.client, adminCore: deps.adminCore.client }, input);
  assert.equal(outcome.status, "error");
  if (outcome.status !== "error") return;
  assert.equal(outcome.code, "pack_import_failed");
  assert.equal(outcome.upstream?.status, 500);
});

test("parseBootstrapArgs validates flags and falls back to PROFILES_LIBRARY_PRINCIPAL", () => {
  const ok = parseBootstrapArgs(
    ["--url", "https://git.example/skills.git", "--name", "技能图书馆", "--skill", "a", "--skill", "b"],
    { PROFILES_LIBRARY_PRINCIPAL: "dev-admin" },
  );
  assert.deepEqual(ok, {
    adminPrincipalId: "dev-admin",
    projectName: "技能图书馆",
    packUrl: "https://git.example/skills.git",
    selected: ["a", "b"],
  });

  assert.deepEqual(parseBootstrapArgs([], {}), { problem: "--url <git repository> is required" });
  assert.deepEqual(parseBootstrapArgs(["--url", "u"], {}), {
    problem: "--name <library project name> is required",
  });
  assert.deepEqual(parseBootstrapArgs(["--url", "u", "--name", "n"], {}), {
    problem: "--admin <principalId> or PROFILES_LIBRARY_PRINCIPAL is required",
  });
  assert.deepEqual(parseBootstrapArgs(["--oops", "x"], {}), { problem: "unknown flag: --oops" });
  assert.deepEqual(parseBootstrapArgs(["--url"], {}), { problem: "--url requires a value" });
});

test("adminActorHeader appends the org suffix exactly once", () => {
  assert.equal(adminActorHeader("app_u10086", "acme"), "app_u10086@acme");
  assert.equal(adminActorHeader("admin@acme.dev", "acme"), "admin@acme.dev@acme");
  assert.equal(adminActorHeader("admin@acme.dev@acme", "acme"), "admin@acme.dev@acme");
});
