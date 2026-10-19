-- La búsqueda con ILIKE '%texto%' recorría la tabla entera para contar el total (~74 ms con
-- 100k productos). Con índices de trigramas, Postgres resuelve el filtro desde el índice (~7 ms).
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX products_name_trgm ON products USING gin (name gin_trgm_ops);
CREATE INDEX products_description_trgm ON products USING gin (description gin_trgm_ops);
ANALYZE products;
