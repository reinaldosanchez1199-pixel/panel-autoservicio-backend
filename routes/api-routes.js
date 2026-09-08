// ============================================
// api-routes.js v2
// ============================================

const express = require('express');
const router = express.Router();
const multer = require('multer');
const upload = multer({ dest: 'uploads/comprobantes/' });
const pool = require('../db');
const { crearPedido, crearPedidosEnLote, aplicarBundle, enviarPedidoAProveedor, obtenerDescuentoNivel, aprobarRecargaManual, aprobarBonoReferidoManual, rechazarBonoReferido, cancelarItemAdmin, ajustarCreditosManual, solicitarRefill, repetirItem } = require('../wallet');
const { verificarSesion, requiereAdmin, resolverSolicitudReset } = require('../auth');

// ---------------------------------------------
// CLIENTE — cuenta y catálogo
// ---------------------------------------------

router.get('/me', verificarSesion, async (req, res) => {
  const r = await pool.query('SELECT email, nombre, creado_en, es_admin, codigo_referido FROM users WHERE id = $1', [req.userId]);
  if (r.rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });

  const referidosRes = await pool.query(
    `SELECT COUNT(*) AS aprobados FROM bonos_referido WHERE referente_id = $1 AND estado = 'aprobado'`,
    [req.userId]
  );
  const aprobados = parseInt(referidosRes.rows[0].aprobados);

  res.json({ ...r.rows[0], referidos_aprobados: aprobados, creditos_ganados_por_referidos: aprobados * 500 });
});

router.get('/wallet', verificarSesion, async (req, res) => {
  const client = await pool.connect();
  const walletRes = await client.query('SELECT saldo_creditos FROM wallets WHERE user_id = $1', [req.userId]);
  const consumidoRes = await client.query('SELECT creditos_consumidos_total FROM users WHERE id = $1', [req.userId]);
  const nivel = await obtenerDescuentoNivel(client, req.userId);
  client.release();
  res.json({
    saldo: walletRes.rows[0]?.saldo_creditos ?? 0,
    consumido: consumidoRes.rows[0]?.creditos_consumidos_total ?? 0,
    nivel: nivel.nombre,
    descuento_pct: nivel.descuento_pct,
  });
});

router.get('/services', verificarSesion, async (req, res) => {
  const r = await pool.query(
    `SELECT id, plataforma, tipo, nombre_publico, precio_creditos_por_1000, cantidad_min, cantidad_max, dias_garantia
     FROM services WHERE activo = true ORDER BY plataforma, tipo, nombre_publico`
  );
  res.json(r.rows);
});

router.get('/bundles', verificarSesion, async (req, res) => {
  const bundlesRes = await pool.query('SELECT id, nombre, descripcion, precio_creditos FROM bundles WHERE activo = true');
  const bundles = [];
  for (const b of bundlesRes.rows) {
    const itemsRes = await pool.query(
      `SELECT bi.cantidad, s.nombre_publico, s.tipo FROM bundle_items bi
       JOIN services s ON s.id = bi.service_id WHERE bi.bundle_id = $1`,
      [b.id]
    );
    bundles.push({ ...b, items: itemsRes.rows });
  }
  res.json(bundles);
});

router.get('/paquetes-recarga', verificarSesion, async (req, res) => {
  const r = await pool.query(
    'SELECT id, precio_usd, creditos_otorgados FROM paquetes_recarga WHERE activo = true ORDER BY orden'
  );
  res.json(r.rows);
});

router.get('/niveles', verificarSesion, async (req, res) => {
  const r = await pool.query('SELECT nombre, minimo_consumido, descuento_pct FROM niveles ORDER BY orden');
  res.json(r.rows);
});

// ---------------------------------------------
// CLIENTE — perfiles guardados
// ---------------------------------------------

router.get('/perfiles', verificarSesion, async (req, res) => {
  const r = await pool.query(
    'SELECT id, plataforma, nombre_usuario, url FROM perfiles_guardados WHERE user_id = $1',
    [req.userId]
  );
  res.json(r.rows);
});

router.post('/perfiles', verificarSesion, async (req, res) => {
  const { plataforma, nombreUsuario, url } = req.body;
  if (!plataforma || !url) return res.status(400).json({ error: 'Faltan datos' });
  const r = await pool.query(
    `INSERT INTO perfiles_guardados (user_id, plataforma, nombre_usuario, url)
     VALUES ($1, $2, $3, $4) ON CONFLICT (user_id, plataforma, url) DO NOTHING RETURNING id`,
    [req.userId, plataforma, nombreUsuario, url]
  );
  res.json({ id: r.rows[0]?.id });
});

