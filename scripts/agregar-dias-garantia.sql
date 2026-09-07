-- Días de garantía de reposición (refill) por servicio, para mostrarse al
-- cliente como sello de confianza (no como advertencia de que "se caen").
ALTER TABLE services ADD COLUMN IF NOT EXISTS dias_garantia INT;
