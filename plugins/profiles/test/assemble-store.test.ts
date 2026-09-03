import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryAssemblyRegistry, createPostgresAssemblyRegistry } from "../src/assemble-store.ts";

test("memory registry upserts by externalId and lists everything", async () => {
  const registry = createMemoryAssemblyRegistry();
  await registry.put({
    externalId: "mini-1",
    projectId: "web-project-1",
    projectScopeId: "group:web-project-1",
    grantedSkillIds: ["s1", "s2"],
    at: 1,
  });
  await registry.put({
    externalId: "mini-1",
    projectId: "web-project-1",
    projectScopeId: "group:web-project-1",
    grantedSkillIds: ["s1", "s2", "s3"],
    at: 2,
  });
  const stored = await registry.get("mini-1");
  assert.deepEqual(stored?.grantedSkillIds, ["s1", "s2", "s3"]);
  assert.equal(stored?.at, 2);
  assert.equal(await registry.get("mini-2"), null);
  assert.equal((await registry.list()).length, 1);
});

test(
  "postgres registry upserts by externalId and survives round trips",
  { skip: process.env.DATABASE_URL ? false : "DATABASE_URL not set" },
  async () => {
    const registry = await createPostgresAssemblyRegistry(process.env.DATABASE_URL!);
    const externalId = `profiles_test_${Date.now()}`;
    await registry.put({
      externalId,
      projectId: "web-project-pg",
      projectScopeId: "group:web-project-pg",
      grantedSkillIds: ["s1"],
      at: 5,
    });
    await registry.put({
      externalId,
      projectId: "web-project-pg",
      projectScopeId: "group:web-project-pg",
      grantedSkillIds: ["s1", "s2"],
      at: 6,
    });
    const stored = await registry.get(externalId);
    assert.deepEqual(stored?.grantedSkillIds, ["s1", "s2"]);
    assert.equal(stored?.at, 6);
    assert.equal(await registry.get(`${externalId}_missing`), null);
  },
);
