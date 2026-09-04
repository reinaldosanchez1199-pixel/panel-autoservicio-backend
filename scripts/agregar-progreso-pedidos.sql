-- Necesario para calcular el % de progreso real de un pedido "procesando":
-- restantes_proveedor = lo que el proveedor reporta como pendiente de entregar (remains).
-- cantidad_enviada_proveedor = la cantidad real pedida al proveedor (incluye el
-- +10% de compensación en seguidores), para no calcular el % contra la cantidad
-- que ve el cliente y que el progreso arranque en negativo.
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS cantidad_enviada_proveedor INT;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS restantes_proveedor INT;
