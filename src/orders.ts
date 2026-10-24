import { Router } from 'express';
import { pool, transaction } from './db.ts';
import { HttpError, intParam, stringParam } from './http.ts';

export const orders = Router();

class LostRace extends Error {}

const COLUMNS = 'id, user_id, product_id, quantity, total_cents, idempotency_key, created_at';

/**
 * Crea un pedido descontando stock en una transacción (bloquea la fila del producto).
 * Con `idempotency_key`, repetir el pedido devuelve el original con 200 en lugar de duplicarlo.
 */
orders.post('/', async (req, res) => {
  const userId: number = res.locals.userId;
  const productId = intParam(req.body?.product_id, 'product_id', {
    min: 1,
    max: Number.MAX_SAFE_INTEGER,
  });
  const quantity = intParam(req.body?.quantity, 'quantity', { min: 1, max: 100, fallback: 1 });
  const key = stringParam(req.body?.idempotency_key, 'idempotency_key', 100) ?? null;

  const existing = async () => {
    if (!key) return undefined;
    const { rows } = await pool.query(
      `SELECT ${COLUMNS} FROM orders WHERE user_id = $1 AND idempotency_key = $2`,
      [userId, key],
    );
    return rows[0];
  };
  const repeated = await existing();
  if (repeated) {
    res.json(repeated);
    return;
  }

  const result = await transaction(async (client) => {
    const product = await client.query<{ price_cents: number; stock: number }>(
      'SELECT price_cents, stock FROM products WHERE id = $1 FOR UPDATE',
      [productId],
    );
    if (product.rows.length === 0) throw new HttpError(404, 'producto inexistente');
    const { price_cents, stock } = product.rows[0];
    if (stock < quantity) throw new HttpError(409, `stock insuficiente (quedan ${stock})`);
    await client.query('UPDATE products SET stock = stock - $1 WHERE id = $2', [quantity, productId]);
    // Si otro request con la misma clave ganó la carrera, no hay fila: se deshace el descuento.
    const inserted = await client.query(
      `INSERT INTO orders (user_id, product_id, quantity, total_cents, idempotency_key)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, idempotency_key) DO NOTHING RETURNING ${COLUMNS}`,
      [userId, productId, quantity, price_cents * quantity, key],
    );
    if (inserted.rows.length === 0) throw new LostRace();
    return inserted.rows[0];
  }).catch(async (err) => {
    if (err instanceof LostRace) return { repeated: await existing() };
    throw err;
  });
  if ('repeated' in result) res.json(result.repeated);
  else res.status(201).json(result);
});

/** Pedidos del usuario, del más nuevo al más viejo, paginados por cursor (`next_cursor`). */
orders.get('/', async (req, res) => {
  const limit = intParam(req.query.limit, 'limit', { min: 1, max: 100, fallback: 20 });
  const cursor = intParam(req.query.cursor, 'cursor', {
    min: 1,
    max: Number.MAX_SAFE_INTEGER,
    fallback: Number.MAX_SAFE_INTEGER,
  });
  const { rows } = await pool.query(
    `SELECT ${COLUMNS} FROM orders WHERE user_id = $1 AND id < $2 ORDER BY id DESC LIMIT $3`,
    [res.locals.userId, cursor, limit + 1],
  );
  const more = rows.length > limit;
  const items = rows.slice(0, limit);
  res.json({ items, next_cursor: more ? items[items.length - 1].id : null });
});

orders.get('/:id', async (req, res) => {
  const id = intParam(req.params.id, 'id', { min: 1, max: Number.MAX_SAFE_INTEGER });
  const { rows } = await pool.query(
    `SELECT ${COLUMNS} FROM orders WHERE id = $1 AND user_id = $2`,
    [id, res.locals.userId],
  );
  // Un pedido ajeno responde igual que uno inexistente.
  if (rows.length === 0) throw new HttpError(404, 'pedido inexistente');
  res.json(rows[0]);
});
