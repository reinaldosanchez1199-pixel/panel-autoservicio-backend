-- Cambia Seguidores y Likes latinos de Instagram a bestsmmprovider (nuevos IDs
-- verificados en vivo: 3493/3494/3495 seguidores, 3497/3498 likes), agrega las
-- variantes femenino/masculino de Seguidores que no existían, y renombra el
-- "Seguidores" de TikTok a "Seguidores Latinos".
-- Precios calibrados para mantener el mismo target ya vigente (~$37.50/1000
-- seguidores, ~$6.00/1000 likes), igual que el resto del catálogo.

-- Instagram: Seguidores Latinos (general) — reutiliza la fila existente,
-- solo cambia de proveedor (era smmcpan/21709).
UPDATE services SET
  provider_id = 1,
  provider_service_id = '3493',
  nombre_publico = 'Seguidores Latinos',
  costo_provider_por_1000 = 6.24,
  margen_multiplicador = 6.01,
  precio_creditos_por_1000 = 6.24 * 100 * 6.01,
  cantidad_min = 100,
  cantidad_max = 250000,
  soporta_refill = true,
  activo = true
WHERE provider_id = 2 AND provider_service_id = '21709';

-- Instagram: Seguidores Latinos Femeninos y Masculinos — servicios nuevos.
INSERT INTO services (provider_id, provider_service_id, plataforma, tipo, nombre_publico, costo_provider_por_1000, margen_multiplicador, precio_creditos_por_1000, cantidad_min, cantidad_max, activo, soporta_refill) VALUES
(1, '3494', 'Instagram', 'Seguidores', 'Seguidores Latinos Femeninos', 6.50, 5.77, 6.50 * 100 * 5.77, 100, 150000, true, true),
(1, '3495', 'Instagram', 'Seguidores', 'Seguidores Latinos Masculinos', 6.50, 5.77, 6.50 * 100 * 5.77, 100, 100000, true, true)
ON CONFLICT (provider_id, provider_service_id) DO NOTHING;

-- Instagram: Likes Latinos Femeninos/Masculinos — mismo proveedor de antes,
-- pero cambian de ID (los viejos 1395/1396 quedaron discontinuados).
UPDATE services SET
  provider_service_id = '3498',
  nombre_publico = 'Likes Latinos Femeninos',
  costo_provider_por_1000 = 1.30,
  margen_multiplicador = 4.62,
  precio_creditos_por_1000 = 1.30 * 100 * 4.62,
  cantidad_min = 100,
  cantidad_max = 100000,
  soporta_refill = true
WHERE provider_id = 1 AND provider_service_id = '1395';

UPDATE services SET
  provider_service_id = '3497',
  nombre_publico = 'Likes Latinos Masculinos',
  costo_provider_por_1000 = 1.30,
  margen_multiplicador = 4.62,
  precio_creditos_por_1000 = 1.30 * 100 * 4.62,
  cantidad_min = 100,
  cantidad_max = 100000,
  soporta_refill = true
WHERE provider_id = 1 AND provider_service_id = '1396';

-- TikTok: mismo servicio (3766), solo cambia el nombre.
UPDATE services SET nombre_publico = 'Seguidores Latinos' WHERE provider_id = 1 AND provider_service_id = '3766';

SELECT plataforma, tipo, nombre_publico, provider_id, provider_service_id, precio_creditos_por_1000, cantidad_min, cantidad_max, soporta_refill
FROM services WHERE provider_service_id IN ('3493','3494','3495','3497','3498','3766') ORDER BY plataforma, tipo;
