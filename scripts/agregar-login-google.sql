-- Las cuentas creadas con Google no tienen contraseña propia.
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
