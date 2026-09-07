// ============================================
// wallet.js v2 — pedidos multi-item, niveles con descuento,
// bundles y paquetes de recarga con bono
// ============================================

const pool = require('./db');

// Descuento por volumen, en bandas progresivas (no depende del historial del
// cliente, se ve al instante en el pedido). Cada banda define hasta qué
// cantidad aplica, de cuánto en cuánto se suma el % dentro de esa banda, y
// qué % suma cada tramo. El límite de una banda es el tamaño de tramo de la
// siguiente. Debe coincidir con el mismo mapa en Dashboard.jsx.
const BANDAS_DESCUENTO_CANTIDAD = {
  Seguidores: [
    { hasta: 2000, tramo: 500, pct: 3 },
    { hasta: 5000, tramo: 2000, pct: 5 },
    { hasta: Infinity, tramo: 5000, pct: 7 },
  ],
  Likes: [
    { hasta: 2000, tramo: 500, pct: 3 },
    { hasta: 5000, tramo: 2000, pct: 5 },
    { hasta: Infinity, tramo: 5000, pct: 7 },
  ],
  Reproducciones: [
    { hasta: 20000, tramo: 4000, pct: 3 },
    { hasta: 50000, tramo: 20000, pct: 5 },
    { hasta: Infinity, tramo: 50000, pct: 7 },
  ],
  'Alcance + Impresiones': [
    { hasta: 20000, tramo: 4000, pct: 3 },
    { hasta: 50000, tramo: 20000, pct: 5 },
    { hasta: Infinity, tramo: 50000, pct: 7 },
  ],
  Guardados: [
    { hasta: 2000, tramo: 400, pct: 3 },
    { hasta: 5000, tramo: 2000, pct: 5 },
    { hasta: Infinity, tramo: 5000, pct: 7 },
  ],
  Compartidos: [
    { hasta: 2000, tramo: 400, pct: 3 },
    { hasta: 5000, tramo: 2000, pct: 5 },
    { hasta: Infinity, tramo: 5000, pct: 7 },
  ],
  Reposts: [
    { hasta: 360, tramo: 120, pct: 3 },
    { hasta: 1000, tramo: 360, pct: 5 },
    { hasta: Infinity, tramo: 1000, pct: 7 },
  ],
};
const TOPE_DESCUENTO_CANTIDAD = 35; // margen de seguridad en pedidos enormes

function descuentoPorCantidad(tipo, cantidad) {
  const bandas = BANDAS_DESCUENTO_CANTIDAD[tipo];
  if (!bandas) return 0;
  let descuento = 0;
  let desde = 0;
  for (const banda of bandas) {
    const tramoCubierto = Math.min(cantidad, banda.hasta) - desde;
    if (tramoCubierto > 0) descuento += Math.floor(tramoCubierto / banda.tramo) * banda.pct;
    if (cantidad <= banda.hasta) break;
    desde = banda.hasta;
  }
  return Math.min(TOPE_DESCUENTO_CANTIDAD, descuento);
}

// El 10% de compensación (para contrarrestar caídas naturales) solo aplica a
// seguidores/suscriptores — el resto de servicios (likes, vistas, guardados...)
// son estables y no lo necesitan.
function requiereCompensacion(tipo) {
  return tipo === 'Seguidores';
}

// Interacciones "de publicación" — reciben un extra aleatorio (no un % fijo,
// a diferencia de Seguidores) para que dos publicaciones con la misma compra
// no queden con el numero exacto de interacciones, lo cual se ve artificial.
const TIPOS_VARIACION = ['Likes', 'Reproducciones', 'Guardados', 'Compartidos', 'Reposts', 'Alcance + Impresiones'];
function requiereVariacion(tipo) {
  return TIPOS_VARIACION.includes(tipo);
}
// Entre 5% y 10%, distinto en cada pedido.
function bonoVariacion() {
  return 1 + (0.05 + Math.random() * 0.05);
}

// Combo "impulsa tu publicación completa" — comprar juntos, en el mismo
// pedido, todos los tipos que exige la plataforma da 20% de descuento (ver
// crearPedido). Los requisitos varían por plataforma porque el catálogo real
// de servicios varía por plataforma (ej. TikTok no tiene Repost; Facebook no
// tiene Guardados/Compartidos). En Instagram, Reproducciones es opcional: si
// se agrega también recibe el 20%, pero no hace falta para activar el combo.
const REGLAS_COMBO_PUBLICACION = {
  Instagram: ['Likes', 'Guardados', 'Compartidos', 'Reposts'],
  TikTok: ['Likes', 'Guardados', 'Compartidos', 'Reproducciones'],
  Facebook: ['Likes', 'Reproducciones'],
};

