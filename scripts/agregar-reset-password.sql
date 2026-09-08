-- Recuperación de contraseña mediada por WhatsApp (sin servicio de correo):
-- el cliente pide el reset desde la app, el admin lo verifica y genera una
-- contraseña temporal para enviarle por WhatsApp — mismo patrón que las
-- recargas manuales.
CREATE TABLE IF NOT EXISTS solicitudes_reset_password (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  estado VARCHAR(20) NOT NULL DEFAULT 'pendiente', -- pendiente | resuelto
  creado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
  resuelto_por UUID REFERENCES users(id),
  resuelto_en TIMESTAMPTZ
);
