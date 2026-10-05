-- Cambia, en la MISMA fila (no se crean filas nuevas), los servicios de Instagram:
--   * Likes Universales  (id 2197): smmcpan 22533 -> 22532
--   * Reproducciones     (id 1473): smmcpan 13409 -> 19477
-- Verificado en vivo contra la API de smmcpan:
--   22532: $0.297/1000, min 10, max 20000, refill:false
--   19477: $0.0059/1000, min 100 (se mantiene el minimo de negocio de 1000)
-- Se recalibra el margen para conservar el precio actual al cliente:
--   Likes ~600.60 creditos/1000, Reproducciones IG 75 creditos/1000.

-- Seguridad: si el sync ya hubiera creado filas sueltas e inactivas para estos
-- IDs (chocarian con la restriccion unica), se limpian solo si nadie las usa.
DELETE FROM services s
WHERE s.provider_id = 2 AND s.provider_service_id IN ('22532', '19477') AND s.activo = false
  AND NOT EXISTS (SELECT 1 FROM order_items oi WHERE oi.service_id = s.id)
  AND NOT EXISTS (SELECT 1 FROM bundle_items bi WHERE bi.service_id = s.id);

UPDATE services SET
  provider_service_id = '22532',
  costo_provider_por_1000 = 0.297,
  margen_multiplicador = 20.2222,
  precio_creditos_por_1000 = 0.297 * 100 * 20.2222,
  cantidad_min = 100,
  cantidad_max = 20000,
  soporta_refill = false
WHERE id = 2197 AND provider_id = 2;

UPDATE services SET
  provider_service_id = '19477',
  costo_provider_por_1000 = 0.0059,
  margen_multiplicador = 127.12,
  precio_creditos_por_1000 = 0.0059 * 100 * 127.12,
  cantidad_min = 1000,
  cantidad_max = 2147483647,
  soporta_refill = false
WHERE id = 1473 AND provider_id = 2;

SELECT id, provider_id, provider_service_id, plataforma, tipo, nombre_publico,
       costo_provider_por_1000, margen_multiplicador, precio_creditos_por_1000, cantidad_min, cantidad_max
FROM services WHERE id IN (2197, 1473);
