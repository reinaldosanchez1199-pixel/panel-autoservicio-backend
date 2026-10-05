-- Cambia, en la MISMA fila (id 2197, Likes Universales de Instagram), el servicio
-- de smmcpan 22532 -> 21250.
-- Verificado en vivo contra la API de smmcpan:
--   21250: $0.1188/1000, min 10, max 1,000,000, refill:false
--   (22532 costaba $0.297/1000)
-- Se recalibra el margen para conservar el precio actual al cliente
-- (~600.60 creditos/1000): 600.60 / (0.1188 * 100) = 50.55.

-- Seguridad: si el sync ya creo una fila suelta e inactiva para 21250 (chocaria
-- con la restriccion unica), se limpia solo si nadie la usa.
DELETE FROM services s
WHERE s.provider_id = 2 AND s.provider_service_id = '21250' AND s.activo = false
  AND NOT EXISTS (SELECT 1 FROM order_items oi WHERE oi.service_id = s.id)
  AND NOT EXISTS (SELECT 1 FROM bundle_items bi WHERE bi.service_id = s.id);

UPDATE services SET
  provider_service_id = '21250',
  costo_provider_por_1000 = 0.1188,
  margen_multiplicador = 50.55,
  precio_creditos_por_1000 = 0.1188 * 100 * 50.55,
  cantidad_min = 100,
  cantidad_max = 20000,
  soporta_refill = false
WHERE id = 2197 AND provider_id = 2;

SELECT id, provider_id, provider_service_id, plataforma, tipo, nombre_publico,
       costo_provider_por_1000, margen_multiplicador, precio_creditos_por_1000, cantidad_min, cantidad_max
FROM services WHERE id = 2197;
