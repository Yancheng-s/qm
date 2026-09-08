import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_LIBRARY_SKILLS,
  MAX_NAME_CHARS,
  MAX_SOUL_BYTES,
  MAX_STANDING_ORDERS_CHARS,
  assembleEmployee,
  parseAssembleBody,
  type AssembleDeps,
  type AssembleInput,
} from "../src/routes/partner/assemble.ts";
import {
  LIBRARIES,
  LIBRARY_KEY,
  LIBRARY_PRINCIPAL,
  LIBRARY_SCOPE,
  ok,
  recordingCore,
  unreachable,
  type CoreScript,
  type RecordedCall,
  type RecordingCore,
} from "./support.ts";

const PRINCIPAL = "acme_u1";

interface CoreOptions {
  librarySkills?: { id: string; name: string; scopeId?: string; status?: string }[];
  skillListStatus?: number;
  skillListUnreachable?: boolean;
  grantStatuses?: Record<string, number>;
  soulStatus?: number;
  policyStatus?: number;
  projectStatus?: number;
  projectUnreachable?: boolean;
}

const DEFAULT_SKILLS: { id: string; name: string; scopeId?: string; status?: string }[] = [
  { id: "skill-writer", name: "space-xhs-writer" },
  { id: "skill-title", name: "space-xhs-title" },
];

function stubCore(options: CoreOptions = {}): RecordingCore {
  let created = 0;
  const skills = options.librarySkills ?? DEFAULT_SKILLS;
  const script: CoreScript = (call: RecordedCall) => {
    if (call.path.startsWith("/v1/skills")) {
      if (options.skillListUnreachable) return unreachable();
      return ok(options.skillListStatus ?? 200, {
        skills: skills.map((skill) => ({
          id: skill.id,
          name: skill.name,
          scopeId: skill.scopeId ?? LIBRARY_SCOPE,
          status: skill.status ?? "active",
        })),
      });
    }
    if (call.path === "/v1/projects") {
      if (options.projectUnreachable) return unreachable();
      created += 1;
      return ok(options.projectStatus ?? 201, {
        project: { id: `web-project-${created}`, scopeId: `group:web-project-${created}`, name: "Support" },
      });
    }
    if (call.path === "/v1/grants") {
      const body = call.body as { ref?: string };
      const id = (body.ref ?? "").replace("skill:", "");
      const status = options.grantStatuses?.[id] ?? 200;
      return ok(status, status === 200 ? { ok: true } : { error: "grant_failed" });
    }
    if (call.path === "/v1/soul") return ok(options.soulStatus ?? 200, { ok: true, version: 1 });
    if (call.path === "/v1/contexts/policy") {
      const body = call.body as { orders?: string };
      return ok(options.policyStatus ?? 200, {
        policy: { orders: body.orders ?? "", bots: {}, ambientEnabled: null, updatedAt: 1 },
      });
    }
    return ok(404, { error: "not_found" });
  };
  return recordingCore(script);
}

function depsFor(core: RecordingCore): AssembleDeps {
  return {
    core: core.factory(PRINCIPAL),
    libraryCore: core.factory(LIBRARY_PRINCIPAL),
    libraries: LIBRARIES,
    libraryPrincipalId: LIBRARY_PRINCIPAL,
  };
}

function paths(calls: readonly RecordedCall[]): string[] {
  return calls.map((call) => call.path.split("?")[0]!);
}

function bodies(calls: readonly RecordedCall[], path: string): unknown[] {
  return calls.filter((call) => call.path === path).map((call) => call.body);
}

