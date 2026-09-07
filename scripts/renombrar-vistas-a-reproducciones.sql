-- "Vistas" suena a algo pasivo; "Reproducciones" comunica mejor el valor del
-- servicio (views reales del contenido) y es el término que usa la industria.
UPDATE services SET tipo = 'Reproducciones', nombre_publico = 'Reproducciones'
WHERE tipo = 'Vistas';
