import type { Request, RequestHandler, Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { config } from './config.ts';

const noLimit: RequestHandler = (_req, _res, next) => next();

/**
 * Ventana fija de un minuto, en memoria (una sola instancia). Al pasarse responde 429 con
 * `Retry-After` y los headers `RateLimit` / `RateLimit-Policy` (borrador 8 de la IETF).
 */
function perMinute(
  limit: number,
  name: string,
  key?: (req: Request, res: Response) => string,
): RequestHandler {
  if (limit === 0) return noLimit;
  return rateLimit({
    windowMs: 60_000,
    limit,
    identifier: name,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    ...(key && { keyGenerator: key }),
    handler: (_req, res, _next, options) => {
      res.status(options.statusCode).json({
        error: `demasiados requests: el límite es ${limit} por minuto (${name})`,
      });
    },
  });
}

/** Login y registro: por IP, para frenar fuerza bruta. */
export const authLimit = perMinute(config.authRateLimitPerMinute, 'auth');

/** El resto de la API autenticada: por usuario. Va después de `requireAuth`. */
export const userLimit = perMinute(config.rateLimitPerMinute, 'user', (_req, res) => `user:${res.locals.userId}`);
