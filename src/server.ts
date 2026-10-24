import { app } from './app.ts';
import { config } from './config.ts';
import { migrate, pool } from './db.ts';
import { seed } from './seed.ts';

await migrate();
if (process.env.SEED === 'true') await seed();

const server = app.listen(config.port, config.host, () => {
  console.log(`market-api en http://${config.host}:${config.port}`);
});
// Más que el keep-alive de un proxy típico (60 s), para que no corte conexiones que el proxy reusa.
server.keepAliveTimeout = 65_000;

// Docker manda SIGTERM: se dejan de aceptar conexiones, terminan las que están y se cierra el pool.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    console.log(`${signal}: cerrando`);
    server.close(() => void pool.end().then(() => process.exit(0)));
    server.closeIdleConnections();
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