test("assemble lists library skills, builds the project, grants each by reference, then writes the soul", async () => {
  const core = stubCore();
  const outcome = await assembleEmployee(depsFor(core), {
    principalId: PRINCIPAL,
    name: "Support",
    library: LIBRARY_KEY,
    skills: [],
    soul: "Be terse.",
  });

  assert.deepEqual(paths(core.calls), ["/v1/skills", "/v1/projects", "/v1/grants", "/v1/grants", "/v1/soul"]);
  assert.deepEqual(
    core.calls.map((call) => call.principalId),
    [LIBRARY_PRINCIPAL, PRINCIPAL, LIBRARY_PRINCIPAL, LIBRARY_PRINCIPAL, PRINCIPAL],
  );
  assert.deepEqual(bodies(core.calls, "/v1/projects"), [{ principalId: PRINCIPAL, name: "Support" }]);
  assert.deepEqual(bodies(core.calls, "/v1/grants"), [
    {
      ownerScopeId: LIBRARY_SCOPE,
      ref: "skill:skill-writer",
      granteeScopeId: "group:web-project-1",
      permission: "read",
      grantedBy: LIBRARY_PRINCIPAL,
    },
    {
      ownerScopeId: LIBRARY_SCOPE,
      ref: "skill:skill-title",
      granteeScopeId: "group:web-project-1",
      permission: "read",
      grantedBy: LIBRARY_PRINCIPAL,
    },
  ]);
  assert.deepEqual(bodies(core.calls, "/v1/soul"), [
    { scopeId: "group:web-project-1", content: "Be terse.", actorId: PRINCIPAL },
  ]);

  assert.equal(outcome.status, "assembled");
  if (outcome.status !== "assembled") return;
  assert.deepEqual(outcome.employee, { id: "web-project-1", scopeId: "group:web-project-1", name: "Support" });
  assert.deepEqual(outcome.granted, ["space-xhs-writer", "space-xhs-title"]);
  assert.equal(outcome.grantFailures, undefined);
  assert.equal(outcome.soul, true);
  assert.deepEqual(outcome.files, []);
});

test("a single bound library is used when the request omits the library field", async () => {
  const core = stubCore();
  const outcome = await assembleEmployee(depsFor(core), {
    principalId: PRINCIPAL,
    name: "Support",
    skills: [],
  });
  assert.equal(outcome.status, "assembled");
  if (outcome.status !== "assembled") return;
  assert.deepEqual(outcome.granted, ["space-xhs-writer", "space-xhs-title"]);
});

test("a skills subset grants only the named library skills in request order", async () => {
  const core = stubCore();
  const outcome = await assembleEmployee(depsFor(core), {
    principalId: PRINCIPAL,
    name: "Support",
    library: LIBRARY_KEY,
    skills: ["space-xhs-title"],
  });
  assert.equal(bodies(core.calls, "/v1/grants").length, 1);
  assert.deepEqual(bodies(core.calls, "/v1/grants"), [
    {
      ownerScopeId: LIBRARY_SCOPE,
      ref: "skill:skill-title",
      granteeScopeId: "group:web-project-1",
      permission: "read",
      grantedBy: LIBRARY_PRINCIPAL,
    },
  ]);
  assert.equal(outcome.status, "assembled");
  if (outcome.status !== "assembled") return;
  assert.deepEqual(outcome.granted, ["space-xhs-title"]);
});

test("archived skills and skills from another scope are never granted", async () => {
  const core = stubCore({
    librarySkills: [
      { id: "keep", name: "keep" },
      { id: "old", name: "old", status: "archived" },
      { id: "other", name: "other", scopeId: "group:elsewhere" },
    ],
  });
  const outcome = await assembleEmployee(depsFor(core), {
    principalId: PRINCIPAL,
    name: "Support",
    library: LIBRARY_KEY,
    skills: [],
  });
  assert.equal(bodies(core.calls, "/v1/grants").length, 1);
  assert.equal(outcome.status, "assembled");
  if (outcome.status !== "assembled") return;
  assert.deepEqual(outcome.granted, ["keep"]);
});

test("an unknown skill name is refused before any project is created", async () => {
  const core = stubCore();
  const outcome = await assembleEmployee(depsFor(core), {
    principalId: PRINCIPAL,
    name: "Support",
    library: LIBRARY_KEY,
    skills: ["space-xhs-writer", "nope"],
  });
  assert.equal(outcome.status, "failed");
  assert.deepEqual(paths(core.calls), ["/v1/skills"]);
  if (outcome.status !== "failed") return;
  assert.equal(outcome.problem.status, 400);
  assert.match(String(outcome.problem.body.message), /unknown skill\(s\).*nope/);
});

