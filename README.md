# market-api

Tienda de ejemplo con lo que tiene una API real: Postgres, login con JWT que vence y refresh tokens, rate limiting, paginación y búsqueda sobre 100k productos, pedidos transaccionales con idempotencia y subida de archivos. Sirve para probar [lt](../load-test) contra algo que se puede subir a un servidor, con TLS.

A diferencia de `shop-api`, acá no hay problemas plantados: lo que aparezca bajo carga es lo que tendría una API escrita así de verdad. La sección [Bajo carga](#bajo-carga) dice dónde mirar.

## Correrla

Con Docker (en esta máquina, Docker está en WSL):

```bash
cp .env.example .env            # y poné un JWT_SECRET largo
docker compose up -d --build    # API en http://127.0.0.1:8080, Postgres en 127.0.0.1:5434
docker compose logs -f api
```

Al arrancar aplica las migraciones y, con `SEED=true`, carga 100k productos y 50 usuarios: de `loadtest-1@example.test` a `loadtest-50@example.test`, todos con la contraseña `loadtest`.

Sin Docker para la API (Postgres sigue en el compose):

```bash
docker compose up -d db
npm install
npm run dev                     # lee .env; con PORT=8081 no choca con el contenedor
```

Tests de integración. Usan la base `market_test`, que el compose crea la primera vez:

```bash
npm test
npm run typecheck
```

## Endpoints

| Método y ruta | Auth | Qué hace |
| --- | --- | --- |
| `GET /health` | — | `{status: ok}` si hay base; si no, 503 |
| `POST /auth/register` | — | `{email, password, name?}` → 201 con usuario y tokens; 409 si el email existe |
| `POST /auth/login` | — | `{email, password}` → `{user_id, access_token, expires_in, refresh_token}` |
| `POST /auth/refresh` | — | `{refresh_token}` → par nuevo; el usado queda revocado (sirve una vez) |
| `GET /me` | Bearer | El usuario del token |
| `GET /products` | — | `q`, `category`, `min_price`, `max_price`, `sort` (`newest`, `price`, `-price`, `name`), `page`, `limit` ≤ 100 → `{items, page, limit, total}` |
| `GET /products/categories` | — | Categorías con cantidad de productos |
| `GET /products/:id` | — | Un producto; 404 si no existe |
| `POST /orders` | Bearer | `{product_id, quantity?, idempotency_key?}` → 201; repetir la clave devuelve el mismo pedido con 200; 409 sin stock |
| `GET /orders` | Bearer | Pedidos propios, del más nuevo al más viejo: `limit`, `cursor` → `{items, next_cursor}` |
| `GET /orders/:id` | Bearer | Un pedido propio; uno ajeno da 404 |
| `POST /files` | Bearer | Multipart con el campo `file` → 201 con `id`, tamaño y `sha256`; 413 si supera `MAX_UPLOAD_MB` |
| `GET /files`, `GET /files/:id` | Bearer | Archivos propios y su metadata |
| `GET /files/:id/content` | Bearer | El archivo, con su nombre original |
| `DELETE /files/:id` | Bearer | 204 |

Errores: siempre `{error: "…"}` con el status que corresponde. Un 401 trae `WWW-Authenticate`, y si el token venció lo dice: `error_description="expired"`. Un 429 trae `Retry-After`, `RateLimit` y `RateLimit-Policy`.

## Configuración

| Variable | Por defecto | Qué es |
| --- | --- | --- |
| `JWT_SECRET` | — (obligatoria) | Firma de los access tokens (HS256) |
| `ACCESS_TTL_SECONDS` | `300` | Vida del access token |
| `REFRESH_TTL_SECONDS` | `604800` (7 días) | Vida del refresh token |
| `RATE_LIMIT_PER_MINUTE` | `600` | Requests por minuto por usuario en las rutas con Bearer; `0` lo apaga |
| `AUTH_RATE_LIMIT_PER_MINUTE` | `30` | Login y registro por minuto por IP; `0` lo apaga |
| `PG_POOL_MAX` | `10` | Conexiones a Postgres |
| `MAX_UPLOAD_MB` | `10` | Tamaño máximo por archivo |
| `TRUST_PROXY` | `false` | `true` detrás de Caddy, para limitar por la IP real |
| `DATABASE_URL`, `HOST`, `PORT`, `UPLOAD_DIR` | ver `src/config.ts` | |
| `SEED`, `SEED_PRODUCTS`, `SEED_USERS`, `SEED_PASSWORD` | `100000`, `50`, `loadtest` | Datos de prueba al arrancar |

En el compose, las de límites y TTL se pueden pisar desde `.env`.

## Bajo carga

Decisiones comunes que tienen costo, para saber qué esperar:

- **Búsqueda con `q`:** ILIKE `%texto%` sin índice de trigramas, así que recorre la tabla entera, y además cuenta el total con otro `count(*)`.
- **Paginación por página:** `OFFSET` crece con `page`. Los pedidos usan cursor, que no tiene ese problema.
- **Login:** scrypt cuesta ~40 ms de CPU por intento. Corre en el pool de libuv (4 hilos por defecto), así que no bloquea el event loop pero tiene su propio techo.
- **Pool de Postgres:** 10 conexiones. Bajo concurrencia alta, los requests esperan conexión.
- **Rate limit en memoria:** vale para una sola instancia. Con 20 VUs en un mismo usuario se llega rápido a 600 por minuto.
- **Login por IP:** 30 por minuto. Una prueba con `vu_setup` de más de 30 VUs desde una sola máquina recibe 429 en el login, salvo que se suba `AUTH_RATE_LIMIT_PER_MINUTE`.
- **Tokens:** el access token dura 5 minutos. Una corrida más larga que eso empieza a recibir 401.

## Pruebas con lt

En `.loadtest/` (todas pasan `lt check`):

| Escenario | Qué prueba |
| --- | --- |
| `smoke` | Salud, listado y un producto, 5/s |
| `browse` | Búsqueda, categorías y páginas al azar, anónimo, 20/s |
| `shop-per-user` | 20 VUs, uno por usuario de `data/users.csv`: login una vez y después buscan, compran y revisan sus pedidos con pausas |
| `rate-limit` | Un usuario a 20/s contra un límite de 10/s: tiene que aparecer el 429 |

```powershell
lt check shop-per-user
lt approve shop-per-user --env local
lt run shop-per-user --env local
```

## Subirla

Va en cualquier servidor con Docker: el mismo compose más Caddy, que saca el certificado de Let's Encrypt.

```bash
# en el servidor, con el puerto 80 y 443 abiertos y el DNS de DOMAIN apuntando a él
echo "JWT_SECRET=$(openssl rand -hex 32)" > .env
echo "POSTGRES_PASSWORD=$(openssl rand -hex 16)" >> .env
echo "TRUST_PROXY=true" >> .env
DOMAIN=api.ejemplo.com docker compose --profile tls up -d --build
```

Postgres y la API quedan escuchando solo en `127.0.0.1` del servidor. Lo único expuesto es Caddy.

**Antes de cargarla:** probá solo servidores tuyos. Muchos hostings (sobre todo los planes gratis) prohíben las pruebas de carga o cortan el tráfico que las parece. Un VPS propio no tiene ese problema, pero conviene revisar los términos del proveedor y empezar con límites bajos en el entorno de lt.
