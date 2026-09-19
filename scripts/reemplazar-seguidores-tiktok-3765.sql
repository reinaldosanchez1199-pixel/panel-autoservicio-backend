-- Reemplaza el servicio de Seguidores de TikTok (era bestsmmprovider/3766,
-- audiencia latina/hispana) por bestsmmprovider/3765 ("Tiktok Brazil
-- Followers", audiencia de Brasil). Se reutiliza la misma fila (id 450) en
-- vez de crear una nueva. Verificado en vivo contra la API del proveedor:
--   - Costo real: $3.12/1000 (antes tenía otro costo, se recalibra el margen
--     para mantener el mismo precio al cliente: ~3750.97 créditos/1000).
--   - El proveedor reporta refill:false para este servicio ahora mismo
--     (aunque el título diga "30 Days Refill"), así que se quita la
--     garantía de reposición para no prometer algo que hoy no está activo.
--   - Nombre cambiado a "Seguidores Brasil" (ya no "Latinos") para no dar a
--     entender audiencia hispana cuando en realidad es de Brasil.
UPDATE services SET
  provider_service_id = '3765',
  nombre_publico = 'Seguidores Brasil',
  costo_provider_por_1000 = 3.12,
  margen_multiplicador = 12.0223,
  precio_creditos_por_1000 = 3.12 * 100 * 12.0223,
  cantidad_min = 100,   -- se mantiene el mínimo de negocio ya vigente (el proveedor permite desde 10)
  cantidad_max = 100000,
  soporta_refill = false,
  dias_garantia = NULL,
  activo = true
WHERE id = 450;

SELECT id, provider_id, provider_service_id, plataforma, tipo, nombre_publico,
       precio_creditos_por_1000, cantidad_min, cantidad_max, soporta_refill, dias_garantia
FROM services WHERE id = 450;