test("an unknown library is refused before touching core", async () => {
  const core = stubCore();
  const outcome = await assembleEmployee(depsFor(core), {
    principalId: PRINCIPAL,
    name: "Support",
    library: "nope",
    skills: [],
  });
  assert.equal(outcome.status, "failed");
  assert.equal(core.calls.length, 0);
  if (outcome.status !== "failed") return;
  assert.equal(outcome.problem.status, 400);
  assert.match(String(outcome.problem.body.message), /unknown library "nope"/);
});

test("an empty library is refused without creating a project", async () => {
  const core = stubCore({ librarySkills: [] });
  const outcome = await assembleEmployee(depsFor(core), {
    principalId: PRINCIPAL,
    name: "Support",
    library: LIBRARY_KEY,
    skills: [],
  });
  assert.equal(outcome.status, "failed");
  assert.deepEqual(paths(core.calls), ["/v1/skills"]);
  if (outcome.status !== "failed") return;
  assert.equal(outcome.problem.status, 400);
  assert.match(String(outcome.problem.body.message), /holds no skill to grant/);
});

test("a skill listing failure surfaces the upstream status", async () => {
  const forbidden = stubCore({ skillListStatus: 403 });
  const outcome = await assembleEmployee(depsFor(forbidden), {
    principalId: PRINCIPAL,
    name: "Support",
    library: LIBRARY_KEY,
    skills: [],
  });
  assert.equal(outcome.status, "failed");
  if (outcome.status !== "failed") return;
  assert.equal(outcome.problem.status, 502);
  assert.deepEqual(outcome.problem.body.upstream, { status: 403 });

  const down = stubCore({ skillListUnreachable: true });
  const unreachableOutcome = await assembleEmployee(depsFor(down), {
    principalId: PRINCIPAL,
    name: "Support",
    library: LIBRARY_KEY,
    skills: [],
  });
  assert.equal(unreachableOutcome.status, "failed");
});

test("a partial grant failure reports which skills landed and which did not", async () => {
  const core = stubCore({ grantStatuses: { "skill-title": 400 } });
  const outcome = await assembleEmployee(depsFor(core), {
    principalId: PRINCIPAL,
    name: "Support",
    library: LIBRARY_KEY,
    skills: [],
  });
  assert.equal(bodies(core.calls, "/v1/grants").length, 2);
  assert.equal(outcome.status, "assembled");
  if (outcome.status !== "assembled") return;
  assert.deepEqual(outcome.granted, ["space-xhs-writer"]);
  assert.deepEqual(outcome.grantFailures, [{ name: "space-xhs-title", error: "grant_failed" }]);
});

test("a project failure produces no grant at all", async () => {
  const down = stubCore({ projectUnreachable: true });
  const failed = await assembleEmployee(depsFor(down), {
    principalId: PRINCIPAL,
    name: "Support",
    library: LIBRARY_KEY,
    skills: [],
  });
  assert.equal(failed.status, "failed");
  assert.deepEqual(paths(down.calls), ["/v1/skills", "/v1/projects"]);
  if (failed.status !== "failed") return;
  assert.equal(failed.problem.status, 502);

  const forbidden = stubCore({ projectStatus: 403 });
  const refused = await assembleEmployee(depsFor(forbidden), {
    principalId: PRINCIPAL,
    name: "Support",
    library: LIBRARY_KEY,
    skills: [],
  });
  assert.equal(refused.status, "failed");
  if (refused.status !== "failed") return;
  assert.deepEqual(refused.problem.body.upstream, { status: 403 });
});

test("a failed soul leaves the employee valid and reports the reason", async () => {
  const core = stubCore({ soulStatus: 403 });
  const outcome = await assembleEmployee(depsFor(core), {
    principalId: PRINCIPAL,
    name: "Support",
    library: LIBRARY_KEY,
    skills: [],
    soul: "Be terse.",
  });
  assert.equal(outcome.status, "assembled");
  if (outcome.status !== "assembled") return;
  assert.equal(outcome.soul, false);
  assert.equal(outcome.soulError, "core replied 403");
});

