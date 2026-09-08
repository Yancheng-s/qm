import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { createMemoryAssemblyRegistry, createPostgresAssemblyRegistry } from "../src/profiles/assemble-store.ts";

test("memory registry upserts by externalId and library and lists everything", async () => {
  const registry = createMemoryAssemblyRegistry();
  await registry.put({
    externalId: "mini-1",
    library: "xhs",
    projectId: "web-project-1",
    projectScopeId: "group:web-project-1",
    grantedSkillIds: ["s1", "s2"],
    at: 1,
  });
  await registry.put({
    externalId: "mini-1",
    library: "xhs",
    projectId: "web-project-1",
    projectScopeId: "group:web-project-1",
    grantedSkillIds: ["s1", "s2", "s3"],
    at: 2,
  });
  await registry.put({
    externalId: "mini-1",
    library: "ecom",
    projectId: "web-project-2",
    projectScopeId: "group:web-project-2",
    grantedSkillIds: ["s9"],
    at: 3,
  });
  const stored = await registry.get("mini-1", "xhs");
  assert.deepEqual(stored?.grantedSkillIds, ["s1", "s2", "s3"]);
  assert.equal(stored?.at, 2);
  assert.deepEqual((await registry.get("mini-1", "ecom"))?.grantedSkillIds, ["s9"]);
  assert.equal(await registry.get("mini-1", "douyin"), null);
  assert.equal(await registry.get("mini-2", "xhs"), null);
  assert.equal((await registry.list()).length, 2);
});

test(
  "postgres registry upserts by externalId and library and survives round trips",
  { skip: process.env.DATABASE_URL ? false : "DATABASE_URL not set" },
  async () => {
    const registry = await createPostgresAssemblyRegistry(process.env.DATABASE_URL!, "xhs");
    const externalId = `profiles_test_${Date.now()}`;
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL! });
    try {
      await registry.put({
        externalId,
        library: "xhs",
        projectId: "web-project-pg",
        projectScopeId: "group:web-project-pg",
        grantedSkillIds: ["s1"],
        at: 5,
      });
      await registry.put({
        externalId,
        library: "xhs",
        projectId: "web-project-pg",
        projectScopeId: "group:web-project-pg",
        grantedSkillIds: ["s1", "s2"],
        at: 6,
      });
      await registry.put({
        externalId,
        library: "ecom",
        projectId: "web-project-pg-2",
        projectScopeId: "group:web-project-pg-2",
        grantedSkillIds: ["s9"],
        at: 7,
      });
      const stored = await registry.get(externalId, "xhs");
      assert.deepEqual(stored?.grantedSkillIds, ["s1", "s2"]);
      assert.equal(stored?.at, 6);
      assert.equal(stored?.library, "xhs");
      assert.equal((await registry.get(externalId, "ecom"))?.projectId, "web-project-pg-2");
      assert.equal(await registry.get(`${externalId}_missing`, "xhs"), null);
      assert.equal(await registry.get(externalId, "douyin"), null);
    } finally {
      await pool.query("DELETE FROM profiles_assemblies WHERE external_id = $1", [externalId]);
      await pool.end();
    }
  },
);

test(
  "postgres migration is idempotent and leaves library sealed inside the primary key",
  { skip: process.env.DATABASE_URL ? false : "DATABASE_URL not set" },
  async () => {
    const externalId = `profiles_schema_${Date.now()}`;
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL! });
    try {
      const first = await createPostgresAssemblyRegistry(process.env.DATABASE_URL!, "");
      await first.put({
        externalId,
        library: "xhs",
        projectId: "web-project-schema",
        projectScopeId: "group:web-project-schema",
        grantedSkillIds: ["s1"],
        at: 1,
      });
      const second = await createPostgresAssemblyRegistry(process.env.DATABASE_URL!, "ecom");
      assert.deepEqual((await second.get(externalId, "xhs"))?.grantedSkillIds, ["s1"]);

      const column = await pool.query(
        `SELECT is_nullable, column_default FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'profiles_assemblies' AND column_name = 'library'`,
      );
      assert.equal(column.rows[0]?.is_nullable, "NO");
      assert.equal(column.rows[0]?.column_default, null);

      const pkey = await pool.query(
        `SELECT string_agg(kcu.column_name, ',' ORDER BY kcu.ordinal_position) AS columns
           FROM information_schema.table_constraints tc
           JOIN information_schema.key_column_usage kcu
             ON kcu.table_schema = tc.table_schema
            AND kcu.table_name = tc.table_name
            AND kcu.constraint_name = tc.constraint_name
          WHERE tc.table_schema = 'public'
            AND tc.table_name = 'profiles_assemblies'
            AND tc.constraint_type = 'PRIMARY KEY'
          GROUP BY tc.constraint_name`,
      );
      assert.equal(pkey.rows[0]?.columns, "external_id,library");
    } finally {
      await pool.query("DELETE FROM profiles_assemblies WHERE external_id = $1", [externalId]);
      await pool.end();
    }
  },
);

test(
  "postgres migration refuses to guess a library for unattributed rows",
  { skip: process.env.DATABASE_URL ? false : "DATABASE_URL not set" },
  async () => {
    const registry = await createPostgresAssemblyRegistry(process.env.DATABASE_URL!, "xhs");
    const externalId = `profiles_orphan_${Date.now()}`;
    await registry.put({
      externalId,
      library: "xhs",
      projectId: "web-project-orphan",
      projectScopeId: "group:web-project-orphan",
      grantedSkillIds: [],
      at: 1,
    });
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL! });
    try {
      await pool.query("UPDATE profiles_assemblies SET library = '' WHERE external_id = $1", [externalId]);
      await assert.rejects(
        () => createPostgresAssemblyRegistry(process.env.DATABASE_URL!, ""),
        /from the single-library era/,
      );
      const healed = await createPostgresAssemblyRegistry(process.env.DATABASE_URL!, "ecom");
      assert.equal((await healed.get(externalId, "ecom"))?.projectId, "web-project-orphan");
    } finally {
      await pool.query("DELETE FROM profiles_assemblies WHERE external_id = $1", [externalId]);
      await pool.end();
    }
  },
);
