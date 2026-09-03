import test from "node:test";
import assert from "node:assert/strict";
import { assembleProject, type CoreClient, type CoreResponse } from "../src/profiles/assemble.ts";
import { createMemoryAssemblyRegistry } from "../src/profiles/assemble-store.ts";
import type { ProfilesConfig } from "../src/profiles/config.ts";

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
  skills: Array<{ id: string; name: string; scopeId: string }>;
  projectStatus?: number;
  project?: { id: string; scopeId: string };
  failGrantRefs?: string[];
}): FakeCore {
  const calls: Recorded[] = [];
  const client: CoreClient = {
    async call(method, path, body): Promise<CoreResponse> {
      calls.push({ method, path, ...(body === undefined ? {} : { body }) });
      if (method === "GET" && path.startsWith("/v1/skills")) return { status: 200, json: { skills: opts.skills } };
      if (method === "POST" && path === "/v1/projects") {
        if (opts.projectStatus !== undefined && opts.projectStatus !== 201)
          return { status: opts.projectStatus, json: { error: "forbidden" } };
        const project = opts.project ?? { id: "web-project-abc", scopeId: "group:web-project-abc" };
        return { status: 201, json: { project } };
      }
      if (method === "POST" && path === "/v1/grants") {
        const ref = (body as { ref: string }).ref;
        if (opts.failGrantRefs?.includes(ref)) return { status: 400, json: { error: "grant_failed" } };
        return { status: 200, json: { ok: true } };
      }
      return { status: 404, json: { error: "not_found" } };
    },
  };
  return { client, calls };
}

const cfg: ProfilesConfig = {
  assembleKey: "k".repeat(40),
  libraryScopeId: "group:web-project-lib",
  libraryPrincipalId: "app_admin",
  skillNames: ["space-xhs-title", "space-xhs-cover", "space-xhs-missing"],
};

const librarySkills = [
  { id: "skill-title", name: "space-xhs-title", scopeId: "group:web-project-lib" },
  { id: "skill-cover", name: "space-xhs-cover", scopeId: "group:web-project-lib" },
  { id: "skill-elsewhere", name: "space-xhs-hotspot", scopeId: "org:acme" },
];

test("assembles a project and grants every library skill by id", async () => {
  const registry = createMemoryAssemblyRegistry();
  const core = createFakeCore({ skills: librarySkills });
  const outcome = await assembleProject(
    { core: core.client, cfg, registry },
    {
      externalId: "miniapp-42",
      name: "张三的运营项目",
      principalId: "app_u1",
    },
  );
  assert.equal(outcome.status, "assembled");
  if (outcome.status !== "assembled") return;
  assert.equal(outcome.projectId, "web-project-abc");
  assert.equal(outcome.projectScopeId, "group:web-project-abc");
  assert.deepEqual(outcome.granted, ["space-xhs-title", "space-xhs-cover"]);
  assert.deepEqual(outcome.missing, ["space-xhs-missing"]);
  assert.equal(outcome.reused, false);

  const grants = core.calls.filter((c) => c.path === "/v1/grants");
  assert.equal(grants.length, 2);
  assert.deepEqual(grants[0]!.body, {
    ownerScopeId: "group:web-project-lib",
    ref: "skill:skill-title",
    granteeScopeId: "group:web-project-abc",
    permission: "read",
    grantedBy: "app_admin",
  });
  const projectCall = core.calls.find((c) => c.path === "/v1/projects");
  assert.deepEqual(projectCall?.body, { principalId: "app_u1", name: "张三的运营项目" });
  const stored = await registry.get("miniapp-42");
  assert.deepEqual(stored?.grantedSkillIds, ["skill-title", "skill-cover"]);
  assert.equal(stored?.projectScopeId, "group:web-project-abc");
});

