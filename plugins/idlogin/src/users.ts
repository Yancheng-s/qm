import pg from "pg";

export interface IdLoginUser {
  id: string;
  name: string;
}

export interface UserRegistry {
  put(user: IdLoginUser): Promise<void>;
  get(id: string): Promise<IdLoginUser | null>;
  list(): Promise<IdLoginUser[]>;
}

export function createMemoryUserRegistry(): UserRegistry {
  const users = new Map<string, string>();
  return {
    async put(user) {
      users.set(user.id, user.name);
    },
    async get(id) {
      const name = users.get(id);
      return name === undefined ? null : { id, name };
    },
    async list() {
      return [...users].map(([id, name]) => ({ id, name }));
    },
  };
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS idlogin_users(
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    updated_at BIGINT NOT NULL
  )`,
];

export async function createPostgresUserRegistry(connectionString: string): Promise<UserRegistry> {
  const pool = new pg.Pool({ connectionString });
  for (const stmt of SCHEMA) await pool.query(stmt);
  return {
    async put(user) {
      await pool.query(
        `INSERT INTO idlogin_users (id, name, updated_at) VALUES ($1, $2, $3)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, updated_at = EXCLUDED.updated_at`,
        [user.id, user.name, Date.now()],
      );
    },
    async get(id) {
      const result = await pool.query("SELECT id, name FROM idlogin_users WHERE id = $1", [id]);
      const row = result.rows[0] as { id: string; name: string } | undefined;
      return row ? { id: row.id, name: row.name } : null;
    },
    async list() {
      const result = await pool.query("SELECT id, name FROM idlogin_users ORDER BY updated_at");
      return result.rows.map((row: { id: string; name: string }) => ({ id: row.id, name: row.name }));
    },
  };
}