router.delete('/perfiles/:id', verificarSesion, async (req, res) => {
  await pool.query('DELETE FROM perfiles_guardados WHERE id = $1 AND user_id = $2', [req.params.id, req.userId]);
  res.json({ ok: true });
});

// ---------------------------------------------
// CLIENTE — pedidos (multi-item)
// ---------------------------------------------

// Crear pedido con selección múltiple: items = [{ serviceId, cantidad }, ...]
router.post('/orders', verificarSesion, async (req, res) => {
  const { linkCliente, items } = req.body;
  if (!linkCliente || !items?.length) {
    return res.status(400).json({ error: 'Faltan datos: linkCliente, items[]' });
  }
  try {
    const resultado = await crearPedido({ userId: req.userId, linkCliente, items });
    enviarPedidoAProveedor(resultado.pedidoId).catch((err) => console.error('Error al enviar pedido:', err));
    res.json(resultado);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Crear varios pedidos (uno por link, ej. varias cuentas) en una sola operación
// atómica — 3 o más filas activan el descuento de lote (ver crearPedidosEnLote).
// filas = [{ linkCliente, items: [{ serviceId, cantidad }] }, ...]
router.post('/orders/lote', verificarSesion, async (req, res) => {
  const { filas } = req.body;
  if (!filas?.length) return res.status(400).json({ error: 'Faltan datos: filas[]' });
  try {
    const resultado = await crearPedidosEnLote({ userId: req.userId, filas });
    for (const pedidoId of resultado.pedidoIds) {
      enviarPedidoAProveedor(pedidoId).catch((err) => console.error('Error al enviar pedido del lote:', err));
    }
    res.json(resultado);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Crear pedido a partir de un bundle pre-armado
router.post('/orders/bundle', verificarSesion, async (req, res) => {
  const { linkCliente, bundleId } = req.body;
  if (!linkCliente || !bundleId) return res.status(400).json({ error: 'Faltan datos: linkCliente, bundleId' });
  try {
    const resultado = await aplicarBundle({ userId: req.userId, linkCliente, bundleId });
    enviarPedidoAProveedor(resultado.pedidoId).catch((err) => console.error('Error al enviar bundle:', err));
    res.json(resultado);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Lista los pedidos del cliente con sus items (para la pestaña "Pedidos")
router.get('/orders', verificarSesion, async (req, res) => {
  const pedidosRes = await pool.query(
    `SELECT id, link_cliente, estado, costo_total_creditos, descuento_aplicado_pct, creado_en
     FROM orders WHERE user_id = $1 ORDER BY creado_en DESC LIMIT 30`,
    [req.userId]
  );
  const pedidos = [];
  for (const pedido of pedidosRes.rows) {
    const itemsRes = await pool.query(
      `SELECT oi.id, oi.cantidad, oi.costo_creditos, oi.estado,
              oi.refill_solicitado_en, oi.cantidad_enviada_proveedor, oi.restantes_proveedor,
              s.nombre_publico, s.tipo, s.soporta_refill
       FROM order_items oi JOIN services s ON s.id = oi.service_id WHERE oi.order_id = $1`,
      [pedido.id]
    );
    pedidos.push({ ...pedido, items: itemsRes.rows });
  }
  res.json(pedidos);
});

// El cliente solicita la reposición de un item ya entregado — va directo al proveedor.
router.post('/orders/items/:itemId/refill', verificarSesion, async (req, res) => {
  try {
    const resultado = await solicitarRefill(req.params.itemId, req.userId);
    res.json(resultado);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Repite un envío ya completado (mismo servicio/link/cantidad) — no existe
// "cancelar" un pedido, esta es la acción posterior a un envío terminado.
router.post('/orders/items/:itemId/repetir', verificarSesion, async (req, res) => {
  try {
    const resultado = await repetirItem(req.params.itemId, req.userId);
    res.json(resultado);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Estado de un pedido con sus items (para polling desde el frontend)
router.get('/orders/:id', verificarSesion, async (req, res) => {
  const pedidoRes = await pool.query(
    'SELECT id, estado, costo_total_creditos, descuento_aplicado_pct, creado_en FROM orders WHERE id = $1 AND user_id = $2',
    [req.params.id, req.userId]
  );
  if (pedidoRes.rows.length === 0) return res.status(404).json({ error: 'Pedido no encontrado' });

  const itemsRes = await pool.query(
    `SELECT oi.id, oi.cantidad, oi.costo_creditos, oi.estado, s.nombre_publico, s.tipo
     FROM order_items oi JOIN services s ON s.id = oi.service_id WHERE oi.order_id = $1`,
    [req.params.id]
  );
  res.json({ ...pedidoRes.rows[0], items: itemsRes.rows });
});

router.get('/activity', verificarSesion, async (req, res) => {
  const r = await pool.query(
    `SELECT id, tipo, monto, saldo_resultante, nota, creado_en
     FROM transactions WHERE user_id = $1 ORDER BY creado_en DESC LIMIT 30`,
    [req.userId]
  );
  res.json(r.rows);
});

// ---------------------------------------------
// CLIENTE — recargas manuales (ahora por paquete, con bono)
// ---------------------------------------------

// El comprobante es opcional a propósito: el cliente ya lo manda por
// WhatsApp (donde el admin lo ve y lo revisa antes de aprobar); esto solo
// crea el registro "ya pagué" que aparece en el Panel Admin para aprobar.
router.post('/recargas/manual', verificarSesion, upload.single('comprobante'), async (req, res) => {
  const { paqueteId, metodo } = req.body;
  if (!paqueteId) return res.status(400).json({ error: 'Falta el paquete' });

  const paqueteRes = await pool.query('SELECT precio_usd, creditos_otorgados FROM paquetes_recarga WHERE id = $1', [paqueteId]);
  if (paqueteRes.rows.length === 0) return res.status(400).json({ error: 'Paquete inválido' });
  const paquete = paqueteRes.rows[0];

  const r = await pool.query(
    `INSERT INTO recargas_manuales (user_id, paquete_id, monto_declarado, creditos_a_acreditar, comprobante_url, metodo)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [req.userId, paqueteId, paquete.precio_usd, paquete.creditos_otorgados, req.file?.path || null, metodo || null]
  );
  res.json({ recargaId: r.rows[0].id, estado: 'pendiente', creditosAAcreditar: paquete.creditos_otorgados });
});

// ---------------------------------------------
// ADMIN
// ---------------------------------------------

router.get('/admin/recargas', verificarSesion, requiereAdmin, async (req, res) => {
  const r = await pool.query(
    `SELECT rm.id, rm.user_id, u.email, rm.monto_declarado, rm.creditos_a_acreditar,
            rm.comprobante_url, rm.metodo, rm.creado_en
     FROM recargas_manuales rm JOIN users u ON u.id = rm.user_id
     WHERE rm.estado = 'pendiente' ORDER BY rm.creado_en ASC`
  );
  res.json(r.rows);
});

router.post('/admin/recargas/:id/aprobar', verificarSesion, requiereAdmin, async (req, res) => {
  try {
    const nuevoSaldo = await aprobarRecargaManual(req.params.id, req.userId);
    res.json({ ok: true, nuevoSaldo });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/admin/recargas/:id/rechazar', verificarSesion, requiereAdmin, async (req, res) => {
  await pool.query(
    "UPDATE recargas_manuales SET estado = 'rechazado', revisado_por = $1, revisado_en = now() WHERE id = $2",
    [req.userId, req.params.id]
  );
  res.json({ ok: true });
});

// Detalle de clientes: saldo actual y cuánto ha recargado cada uno en total
// (solo recargas aprobadas), para que el admin tenga visibilidad financiera.
router.get('/admin/clientes', verificarSesion, requiereAdmin, async (req, res) => {
  const { email } = req.query;
  const r = await pool.query(
    `SELECT u.id, u.email, u.nombre, u.creado_en, u.creditos_consumidos_total, u.activo,
            w.saldo_creditos,
            COALESCE(r.total_recargado_usd, 0) AS total_recargado_usd,
            COALESCE(r.total_creditos_recargados, 0) AS total_creditos_recargados,
            COALESCE(r.cantidad_recargas, 0) AS cantidad_recargas
     FROM users u
     JOIN wallets w ON w.user_id = u.id
     LEFT JOIN (
       SELECT user_id, SUM(monto_declarado) AS total_recargado_usd,
              SUM(creditos_a_acreditar) AS total_creditos_recargados, COUNT(*) AS cantidad_recargas
       FROM recargas_manuales WHERE estado = 'aprobado' GROUP BY user_id
     ) r ON r.user_id = u.id
     WHERE u.es_admin = false ${email ? 'AND u.email ILIKE $1' : ''}
     ORDER BY total_recargado_usd DESC NULLS LAST
     LIMIT 100`,
    email ? [`%${email}%`] : []
  );
  res.json(r.rows);
});

router.post('/admin/clientes/:id/suspender', verificarSesion, requiereAdmin, async (req, res) => {
  await pool.query('UPDATE users SET activo = false WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

router.post('/admin/clientes/:id/reactivar', verificarSesion, requiereAdmin, async (req, res) => {
  await pool.query('UPDATE users SET activo = true WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// Ajuste manual de créditos (positivo suma, negativo resta) — ej. compensar
// al cliente o descontar el costo de un envío hecho a mano con otro proveedor.
router.post('/admin/clientes/:id/ajustar-creditos', verificarSesion, requiereAdmin, async (req, res) => {
  const { monto, motivo } = req.body;
  if (monto === undefined || isNaN(parseFloat(monto)) || parseFloat(monto) === 0) {
    return res.status(400).json({ error: 'Falta un monto válido (positivo para sumar, negativo para restar)' });
  }
  try {
    const nuevoSaldo = await ajustarCreditosManual(req.params.id, parseFloat(monto), motivo, req.userId);
    res.json({ ok: true, nuevoSaldo });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Cancela un item de pedido que aún no se completó y devuelve sus créditos.
router.post('/admin/orders/items/:id/cancelar', verificarSesion, requiereAdmin, async (req, res) => {
  try {
    await cancelarItemAdmin(req.params.id, req.body?.motivo);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Bonos de referido marcados "sospechoso" por procesarBonoReferido — un
// admin decide si son de verdad dos personas distintas o la misma con dos cuentas.
router.get('/admin/referidos/sospechosos', verificarSesion, requiereAdmin, async (req, res) => {
  const r = await pool.query(
    `SELECT b.id, b.motivo_sospecha, b.creado_en,
            ur.email AS referente_email, uo.email AS referido_email, uo.ip_registro
     FROM bonos_referido b
     JOIN users ur ON ur.id = b.referente_id
     JOIN users uo ON uo.id = b.referido_id
     WHERE b.estado = 'sospechoso' ORDER BY b.creado_en ASC`
  );
  res.json(r.rows);
});

router.post('/admin/referidos/:id/aprobar', verificarSesion, requiereAdmin, async (req, res) => {
  try {
    await aprobarBonoReferidoManual(req.params.id, req.userId);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/admin/referidos/:id/rechazar', verificarSesion, requiereAdmin, async (req, res) => {
  await rechazarBonoReferido(req.params.id, req.userId);
  res.json({ ok: true });
});

// Solicitudes de recuperación de contraseña (sin correo — se resuelven por
// WhatsApp): el admin verifica al cliente y genera una contraseña temporal.
router.get('/admin/solicitudes-reset', verificarSesion, requiereAdmin, async (req, res) => {
  const r = await pool.query(
    `SELECT s.id, s.creado_en, u.email
     FROM solicitudes_reset_password s JOIN users u ON u.id = s.user_id
     WHERE s.estado = 'pendiente' ORDER BY s.creado_en ASC`
  );
  res.json(r.rows);
});

router.post('/admin/solicitudes-reset/:id/resolver', verificarSesion, requiereAdmin, async (req, res) => {
  try {
    const passwordTemporal = await resolverSolicitudReset(req.params.id, req.userId);
    res.json({ ok: true, passwordTemporal });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Historial de pedidos de TODOS los clientes, para revisión o corrección
// manual. ?email=algo filtra por coincidencia parcial (para buscar rápido).
router.get('/admin/orders', verificarSesion, requiereAdmin, async (req, res) => {
  const { email } = req.query;
  const params = [];
  let where = '';
  if (email) {
    params.push(`%${email}%`);
    where = `WHERE u.email ILIKE $${params.length}`;
  }
  const pedidosRes = await pool.query(
    `SELECT o.id, o.link_cliente, o.estado, o.costo_total_creditos, o.creado_en, u.email
     FROM orders o JOIN users u ON u.id = o.user_id
     ${where}
     ORDER BY o.creado_en DESC LIMIT 100`,
    params
  );
  const pedidos = [];
  for (const pedido of pedidosRes.rows) {
    const itemsRes = await pool.query(
      `SELECT oi.id, oi.cantidad, oi.costo_creditos, oi.estado, oi.provider_order_id,
              oi.cantidad_enviada_proveedor, oi.restantes_proveedor,
              s.nombre_publico, s.tipo, s.plataforma
       FROM order_items oi JOIN services s ON s.id = oi.service_id WHERE oi.order_id = $1`,
      [pedido.id]
    );
    pedidos.push({ ...pedido, items: itemsRes.rows });
  }
  res.json(pedidos);
});

router.get('/admin/services/pendientes', verificarSesion, requiereAdmin, async (req, res) => {
  const r = await pool.query(
    `SELECT id, plataforma, tipo, nombre_publico, costo_provider_por_1000, precio_creditos_por_1000
     FROM services WHERE activo = false ORDER BY ultima_sincronizacion DESC`
  );
  res.json(r.rows);
});

// Catálogo activo completo con detalle de proveedor — para gestión desde admin
// (el endpoint público /services nunca expone provider_id/provider_service_id).
router.get('/admin/services', verificarSesion, requiereAdmin, async (req, res) => {
  const r = await pool.query(
    `SELECT id, provider_id, provider_service_id, plataforma, tipo, nombre_publico,
            precio_creditos_por_1000, cantidad_min, cantidad_max, soporta_refill, dias_garantia
     FROM services WHERE activo = true ORDER BY plataforma, tipo`
  );
  res.json(r.rows);
});

// Fuerza una sincronización de precios inmediata (el cron corre cada 4h) —
// útil al agregar un servicio nuevo a SERVICIOS_SEGUIDOS y no querer esperar.
router.post('/admin/sync/precios', verificarSesion, requiereAdmin, async (req, res) => {
  const { sincronizarPrecios } = require('../sync');
  await sincronizarPrecios();
  res.json({ ok: true });
});

router.patch('/admin/services/:id', verificarSesion, requiereAdmin, async (req, res) => {
  try {
    const { nombrePublico, plataforma, tipo, margenMultiplicador, activo, diasGarantia } = req.body;
    const servicioRes = await pool.query('SELECT costo_provider_por_1000, margen_multiplicador FROM services WHERE id = $1', [req.params.id]);
    if (servicioRes.rows.length === 0) return res.status(404).json({ error: 'Servicio no encontrado' });
    const costo = parseFloat(servicioRes.rows[0].costo_provider_por_1000);
    // margenMultiplicador es opcional — si no se manda (ej. solo se está
    // actualizando dias_garantia), se conserva el margen/precio actuales en
    // vez de recalcular con un valor undefined (eso ponía el precio en NaN).
    const margenFinal = margenMultiplicador !== undefined ? parseFloat(margenMultiplicador) : parseFloat(servicioRes.rows[0].margen_multiplicador);
    // margen_multiplicador es NUMERIC(5,2) en la base — un costo del proveedor
    // casi nulo puede pedir un margen absurdamente alto para llegar al precio
    // deseado; se limita antes de llegar a la base para no tirar la conexión.
    if (!Number.isFinite(margenFinal) || margenFinal <= 0 || margenFinal >= 1000) {
      return res.status(400).json({ error: 'El margen debe ser un número mayor a 0 y menor a 1000' });
    }
    // Los créditos valen ~$0.01 c/u ($10 = 1000 créditos) — sin este factor
    // el precio quedaba en escala de dólares, casi regalando el servicio.
    const CREDITOS_POR_USD = 100;
    const nuevoPrecio = costo * CREDITOS_POR_USD * margenFinal;

    await pool.query(
      `UPDATE services SET nombre_publico = COALESCE($1, nombre_publico), plataforma = COALESCE($2, plataforma),
       tipo = COALESCE($3, tipo), margen_multiplicador = $4, precio_creditos_por_1000 = $5,
       activo = COALESCE($6, activo), dias_garantia = COALESCE($7, dias_garantia) WHERE id = $8`,
      [nombrePublico ?? null, plataforma ?? null, tipo ?? null, margenFinal, nuevoPrecio, activo ?? null, diasGarantia ?? null, req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Crear/editar bundles desde el admin
router.post('/admin/bundles', verificarSesion, requiereAdmin, async (req, res) => {
  const { nombre, descripcion, precioCreditos, items } = req.body; // items = [{ serviceId, cantidad }]
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const bundleRes = await client.query(
      'INSERT INTO bundles (nombre, descripcion, precio_creditos) VALUES ($1, $2, $3) RETURNING id',
      [nombre, descripcion, precioCreditos]
    );
    const bundleId = bundleRes.rows[0].id;
    for (const item of items) {
      await client.query(
        'INSERT INTO bundle_items (bundle_id, service_id, cantidad) VALUES ($1, $2, $3)',
        [bundleId, item.serviceId, item.cantidad]
      );
    }
    await client.query('COMMIT');
    res.json({ id: bundleId });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
