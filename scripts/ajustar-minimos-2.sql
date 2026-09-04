-- Reaplica los mínimos "de negocio" (los mismos de Instagram) a TODAS las
-- plataformas, por tipo de servicio. Necesario porque ajustar-minimos.sql
-- corrió ANTES de curar Twitter/YouTube/Facebook (curar-servicios-3.sql),
-- así que esas plataformas se quedaron con el mínimo crudo del proveedor
-- en vez del mínimo de negocio (ej. Facebook Me Gusta con min=10).
-- Seguro de volver a correr (idempotente).

UPDATE services SET cantidad_min = 100  WHERE activo = true AND tipo = 'Seguidores';
UPDATE services SET cantidad_min = 100  WHERE activo = true AND tipo = 'Likes';
UPDATE services SET cantidad_min = 1000 WHERE activo = true AND tipo = 'Vistas';
UPDATE services SET cantidad_min = 100  WHERE activo = true AND tipo = 'Guardados';
UPDATE services SET cantidad_min = 100  WHERE activo = true AND tipo = 'Compartidos';
UPDATE services SET cantidad_min = 30   WHERE activo = true AND tipo = 'Reposts';

SELECT plataforma, nombre_publico, tipo, cantidad_min, cantidad_max
FROM services WHERE activo = true ORDER BY tipo, plataforma;
