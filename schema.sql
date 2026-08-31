-- ============================================
-- ESQUEMA v2: agrega niveles, paquetes con bono,
-- bundles y perfiles guardados + soporte multi-item por pedido
-- PostgreSQL
-- ============================================

CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    nombre VARCHAR(255),
    es_admin BOOLEAN DEFAULT false,
    creditos_consumidos_total NUMERIC(14,2) NOT NULL DEFAULT 0,
    creado_en TIMESTAMPTZ DEFAULT now(),
    activo BOOLEAN DEFAULT true
);

CREATE TABLE wallets (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    saldo_creditos NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (saldo_creditos >= 0),
    actualizado_en TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE providers (
    id SERIAL PRIMARY KEY,
    nombre VARCHAR(100) NOT NULL,
    api_url VARCHAR(255) NOT NULL,
    api_key VARCHAR(255) NOT NULL,
    activo BOOLEAN DEFAULT true
);

CREATE TABLE services (
    id SERIAL PRIMARY KEY,
    provider_id INT REFERENCES providers(id),
    provider_service_id VARCHAR(50) NOT NULL,
    plataforma VARCHAR(30) NOT NULL,
    tipo VARCHAR(30) NOT NULL,
    nombre_publico VARCHAR(255) NOT NULL,
    costo_provider_por_1000 NUMERIC(10,4) NOT NULL,
    margen_multiplicador NUMERIC(5,2) NOT NULL DEFAULT 3.0,
    precio_creditos_por_1000 NUMERIC(10,2) NOT NULL,
    cantidad_min INT NOT NULL DEFAULT 100,
    cantidad_max INT NOT NULL DEFAULT 100000,
    activo BOOLEAN DEFAULT true,
    ultima_sincronizacion TIMESTAMPTZ DEFAULT now(),
    UNIQUE(provider_id, provider_service_id)
);

-- Niveles de cliente (descuento automático por consumo histórico)
CREATE TABLE niveles (
    id SERIAL PRIMARY KEY,
    nombre VARCHAR(50) NOT NULL,
    minimo_consumido NUMERIC(14,2) NOT NULL,
    descuento_pct NUMERIC(5,2) NOT NULL DEFAULT 0,
    orden INT NOT NULL
);

INSERT INTO niveles (nombre, minimo_consumido, descuento_pct, orden) VALUES
    ('Starter', 0, 0, 1),
    ('Pro', 5000, 3, 2),
    ('Growth', 25000, 7, 3),
    ('Elite', 100000, 10, 4);

-- Paquetes de recarga con bono (precio fijo -> créditos con bono incluido)
CREATE TABLE paquetes_recarga (
    id SERIAL PRIMARY KEY,
    precio_usd NUMERIC(10,2) NOT NULL,
    creditos_otorgados NUMERIC(14,2) NOT NULL,
    activo BOOLEAN DEFAULT true,
    orden INT NOT NULL
);

INSERT INTO paquetes_recarga (precio_usd, creditos_otorgados, orden) VALUES
    (10, 1000, 1),
    (20, 2000, 2),
    (50, 5300, 3),
    (100, 11000, 4),
    (250, 28750, 5);

-- Perfiles guardados por cliente
CREATE TABLE perfiles_guardados (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    plataforma VARCHAR(30) NOT NULL,
    nombre_usuario VARCHAR(255) NOT NULL,
    url VARCHAR(500) NOT NULL,
    creado_en TIMESTAMPTZ DEFAULT now(),
    UNIQUE(user_id, plataforma, url)
);

-- Bundles / paquetes pre-armados
CREATE TABLE bundles (
    id SERIAL PRIMARY KEY,
    nombre VARCHAR(255) NOT NULL,
    descripcion VARCHAR(500),
    precio_creditos NUMERIC(14,2) NOT NULL,
    activo BOOLEAN DEFAULT true
);

CREATE TABLE bundle_items (
    id SERIAL PRIMARY KEY,
    bundle_id INT REFERENCES bundles(id) ON DELETE CASCADE,
    service_id INT REFERENCES services(id),
    cantidad INT NOT NULL
);

CREATE TABLE transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id),
    tipo VARCHAR(20) NOT NULL,
    monto NUMERIC(14,2) NOT NULL,
    saldo_resultante NUMERIC(14,2) NOT NULL,
    referencia_orden UUID,
    referencia_comprobante VARCHAR(255),
    nota TEXT,
    creado_en TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE recargas_manuales (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id),
    paquete_id INT REFERENCES paquetes_recarga(id),
    monto_declarado NUMERIC(14,2) NOT NULL,
    creditos_a_acreditar NUMERIC(14,2) NOT NULL,
    comprobante_url VARCHAR(500) NOT NULL,
    estado VARCHAR(20) DEFAULT 'pendiente',
    revisado_por UUID REFERENCES users(id),
    creado_en TIMESTAMPTZ DEFAULT now(),
    revisado_en TIMESTAMPTZ
);

-- Pedido = encabezado. Puede tener VARIOS items (multi-selección)
CREATE TABLE orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id),
    link_cliente VARCHAR(500) NOT NULL,
    bundle_id INT REFERENCES bundles(id),
    costo_total_creditos NUMERIC(14,2) NOT NULL,
    descuento_aplicado_pct NUMERIC(5,2) NOT NULL DEFAULT 0,
    estado VARCHAR(20) DEFAULT 'pendiente',
    creado_en TIMESTAMPTZ DEFAULT now(),
    actualizado_en TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE order_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID REFERENCES orders(id) ON DELETE CASCADE,
    service_id INT REFERENCES services(id),
    cantidad INT NOT NULL,
    costo_creditos NUMERIC(14,2) NOT NULL,
    provider_order_id VARCHAR(100),
    estado VARCHAR(20) DEFAULT 'pendiente'
);

CREATE INDEX idx_transactions_user ON transactions(user_id, creado_en DESC);
CREATE INDEX idx_orders_user ON orders(user_id, creado_en DESC);
CREATE INDEX idx_order_items_order ON order_items(order_id);
CREATE INDEX idx_order_items_estado ON order_items(estado) WHERE estado IN ('pendiente', 'procesando');
CREATE INDEX idx_perfiles_user ON perfiles_guardados(user_id);
