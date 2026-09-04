-- Quita "Latino(s)" del nombre público — la audiencia se menciona ahora en la
-- descripción del panel, no en el título del servicio.
UPDATE services SET nombre_publico = 'Likes femeninos'  WHERE provider_id = 1 AND provider_service_id = '1395';
UPDATE services SET nombre_publico = 'Likes masculinos' WHERE provider_id = 1 AND provider_service_id = '1396';
UPDATE services SET nombre_publico = 'Seguidores'        WHERE provider_id = 1 AND provider_service_id = '3766'; -- TikTok

-- Este cuarto no estaba en la lista que me diste, pero tiene el mismo problema:
-- el "Seguidores" de Instagram también quedó guardado como "Seguidores Latinos".
UPDATE services SET nombre_publico = 'Seguidores'        WHERE provider_id = 2 AND provider_service_id = '21709'; -- Instagram

SELECT plataforma, nombre_publico, tipo FROM services
WHERE (provider_id = 1 AND provider_service_id IN ('1395','1396','3766'))
   OR (provider_id = 2 AND provider_service_id = '21709');
