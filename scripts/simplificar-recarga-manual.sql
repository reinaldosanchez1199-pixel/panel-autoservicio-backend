-- El comprobante ya no es obligatorio subirlo en el panel — el cliente lo
-- manda por WhatsApp (donde el admin lo revisa antes de aprobar), así que
-- aquí solo queda un registro de "ya pagué, avisé por WhatsApp".
ALTER TABLE recargas_manuales ALTER COLUMN comprobante_url DROP NOT NULL;
ALTER TABLE recargas_manuales ADD COLUMN IF NOT EXISTS metodo VARCHAR(50);
