import test from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  adminActorHeader,
  bootstrapLibrary,
  bootstrapScannedPacks,
  formatLibraryScopes,
  mergeLibraryScopes,
  parseBootstrapArgs,
  filterPacksByLibrary,
  parseLibraryManifest,
  parseLibraryScopes,
  scanBootstrapPacks,
  upsertEnvKey,
  WORKTREE_ENV,
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

test("preferredScopeId reuses the bound project even when the display name changed", async () => {
  const deps = createDeps({
    projects: [{ id: "lib-bound", name: "旧名字", scopeId: "group:web-project-bound" }],
    packs: [{ id: "pack-existing", url: "https://git.example/skills.git" }],
  });
  const outcome = await bootstrapLibrary(
    { core: deps.core.client, adminCore: deps.adminCore.client },
    { ...input, preferredScopeId: "group:web-project-bound" },
  );
  assert.equal(outcome.status, "bootstrapped");
  if (outcome.status !== "bootstrapped") return;
  assert.equal(outcome.projectId, "lib-bound");
  assert.equal(outcome.projectScopeId, "group:web-project-bound");
  assert.equal(
    deps.core.calls.some((c) => c.method === "POST" && c.path === "/v1/projects"),
    false,
  );
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

test("parseBootstrapArgs takes library filters and LIBRARY_PRINCIPAL", () => {
  assert.deepEqual(parseBootstrapArgs(["card", "xhs"], { LIBRARY_PRINCIPAL: "dev-admin" }), {
    adminPrincipalId: "dev-admin",
    libraries: ["card", "xhs"],
  });
  assert.deepEqual(parseBootstrapArgs(["--admin", "ops"], {}), {
    adminPrincipalId: "ops",
    libraries: [],
  });
  assert.deepEqual(parseBootstrapArgs([], {}), { problem: "--admin <principalId> or LIBRARY_PRINCIPAL is required" });
  assert.deepEqual(parseBootstrapArgs(["--oops"], { LIBRARY_PRINCIPAL: "a" }), { problem: "unknown flag: --oops" });
  assert.deepEqual(parseBootstrapArgs(["--admin"], {}), { problem: "--admin requires a value" });
  assert.deepEqual(parseBootstrapArgs(["Bad"], { LIBRARY_PRINCIPAL: "a" }), { problem: "invalid library key: Bad" });
});

test("parseLibraryManifest requires a library alias", () => {
  assert.deepEqual(parseLibraryManifest({ library: "card", projectName: "智渠名片技能库", skills: ["zhiqu-card-create"] }, "p"), {
    library: "card",
    projectName: "智渠名片技能库",
    skills: ["zhiqu-card-create"],
  });
  assert.deepEqual(parseLibraryManifest({ library: "xhs" }, "p"), { library: "xhs", projectName: "xhs" });
  assert.ok("problem" in parseLibraryManifest({}, "p"));
  assert.ok("problem" in parseLibraryManifest({ library: "card", skills: [1] }, "p"));
});

test("parseLibraryManifest accepts a single mcp object or an array", () => {
  assert.deepEqual(
    parseLibraryManifest(
      {
        library: "card",
        projectName: "智渠名片技能库",
        mcp: { id: "zhiqu-card", url: "http://127.0.0.1:8310/mcp", name: "智渠名片创建" },
      },
      "p",
    ),
    {
      library: "card",
      projectName: "智渠名片技能库",
      mcp: [
        {
          id: "zhiqu-card",
          url: "http://127.0.0.1:8310/mcp",
          name: "智渠名片创建",
          readOnly: false,
          auth: "none",
        },
      ],
    },
  );
  const many = parseLibraryManifest(
    {
      library: "card",
      mcp: [
        { id: "zhiqu-card", url: "http://127.0.0.1:8310/mcp" },
        { id: "zhiqu-search", url: "http://127.0.0.1:8311/mcp", readOnly: true },
      ],
    },
    "p",
  );
  if ("problem" in many) assert.fail(many.problem);
  assert.equal(many.mcp?.length, 2);
  assert.equal(many.mcp?.[1]?.readOnly, true);
  assert.ok("problem" in parseLibraryManifest({ library: "card", mcp: { id: "Bad", url: "http://127.0.0.1:8310/mcp" } }, "p"));
  assert.ok(
    "problem" in
      parseLibraryManifest({ library: "card", mcp: { id: "zhiqu-card", url: "http://127.0.0.1:8310/mcp?x=1" } }, "p"),
  );
  assert.ok(
    "problem" in
      parseLibraryManifest(
        {
          library: "card",
          mcp: [
            { id: "zhiqu-card", url: "http://127.0.0.1:8310/mcp" },
            { id: "zhiqu-card", url: "http://127.0.0.1:8311/mcp" },
          ],
        },
        "p",
      ),
  );
  assert.deepEqual(
    parseLibraryManifest(
      {
        library: "pmos",
        mcp: {
          id: "pmos",
          url: "http://127.0.0.1:3000/mcp",
          auth: "bearer",
          bearerEnv: "PMOS_API_KEY",
        },
      },
      "p",
    ),
    {
      library: "pmos",
      projectName: "pmos",
      mcp: [
        {
          id: "pmos",
          url: "http://127.0.0.1:3000/mcp",
          name: "pmos",
          readOnly: false,
          auth: "bearer",
          bearerEnv: "PMOS_API_KEY",
        },
      ],
    },
  );
  assert.ok("problem" in parseLibraryManifest({ library: "pmos", mcp: { id: "pmos", url: "http://127.0.0.1:3000/mcp", auth: "bearer" } }, "p"));
});

test("library scope maps merge updates without dropping other keys", () => {
  const existing = parseLibraryScopes("card=group:old,cover=group:keep");
  const merged = mergeLibraryScopes(existing, [["card", "group:new"]]);
  assert.equal(formatLibraryScopes(merged), "card=group:new,cover=group:keep");
  assert.equal(upsertEnvKey("A=1\nLIBRARY_SCOPES=card=group:old\n", "LIBRARY_SCOPES", "card=group:new"), "A=1\nLIBRARY_SCOPES=card=group:new\n");
});

test("WORKTREE_ENV is the repo root .env", () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  assert.equal(WORKTREE_ENV, resolve(repoRoot, ".env"));
});

test("scanBootstrapPacks finds library.json git packs and skips the rest", () => {
  const root = mkdtempSync(join(tmpdir(), "qm-bootstrap-scan-"));
  try {
    const packDir = join(root, "demo-skills");
    mkdirSync(join(packDir, "demo"), { recursive: true });
    writeFileSync(
      join(packDir, "library.json"),
      JSON.stringify({ library: "demo", projectName: "演示库", skills: ["demo"] }),
    );
    writeFileSync(join(packDir, "demo", "SKILL.md"), "---\nname: demo\ndescription: d\n---\n\n# d\n");
    execSync("git init", { cwd: packDir, stdio: "ignore" });
    mkdirSync(join(root, "not-a-pack"));
    writeFileSync(join(root, "bootstrap-library.ts"), "x");
    const scanned = scanBootstrapPacks(root);
    assert.deepEqual(scanned.problems, []);
    assert.equal(scanned.packs.length, 1);
    assert.equal(scanned.packs[0]?.library, "demo");
    assert.equal(scanned.packs[0]?.projectName, "演示库");
    assert.deepEqual(scanned.packs[0]?.skills, ["demo"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scanBootstrapPacks finds the bundled card and pmos packs", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "../bootstrap");
  const scanned = scanBootstrapPacks(root);
  assert.deepEqual(scanned.problems, []);
  const card = scanned.packs.find((pack) => pack.library === "card");
  assert.ok(card);
  assert.equal(card?.projectName, "智渠名片技能库");
  assert.deepEqual(card?.skills, ["zhiqu-card-create"]);
  assert.deepEqual(card?.mcp, [
    {
      id: "zhiqu-card",
      url: "http://127.0.0.1:8310/mcp",
      name: "智渠名片创建",
      readOnly: false,
      auth: "none",
    },
  ]);
  const pmos = scanned.packs.find((pack) => pack.library === "pmos");
  assert.ok(pmos);
  assert.deepEqual(pmos?.mcp, [
    {
      id: "pmos",
      url: "http://127.0.0.1:3000/mcp",
      name: "PMOS 营销素材",
      readOnly: false,
      auth: "bearer",
      bearerEnv: "PMOS_API_KEY",
    },
  ]);
});

test("scanBootstrapPacks rejects the same mcp.id in two packs", () => {
  const root = mkdtempSync(join(tmpdir(), "qm-bootstrap-mcp-dup-"));
  try {
    for (const name of ["one", "two"]) {
      const packDir = join(root, `${name}-skills`);
      mkdirSync(join(packDir, "demo"), { recursive: true });
      writeFileSync(
        join(packDir, "library.json"),
        JSON.stringify({
          library: name,
          mcp: { id: "shared-mcp", url: "http://127.0.0.1:8310/mcp" },
        }),
      );
      writeFileSync(join(packDir, "demo", "SKILL.md"), "---\nname: demo\ndescription: d\n---\n\n# d\n");
      execSync("git init", { cwd: packDir, stdio: "ignore" });
    }
    const scanned = scanBootstrapPacks(root);
    assert.equal(scanned.packs.length, 2);
    assert.ok(scanned.problems.some((problem) => problem.includes('mcp.id "shared-mcp"')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("filterPacksByLibrary keeps all packs or the named subset", () => {
  const packs = [
    { dir: "/a", packUrl: "/a", library: "card", projectName: "card" },
    { dir: "/b", packUrl: "/b", library: "cover", projectName: "cover" },
  ];
  const all = filterPacksByLibrary(packs, []);
  if ("problem" in all) assert.fail(all.problem);
  assert.deepEqual(all.packs.map((pack) => pack.library), ["card", "cover"]);
  const cover = filterPacksByLibrary(packs, ["cover"]);
  if ("problem" in cover) assert.fail(cover.problem);
  assert.deepEqual(cover.packs.map((pack) => pack.library), ["cover"]);
  assert.equal("problem" in filterPacksByLibrary(packs, ["missing"]), true);
});

test("bootstrapScannedPacks imports each pack and records LIBRARY_SCOPES", async () => {
  const deps = createDeps({ projects: [], packs: [] });
  const { results, scopes } = await bootstrapScannedPacks(
    { core: deps.core.client, adminCore: deps.adminCore.client },
    [
      {
        dir: "/pack/card",
        packUrl: "https://git.example/skills.git",
        library: "card",
        projectName: "智渠名片技能库",
        skills: ["zhiqu-card-create"],
      },
    ],
    "admin@acme.dev",
    parseLibraryScopes(""),
  );
  assert.equal(results.length, 1);
  assert.equal(results[0]?.library, "card");
  assert.equal(results[0]?.outcome.status, "bootstrapped");
  assert.equal(scopes.get("card"), "group:lib-new-project");
  const imported = deps.adminCore.calls.find((c) => c.path.includes("/import"));
  assert.deepEqual(imported?.body, { selected: ["zhiqu-card-create"], scopeIds: ["group:lib-new-project"] });
});

test("adminActorHeader appends the org suffix exactly once", () => {
  assert.equal(adminActorHeader("app_u10086", "acme"), "app_u10086@acme");
  assert.equal(adminActorHeader("admin@acme.dev", "acme"), "admin@acme.dev@acme");
  assert.equal(adminActorHeader("admin@acme.dev@acme", "acme"), "admin@acme.dev@acme");
});
