-- Twitter
UPDATE services SET nombre_publico='Seguidores', tipo='Seguidores', plataforma='Twitter',
  margen_multiplicador=13, precio_creditos_por_1000=costo_provider_por_1000*100*13, cantidad_min=100, activo=true
WHERE provider_id=2 AND provider_service_id='23529';

UPDATE services SET nombre_publico='Me Gusta', tipo='Likes', plataforma='Twitter',
  margen_multiplicador=17, precio_creditos_por_1000=costo_provider_por_1000*100*17, activo=true
WHERE provider_id=2 AND provider_service_id='23531';

UPDATE services SET nombre_publico='Vistas', tipo='Vistas', plataforma='Twitter',
  margen_multiplicador=13, precio_creditos_por_1000=costo_provider_por_1000*100*13, activo=true
WHERE provider_id=2 AND provider_service_id='5319';

-- YouTube
UPDATE services SET nombre_publico='Suscriptores', tipo='Seguidores', plataforma='YouTube',
  margen_multiplicador=13, precio_creditos_por_1000=costo_provider_por_1000*100*13, cantidad_min=100, activo=true
WHERE provider_id=2 AND provider_service_id='21539';

UPDATE services SET nombre_publico='Vistas', tipo='Vistas', plataforma='YouTube',
  margen_multiplicador=13, precio_creditos_por_1000=costo_provider_por_1000*100*13, activo=true
WHERE provider_id=2 AND provider_service_id='12188';

UPDATE services SET nombre_publico='Me Gusta', tipo='Likes', plataforma='YouTube',
  margen_multiplicador=17, precio_creditos_por_1000=costo_provider_por_1000*100*17, activo=true
WHERE provider_id=2 AND provider_service_id='17089';

-- Facebook
UPDATE services SET nombre_publico='Seguidores (Perfil)', tipo='Seguidores', plataforma='Facebook',
  margen_multiplicador=13, precio_creditos_por_1000=costo_provider_por_1000*100*13, cantidad_min=100, activo=true
WHERE provider_id=2 AND provider_service_id='17179';

UPDATE services SET nombre_publico='Seguidores (Página)', tipo='Seguidores', plataforma='Facebook',
  margen_multiplicador=13, precio_creditos_por_1000=costo_provider_por_1000*100*13, cantidad_min=100, activo=true
WHERE provider_id=2 AND provider_service_id='17178';

UPDATE services SET nombre_publico='Me Gusta + Seguidores (Página)', tipo='Likes', plataforma='Facebook',
  margen_multiplicador=17, precio_creditos_por_1000=costo_provider_por_1000*100*17, activo=true
WHERE provider_id=2 AND provider_service_id='21749';

UPDATE services SET nombre_publico='Me Gusta (Publicación)', tipo='Likes', plataforma='Facebook',
  margen_multiplicador=17, precio_creditos_por_1000=costo_provider_por_1000*100*17, activo=true
WHERE provider_id=2 AND provider_service_id='21087';

UPDATE services SET nombre_publico='Vistas', tipo='Vistas', plataforma='Facebook',
  margen_multiplicador=13, precio_creditos_por_1000=costo_provider_por_1000*100*13, activo=true
WHERE provider_id=2 AND provider_service_id='22577';

-- Verificación: deberían ser 25 filas (14 anteriores + 11 nuevas)
SELECT plataforma, nombre_publico, tipo, precio_creditos_por_1000, cantidad_min, cantidad_max, activo
FROM services WHERE activo = true ORDER BY plataforma, tipo;
