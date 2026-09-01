// ============================================
// sync.js v2 — sincronización de precios y estado de pedidos
// Actualizado a los nombres de columna de créditos (schema v2)
// ============================================

require('dotenv').config();
const pool = require('./db');

// smmcpan pausado el 2026-09-01: la misma API key se usa en el child panel
// worldklox.online, y sus pedidos dejaron de procesarse justo después de
// empezar a probarla aquí también. Reactivar (quitar el filtro de abajo)
// solo cuando soporte de smmcpan confirme que la key está bien.
const SMMCPAN_PAUSADO = true;

const PROVIDERS = [
  { id: 1, nombre: 'bestsmmprovider', apiUrl: 'https://bestsmmprovider.com/api/v2', apiKey: process.env.BESTSMM_API_KEY },
  { id: 2, nombre: 'smmcpan', apiUrl: 'https://smmcpan.com/api/v2', apiKey: process.env.SMMCPAN_API_KEY },
].filter((p) => !(p.nombre === 'smmcpan' && SMMCPAN_PAUSADO));

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
        signal: AbortSignal.timeout(30000), // nunca dejar el cron colgado si el proveedor no responde
      });
      const servicios = await resp.json();
      if (!Array.isArray(servicios)) {
        console.error(`[${provider.nombre}] Respuesta inesperada:`, servicios);
        continue;
      }
      await upsertServiciosBatch(provider.id, servicios);
      console.log(`[${provider.nombre}] Sincronizados ${servicios.length} servicios`);
    } catch (err) {
      console.error(`[${provider.nombre}] Error al sincronizar precios:`, err.message);
    }
  }
}

// Estos paneles listan miles de servicios (bestsmmprovider ~1.3k, smmcpan ~8k).
// Un upsert fila por fila implica 2 round-trips por servicio (~18k+ queries).
// Se hace por lotes con un solo INSERT ... ON CONFLICT por chunk.
async function upsertServiciosBatch(providerId, servicios, chunkSize = 500) {
  for (let i = 0; i < servicios.length; i += chunkSize) {
    const chunk = servicios.slice(i, i + chunkSize);
    const filas = [];
    const params = [];
    let idx = 1;

    for (const s of chunk) {
      const costoProvider = parseFloat(s.rate);
      filas.push(`($${idx++}, $${idx++}, 'sin_clasificar', 'sin_clasificar', $${idx++}, $${idx++}, 3.0, $${idx++}, $${idx++}, $${idx++}, false)`);
      params.push(
        providerId,
        s.service,
        s.name || 'Servicio sin nombre',
        costoProvider,
        costoProvider * 3.0,
        s.min,
        s.max
      );
    }

    await pool.query(
      `INSERT INTO services
        (provider_id, provider_service_id, plataforma, tipo, nombre_publico,
         costo_provider_por_1000, margen_multiplicador, precio_creditos_por_1000,
         cantidad_min, cantidad_max, activo)
       VALUES ${filas.join(', ')}
       ON CONFLICT (provider_id, provider_service_id) DO UPDATE SET
         costo_provider_por_1000 = EXCLUDED.costo_provider_por_1000,
         -- se preserva el margen ya configurado del servicio existente, no el default 3.0
         precio_creditos_por_1000 = EXCLUDED.costo_provider_por_1000 * services.margen_multiplicador,
         cantidad_min = EXCLUDED.cantidad_min,
         cantidad_max = EXCLUDED.cantidad_max,
         ultima_sincronizacion = now()`,
      params
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
        signal: AbortSignal.timeout(30000),
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