test("standing orders are written to the context policy after the soul", async () => {
  const core = stubCore();
  const outcome = await assembleEmployee(depsFor(core), {
    principalId: PRINCIPAL,
    name: "Support",
    library: LIBRARY_KEY,
    skills: [],
    soul: "Be terse.",
    standingOrders: "Your name is Red.",
  });
  assert.deepEqual(paths(core.calls), [
    "/v1/skills",
    "/v1/projects",
    "/v1/grants",
    "/v1/grants",
    "/v1/soul",
    "/v1/contexts/policy",
  ]);
  assert.deepEqual(bodies(core.calls, "/v1/contexts/policy"), [
    { principalId: PRINCIPAL, scope: "group:web-project-1", orders: "Your name is Red." },
  ]);
  assert.equal(outcome.status, "assembled");
  if (outcome.status !== "assembled") return;
  assert.equal(outcome.standingOrders, true);
});

test("assemble imports files into the employee scope after project creation", async () => {
  const core = stubCore();
  const imported = await assembleEmployee(
    {
      ...depsFor(core),
      importFiles: async ({ principalId, scopeId, files }) => {
        assert.equal(principalId, PRINCIPAL);
        assert.equal(scopeId, "group:web-project-1");
        assert.deepEqual(files, [
          {
            url: "https://files.example.test/profile.md",
            name: "profile.md",
            mimetype: "text/markdown",
            sha256: "a".repeat(64),
            sizeBytes: 12,
          },
        ]);
        return [{ ok: true, file: { id: "file-1", name: "profile.md", mimetype: "text/markdown", sizeBytes: 12 } }];
      },
    },
    {
      principalId: PRINCIPAL,
      name: "Support",
      library: LIBRARY_KEY,
      skills: [],
      files: [
        {
          url: "https://files.example.test/profile.md",
          name: "profile.md",
          mimetype: "text/markdown",
          sha256: "a".repeat(64),
          sizeBytes: 12,
        },
      ],
    },
  );

  assert.equal(imported.status, "assembled");
  if (imported.status !== "assembled") return;
  assert.deepEqual(imported.files, [{ id: "file-1", name: "profile.md", mimetype: "text/markdown", sizeBytes: 12 }]);
  assert.equal(imported.fileFailures, undefined);
});

test("file import failures leave the employee valid and report the reason", async () => {
  const core = stubCore();
  const outcome = await assembleEmployee(
    {
      ...depsFor(core),
      importFiles: async () => [
        {
          ok: false,
          url: "https://files.example.test/missing.md",
          name: "missing.md",
          error: "file download replied 404",
        },
      ],
    },
    {
      principalId: PRINCIPAL,
      name: "Support",
      library: LIBRARY_KEY,
      skills: [],
      files: [{ url: "https://files.example.test/missing.md", name: "missing.md" }],
    },
  );

  assert.equal(outcome.status, "assembled");
  if (outcome.status !== "assembled") return;
  assert.deepEqual(outcome.files, []);
  assert.deepEqual(outcome.fileFailures, [
    { url: "https://files.example.test/missing.md", name: "missing.md", error: "file download replied 404" },
  ]);
});

test("a rejected context policy leaves the employee valid and reports the reason", async () => {
  const core = stubCore({ policyStatus: 403 });
  const outcome = await assembleEmployee(depsFor(core), {
    principalId: PRINCIPAL,
    name: "Support",
    library: LIBRARY_KEY,
    skills: [],
    standingOrders: "Your name is Red.",
  });
  assert.equal(outcome.status, "assembled");
  if (outcome.status !== "assembled") return;
  assert.equal(outcome.standingOrders, false);
  assert.equal(outcome.standingOrdersError, "core replied 403");
});

