// Tests de integración contra un Postgres real (por defecto la base `market_test` del compose).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://market:market@127.0.0.1:5434/market_test';
process.env.JWT_SECRET = 'secreto-de-test';
process.env.ACCESS_TTL_SECONDS = '2';
process.env.RATE_LIMIT_PER_MINUTE = '40';
process.env.AUTH_RATE_LIMIT_PER_MINUTE = '0';
process.env.MAX_UPLOAD_MB = '1';
process.env.SEED_PRODUCTS = '500';
process.env.SEED_USERS = '0';
process.env.UPLOAD_DIR = await mkdtemp(path.join(tmpdir(), 'market-uploads-'));

const { app } = await import('../src/app.ts');
const { migrate, pool } = await import('../src/db.ts');
const { seed } = await import('../src/seed.ts');

let base = '';
let server: ReturnType<typeof app.listen>;

before(async () => {
  await migrate();
  await seed();
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.close();
  await pool.end();
});

type Json = Record<string, any>;

async function call(method: string, url: string, { token, json, body }: { token?: string; json?: unknown; body?: FormData } = {}) {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (json !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(base + url, {
    method,
    headers,
    body: json !== undefined ? JSON.stringify(json) : body,
  });
  const text = await res.text();
  const data: Json = text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : { text };
  return { status: res.status, headers: res.headers, data };
}

/** Usuario nuevo por test, así ninguno depende de otro (ni comparten el rate limit). */
async function user() {
  const email = `u-${crypto.randomUUID()}@example.test`;
  const r = await call('POST', '/auth/register', { json: { email, password: 'contraseña-larga' } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return { email, id: r.data.id as number, token: r.data.access_token as string, refresh: r.data.refresh_token as string };
}

test('health responde con la base conectada', async () => {
  const r = await call('GET', '/health');
  assert.equal(r.status, 200);
  assert.equal(r.data.status, 'ok');
});

describe('auth', () => {
  test('registro, login y /me', async () => {
    const u = await user();
    const login = await call('POST', '/auth/login', { json: { email: u.email.toUpperCase(), password: 'contraseña-larga' } });
    assert.equal(login.status, 200);
    assert.equal(login.data.user_id, u.id);
    assert.equal(login.data.expires_in, 2);
    const me = await call('GET', '/me', { token: login.data.access_token });
    assert.equal(me.data.email, u.email);
  });

  test('credenciales malas y email repetido', async () => {
    const u = await user();
    const bad = await call('POST', '/auth/login', { json: { email: u.email, password: 'otra-cosa' } });
    assert.equal(bad.status, 401);
    const again = await call('POST', '/auth/register', { json: { email: u.email, password: 'contraseña-larga' } });
    assert.equal(again.status, 409);
    const short = await call('POST', '/auth/register', { json: { email: 'x@y.z', password: 'corta' } });
    assert.equal(short.status, 400);
  });

  test('sin token o con token roto: 401 con WWW-Authenticate', async () => {
    const none = await call('GET', '/orders');
    assert.equal(none.status, 401);
    assert.match(none.headers.get('www-authenticate') ?? '', /^Bearer/);
    const broken = await call('GET', '/orders', { token: 'no.es.jwt' });
    assert.equal(broken.data.error, 'token inválido');
  });

  test('el access token vence y el refresh lo renueva una sola vez', async () => {
    const u = await user();
    await new Promise((r) => setTimeout(r, 2100));
    const expired = await call('GET', '/me', { token: u.token });
    assert.equal(expired.status, 401);
    assert.equal(expired.data.error, 'token vencido');
    assert.match(expired.headers.get('www-authenticate') ?? '', /error_description="expired"/);

    const renewed = await call('POST', '/auth/refresh', { json: { refresh_token: u.refresh } });
    assert.equal(renewed.status, 200);
    assert.notEqual(renewed.data.refresh_token, u.refresh);
    assert.equal((await call('GET', '/me', { token: renewed.data.access_token })).status, 200);

    const reused = await call('POST', '/auth/refresh', { json: { refresh_token: u.refresh } });
    assert.equal(reused.status, 401);
  });
});

describe('productos', () => {
  test('paginación, filtros y orden', async () => {
    const page = await call('GET', '/products?limit=5&page=2&sort=price');
    assert.equal(page.status, 200);
    assert.equal(page.data.items.length, 5);
    assert.equal(page.data.total, 500);
    const prices = page.data.items.map((p: Json) => p.price_cents);
    assert.deepEqual(prices, [...prices].sort((a, b) => a - b));

    const filtered = await call('GET', '/products?category=libros&min_price=1000&q=premium');
    for (const p of filtered.data.items) {
      assert.equal(p.category, 'libros');
      assert.ok(p.price_cents >= 1000);
      assert.match(p.name, /premium/i);
    }
  });

  test('búsqueda escapa comodines de LIKE', async () => {
    const r = await call('GET', '/products?q=%25');
    assert.equal(r.data.total, 0);
  });

  test('parámetros inválidos e inexistentes', async () => {
    assert.equal((await call('GET', '/products?sort=nada')).status, 400);
    assert.equal((await call('GET', '/products?limit=500')).status, 400);
    assert.equal((await call('GET', '/products/abc')).status, 400);
    assert.equal((await call('GET', '/products/999999')).status, 404);
    const cats = await call('GET', '/products/categories');
    assert.equal(cats.data.length, 20);
  });
});

describe('pedidos', () => {
  test('crear, idempotencia y pedidos ajenos', async () => {
    const u = await user();
    const order = { product_id: 7, quantity: 2, idempotency_key: 'k-1' };
    const first = await call('POST', '/orders', { token: u.token, json: order });
    assert.equal(first.status, 201);
    assert.equal(first.data.user_id, u.id);
    const repeated = await call('POST', '/orders', { token: u.token, json: order });
    assert.equal(repeated.status, 200);
    assert.equal(repeated.data.id, first.data.id);

    const mine = await call('GET', `/orders/${first.data.id}`, { token: u.token });
    assert.equal(mine.status, 200);
    const other = await user();
    assert.equal((await call('GET', `/orders/${first.data.id}`, { token: other.token })).status, 404);
  });

  test('la misma clave en paralelo crea un solo pedido', async () => {
    const u = await user();
    const before = (await pool.query('SELECT stock FROM products WHERE id = 3')).rows[0].stock;
    const order = { product_id: 3, idempotency_key: 'carrera' };
    const all = await Promise.all(
      Array.from({ length: 10 }, () => call('POST', '/orders', { token: u.token, json: order })),
    );
    const statuses = all.map((r) => r.status).sort();
    assert.deepEqual(statuses, [200, 200, 200, 200, 200, 200, 200, 200, 200, 201]);
    assert.equal(new Set(all.map((r) => r.data.id)).size, 1);
    const after = (await pool.query('SELECT stock FROM products WHERE id = 3')).rows[0].stock;
    assert.equal(after, before - 1);
  });

  test('stock insuficiente y producto inexistente', async () => {
    const u = await user();
    await pool.query('UPDATE products SET stock = 1 WHERE id = 9');
    assert.equal((await call('POST', '/orders', { token: u.token, json: { product_id: 9, quantity: 2 } })).status, 409);
    assert.equal((await call('POST', '/orders', { token: u.token, json: { product_id: 999999 } })).status, 404);
    assert.equal((await call('POST', '/orders', { token: u.token, json: {} })).status, 400);
  });

  test('paginación por cursor sin repetir ni saltear', async () => {
    const u = await user();
    const created: number[] = [];
    for (let i = 0; i < 5; i++) {
      created.push((await call('POST', '/orders', { token: u.token, json: { product_id: 1 + i } })).data.id);
    }
    const seen: number[] = [];
    let cursor = '';
    do {
      const r = await call('GET', `/orders?limit=2${cursor}`, { token: u.token });
      seen.push(...r.data.items.map((o: Json) => o.id));
      cursor = r.data.next_cursor ? `&cursor=${r.data.next_cursor}` : '';
    } while (cursor);
    assert.deepEqual(seen, created.reverse());
  });
});

test('rate limit por usuario: 429 con Retry-After', async () => {
  const u = await user();
  const statuses: number[] = [];
  let limited;
  for (let i = 0; i < 41; i++) {
    const r = await call('GET', '/me', { token: u.token });
    statuses.push(r.status);
    if (r.status === 429) limited = r;
  }
  assert.deepEqual(statuses.slice(0, 40), Array(40).fill(200));
  assert.ok(limited, 'el request 41 tendría que dar 429');
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  assert.match(limited.headers.get('ratelimit-policy') ?? '', /q=40/);
  // Otro usuario no se ve afectado.
  assert.equal((await call('GET', '/me', { token: (await user()).token })).status, 200);
});

describe('archivos', () => {
  test('subir, listar, bajar y borrar', async () => {
    const u = await user();
    const content = Buffer.from('id,nombre\n1,ana\n');
    const form = new FormData();
    form.append('file', new Blob([content], { type: 'text/csv' }), 'datos.csv');
    const up = await call('POST', '/files', { token: u.token, body: form });
    assert.equal(up.status, 201, JSON.stringify(up.data));
    assert.equal(up.data.filename, 'datos.csv');
    assert.equal(up.data.size_bytes, content.length);
    assert.equal(up.data.sha256, createHash('sha256').update(content).digest('hex'));

    const list = await call('GET', '/files', { token: u.token });
    assert.deepEqual(list.data.items.map((f: Json) => f.id), [up.data.id]);
    const down = await call('GET', `/files/${up.data.id}/content`, { token: u.token });
    assert.equal(down.data.text, content.toString());
    assert.match(down.headers.get('content-disposition') ?? '', /datos\.csv/);

    const other = await user();
    assert.equal((await call('GET', `/files/${up.data.id}`, { token: other.token })).status, 404);
    assert.equal((await call('DELETE', `/files/${up.data.id}`, { token: u.token })).status, 204);
    assert.equal((await call('GET', `/files/${up.data.id}`, { token: u.token })).status, 404);
  });

  test('archivo demasiado grande: 413; sin archivo: 400', async () => {
    const u = await user();
    const form = new FormData();
    form.append('file', new Blob([Buffer.alloc(1024 * 1024 + 1)]), 'grande.bin');
    const big = await call('POST', '/files', { token: u.token, body: form });
    assert.equal(big.status, 413);
    assert.equal((await call('POST', '/files', { token: u.token, body: new FormData() })).status, 400);
  });
});
