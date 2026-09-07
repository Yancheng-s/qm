import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_NAME_CHARS,
  MAX_SKILLS,
  MAX_SOUL_BYTES,
  assembleEmployee,
  parseAssembleBody,
  type AssembleInput,
} from "../src/routes/assemble.ts";
import { MAX_SKILL_BODY_BYTES } from "../src/routes/skills.ts";
import { ok, recordingCore, unreachable, type CoreScript, type RecordedCall } from "./support.ts";

const PRINCIPAL = "acme_u1";

function skill(
  name: string,
  body = `# ${name}\n\ndo the thing\n`,
): { name: string; description: string; body: string } {
  return { name, description: `${name} does the thing`, body };
}

interface CoreOptions {
  skillStatuses?: Record<string, number>;
  soulStatus?: number;
  projectStatus?: number;
  projectUnreachable?: boolean;
}

function stubCore(options: CoreOptions = {}): ReturnType<typeof recordingCore> {
  let created = 0;
  const script: CoreScript = (call: RecordedCall) => {
    if (call.path === "/v1/projects") {
      if (options.projectUnreachable) return unreachable();
      created += 1;
      return ok(options.projectStatus ?? 201, {
        project: { id: `web-project-${created}`, scopeId: `group:web-project-${created}`, name: "Support" },
      });
    }
    if (call.path === "/v1/skills") {
      const body = call.body as { name?: string };
      const status = options.skillStatuses?.[body.name ?? ""] ?? 201;
      return ok(
        status,
        status === 201 ? { skill: { id: `skill-${body.name}`, name: body.name } } : { error: "exists" },
      );
    }
    if (call.path === "/v1/soul") return ok(options.soulStatus ?? 200, { ok: true, version: 1 });
    return ok(404, { error: "not_found" });
  };
  return recordingCore(script);
}

function bodies(calls: readonly RecordedCall[], path: string): unknown[] {
  return calls.filter((call) => call.path === path).map((call) => call.body);
}

test("assemble calls projects, then every skill in order, then soul", async () => {
  const core = stubCore();
  const outcome = await assembleEmployee(core.factory(PRINCIPAL), {
    principalId: PRINCIPAL,
    name: "Support",
    skills: [skill("one"), skill("two")],
    soul: "Be terse.",
  });

  assert.deepEqual(
    core.calls.map((call) => call.path),
    ["/v1/projects", "/v1/skills", "/v1/skills", "/v1/soul"],
  );
  assert.deepEqual(
    core.calls.map((call) => call.principalId),
    [PRINCIPAL, PRINCIPAL, PRINCIPAL, PRINCIPAL],
  );
  assert.deepEqual(bodies(core.calls, "/v1/projects"), [{ principalId: PRINCIPAL, name: "Support" }]);
  assert.deepEqual(bodies(core.calls, "/v1/skills"), [
    { principalId: PRINCIPAL, scopeId: "group:web-project-1", ...skill("one") },
    { principalId: PRINCIPAL, scopeId: "group:web-project-1", ...skill("two") },
  ]);
  assert.deepEqual(bodies(core.calls, "/v1/soul"), [
    { scopeId: "group:web-project-1", content: "Be terse.", actorId: PRINCIPAL },
  ]);

  assert.equal(outcome.status, "assembled");
  if (outcome.status !== "assembled") return;
  assert.deepEqual(outcome.employee, { id: "web-project-1", scopeId: "group:web-project-1", name: "Support" });
  assert.deepEqual(outcome.skills, [
    { name: "one", ok: true },
    { name: "two", ok: true },
  ]);
  assert.equal(outcome.soul, true);
  assert.equal(outcome.soulError, undefined);
});

test("soul is skipped entirely when the request carries none", async () => {
  const core = stubCore();
  const outcome = await assembleEmployee(core.factory(PRINCIPAL), {
    principalId: PRINCIPAL,
    name: "Support",
    skills: [],
  });
  assert.deepEqual(
    core.calls.map((call) => call.path),
    ["/v1/projects"],
  );
  assert.equal(outcome.status, "assembled");
  if (outcome.status !== "assembled") return;
  assert.equal(outcome.soul, false);
  assert.equal(outcome.soulError, undefined);
});

test("a rejected skill is recorded and the run continues to the next one", async () => {
  const core = stubCore({ skillStatuses: { two: 409 } });
  const outcome = await assembleEmployee(core.factory(PRINCIPAL), {
    principalId: PRINCIPAL,
    name: "Support",
    skills: [skill("one"), skill("two"), skill("three")],
  });

  assert.equal(bodies(core.calls, "/v1/skills").length, 3);
  assert.equal(outcome.status, "assembled");
  if (outcome.status !== "assembled") return;
  assert.deepEqual(outcome.skills, [
    { name: "one", ok: true },
    { name: "two", ok: false, error: "exists" },
    { name: "three", ok: true },
  ]);
});

