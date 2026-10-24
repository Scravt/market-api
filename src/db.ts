import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { config } from './config.ts';

// BIGINT y NUMERIC llegan como texto por defecto; los ids y montos de esta API entran en un number.
pg.types.setTypeParser(pg.types.builtins.INT8, Number);

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: config.poolMax,
});

pool.on('error', (err) => {
  console.error('error en una conexión ociosa de Postgres:', err.message);
});

/** Corre en una transacción; si `fn` falla, hace rollback. */
export async function transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

const MIGRATIONS = new URL('./migrations/', import.meta.url);

/** Aplica en orden los `.sql` de `migrations/` que falten. Un lock evita que dos instancias choquen. */
export async function migrate(): Promise<void> {
  await transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(4242)');
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())',
    );
    const { rows } = await client.query<{ name: string }>('SELECT name FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.name));
    const files = (await readdir(MIGRATIONS)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      await client.query(await readFile(new URL(file, MIGRATIONS), 'utf8'));
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      console.log(`migración aplicada: ${file}`);
    }
  });
}
