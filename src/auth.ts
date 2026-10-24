import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { errors as joseErrors, jwtVerify, SignJWT } from 'jose';
import { config } from './config.ts';
import { pool, transaction } from './db.ts';
import { HttpError, stringParam } from './http.ts';

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;
const secret = new TextEncoder().encode(config.jwtSecret);
const KEY_LENGTH = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, KEY_LENGTH);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [, salt, hash] = stored.split('$');
  const expected = Buffer.from(hash, 'hex');
  const actual = await scryptAsync(password, Buffer.from(salt, 'hex'), expected.length);
  return timingSafeEqual(actual, expected);
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** Access token (JWT corto) + refresh token (opaco, se guarda solo su hash). */
async function issueTokens(userId: number, db: { query: typeof pool.query } = pool) {
  const accessToken = await new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(String(userId))
    .setIssuedAt()
    .setExpirationTime(`${config.accessTtlSeconds}s`)
    .sign(secret);
  const refreshToken = randomBytes(32).toString('base64url');
  await db.query(
    `INSERT INTO refresh_tokens (token_hash, user_id, expires_at)
     VALUES ($1, $2, now() + make_interval(secs => $3))`,
    [sha256(refreshToken), userId, config.refreshTtlSeconds],
  );
  return {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: config.accessTtlSeconds,
    refresh_token: refreshToken,
  };
}

function credentials(body: unknown): { email: string; password: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const email = stringParam(b.email, 'email')?.trim().toLowerCase();
  const password = stringParam(b.password, 'password');
  if (!email || !password) throw new HttpError(400, 'faltan `email` y `password`');
  return { email, password };
}

export const auth = Router();

auth.post('/register', async (req, res) => {
  const { email, password } = credentials(req.body);
  const name = stringParam(req.body?.name, 'name') ?? email.split('@')[0];
  if (password.length < 8) throw new HttpError(400, 'la contraseña necesita al menos 8 caracteres');
  const hash = await hashPassword(password);
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3)
     ON CONFLICT (email) DO NOTHING RETURNING id`,
    [email, name, hash],
  );
  if (rows.length === 0) throw new HttpError(409, 'ya existe un usuario con ese email');
  res.status(201).json({ id: rows[0].id, email, name, ...(await issueTokens(rows[0].id)) });
});

auth.post('/login', async (req, res) => {
  const { email, password } = credentials(req.body);
  const { rows } = await pool.query<{ id: number; password_hash: string }>(
    'SELECT id, password_hash FROM users WHERE email = $1',
    [email],
  );
  if (rows.length === 0 || !(await verifyPassword(password, rows[0].password_hash))) {
    throw new HttpError(401, 'email o contraseña incorrectos');
  }
  res.json({ user_id: rows[0].id, ...(await issueTokens(rows[0].id)) });
});

/** Rota el refresh token: el usado queda revocado y se emite un par nuevo. */
auth.post('/refresh', async (req, res) => {
  const token = stringParam(req.body?.refresh_token, 'refresh_token', 100);
  if (!token) throw new HttpError(400, 'falta `refresh_token`');
  const tokens = await transaction(async (client) => {
    const { rows } = await client.query<{ user_id: number }>(
      `UPDATE refresh_tokens SET revoked_at = now()
       WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()
       RETURNING user_id`,
      [sha256(token)],
    );
    if (rows.length === 0) throw new HttpError(401, 'refresh token inválido, vencido o ya usado');
    return issueTokens(rows[0].user_id, client);
  });
  res.json(tokens);
});

/** Exige `Authorization: Bearer <jwt>` válido y deja el id en `res.locals.userId`. */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.get('authorization') ?? '';
  const [scheme, token] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    throw new HttpError(401, 'falta el token (Authorization: Bearer …)', {
      'WWW-Authenticate': 'Bearer',
    });
  }
  try {
    const { payload } = await jwtVerify(token, secret, { algorithms: ['HS256'] });
    res.locals.userId = Number(payload.sub);
  } catch (err) {
    const expired = err instanceof joseErrors.JWTExpired;
    throw new HttpError(401, expired ? 'token vencido' : 'token inválido', {
      'WWW-Authenticate': `Bearer error="invalid_token", error_description="${expired ? 'expired' : 'invalid'}"`,
    });
  }
  next();
}

export const me = Router();

me.get('/', async (_req, res) => {
  const { rows } = await pool.query(
    'SELECT id, email, name, created_at FROM users WHERE id = $1',
    [res.locals.userId],
  );
  if (rows.length === 0) throw new HttpError(404, 'el usuario ya no existe');
  res.json(rows[0]);
});
