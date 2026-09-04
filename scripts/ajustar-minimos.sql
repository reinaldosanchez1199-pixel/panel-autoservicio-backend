-- Ajusta cantidad_min según tus reglas de negocio (no el mínimo del proveedor):
-- Likes 100 · Guardados 100 · Compartidos 100 · Repost 30 · Alcance+Impresiones 1000 · Vistas 1000 · Seguidores ya en 100

UPDATE services SET cantidad_min = 100 WHERE activo = true AND tipo = 'Likes';
UPDATE services SET cantidad_min = 100 WHERE activo = true AND tipo = 'Guardados';
UPDATE services SET cantidad_min = 100 WHERE activo = true AND tipo = 'Compartidos';
UPDATE services SET cantidad_min = 30  WHERE activo = true AND tipo = 'Reposts';
UPDATE services SET cantidad_min = 1000 WHERE activo = true AND tipo = 'Alcance + Impresiones';
UPDATE services SET cantidad_min = 1000 WHERE activo = true AND tipo = 'Vistas';

SELECT plataforma, nombre_publico, tipo, cantidad_min, cantidad_max FROM services WHERE activo = true ORDER BY tipo, plataforma;
