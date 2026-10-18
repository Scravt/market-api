import type { NextFunction, Request, Response } from 'express';

/** Error con status HTTP: el manejador de errores lo devuelve como `{ error }`. */
export class HttpError extends Error {
  status: number;
  headers: Record<string, string>;

  constructor(status: number, message: string, headers: Record<string, string> = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

export function errorHandler(
  err: Error & { status?: number; type?: string; code?: string },
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof HttpError) {
    res.set(err.headers).status(err.status).json({ error: err.message });
    return;
  }
  if (err.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'JSON inválido' });
    return;
  }
  if (err.type === 'entity.too.large') {
    res.status(413).json({ error: 'body demasiado grande' });
    return;
  }
  console.error(err);
  res.status(500).json({ error: 'error interno' });
}

/** Entero de la query o del body, con rango. Sin valor devuelve `fallback`. */
export function intParam(
  value: unknown,
  name: string,
  { min, max, fallback }: { min: number; max: number; fallback?: number },
): number {
  if (value === undefined || value === '') {
    if (fallback === undefined) throw new HttpError(400, `falta \`${name}\``);
    return fallback;
  }
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new HttpError(400, `\`${name}\` tiene que ser un entero entre ${min} y ${max}`);
  }
  return n;
}

export function stringParam(value: unknown, name: string, maxLength = 200): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || value.length > maxLength) {
    throw new HttpError(400, `\`${name}\` tiene que ser texto de hasta ${maxLength} caracteres`);
  }
  return value;
}
