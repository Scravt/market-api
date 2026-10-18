// Datos de prueba: productos generados en SQL y usuarios loadtest-N@example.test.
// Es idempotente: si ya hay productos o usuarios, no los duplica.
import { hashPassword } from './auth.ts';
import { config } from './config.ts';
import { migrate, pool } from './db.ts';

const CATEGORIES = [
  'audio', 'bebidas', 'cocina', 'deportes', 'electrónica', 'herramientas', 'hogar', 'jardín',
  'juguetes', 'libros', 'mascotas', 'música', 'oficina', 'papelería', 'ropa', 'salud',
  'calzado', 'viajes', 'videojuegos', 'vinos',
];
const ADJECTIVES = ['rojo', 'azul', 'verde', 'negro', 'clásico', 'compacto', 'premium', 'liviano', 'pro', 'eco'];
const NOUNS = ['set', 'kit', 'pack', 'modelo', 'edición', 'versión', 'combo', 'serie'];

export async function seed(): Promise<void> {
  const { rows } = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM products');
  if (rows[0].n === 0 && config.seedProducts > 0) {
    const started = Date.now();
    await pool.query(
      `INSERT INTO products (name, description, category, price_cents, stock, created_at)
       SELECT
         initcap(($2::text[])[i % array_length($2::text[], 1) + 1]) || ' '
           || ($3::text[])[(i / 7) % array_length($3::text[], 1) + 1] || ' ' || i,
         'Producto número ' || i || ' de la categoría ' || ($1::text[])[i % array_length($1::text[], 1) + 1],
         ($1::text[])[i % array_length($1::text[], 1) + 1],
         100 + (i * 7919) % 99900,
         1000,
         now() - make_interval(mins => i)
       FROM generate_series(1, $4::int) AS i`,
      [CATEGORIES, NOUNS, ADJECTIVES, config.seedProducts],
    );
    await pool.query('ANALYZE products');
    console.log(`seed: ${config.seedProducts} productos en ${Date.now() - started} ms`);
  }

  if (config.seedUsers > 0) {
    // Un solo hash para todos: con scrypt, 50 hashes distintos tardarían segundos en cada arranque.
    const hash = await hashPassword(config.seedPassword);
    const { rowCount } = await pool.query(
      `INSERT INTO users (email, name, password_hash)
       SELECT 'loadtest-' || i || '@example.test', 'Load Test ' || i, $1
       FROM generate_series(1, $2::int) AS i
       ON CONFLICT (email) DO NOTHING`,
      [hash, config.seedUsers],
    );
    if (rowCount) console.log(`seed: ${rowCount} usuarios loadtest-N@example.test`);
  }
}

if (import.meta.main) {
  await migrate();
  await seed();
  await pool.end();
}
