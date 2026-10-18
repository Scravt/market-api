import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { config } from './config.ts';
import { pool } from './db.ts';
import { HttpError, intParam } from './http.ts';

await mkdir(config.uploadDir, { recursive: true });

// Cada archivo se guarda en disco con un UUID como nombre; el original queda en la base.
const upload = multer({
  storage: multer.diskStorage({
    destination: config.uploadDir,
    filename: (_req, _file, done) => done(null, randomUUID()),
  }),
  limits: { fileSize: config.maxUploadBytes, files: 1, fields: 10 },
}).single('file');

/** Corre multer y traduce sus errores a respuestas HTTP. */
function receive(req: Request, res: Response, next: NextFunction): void {
  upload(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError) {
      const tooLarge = err.code === 'LIMIT_FILE_SIZE';
      const mb = config.maxUploadBytes / 1024 / 1024;
      next(new HttpError(tooLarge ? 413 : 400, tooLarge ? `el archivo supera ${mb} MB` : err.message));
      return;
    }
    next(err);
  });
}

async function sha256Of(file: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

const COLUMNS = 'id, filename, content_type, size_bytes, sha256, created_at';

export const files = Router();

files.post('/', receive, async (req, res) => {
  const file = req.file;
  if (!file) throw new HttpError(400, 'falta el archivo (campo multipart `file`)');
  try {
    const { rows } = await pool.query(
      `INSERT INTO files (id, user_id, filename, content_type, size_bytes, sha256)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${COLUMNS}`,
      [
        file.filename,
        res.locals.userId,
        file.originalname,
        file.mimetype,
        file.size,
        await sha256Of(file.path),
      ],
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    await unlink(file.path).catch(() => {});
    throw err;
  }
});

files.get('/', async (req, res) => {
  const limit = intParam(req.query.limit, 'limit', { min: 1, max: 100, fallback: 20 });
  const { rows } = await pool.query(
    `SELECT ${COLUMNS} FROM files WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`,
    [res.locals.userId, limit],
  );
  res.json({ items: rows });
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function own(req: Request, res: Response) {
  const id = String(req.params.id);
  if (!UUID.test(id)) throw new HttpError(404, 'archivo inexistente');
  const { rows } = await pool.query(`SELECT ${COLUMNS} FROM files WHERE id = $1 AND user_id = $2`, [
    id,
    res.locals.userId,
  ]);
  if (rows.length === 0) throw new HttpError(404, 'archivo inexistente');
  return rows[0];
}

files.get('/:id', async (req, res) => {
  res.json(await own(req, res));
});

files.get('/:id/content', async (req, res) => {
  const meta = await own(req, res);
  res.set('Content-Type', meta.content_type);
  res.attachment(meta.filename);
  res.sendFile(path.resolve(config.uploadDir, meta.id));
});

files.delete('/:id', async (req, res) => {
  const meta = await own(req, res);
  await pool.query('DELETE FROM files WHERE id = $1', [meta.id]);
  await unlink(path.resolve(config.uploadDir, meta.id)).catch(() => {});
  res.status(204).end();
});
