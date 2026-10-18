// Configuración por variables de entorno. Todo tiene un valor por defecto salvo el secreto del JWT.

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} tiene que ser un entero ≥ 0 (vale \`${raw}\`)`);
  }
  return value;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`falta la variable de entorno ${name}`);
  return value;
}

export const config = {
  host: process.env.HOST ?? '127.0.0.1',
  port: int('PORT', 8080),
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://market:market@127.0.0.1:5434/market',
  poolMax: int('PG_POOL_MAX', 10),
  /** Detrás de un proxy (Caddy) hay que confiar en X-Forwarded-For para limitar por IP. */
  trustProxy: process.env.TRUST_PROXY === 'true',

  jwtSecret: required('JWT_SECRET'),
  accessTtlSeconds: int('ACCESS_TTL_SECONDS', 300),
  refreshTtlSeconds: int('REFRESH_TTL_SECONDS', 7 * 24 * 3600),

  /** Requests por minuto por usuario autenticado (0 = sin límite). */
  rateLimitPerMinute: int('RATE_LIMIT_PER_MINUTE', 600),
  /** Intentos de login y registro por minuto por IP (0 = sin límite). */
  authRateLimitPerMinute: int('AUTH_RATE_LIMIT_PER_MINUTE', 30),

  uploadDir: process.env.UPLOAD_DIR ?? 'uploads',
  maxUploadBytes: int('MAX_UPLOAD_MB', 10) * 1024 * 1024,

  seedProducts: int('SEED_PRODUCTS', 100_000),
  seedUsers: int('SEED_USERS', 50),
  seedPassword: process.env.SEED_PASSWORD ?? 'loadtest',
};
