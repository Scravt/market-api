import { Router } from 'express';
import { pool } from './db.ts';
import { HttpError, intParam, stringParam } from './http.ts';

export const products = Router();

const SORTS: Record<string, string> = {
  newest: 'created_at DESC, id DESC',
  price: 'price_cents ASC, id ASC',
  '-price': 'price_cents DESC, id DESC',
  name: 'name ASC, id ASC',
};

/**
 * Listado con filtros y paginación por página (`page`, `limit`), con `total`.
 * `q` busca con ILIKE en nombre y descripción, con índices de trigramas (migración 002).
 */
products.get('/', async (req, res) => {
  const page = intParam(req.query.page, 'page', { min: 1, max: 100_000, fallback: 1 });
  const limit = intParam(req.query.limit, 'limit', { min: 1, max: 100, fallback: 20 });
  const sort = stringParam(req.query.sort, 'sort') ?? 'newest';
  if (!(sort in SORTS)) {
    throw new HttpError(400, `\`sort\` tiene que ser uno de: ${Object.keys(SORTS).join(', ')}`);
  }

  const where: string[] = [];
  const params: unknown[] = [];
  const q = stringParam(req.query.q, 'q', 100);
  if (q) {
    params.push(`%${q.replace(/[\\%_]/g, '\\$&')}%`);
    where.push(`(name ILIKE $${params.length} OR description ILIKE $${params.length})`);
  }
  const category = stringParam(req.query.category, 'category', 50);
  if (category) {
    params.push(category);
    where.push(`category = $${params.length}`);
  }
  for (const [key, op] of [['min_price', '>='], ['max_price', '<=']] as const) {
    if (req.query[key] !== undefined) {
      params.push(intParam(req.query[key], key, { min: 0, max: 10_000_000 }));
      where.push(`price_cents ${op} $${params.length}`);
    }
  }
  const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const [items, count] = await Promise.all([
    pool.query(
      `SELECT id, name, category, price_cents, stock, created_at FROM products ${filter}
       ORDER BY ${SORTS[sort]} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, (page - 1) * limit],
    ),
    pool.query<{ total: number }>(`SELECT count(*)::int AS total FROM products ${filter}`, params),
  ]);
  res.json({ items: items.rows, page, limit, total: count.rows[0].total });
});

products.get('/categories', async (_req, res) => {
  const { rows } = await pool.query(
    'SELECT category, count(*)::int AS products FROM products GROUP BY category ORDER BY category',
  );
  res.json(rows);
});

products.get('/:id', async (req, res) => {
  const id = intParam(req.params.id, 'id', { min: 1, max: Number.MAX_SAFE_INTEGER });
  const { rows } = await pool.query('SELECT * FROM products WHERE id = $1', [id]);
  if (rows.length === 0) throw new HttpError(404, 'producto inexistente');
  res.json(rows[0]);
});
