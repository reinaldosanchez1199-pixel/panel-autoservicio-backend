-- Curación de los 12 servicios confirmados (nombre público, margen, activación).
-- Márgenes por categoría calibrados con precios reales de viralizame.com:
--   Seguidores 13x · Likes 17x · Vistas 13x · Engagement extra 18x

-- ===== Instagram =====

UPDATE services SET
  nombre_publico = 'Me Gusta',
  tipo = 'Likes',
  margen_multiplicador = 17,
  precio_creditos_por_1000 = costo_provider_por_1000 * 100 * 17,
  activo = true
WHERE provider_id = 2 AND provider_service_id = '22533';

UPDATE services SET
  nombre_publico = 'Me Gusta Latino Femenino',
  tipo = 'Likes',
  margen_multiplicador = 17,
  precio_creditos_por_1000 = costo_provider_por_1000 * 100 * 17,
  activo = true
WHERE provider_id = 1 AND provider_service_id = '1395';

UPDATE services SET
  nombre_publico = 'Me Gusta Latino Masculino',
  tipo = 'Likes',
  margen_multiplicador = 17,
  precio_creditos_por_1000 = costo_provider_por_1000 * 100 * 17,
  activo = true
WHERE provider_id = 1 AND provider_service_id = '1396';

UPDATE services SET
  nombre_publico = 'Vistas',
  tipo = 'Vistas',
  margen_multiplicador = 13,
  precio_creditos_por_1000 = costo_provider_por_1000 * 100 * 13,
  activo = true
WHERE provider_id = 2 AND provider_service_id = '13409';

UPDATE services SET
  nombre_publico = 'Alcance + Impresiones',
  tipo = 'Alcance + Impresiones',
  margen_multiplicador = 18,
  precio_creditos_por_1000 = costo_provider_por_1000 * 100 * 18,
  activo = true
WHERE provider_id = 2 AND provider_service_id = '18580';

UPDATE services SET
  nombre_publico = 'Compartidos',
  tipo = 'Compartidos',
  margen_multiplicador = 18,
  precio_creditos_por_1000 = costo_provider_por_1000 * 100 * 18,
  activo = true
WHERE provider_id = 2 AND provider_service_id = '21386';

UPDATE services SET
  nombre_publico = 'Repost',
  tipo = 'Reposts',
  margen_multiplicador = 18,
  precio_creditos_por_1000 = costo_provider_por_1000 * 100 * 18,
  activo = true
WHERE provider_id = 2 AND provider_service_id = '21372';

-- ===== TikTok =====

UPDATE services SET
  nombre_publico = 'Seguidores Latinos',
  tipo = 'Seguidores',
  margen_multiplicador = 13,
  precio_creditos_por_1000 = costo_provider_por_1000 * 100 * 13,
  cantidad_min = 100,
  activo = true
WHERE provider_id = 1 AND provider_service_id = '3766';

UPDATE services SET
  nombre_publico = 'Me Gusta',
  tipo = 'Likes',
  margen_multiplicador = 17,
  precio_creditos_por_1000 = costo_provider_por_1000 * 100 * 17,
  activo = true
WHERE provider_id = 2 AND provider_service_id = '23629';

UPDATE services SET
  nombre_publico = 'Vistas',
  tipo = 'Vistas',
  margen_multiplicador = 13,
  precio_creditos_por_1000 = costo_provider_por_1000 * 100 * 13,
  activo = true
WHERE provider_id = 2 AND provider_service_id = '22911';

UPDATE services SET
  nombre_publico = 'Guardados',
  tipo = 'Guardados',
  margen_multiplicador = 18,
  precio_creditos_por_1000 = costo_provider_por_1000 * 100 * 18,
  activo = true
WHERE provider_id = 2 AND provider_service_id = '18658';

UPDATE services SET
  nombre_publico = 'Compartidos',
  tipo = 'Compartidos',
  margen_multiplicador = 18,
  precio_creditos_por_1000 = costo_provider_por_1000 * 100 * 18,
  activo = true
WHERE provider_id = 2 AND provider_service_id = '22304';

-- Establece la plataforma correcta para todos los recién activados
UPDATE services SET plataforma = 'Instagram' WHERE provider_id = 2 AND provider_service_id IN ('22533','13409','18580','21386','21372');
UPDATE services SET plataforma = 'Instagram' WHERE provider_id = 1 AND provider_service_id IN ('1395','1396');
UPDATE services SET plataforma = 'TikTok' WHERE provider_id = 1 AND provider_service_id = '3766';
UPDATE services SET plataforma = 'TikTok' WHERE provider_id = 2 AND provider_service_id IN ('23629','22911','18658','22304');

-- Verificación: deberían salir 12 filas
SELECT plataforma, nombre_publico, tipo, precio_creditos_por_1000, cantidad_min, cantidad_max, activo
FROM services WHERE activo = true ORDER BY plataforma, tipo;
