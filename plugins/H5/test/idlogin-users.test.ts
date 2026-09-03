import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryUserRegistry, createPostgresUserRegistry } from "../src/idlogin/users.ts";

test("memory registry upserts by id and lists everything", async () => {
  const registry = createMemoryUserRegistry();
  await registry.put({ id: "app_u1", name: "甲" });
  await registry.put({ id: "app_u2", name: "乙" });
  await registry.put({ id: "app_u1", name: "丙" });
  assert.deepEqual(await registry.get("app_u1"), { id: "app_u1", name: "丙" });
  assert.equal(await registry.get("missing"), null);
  assert.deepEqual(
    (await registry.list()).sort((a, b) => a.id.localeCompare(b.id)),
    [
      { id: "app_u1", name: "丙" },
      { id: "app_u2", name: "乙" },
    ],
  );
});

test(
  "postgres registry upserts by id and lists everything",
  { skip: process.env.DATABASE_URL ? false : "DATABASE_URL not set" },
  async () => {
    const registry = await createPostgresUserRegistry(process.env.DATABASE_URL!);
    const id = `idlogin_test_${Date.now()}`;
    await registry.put({ id, name: "甲" });
    await registry.put({ id, name: "乙" });
    assert.deepEqual(await registry.get(id), { id, name: "乙" });
    const listed = await registry.list();
    assert.ok(listed.some((u) => u.id === id && u.name === "乙"));
  },
);
