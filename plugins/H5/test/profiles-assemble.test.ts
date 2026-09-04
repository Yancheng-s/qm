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
  skills: Array<{ id: string; name: string; scopeId: string; status?: string }>;
  projectStatus?: number;
  failGrantRefs?: string[];
}): FakeCore {
  const calls: Recorded[] = [];
  let projects = 0;
  const client: CoreClient = {
    async call(method, path, body): Promise<CoreResponse> {
      calls.push({ method, path, ...(body === undefined ? {} : { body }) });
      if (method === "GET" && path.startsWith("/v1/skills")) return { status: 200, json: { skills: opts.skills } };
      if (method === "POST" && path === "/v1/projects") {
        if (opts.projectStatus !== undefined && opts.projectStatus !== 201)
          return { status: opts.projectStatus, json: { error: "forbidden" } };
        projects += 1;
        const project = { id: `web-project-${projects}`, scopeId: `group:web-project-${projects}` };
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
  libraries: [
    { key: "xhs", scopeId: "group:web-project-lib" },
    { key: "ecom", scopeId: "group:web-project-ecom" },
    { key: "empty", scopeId: "group:web-project-empty" },
  ],
  libraryPrincipalId: "app_admin",
};

const librarySkills = [
  { id: "skill-title", name: "space-xhs-title", scopeId: "group:web-project-lib" },
  { id: "skill-cover", name: "space-xhs-cover", scopeId: "group:web-project-lib" },
  { id: "skill-shot", name: "ecom-product-shot", scopeId: "group:web-project-ecom" },
  { id: "skill-elsewhere", name: "space-xhs-hotspot", scopeId: "org:acme" },
];

test("assembles a project and grants every skill the chosen library holds", async () => {
  const registry = createMemoryAssemblyRegistry();
  const core = createFakeCore({ skills: librarySkills });
  const outcome = await assembleProject(
    { core: core.client, cfg, registry },
    {
      library: "xhs",
      externalId: "miniapp-42",
      name: "张三的运营项目",
      principalId: "app_u1",
    },
  );
  assert.equal(outcome.status, "assembled");
  if (outcome.status !== "assembled") return;
  assert.equal(outcome.library, "xhs");
  assert.equal(outcome.projectId, "web-project-1");
  assert.equal(outcome.projectScopeId, "group:web-project-1");
  assert.deepEqual(outcome.granted, ["space-xhs-title", "space-xhs-cover"]);
  assert.equal(outcome.reused, false);

  const grants = core.calls.filter((c) => c.path === "/v1/grants");
  assert.equal(grants.length, 2);
  assert.deepEqual(grants[0]!.body, {
    ownerScopeId: "group:web-project-lib",
    ref: "skill:skill-title",
    granteeScopeId: "group:web-project-1",
    permission: "read",
    grantedBy: "app_admin",
  });
  const projectCall = core.calls.find((c) => c.path === "/v1/projects");
  assert.deepEqual(projectCall?.body, { principalId: "app_u1", name: "张三的运营项目" });
  const stored = await registry.get("miniapp-42", "xhs");
  assert.deepEqual(stored?.grantedSkillIds, ["skill-title", "skill-cover"]);
  assert.equal(stored?.projectScopeId, "group:web-project-1");
  assert.equal(await registry.get("miniapp-42", "ecom"), null);
});

test("replays by externalId within one library without creating a second project and heals grants", async () => {
  const registry = createMemoryAssemblyRegistry();
  await registry.put({
    externalId: "miniapp-42",
    library: "xhs",
    projectId: "web-project-existing",
    projectScopeId: "group:web-project-existing",
    grantedSkillIds: [],
    at: 1,
  });
  const core = createFakeCore({ skills: librarySkills });
  const outcome = await assembleProject(
    { core: core.client, cfg, registry },
    {
      library: "xhs",
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

test("one externalId in two libraries gets two projects with disjoint skills", async () => {
  const registry = createMemoryAssemblyRegistry();
  const core = createFakeCore({ skills: librarySkills });
  const deps = { core: core.client, cfg, registry };

  const xhs = await assembleProject(deps, { library: "xhs", externalId: "miniapp-42", name: "甲", principalId: "u1" });
  const ecom = await assembleProject(deps, {
    library: "ecom",
    externalId: "miniapp-42",
    name: "乙",
    principalId: "u1",
  });

  assert.equal(xhs.status, "assembled");
  assert.equal(ecom.status, "assembled");
  if (xhs.status !== "assembled" || ecom.status !== "assembled") return;
  assert.notEqual(xhs.projectId, ecom.projectId);
  assert.equal(xhs.reused, false);
  assert.equal(ecom.reused, false);
  assert.deepEqual(xhs.granted, ["space-xhs-title", "space-xhs-cover"]);
  assert.deepEqual(ecom.granted, ["ecom-product-shot"]);
  assert.equal((await registry.list()).length, 2);

  const grantees = core.calls
    .filter((c) => c.path === "/v1/grants")
    .map(
      (c) =>
        `${(c.body as { ownerScopeId: string }).ownerScopeId}>${(c.body as { granteeScopeId: string }).granteeScopeId}`,
    );
  assert.deepEqual(grantees, [
    "group:web-project-lib>group:web-project-1",
    "group:web-project-lib>group:web-project-1",
    "group:web-project-ecom>group:web-project-2",
  ]);
});

test("a library the config does not bind is rejected before touching core", async () => {
  const core = createFakeCore({ skills: librarySkills });
  const outcome = await assembleProject(
    { core: core.client, cfg, registry: createMemoryAssemblyRegistry() },
    { library: "douyin", name: "p", principalId: "app_u1" },
  );
  assert.deepEqual(outcome, {
    status: "error",
    code: "unknown_library",
    message: 'unknown library "douyin" (known: xhs, ecom, empty)',
  });
  assert.equal(core.calls.length, 0);
});

test("an archived skill in the library scope is not granted", async () => {
  const core = createFakeCore({
    skills: [
      ...librarySkills,
      { id: "skill-legacy", name: "space-xhs-legacy", scopeId: "group:web-project-lib", status: "archived" },
    ],
  });
  const outcome = await assembleProject(
    { core: core.client, cfg, registry: createMemoryAssemblyRegistry() },
    { library: "xhs", externalId: "miniapp-9", name: "p", principalId: "app_u1" },
  );
  assert.equal(outcome.status, "assembled");
  if (outcome.status !== "assembled") return;
  assert.deepEqual(outcome.granted, ["space-xhs-title", "space-xhs-cover"]);
  assert.equal(
    core.calls.some((c) => c.path === "/v1/grants" && (c.body as { ref: string }).ref === "skill:skill-legacy"),
    false,
  );
});

test("a library scope holding no skill is reported without naming the scope", async () => {
  const core = createFakeCore({ skills: librarySkills });
  const outcome = await assembleProject(
    { core: core.client, cfg, registry: createMemoryAssemblyRegistry() },
    { library: "empty", name: "p", principalId: "app_u1" },
  );
  assert.deepEqual(outcome, {
    status: "error",
    code: "library_empty",
    message: 'no skill available in library "empty"',
  });
  assert.equal(
    core.calls.some((c) => c.path === "/v1/projects"),
    false,
  );
});

test("project creation failure surfaces the upstream status", async () => {
  const core = createFakeCore({ skills: librarySkills, projectStatus: 403 });
  const outcome = await assembleProject(
    { core: core.client, cfg, registry: createMemoryAssemblyRegistry() },
    { library: "xhs", name: "p", principalId: "app_u1" },
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
      library: "xhs",
      externalId: "miniapp-7",
      name: "p",
      principalId: "app_u1",
    },
  );
  assert.equal(outcome.status, "error");
  if (outcome.status !== "error") return;
  assert.equal(outcome.code, "grant_failed");
  assert.deepEqual(outcome.granted, ["space-xhs-title"]);
  assert.equal(outcome.projectId, "web-project-1");
  const stored = await registry.get("miniapp-7", "xhs");
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
    { library: "xhs", name: "p", principalId: "app_u1" },
  );
  assert.equal(outcome.status, "error");
  if (outcome.status !== "error") return;
  assert.equal(outcome.code, "skill_list_failed");
  assert.equal(outcome.upstream?.status, 500);
});
