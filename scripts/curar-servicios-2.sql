UPDATE services SET
  nombre_publico = 'Seguidores Latinos',
  tipo = 'Seguidores',
  plataforma = 'Instagram',
  margen_multiplicador = 13,
  precio_creditos_por_1000 = costo_provider_por_1000 * 100 * 13,
  cantidad_min = 100,
  activo = true
WHERE provider_id = 2 AND provider_service_id = '21709';

UPDATE services SET
  nombre_publico = 'Guardados',
  tipo = 'Guardados',
  plataforma = 'Instagram',
  margen_multiplicador = 18,
  precio_creditos_por_1000 = costo_provider_por_1000 * 100 * 18,
  cantidad_min = 100,
  activo = true
WHERE provider_id = 2 AND provider_service_id = '15595';

SELECT plataforma, nombre_publico, tipo, precio_creditos_por_1000, cantidad_min, cantidad_max, activo
FROM services WHERE activo = true ORDER BY plataforma, tipo;