/**
 * Calcula el % de descuento del cliente según su consumo histórico.
 */
async function obtenerDescuentoNivel(client, userId) {
  const userRes = await client.query(
    'SELECT creditos_consumidos_total FROM users WHERE id = $1',
    [userId]
  );
  const consumido = parseFloat(userRes.rows[0].creditos_consumidos_total);

  const nivelRes = await client.query(
    `SELECT nombre, descuento_pct FROM niveles
     WHERE minimo_consumido <= $1 ORDER BY minimo_consumido DESC LIMIT 1`,
    [consumido]
  );
  return nivelRes.rows[0] || { nombre: 'Starter', descuento_pct: 0 };
}

/**
 * Crea un pedido con uno o varios items (multi-selección: views + likes + guardados).
 * items = [{ serviceId, cantidad }, ...]
 * Todo dentro de una transacción SQL: valida saldo, aplica descuento de nivel,
 * descuenta una sola vez el total, crea el pedido y cada item.
 */
async function crearPedido({ userId, linkCliente, items, bundleId = null }) {
  if (!items || items.length === 0) throw new Error('El pedido necesita al menos un item');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const walletRes = await client.query(
      'SELECT saldo_creditos FROM wallets WHERE user_id = $1 FOR UPDATE',
      [userId]
    );
    if (walletRes.rows.length === 0) throw new Error('Wallet no encontrado');
    const saldoActual = parseFloat(walletRes.rows[0].saldo_creditos);

    const { nombre: nombreNivel, descuento_pct } = await obtenerDescuentoNivel(client, userId);

    // Calcula el costo de cada item con su servicio, aplicando el descuento de nivel
    const itemsCalculados = [];
    let costoTotal = 0;

    for (const item of items) {
      const servicioRes = await client.query(
        `SELECT id, tipo, plataforma, nombre_publico, precio_creditos_por_1000, cantidad_min, cantidad_max, activo
         FROM services WHERE id = $1`,
        [item.serviceId]
      );
      if (servicioRes.rows.length === 0) throw new Error(`Servicio ${item.serviceId} no encontrado`);
      const servicio = servicioRes.rows[0];
      if (!servicio.activo) throw new Error(`Servicio ${item.serviceId} no disponible`);
      if (item.cantidad < servicio.cantidad_min || item.cantidad > servicio.cantidad_max) {
        throw new Error(`Cantidad fuera de rango para el servicio ${item.serviceId}`);
      }

      const descuentoTotalPct = Math.min(45, descuento_pct + descuentoPorCantidad(servicio.tipo, item.cantidad));
      const costoBase = (item.cantidad / 1000) * parseFloat(servicio.precio_creditos_por_1000);
      const costoConDescuento = costoBase * (1 - descuentoTotalPct / 100);

      itemsCalculados.push({
        serviceId: item.serviceId,
        cantidad: item.cantidad,
        costo: costoConDescuento,
        plataforma: servicio.plataforma,
        nombre_publico: servicio.nombre_publico,
        tipo: servicio.tipo,
      });
      costoTotal += costoConDescuento;
    }

    // Combo de publicación: si el pedido trae todos los tipos que exige la
    // plataforma (ver REGLAS_COMBO_PUBLICACION), se premia con 20% adicional
    // por comprar todo junto en vez de por separado. Se asume una sola
    // plataforma por pedido, que es como Impulsar arma cada fila.
    const tiposPresentes = new Set(itemsCalculados.map((i) => i.tipo));
    const requeridosCombo = REGLAS_COMBO_PUBLICACION[itemsCalculados[0]?.plataforma];
    const esComboPublicacion = !!requeridosCombo && requeridosCombo.every((t) => tiposPresentes.has(t));
    if (esComboPublicacion) {
      costoTotal = 0;
      for (const item of itemsCalculados) {
        item.costo *= 0.80;
        costoTotal += item.costo;
      }
    }

    if (saldoActual < costoTotal) throw new Error('Saldo insuficiente');

    const nuevoSaldo = saldoActual - costoTotal;
    await client.query(
      'UPDATE wallets SET saldo_creditos = $1, actualizado_en = now() WHERE user_id = $2',
      [nuevoSaldo, userId]
    );
    await client.query(
      'UPDATE users SET creditos_consumidos_total = creditos_consumidos_total + $1 WHERE id = $2',
      [costoTotal, userId]
    );

    const pedidoRes = await client.query(
      `INSERT INTO orders (user_id, link_cliente, bundle_id, costo_total_creditos, descuento_aplicado_pct, estado)
       VALUES ($1, $2, $3, $4, $5, 'pendiente') RETURNING id`,
      [userId, linkCliente, bundleId, costoTotal, descuento_pct]
    );
    const pedidoId = pedidoRes.rows[0].id;

    const itemsCreados = [];
    for (const item of itemsCalculados) {
      const itemRes = await client.query(
        `INSERT INTO order_items (order_id, service_id, cantidad, costo_creditos, estado)
         VALUES ($1, $2, $3, $4, 'pendiente') RETURNING id`,
        [pedidoId, item.serviceId, item.cantidad, item.costo]
      );
      itemsCreados.push({ itemId: itemRes.rows[0].id, ...item });
    }

    // Nota descriptiva real (ej. "100 Likes Latinos Femeninos · Instagram") en vez de un
    // genérico "Nueva campaña" — el cliente necesita saber qué pidió en cada uno.
    const notaPedido = esComboPublicacion
      ? `Combo de publicación (-20%) · ${itemsCalculados[0].plataforma}`
      : itemsCalculados.length === 1
      ? `${itemsCalculados[0].cantidad.toLocaleString()} ${itemsCalculados[0].nombre_publico} · ${itemsCalculados[0].plataforma}`
      : `${[...new Set(itemsCalculados.map((i) => i.plataforma))].join(' + ')} · ${itemsCalculados.length} servicios`;
    await client.query(
      `INSERT INTO transactions (user_id, tipo, monto, saldo_resultante, referencia_orden, nota)
       VALUES ($1, 'consumo', $2, $3, $4, $5)`,
      [userId, -costoTotal, nuevoSaldo, pedidoId, notaPedido]
    );

    await client.query('COMMIT');
    return { pedidoId, costoTotal, nuevoSaldo, nombreNivel, descuento_pct, items: itemsCreados };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Impulsar 3 o más cuentas en el mismo envío (sección Impulsar en lote) da un
// 10% adicional sobre el total — se calcula server-side igual que el combo de
// publicación, nunca se confía en un porcentaje que mande el cliente.
const MINIMO_CUENTAS_LOTE = 3;
const DESCUENTO_LOTE_PCT = 15;

/**
 * Crea varios pedidos independientes (un link distinto por fila, ej. varias
 * cuentas de seguidores) como una sola operación atómica. Si son 3 o más
 * filas, se aplica el descuento de lote sobre todos los items.
 * filas = [{ linkCliente, items: [{ serviceId, cantidad }] }, ...]
 */
async function crearPedidosEnLote({ userId, filas }) {
  if (!filas || filas.length === 0) throw new Error('El lote necesita al menos una fila');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const walletRes = await client.query('SELECT saldo_creditos FROM wallets WHERE user_id = $1 FOR UPDATE', [userId]);
    if (walletRes.rows.length === 0) throw new Error('Wallet no encontrado');
    let saldoCorriente = parseFloat(walletRes.rows[0].saldo_creditos);

    const { descuento_pct } = await obtenerDescuentoNivel(client, userId);
    const descuentoLotePct = filas.length >= MINIMO_CUENTAS_LOTE ? DESCUENTO_LOTE_PCT : 0;

    const filasCalculadas = [];
    let costoTotalLote = 0;

    for (const fila of filas) {
      if (!fila.items || fila.items.length === 0) throw new Error('Cada fila del lote necesita al menos un item');
      const itemsCalculados = [];
      let costoFila = 0;

      for (const item of fila.items) {
        const servicioRes = await client.query(
          `SELECT id, tipo, plataforma, nombre_publico, precio_creditos_por_1000, cantidad_min, cantidad_max, activo
           FROM services WHERE id = $1`,
          [item.serviceId]
        );
        if (servicioRes.rows.length === 0) throw new Error(`Servicio ${item.serviceId} no encontrado`);
        const servicio = servicioRes.rows[0];
        if (!servicio.activo) throw new Error(`Servicio ${item.serviceId} no disponible`);
        if (item.cantidad < servicio.cantidad_min || item.cantidad > servicio.cantidad_max) {
          throw new Error(`Cantidad fuera de rango para el servicio ${item.serviceId}`);
        }

        const descuentoTotalPct = Math.min(45, descuento_pct + descuentoPorCantidad(servicio.tipo, item.cantidad));
        const costoBase = (item.cantidad / 1000) * parseFloat(servicio.precio_creditos_por_1000);
        let costoConDescuento = costoBase * (1 - descuentoTotalPct / 100);
        if (descuentoLotePct > 0) costoConDescuento *= 1 - descuentoLotePct / 100;

        itemsCalculados.push({
          serviceId: item.serviceId,
          cantidad: item.cantidad,
          costo: costoConDescuento,
          plataforma: servicio.plataforma,
          nombre_publico: servicio.nombre_publico,
        });
        costoFila += costoConDescuento;
      }

      filasCalculadas.push({ linkCliente: fila.linkCliente, itemsCalculados, costoFila });
      costoTotalLote += costoFila;
    }

    if (saldoCorriente < costoTotalLote) throw new Error('Saldo insuficiente');

    await client.query('UPDATE users SET creditos_consumidos_total = creditos_consumidos_total + $1 WHERE id = $2', [costoTotalLote, userId]);

    const pedidoIds = [];
    for (const fila of filasCalculadas) {
      saldoCorriente -= fila.costoFila;
      const pedidoRes = await client.query(
        `INSERT INTO orders (user_id, link_cliente, costo_total_creditos, descuento_aplicado_pct, estado)
         VALUES ($1, $2, $3, $4, 'pendiente') RETURNING id`,
        [userId, fila.linkCliente, fila.costoFila, descuento_pct + descuentoLotePct]
      );
      const pedidoId = pedidoRes.rows[0].id;

      for (const item of fila.itemsCalculados) {
        await client.query(
          `INSERT INTO order_items (order_id, service_id, cantidad, costo_creditos, estado)
           VALUES ($1, $2, $3, $4, 'pendiente')`,
          [pedidoId, item.serviceId, item.cantidad, item.costo]
        );
      }

      const notaPedido = descuentoLotePct > 0
        ? `Cuentas en simultáneo (-${descuentoLotePct}%) · ${fila.itemsCalculados[0].plataforma}`
        : `${fila.itemsCalculados[0].cantidad.toLocaleString()} ${fila.itemsCalculados[0].nombre_publico} · ${fila.itemsCalculados[0].plataforma}`;
      await client.query(
        `INSERT INTO transactions (user_id, tipo, monto, saldo_resultante, referencia_orden, nota)
         VALUES ($1, 'consumo', $2, $3, $4, $5)`,
        [userId, -fila.costoFila, saldoCorriente, pedidoId, notaPedido]
      );

      pedidoIds.push(pedidoId);
    }

    await client.query('UPDATE wallets SET saldo_creditos = $1, actualizado_en = now() WHERE user_id = $2', [saldoCorriente, userId]);

    await client.query('COMMIT');
    return { pedidoIds, costoTotalLote, descuentoLotePct };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Expande un bundle en su lista de items y llama a crearPedido.
 */
async function aplicarBundle({ userId, linkCliente, bundleId }) {
  const bundleItemsRes = await pool.query(
    'SELECT service_id, cantidad FROM bundle_items WHERE bundle_id = $1',
    [bundleId]
  );
  if (bundleItemsRes.rows.length === 0) throw new Error('Bundle sin items configurados');

  const items = bundleItemsRes.rows.map((r) => ({ serviceId: r.service_id, cantidad: r.cantidad }));
  return crearPedido({ userId, linkCliente, items, bundleId });
}

/**
 * Envía cada item de un pedido al proveedor correspondiente.
 */
async function enviarPedidoAProveedor(pedidoId) {
  const itemsRes = await pool.query(
    `SELECT oi.id AS item_id, oi.service_id, oi.cantidad, o.link_cliente,
            s.provider_service_id, s.cantidad_max, s.tipo, p.api_url, p.api_key
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     JOIN services s ON s.id = oi.service_id
     JOIN providers p ON p.id = s.provider_id
     WHERE oi.order_id = $1 AND oi.estado = 'pendiente'`,
    [pedidoId]
  );

  for (const item of itemsRes.rows) {
    try {
      // Se envía un 10% extra sobre lo comprado (misma práctica que viralizame.com)
      // para compensar caídas naturales — solo en seguidores/suscriptores. En
      // likes/reproducciones/etc. se manda un extra aleatorio de 5-10% para
      // que las interacciones de cada publicación no queden en un número
      // exacto y sospechosamente idéntico entre publicaciones.
      const cantidadConBono = requiereCompensacion(item.tipo)
        ? Math.min(item.cantidad_max, Math.round(item.cantidad * 1.1))
        : requiereVariacion(item.tipo)
        ? Math.min(item.cantidad_max, Math.round(item.cantidad * bonoVariacion()))
        : item.cantidad;
      const resp = await fetch(item.api_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          key: item.api_key,
          action: 'add',
          service: item.provider_service_id,
          link: item.link_cliente,
          quantity: cantidadConBono,
        }),
      });
      const data = await resp.json();
      if (data.error) throw new Error(data.error);

      await pool.query(
        "UPDATE order_items SET provider_order_id = $1, estado = 'procesando', cantidad_enviada_proveedor = $2 WHERE id = $3",
        [data.order, cantidadConBono, item.item_id]
      );
    } catch (err) {
      await reembolsarItem(item.item_id, `Fallo al enviar: ${err.message}`);
    }
  }

  await actualizarEstadoAgregadoPedido(pedidoId);
}

