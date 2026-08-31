// ============================================
// sync.js v2 — sincronización de precios y estado de pedidos
// Actualizado a los nombres de columna de créditos (schema v2)
// ============================================

require('dotenv').config();
const pool = require('./db');

const PROVIDERS = [
  { id: 1, nombre: 'bestsmmprovider', apiUrl: 'https://bestsmmprovider.com/api/v2', apiKey: process.env.BESTSMM_API_KEY },
  { id: 2, nombre: 'smmcpan', apiUrl: 'https://smmcpan.com/api/v2', apiKey: process.env.SMMCPAN_API_KEY },
];

// ---------------------------------------------
// 1. SINCRONIZACIÓN DE PRECIOS Y SERVICIOS
// ---------------------------------------------
async function sincronizarPrecios() {
  for (const provider of PROVIDERS) {
    try {
      const resp = await fetch(provider.apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ key: provider.apiKey, action: 'services' }),
      });
      const servicios = await resp.json();
      if (!Array.isArray(servicios)) {
        console.error(`[${provider.nombre}] Respuesta inesperada:`, servicios);
        continue;
      }
      for (const s of servicios) await upsertServicio(provider.id, s);
      console.log(`[${provider.nombre}] Sincronizados ${servicios.length} servicios`);
    } catch (err) {
      console.error(`[${provider.nombre}] Error al sincronizar precios:`, err.message);
    }
  }
}

async function upsertServicio(providerId, servicioProveedor) {
  const { service: providerServiceId, rate, min, max } = servicioProveedor;
  const costoProvider = parseFloat(rate);

  const existente = await pool.query(
    `SELECT id, margen_multiplicador FROM services WHERE provider_id = $1 AND provider_service_id = $2`,
    [providerId, providerServiceId]
  );

  if (existente.rows.length > 0) {
    const margen = parseFloat(existente.rows[0].margen_multiplicador);
    const nuevoPrecio = costoProvider * margen;
    await pool.query(
      `UPDATE services SET costo_provider_por_1000 = $1, precio_creditos_por_1000 = $2,
       cantidad_min = $3, cantidad_max = $4, ultima_sincronizacion = now() WHERE id = $5`,
      [costoProvider, nuevoPrecio, min, max, existente.rows[0].id]
    );
  } else {
    // Nuevo servicio del proveedor: se crea INACTIVO. Se activa desde el admin con nombre público y margen revisado.
    await pool.query(
      `INSERT INTO services
        (provider_id, provider_service_id, plataforma, tipo, nombre_publico,
         costo_provider_por_1000, margen_multiplicador, precio_creditos_por_1000,
         cantidad_min, cantidad_max, activo)
       VALUES ($1, $2, 'sin_clasificar', 'sin_clasificar', $3, $4, 3.0, $5, $6, $7, false)`,
      [providerId, providerServiceId, servicioProveedor.name || 'Servicio sin nombre', costoProvider, costoProvider * 3.0, min, max]
    );
  }
}

// ---------------------------------------------
// 2. POLLING DE ESTADO — ahora sobre order_items, no orders directo
// ---------------------------------------------
async function sincronizarEstadosOrdenes() {
  const itemsActivos = await pool.query(
    `SELECT oi.id AS item_id, oi.provider_order_id, oi.order_id, s.provider_id
     FROM order_items oi
     JOIN services s ON s.id = oi.service_id
     WHERE oi.estado = 'procesando' AND oi.provider_order_id IS NOT NULL`
  );

  const porProveedor = {};
  for (const item of itemsActivos.rows) {
    porProveedor[item.provider_id] = porProveedor[item.provider_id] || [];
    porProveedor[item.provider_id].push(item);
  }

  const { reembolsarItem } = require('./wallet');

  for (const providerId of Object.keys(porProveedor)) {
    const provider = PROVIDERS.find((p) => p.id === parseInt(providerId));
    if (!provider) continue;

    const items = porProveedor[providerId];
    const ids = items.map((i) => i.provider_order_id).join(',');

    try {
      const resp = await fetch(provider.apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ key: provider.apiKey, action: 'status', orders: ids }),
      });
      const estados = await resp.json();

      for (const item of items) {
        const info = estados[item.provider_order_id];
        if (!info) continue;
        await actualizarEstadoItem(item, info.status, reembolsarItem);
      }
    } catch (err) {
      console.error(`[${provider.nombre}] Error al consultar estados:`, err.message);
    }
  }
}

async function actualizarEstadoItem(item, statusProveedor, reembolsarItem) {
  const mapaEstados = {
    Completed: 'completado', 'In progress': 'procesando', Processing: 'procesando',
    Pending: 'procesando', Partial: 'completado', Canceled: 'error', Error: 'error',
  };
  const nuevoEstado = mapaEstados[statusProveedor] || 'procesando';

  if (nuevoEstado === 'error') {
    await reembolsarItem(item.item_id, `Proveedor reportó estado: ${statusProveedor}`);
  } else {
    await pool.query('UPDATE order_items SET estado = $1 WHERE id = $2', [nuevoEstado, item.item_id]);
    // Recalcula el estado agregado del pedido header
    const { actualizarEstadoAgregadoPedido } = require('./wallet');
    await actualizarEstadoAgregadoPedido(item.order_id);
  }
}

if (require.main === module) {
  const modo = process.argv[2];
  if (modo === 'precios') sincronizarPrecios().then(() => process.exit(0));
  else if (modo === 'estados') sincronizarEstadosOrdenes().then(() => process.exit(0));
  else console.log('Uso: node sync.js [precios|estados]');
}

module.exports = { sincronizarPrecios, sincronizarEstadosOrdenes };
