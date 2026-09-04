-- La cantidad mínima de "Alcance + Impresiones" debe ser 1000, no 100.
UPDATE services SET cantidad_min = 1000 WHERE activo = true AND tipo = 'Alcance + Impresiones';

SELECT plataforma, nombre_publico, tipo, cantidad_min, cantidad_max
FROM services WHERE activo = true AND tipo = 'Alcance + Impresiones';
