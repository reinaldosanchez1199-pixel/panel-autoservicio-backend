-- Elimina (desactiva) "Me Gusta + Seguidores (Página)" de Facebook.
UPDATE services SET activo = false WHERE provider_id = 2 AND provider_service_id = '21749';