/**
 * Reembolsa un item individual (no todo el pedido) y actualiza el estado agregado.
 * "motivo" es para los logs del servidor (diagnóstico técnico) — nunca se le
 * muestra al cliente tal cual, para no filtrar detalles de la integración
 * con el proveedor (nombres de servicio, errores de API, etc.).
 */
async function reembolsarItem(itemId, motivo) {
  console.error(`Reembolso de item ${itemId}: ${motivo}`);
  const NOTA_CLIENTE = 'No pudimos completar este servicio — créditos reembolsados automáticamente.';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const itemRes = await client.query(
      `SELECT oi.order_id, oi.costo_creditos, oi.estado, o.user_id
       FROM order_items oi JOIN orders o ON o.id = oi.order_id
       WHERE oi.id = $1 FOR UPDATE`,
      [itemId]
    );
    const item = itemRes.rows[0];
    if (!item || item.estado === 'reembolsado') {
      await client.query('ROLLBACK');
      return;
    }

    const walletRes = await client.query(
      'SELECT saldo_creditos FROM wallets WHERE user_id = $1 FOR UPDATE',
      [item.user_id]
    );
    const nuevoSaldo = parseFloat(walletRes.rows[0].saldo_creditos) + parseFloat(item.costo_creditos);

    await client.query('UPDATE wallets SET saldo_creditos = $1, actualizado_en = now() WHERE user_id = $2', [nuevoSaldo, item.user_id]);
    await client.query("UPDATE order_items SET estado = 'reembolsado' WHERE id = $1", [itemId]);
    await client.query(
      `INSERT INTO transactions (user_id, tipo, monto, saldo_resultante, referencia_orden, nota)
       VALUES ($1, 'reembolso', $2, $3, $4, $5)`,
      [item.user_id, item.costo_creditos, nuevoSaldo, item.order_id, NOTA_CLIENTE]
    );

    await client.query('COMMIT');
    await actualizarEstadoAgregadoPedido(item.order_id);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * El pedido (header) refleja el estado agregado de sus items:
 * completado solo si TODOS están completados; error si alguno falló sin reembolso pendiente.
 */
async function actualizarEstadoAgregadoPedido(pedidoId) {
  const itemsRes = await pool.query('SELECT estado FROM order_items WHERE order_id = $1', [pedidoId]);
  const estados = itemsRes.rows.map((r) => r.estado);

  let estadoPedido;
  if (estados.every((e) => e === 'completado')) estadoPedido = 'completado';
  else if (estados.every((e) => e === 'reembolsado')) estadoPedido = 'reembolsado';
  else if (estados.some((e) => e === 'procesando' || e === 'pendiente')) estadoPedido = 'procesando';
  else estadoPedido = 'error';

  await pool.query(
    'UPDATE orders SET estado = $1, actualizado_en = now() WHERE id = $2',
    [estadoPedido, pedidoId]
  );
}

/**
 * Acredita una recarga manual ya aprobada, usando el paquete (créditos con bono incluido).
 */
async function aprobarRecargaManual(recargaId, adminUserId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const recargaRes = await client.query(
      'SELECT user_id, creditos_a_acreditar, estado FROM recargas_manuales WHERE id = $1 FOR UPDATE',
      [recargaId]
    );
    const recarga = recargaRes.rows[0];
    if (!recarga || recarga.estado !== 'pendiente') {
      await client.query('ROLLBACK');
      throw new Error('Recarga no válida o ya procesada');
    }

    const walletRes = await client.query(
      'SELECT saldo_creditos FROM wallets WHERE user_id = $1 FOR UPDATE',
      [recarga.user_id]
    );
    const nuevoSaldo = parseFloat(walletRes.rows[0].saldo_creditos) + parseFloat(recarga.creditos_a_acreditar);

    await client.query('UPDATE wallets SET saldo_creditos = $1, actualizado_en = now() WHERE user_id = $2', [nuevoSaldo, recarga.user_id]);
    await client.query(
      "UPDATE recargas_manuales SET estado = 'aprobado', revisado_por = $1, revisado_en = now() WHERE id = $2",
      [adminUserId, recargaId]
    );
    await client.query(
      `INSERT INTO transactions (user_id, tipo, monto, saldo_resultante, referencia_comprobante, nota)
       VALUES ($1, 'recarga_manual', $2, $3, $4, 'Recarga aprobada manualmente')`,
      [recarga.user_id, recarga.creditos_a_acreditar, nuevoSaldo, recargaId]
    );

    await client.query('COMMIT');
    return nuevoSaldo;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * El cliente pide la reposición de un item ya entregado (ej. bajaron los seguidores).
 * La solicitud va directo al proveedor vía action=refill — nadie de Viralizame
 * tiene que tocar nada manualmente. Solo se permite una vez por item, y solo si
 * el servicio soporta refill según el proveedor.
 */
async function solicitarRefill(itemId, userId) {
  const itemRes = await pool.query(
    `SELECT oi.id AS item_id, oi.provider_order_id, oi.estado, oi.refill_solicitado_en,
            s.soporta_refill, s.tipo, p.api_url, p.api_key
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     JOIN services s ON s.id = oi.service_id
     JOIN providers p ON p.id = s.provider_id
     WHERE oi.id = $1 AND o.user_id = $2`,
    [itemId, userId]
  );
  const item = itemRes.rows[0];
  if (!item) throw new Error('Pedido no encontrado');
  // Reposición solo para Seguidores/Suscriptores — el resto de servicios son
  // estables y no la necesitan, aunque el proveedor técnicamente la soporte.
  if (!item.soporta_refill || !requiereCompensacion(item.tipo)) throw new Error('Este servicio no admite reposición');
  if (item.estado !== 'completado') throw new Error('Solo se puede reponer un pedido ya completado');
  if (item.refill_solicitado_en) throw new Error('Ya se solicitó una reposición para este pedido');
  if (!item.provider_order_id) throw new Error('Este pedido todavía no se puede reponer, intenta en unos minutos');

  const resp = await fetch(item.api_url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ key: item.api_key, action: 'refill', order: item.provider_order_id }),
    signal: AbortSignal.timeout(20000),
  });
  const data = await resp.json();
  if (data.error) throw new Error(data.error);

  await pool.query('UPDATE order_items SET refill_solicitado_en = now() WHERE id = $1', [itemId]);
  return { ok: true, refillId: data.refill ?? null };
}

