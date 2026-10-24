import express from 'express';
import { auth, me, requireAuth } from './auth.ts';
import { config } from './config.ts';
import { pool } from './db.ts';
import { files } from './files.ts';
import { errorHandler } from './http.ts';
import { authLimit, userLimit } from './limits.ts';
import { orders } from './orders.ts';
import { products } from './products.ts';

export const app = express();
app.disable('x-powered-by');
app.set('trust proxy', config.trustProxy ? 1 : false);
app.use(express.json({ limit: '100kb' }));

app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok' });
  } catch {
    res.status(503).json({ status: 'sin base de datos' });
  }
});

// Contra fuerza bruta: login y registro. El refresh token no se puede adivinar.
app.use(['/auth/login', '/auth/register'], authLimit);
app.use('/auth', auth);
app.use('/products', products);
app.use('/me', requireAuth, userLimit, me);
app.use('/orders', requireAuth, userLimit, orders);
app.use('/files', requireAuth, userLimit, files);

app.use((_req, res) => {
  res.status(404).json({ error: 'ruta inexistente' });
});
app.use(errorHandler);
