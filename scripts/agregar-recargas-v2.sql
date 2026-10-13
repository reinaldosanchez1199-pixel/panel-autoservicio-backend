-- Recargas v2: instrucciones de pago y comprobante dentro de la plataforma.
-- Solo AGREGA columnas/tablas (idempotente); no modifica ni elimina las
-- solicitudes históricas ni sus estados actuales ('pendiente', 'aprobado',
-- 'rechazado' siguen siendo válidos).
--
-- Estados nuevos de recargas_manuales.estado:
--   'pendiente_pago'  -> el cliente eligió monto y método, aún no envía comprobante
--   'en_verificacion' -> envió comprobante (o confirmó el pago con enlace): el admin revisa
--   'aprobado' / 'rechazado' -> igual que antes
-- ('pendiente' queda como estado heredado de solicitudes anteriores a este cambio.)

ALTER TABLE recargas_manuales ADD COLUMN IF NOT EXISTS motivo_rechazo TEXT;
ALTER TABLE recargas_manuales ADD COLUMN IF NOT EXISTS enviado_en TIMESTAMPTZ;
ALTER TABLE recargas_manuales ADD COLUMN IF NOT EXISTS monto_a_pagar NUMERIC(14,2);

-- Comprobantes: se guardan en la base de datos (no en disco) para que sean
-- privados (solo se sirven por endpoint autenticado) y sobrevivan a los
-- redespliegues del servidor, que borran el disco.
CREATE TABLE IF NOT EXISTS comprobantes_recarga (
    recarga_id UUID PRIMARY KEY REFERENCES recargas_manuales(id) ON DELETE CASCADE,
    mime VARCHAR(100) NOT NULL,
    nombre_original VARCHAR(255),
    tamano_bytes INT NOT NULL,
    datos BYTEA NOT NULL,
    creado_en TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_recargas_user ON recargas_manuales (user_id, creado_en DESC);
CREATE INDEX IF NOT EXISTS idx_recargas_estado ON recargas_manuales (estado, creado_en DESC);