test("replays by externalId without creating a second project and heals grants", async () => {
  const registry = createMemoryAssemblyRegistry();
  await registry.put({
    externalId: "miniapp-42",
    projectId: "web-project-existing",
    projectScopeId: "group:web-project-existing",
    grantedSkillIds: [],
    at: 1,
  });
  const core = createFakeCore({ skills: librarySkills });
  const outcome = await assembleProject(
    { core: core.client, cfg, registry },
    {
      externalId: "miniapp-42",
      name: "ignored on replay",
      principalId: "app_u1",
    },
  );
  assert.equal(outcome.status, "assembled");
  if (outcome.status !== "assembled") return;
  assert.equal(outcome.reused, true);
  assert.equal(outcome.projectId, "web-project-existing");
  assert.equal(
    core.calls.some((c) => c.path === "/v1/projects"),
    false,
  );
  const grants = core.calls.filter((c) => c.path === "/v1/grants");
  assert.equal(grants.length, 2);
  assert.equal((grants[0]!.body as { granteeScopeId: string }).granteeScopeId, "group:web-project-existing");
});

test("empty library is a 400-class configuration error", async () => {
  const core = createFakeCore({ skills: [] });
  const outcome = await assembleProject(
    { core: core.client, cfg, registry: createMemoryAssemblyRegistry() },
    { name: "p", principalId: "app_u1" },
  );
  assert.deepEqual(outcome, {
    status: "error",
    code: "library_empty",
    message: "no skill available in library scope group:web-project-lib",
  });
  assert.equal(
    core.calls.some((c) => c.path === "/v1/projects"),
    false,
  );
});

test("an empty name list grants every skill the library scope holds", async () => {
  const core = createFakeCore({ skills: librarySkills });
  const outcome = await assembleProject(
    { core: core.client, cfg: { ...cfg, skillNames: [] }, registry: createMemoryAssemblyRegistry() },
    { externalId: "miniapp-all", principalId: "app_u1", name: "p" },
  );
  assert.equal(outcome.status, "assembled");
  if (outcome.status !== "assembled") return;
  assert.deepEqual(outcome.granted, ["space-xhs-title", "space-xhs-cover"]);
  assert.deepEqual(outcome.missing, []);
  const grants = core.calls.filter((c) => c.path === "/v1/grants");
  assert.deepEqual(
    grants.map((c) => (c!.body as { ref: string }).ref),
    ["skill:skill-title", "skill:skill-cover"],
  );
});

test("project creation failure surfaces the upstream status", async () => {
  const core = createFakeCore({ skills: librarySkills, projectStatus: 403 });
  const outcome = await assembleProject(
    { core: core.client, cfg, registry: createMemoryAssemblyRegistry() },
    { name: "p", principalId: "app_u1" },
  );
  assert.equal(outcome.status, "error");
  if (outcome.status !== "error") return;
  assert.equal(outcome.code, "project_create_failed");
  assert.equal(outcome.upstream?.status, 403);
});

test("partial grant failure reports which skills landed and stores only those", async () => {
  const registry = createMemoryAssemblyRegistry();
  const core = createFakeCore({ skills: librarySkills, failGrantRefs: ["skill:skill-cover"] });
  const outcome = await assembleProject(
    { core: core.client, cfg, registry },
    {
      externalId: "miniapp-7",
      name: "p",
      principalId: "app_u1",
    },
  );
  assert.equal(outcome.status, "error");
  if (outcome.status !== "error") return;
  assert.equal(outcome.code, "grant_failed");
  assert.deepEqual(outcome.granted, ["space-xhs-title"]);
  assert.equal(outcome.projectId, "web-project-abc");
  const stored = await registry.get("miniapp-7");
  assert.deepEqual(stored?.grantedSkillIds, ["skill-title"]);
});

test("skill listing failure is reported, not swallowed", async () => {
  const client: CoreClient = {
    async call() {
      return { status: 500, json: { error: "boom" } };
    },
  };
  const outcome = await assembleProject(
    { core: client, cfg, registry: createMemoryAssemblyRegistry() },
    { name: "p", principalId: "app_u1" },
  );
  assert.equal(outcome.status, "error");
  if (outcome.status !== "error") return;
  assert.equal(outcome.code, "skill_list_failed");
  assert.equal(outcome.upstream?.status, 500);
});
