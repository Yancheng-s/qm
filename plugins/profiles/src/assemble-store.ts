import pg from "pg";

export interface Assembly {
  externalId: string;
  projectId: string;
  projectScopeId: string;
  grantedSkillIds: string[];
  at: number;
}

export interface AssemblyRegistry {
  get(externalId: string): Promise<Assembly | null>;
  put(assembly: Assembly): Promise<void>;
  list(): Promise<Assembly[]>;
}

export function createMemoryAssemblyRegistry(): AssemblyRegistry {
  const rows = new Map<string, Assembly>();
  return {
    async get(externalId) {
      return rows.get(externalId) ?? null;
    },
    async put(assembly) {
      rows.set(assembly.externalId, assembly);
    },
    async list() {
      return [...rows.values()];
    },
  };
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS profiles_assemblies(
    external_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    project_scope_id TEXT NOT NULL,
    granted_skill_ids TEXT NOT NULL,
    updated_at BIGINT NOT NULL
  )`,
];

interface AssemblyRow {
  external_id: string;
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
    projectId: row.project_id,
    projectScopeId: row.project_scope_id,
    grantedSkillIds,
    at: Number(row.updated_at),
  };
}

export async function createPostgresAssemblyRegistry(connectionString: string): Promise<AssemblyRegistry> {
  const pool = new pg.Pool({ connectionString });
  for (const stmt of SCHEMA) await pool.query(stmt);
  return {
    async get(externalId) {
      const result = await pool.query("SELECT * FROM profiles_assemblies WHERE external_id = $1", [externalId]);
      const row = result.rows[0] as AssemblyRow | undefined;
      return row ? fromRow(row) : null;
    },
    async put(assembly) {
      await pool.query(
        `INSERT INTO profiles_assemblies (external_id, project_id, project_scope_id, granted_skill_ids, updated_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (external_id) DO UPDATE SET
           project_id = EXCLUDED.project_id,
           project_scope_id = EXCLUDED.project_scope_id,
           granted_skill_ids = EXCLUDED.granted_skill_ids,
           updated_at = EXCLUDED.updated_at`,
        [
          assembly.externalId,
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
