// ============================================
// sync.js v2 — sincronización de precios y estado de pedidos
// Actualizado a los nombres de columna de créditos (schema v2)
// ============================================

require('dotenv').config();
const pool = require('./db');

// smmcpan reactivado el 2026-09-03 con una nueva API key (la anterior se
// pausó por un incidente con el child panel worldklox.online, ya resuelto).
const SMMCPAN_PAUSADO = false;

// Los Viral Credits valen ~$0.01 c/u (paquetes de recarga: $10 = 1000 créditos).
// Sin este factor, precio_creditos_por_1000 quedaba en escala de dólares
// (ej. 0.18 créditos por algo que cuesta $0.06 al proveedor con margen 3x),
// prácticamente regalando el servicio. Con el factor, ese mismo ejemplo
// queda en 18 créditos (~$0.18), acorde al margen real.
const CREDITOS_POR_USD = 100;

const PROVIDERS = [
  { id: 1, nombre: 'bestsmmprovider', apiUrl: 'https://bestsmmprovider.com/api/v2', apiKey: process.env.BESTSMM_API_KEY },
  { id: 2, nombre: 'smmcpan', apiUrl: 'https://smmcpan.com/api/v2', apiKey: process.env.SMMCPAN_API_KEY },
].filter((p) => !(p.nombre === 'smmcpan' && SMMCPAN_PAUSADO));

// Solo se siguen (y se guardan en nuestra base) los servicios que realmente
// se usan — NO el catálogo completo del proveedor (miles de servicios).
// La API de estos paneles no tiene "traer un solo servicio por ID", así que
// igual hay que pedir el catálogo completo, pero se descarta todo lo que no
// esté en esta lista antes de tocar la base de datos.
const SERVICIOS_SEGUIDOS = {
  1: [3493, 3494, 3495, 3497, 3498, 3766], // bestsmmprovider: seguidores latinos IG (gen/F/M), likes latinos IG (F/M), seguidores latinos tiktok
  2: [
    22533, 13409, 18580, 21386, 21372, 23629, 22911, 18658, 22304, 15595, // Instagram/TikTok (seguidores de Instagram se movió a bestsmmprovider)
    23529, 23531, 5319, // Twitter: seguidores, likes, vistas
    21539, 12188, 17089, // YouTube: suscriptores, vistas, likes
    17179, 17178, 21749, 21087, 22577, // Facebook: seg. perfil, seg. página, likes+seg. página, likes pub, vistas
  ], // smmcpan
};

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
      const todos = await resp.json();
      if (!Array.isArray(todos)) {
        console.error(`[${provider.nombre}] Respuesta inesperada:`, todos);
        continue;
      }
      const seguidos = new Set(SERVICIOS_SEGUIDOS[provider.id] || []);
      const servicios = todos.filter((s) => seguidos.has(Number(s.service)));
      await upsertServiciosBatch(provider.id, servicios);
      console.log(`[${provider.nombre}] Sincronizados ${servicios.length}/${seguidos.size} servicios seguidos`);
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
      filas.push(`($${idx++}, $${idx++}, 'sin_clasificar', 'sin_clasificar', $${idx++}, $${idx++}, 3.0, $${idx++}, $${idx++}, $${idx++}, false, $${idx++})`);
      params.push(
        providerId,
        s.service,
        s.name || 'Servicio sin nombre',
        costoProvider,
        costoProvider * CREDITOS_POR_USD * 3.0,
        s.min,
        s.max,
        s.refill === true
      );
    }

    await pool.query(
      `INSERT INTO services
        (provider_id, provider_service_id, plataforma, tipo, nombre_publico,
         costo_provider_por_1000, margen_multiplicador, precio_creditos_por_1000,
         cantidad_min, cantidad_max, activo, soporta_refill)
       VALUES ${filas.join(', ')}
       ON CONFLICT (provider_id, provider_service_id) DO UPDATE SET
         costo_provider_por_1000 = EXCLUDED.costo_provider_por_1000,
         -- se preserva el margen ya configurado del servicio existente, no el default 3.0
         precio_creditos_por_1000 = EXCLUDED.costo_provider_por_1000 * ${CREDITOS_POR_USD} * services.margen_multiplicador,
         -- cantidad_min es una regla de negocio nuestra (no la del proveedor) — si se
         -- tomara de EXCLUDED, cada sync de 4h borraría los ajustes manuales de mínimos.
         cantidad_max = EXCLUDED.cantidad_max,
         soporta_refill = EXCLUDED.soporta_refill,
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
        if (!info) {
          console.error(`[${provider.nombre}] Sin respuesta de estado para el pedido ${item.provider_order_id} (item ${item.item_id})`);
          continue;
        }
        console.log(`[${provider.nombre}] item ${item.item_id} (orden ${item.provider_order_id}): status=${info.status} remains=${info.remains}`);
        await actualizarEstadoItem(item, info.status, info.remains, reembolsarItem);
      }
    } catch (err) {
      console.error(`[${provider.nombre}] Error al consultar estados:`, err.message);
    }
  }
}

async function actualizarEstadoItem(item, statusProveedor, remains, reembolsarItem) {
  const mapaEstados = {
    Completed: 'completado', 'In progress': 'procesando', Processing: 'procesando',
    Pending: 'procesando', Partial: 'completado', Canceled: 'error', Error: 'error',
  };
  const nuevoEstado = mapaEstados[statusProveedor] || 'procesando';

  if (nuevoEstado === 'error') {
    await reembolsarItem(item.item_id, `Proveedor reportó estado: ${statusProveedor}`);
  } else {
    // "remains" (lo que el proveedor aún no ha entregado) alimenta la barra de
    // progreso del cliente — se guarda tal cual, sin normalizar, la resta la
    // hace el frontend contra cantidad_enviada_proveedor.
    await pool.query(
      'UPDATE order_items SET estado = $1, restantes_proveedor = $2 WHERE id = $3',
      [nuevoEstado, remains ?? null, item.item_id]
    );
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