test("a failed soul leaves the employee valid and reports the reason", async () => {
  const core = stubCore({ soulStatus: 403 });
  const outcome = await assembleEmployee(core.factory(PRINCIPAL), {
    principalId: PRINCIPAL,
    name: "Support",
    skills: [],
    soul: "Be terse.",
  });
  assert.equal(outcome.status, "assembled");
  if (outcome.status !== "assembled") return;
  assert.equal(outcome.soul, false);
  assert.equal(outcome.soulError, "core replied 403");
});

test("a project failure produces no state at all", async () => {
  const unreachableCore = stubCore({ projectUnreachable: true });
  const failed = await assembleEmployee(unreachableCore.factory(PRINCIPAL), {
    principalId: PRINCIPAL,
    name: "Support",
    skills: [skill("one")],
    soul: "Be terse.",
  });
  assert.equal(failed.status, "failed");
  assert.equal(unreachableCore.calls.length, 1);
  if (failed.status !== "failed") return;
  assert.equal(failed.problem.status, 502);

  const forbidden = stubCore({ projectStatus: 403 });
  const refused = await assembleEmployee(forbidden.factory(PRINCIPAL), {
    principalId: PRINCIPAL,
    name: "Support",
    skills: [skill("one")],
  });
  assert.equal(refused.status, "failed");
  assert.equal(forbidden.calls.length, 1);
  if (refused.status !== "failed") return;
  assert.equal(refused.problem.status, 502);
  assert.deepEqual(refused.problem.body.upstream, { status: 403 });
});

test("a project without id or scopeId is treated as an upstream failure", async () => {
  const core = recordingCore(() => ok(201, { project: { id: "web-project-1" } }));
  const outcome = await assembleEmployee(core.factory(PRINCIPAL), {
    principalId: PRINCIPAL,
    name: "Support",
    skills: [skill("one")],
  });
  assert.equal(outcome.status, "failed");
  assert.equal(core.calls.length, 1);
});

test("assemble is not idempotent: every call mints a fresh scope", async () => {
  const core = stubCore();
  const first = await assembleEmployee(core.factory(PRINCIPAL), {
    principalId: PRINCIPAL,
    name: "Support",
    skills: [],
  });
  const second = await assembleEmployee(core.factory(PRINCIPAL), {
    principalId: PRINCIPAL,
    name: "Support",
    skills: [],
  });
  assert.equal(first.status, "assembled");
  assert.equal(second.status, "assembled");
  if (first.status !== "assembled" || second.status !== "assembled") return;
  assert.equal(first.employee.scopeId, "group:web-project-1");
  assert.equal(second.employee.scopeId, "group:web-project-2");
  assert.notEqual(first.employee.id, second.employee.id);
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
  assert.match(problemOf({ name: "ok", skills: {} }), /skills must be an array/);
  assert.match(
    problemOf({ name: "ok", skills: Array.from({ length: MAX_SKILLS + 1 }, (_unused, i) => skill(`s${i}`)) }),
    /at most 20 entries/,
  );
  assert.match(problemOf({ name: "ok", skills: [skill("dup"), skill("dup")] }), /"dup" appears twice/);
  assert.match(problemOf({ name: "ok", skills: [{ description: "d", body: "b" }] }), /name must match/);
  assert.match(problemOf({ name: "ok", skills: [{ name: "Bad", description: "d", body: "b" }] }), /name must match/);
  assert.match(problemOf({ name: "ok", skills: ["nope"] }), /must be an object/);
  assert.match(problemOf({ name: "ok", skills: [{ name: "s", body: "b" }] }), /needs a description/);
  assert.match(
    problemOf({ name: "ok", skills: [{ name: "s", description: "d".repeat(501), body: "b" }] }),
    /needs a description/,
  );
  assert.match(problemOf({ name: "ok", skills: [{ name: "s", description: "d", body: "   " }] }), /needs a body/);
  assert.match(
    problemOf({ name: "ok", skills: [{ name: "s", description: "d", body: "x".repeat(MAX_SKILL_BODY_BYTES + 1) }] }),
    /body exceeds/,
  );
  assert.match(problemOf({ name: "ok", soul: 42 }), /soul must be a string/);
  assert.match(problemOf({ name: "ok", soul: "x".repeat(MAX_SOUL_BYTES + 1) }), /soul exceeds/);
});

test("parseAssembleBody accepts a valid request and drops an empty soul", () => {
  const parsed = parseAssembleBody({ name: " Support ", skills: [skill("one")], soul: "" });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.request, { name: "Support", skills: [skill("one")] });
});

test("AssembleInput carries the derived principal and nothing from the request body", () => {
  const parsed = parseAssembleBody({ name: "Support", principalId: "attacker", skills: [] });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const input: AssembleInput = { principalId: PRINCIPAL, ...parsed.request };
  assert.equal(input.principalId, PRINCIPAL);
  assert.equal("principalId" in parsed.request, false);
});
