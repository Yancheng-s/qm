import pg from "pg";
import { swallow } from "../../../chassis/src/errors.ts";

interface Assembly {
  externalId: string;
  library: string;
  projectId: string;
  projectScopeId: string;
  grantedSkillIds: string[];
  at: number;
}

export interface AssemblyRegistry {
  get(externalId: string, library: string): Promise<Assembly | null>;
  put(assembly: Assembly): Promise<void>;
  list(): Promise<Assembly[]>;
}

function rowKey(externalId: string, library: string): string {
  return `${library}\u0000${externalId}`;
}

export function createMemoryAssemblyRegistry(): AssemblyRegistry {
  const rows = new Map<string, Assembly>();
  return {
    async get(externalId, library) {
      return rows.get(rowKey(externalId, library)) ?? null;
    },
    async put(assembly) {
      rows.set(rowKey(assembly.externalId, assembly.library), assembly);
    },
    async list() {
      return [...rows.values()];
    },
  };
}

const SCHEMA_LOCK = "qm-h5:profiles-assemblies";

const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS profiles_assemblies(
  external_id TEXT NOT NULL,
  library TEXT NOT NULL,
  project_id TEXT NOT NULL,
  project_scope_id TEXT NOT NULL,
  granted_skill_ids TEXT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (external_id, library)
)`;

const ADD_LIBRARY = "ALTER TABLE profiles_assemblies ADD COLUMN IF NOT EXISTS library TEXT NOT NULL DEFAULT ''";

const ATTRIBUTE_LEGACY = "UPDATE profiles_assemblies SET library = $1 WHERE library = ''";

const UNATTRIBUTED_COUNT = "SELECT count(*)::int AS total FROM profiles_assemblies WHERE library = ''";

const SEAL_LIBRARY = "ALTER TABLE profiles_assemblies ALTER COLUMN library DROP DEFAULT";

const SWAP_PRIMARY_KEY = `DO $do$
DECLARE
  pkey_name text;
  pkey_columns text;
BEGIN
  SELECT tc.constraint_name, string_agg(kcu.column_name, ',' ORDER BY kcu.ordinal_position)
    INTO pkey_name, pkey_columns
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON kcu.table_schema = tc.table_schema
     AND kcu.table_name = tc.table_name
     AND kcu.constraint_name = tc.constraint_name
   WHERE tc.table_schema = 'public' AND tc.table_name = 'profiles_assemblies' AND tc.constraint_type = 'PRIMARY KEY'
   GROUP BY tc.constraint_name;
  IF pkey_columns IS DISTINCT FROM 'external_id,library' THEN
    IF pkey_name IS NOT NULL THEN
      EXECUTE format('ALTER TABLE profiles_assemblies DROP CONSTRAINT %I', pkey_name);
    END IF;
    ALTER TABLE profiles_assemblies ADD PRIMARY KEY (external_id, library);
  END IF;
END $do$;`;

async function migrate(pool: pg.Pool, legacyLibrary: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [SCHEMA_LOCK]);
    await client.query(CREATE_TABLE);
    await client.query(ADD_LIBRARY);
    if (legacyLibrary) await client.query(ATTRIBUTE_LEGACY, [legacyLibrary]);
    const unattributed = ((await client.query(UNATTRIBUTED_COUNT)).rows[0] as { total: number }).total;
    if (unattributed > 0)
      throw new Error(
        `profiles_assemblies holds ${unattributed} row(s) from the single-library era and PROFILES_LIBRARY_SCOPES binds several: set the library column on them by hand`,
      );
    await client.query(SEAL_LIBRARY);
    await client.query(SWAP_PRIMARY_KEY);
  } finally {
    client.release(true);
  }
}

interface AssemblyRow {
  external_id: string;
  library: string;
  project_id: string;
  project_scope_id: string;
  granted_skill_ids: string;
  updated_at: number;
}

function fromRow(row: AssemblyRow): Assembly {
  let grantedSkillIds: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.granted_skill_ids);
    if (Array.isArray(parsed)) grantedSkillIds = parsed.filter((id): id is string => typeof id === "string");
  } catch {
    grantedSkillIds = [];
  }
  return {
    externalId: row.external_id,
    library: row.library,
    projectId: row.project_id,
    projectScopeId: row.project_scope_id,
    grantedSkillIds,
    at: Number(row.updated_at),
  };
}

export async function createPostgresAssemblyRegistry(
  connectionString: string,
  legacyLibrary: string,
): Promise<AssemblyRegistry> {
  const pool = new pg.Pool({ connectionString });
  try {
    await migrate(pool, legacyLibrary);
  } catch (e) {
    await pool.end().catch((closeError: unknown) => swallow("h5: assembly pool close", closeError));
    throw e;
  }
  return {
    async get(externalId, library) {
      const result = await pool.query("SELECT * FROM profiles_assemblies WHERE external_id = $1 AND library = $2", [
        externalId,
        library,
      ]);
      const row = result.rows[0] as AssemblyRow | undefined;
      return row ? fromRow(row) : null;
    },
    async put(assembly) {
      await pool.query(
        `INSERT INTO profiles_assemblies (external_id, library, project_id, project_scope_id, granted_skill_ids, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (external_id, library) DO UPDATE SET
           project_id = EXCLUDED.project_id,
           project_scope_id = EXCLUDED.project_scope_id,
           granted_skill_ids = EXCLUDED.granted_skill_ids,
           updated_at = EXCLUDED.updated_at`,
        [
          assembly.externalId,
          assembly.library,
          assembly.projectId,
          assembly.projectScopeId,
          JSON.stringify(assembly.grantedSkillIds),
          assembly.at,
        ],
      );
    },
    async list() {
      const result = await pool.query("SELECT * FROM profiles_assemblies ORDER BY updated_at");
      return result.rows.map((row: AssemblyRow) => fromRow(row));
    },
  };
}