/**
 * Repite un envío ya completado: mismo servicio, mismo link y misma cantidad
 * del pedido original, como un pedido nuevo — se cobra de nuevo en créditos
 * (a precio/descuento vigentes) y se manda de inmediato al proveedor. No existe
 * "cancelar" un pedido; esta es la única acción posterior a un envío.
 */
async function repetirItem(itemId, userId) {
  const itemRes = await pool.query(
    `SELECT oi.service_id, oi.cantidad, oi.estado, o.link_cliente, o.user_id
     FROM order_items oi JOIN orders o ON o.id = oi.order_id
     WHERE oi.id = $1`,
    [itemId]
  );
  const item = itemRes.rows[0];
  if (!item || item.user_id !== userId) throw new Error('Pedido no encontrado');
  if (item.estado !== 'completado') throw new Error('Solo se puede repetir un envío ya completado');

  const resultado = await crearPedido({
    userId,
    linkCliente: item.link_cliente,
    items: [{ serviceId: item.service_id, cantidad: item.cantidad }],
  });
  enviarPedidoAProveedor(resultado.pedidoId).catch((err) => console.error('Error al enviar repetición:', err));
  return resultado;
}

module.exports = {
  crearPedido,
  crearPedidosEnLote,
  aplicarBundle,
  enviarPedidoAProveedor,
  reembolsarItem,
  aprobarRecargaManual,
  obtenerDescuentoNivel,
  actualizarEstadoAgregadoPedido,
  solicitarRefill,
  repetirItem,
};
