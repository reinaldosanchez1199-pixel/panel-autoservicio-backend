-- Programa de referidos: 500 Viral Credits para el que refiere y 500 para el
-- referido, pagados cuando el referido hace su PRIMERA recarga aprobada (no
-- al registrarse, para que cueste dinero real crear cuentas falsas).

-- codigo_referido se deriva del propio id (ya único) — no hace falta generarlo
-- ni verificar colisiones a mano.
ALTER TABLE users ADD COLUMN IF NOT EXISTS codigo_referido VARCHAR(8)
  GENERATED ALWAYS AS (UPPER(SUBSTRING(REPLACE(id::text, '-', '') FOR 8))) STORED;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_codigo_referido ON users(codigo_referido);

ALTER TABLE users ADD COLUMN IF NOT EXISTS referido_por UUID REFERENCES users(id);
-- IP al momento del registro — solo para detectar abuso (varias cuentas de la
-- misma persona), nunca se muestra al usuario.
ALTER TABLE users ADD COLUMN IF NOT EXISTS ip_registro VARCHAR(45);

-- Un registro por referido_id (UNIQUE) impide pagar el bono dos veces a la
-- misma cuenta aunque hubiera una condición de carrera en el código.
CREATE TABLE IF NOT EXISTS bonos_referido (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referente_id UUID NOT NULL REFERENCES users(id),
  referido_id UUID NOT NULL UNIQUE REFERENCES users(id),
  estado VARCHAR(20) NOT NULL DEFAULT 'aprobado', -- aprobado | sospechoso | rechazado
  motivo_sospecha VARCHAR(255),
  creado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
  revisado_por UUID REFERENCES users(id),
  revisado_en TIMESTAMPTZ
);