test("assemble is not idempotent: every call mints a fresh scope", async () => {
  const core = stubCore();
  const first = await assembleEmployee(depsFor(core), {
    principalId: PRINCIPAL,
    name: "Support",
    library: LIBRARY_KEY,
    skills: [],
  });
  const second = await assembleEmployee(depsFor(core), {
    principalId: PRINCIPAL,
    name: "Support",
    library: LIBRARY_KEY,
    skills: [],
  });
  assert.equal(first.status, "assembled");
  assert.equal(second.status, "assembled");
  if (first.status !== "assembled" || second.status !== "assembled") return;
  assert.equal(first.employee.scopeId, "group:web-project-1");
  assert.equal(second.employee.scopeId, "group:web-project-2");
});

function problemOf(body: Record<string, unknown>): string {
  const parsed = parseAssembleBody(body);
  assert.equal(parsed.ok, false);
  if (parsed.ok) throw new Error("expected the body to be refused");
  assert.equal(parsed.problem.status, 400);
  assert.equal(parsed.problem.body.error, "bad_request");
  return String(parsed.problem.body.message);
}

test("parseAssembleBody refuses malformed requests before any core call", () => {
  assert.match(problemOf({}), /name is required/);
  assert.match(problemOf({ name: "  " }), /name is required/);
  assert.match(problemOf({ name: "x".repeat(MAX_NAME_CHARS + 1) }), /name is required/);
  assert.match(problemOf({ name: "ok", library: 42 }), /library must be a string/);
  assert.match(problemOf({ name: "ok", skills: {} }), /skills must be an array/);
  assert.match(
    problemOf({ name: "ok", skills: Array.from({ length: MAX_LIBRARY_SKILLS + 1 }, (_unused, i) => `s${i}`) }),
    /at most 50 entries/,
  );
  assert.match(problemOf({ name: "ok", skills: ["dup", "dup"] }), /"dup" appears twice/);
  assert.match(problemOf({ name: "ok", skills: ["Bad"] }), /must be a name matching/);
  assert.match(problemOf({ name: "ok", skills: [42] }), /must be a name matching/);
  assert.match(problemOf({ name: "ok", soul: 42 }), /soul must be a string/);
  assert.match(problemOf({ name: "ok", soul: "x".repeat(MAX_SOUL_BYTES + 1) }), /soul exceeds/);
  assert.match(problemOf({ name: "ok", standingOrders: 42 }), /standingOrders must be a string/);
  assert.match(
    problemOf({ name: "ok", standingOrders: "x".repeat(MAX_STANDING_ORDERS_CHARS + 1) }),
    /standingOrders exceeds/,
  );
  assert.match(problemOf({ name: "ok", files: {} }), /files must be an array/);
  assert.match(problemOf({ name: "ok", files: [{ url: "" }] }), /each file requires url/);
  assert.match(problemOf({ name: "ok", files: [{ url: "http://files.example.test/a.txt" }] }), /must use https/);
  assert.match(
    problemOf({ name: "ok", files: [{ url: "https://files.example.test/a.txt", sha256: "bad" }] }),
    /sha256/,
  );
});

test("parseAssembleBody accepts a valid request and drops empty optionals", () => {
  const parsed = parseAssembleBody({
    name: " Support ",
    library: " xhs ",
    skills: ["space-xhs-writer"],
    soul: "",
    standingOrders: "",
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.request, { name: "Support", library: "xhs", skills: ["space-xhs-writer"] });
});

test("parseAssembleBody accepts file metadata", () => {
  const parsed = parseAssembleBody({
    name: "Support",
    files: [
      {
        url: "https://files.example.test/profile.md",
        name: " profile.md ",
        mimetype: " text/markdown ",
        sha256: "A".repeat(64),
        sizeBytes: 7,
      },
    ],
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.request.files, [
    {
      url: "https://files.example.test/profile.md",
      name: "profile.md",
      mimetype: "text/markdown",
      sha256: "a".repeat(64),
      sizeBytes: 7,
    },
  ]);
});

test("AssembleInput carries the derived principal and nothing from the request body", () => {
  const parsed = parseAssembleBody({ name: "Support", principalId: "attacker", library: "xhs", skills: [] });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const input: AssembleInput = { principalId: PRINCIPAL, ...parsed.request };
  assert.equal(input.principalId, PRINCIPAL);
  assert.equal("principalId" in parsed.request, false);
});
