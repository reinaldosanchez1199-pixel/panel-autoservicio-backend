// ============================================
// api-routes.js v2
// ============================================

const express = require('express');
const router = express.Router();
const multer = require('multer');
const upload = multer({ dest: 'uploads/comprobantes/' });
const pool = require('../db');
const { crearPedido, aplicarBundle, enviarPedidoAProveedor, obtenerDescuentoNivel, aprobarRecargaManual, solicitarRefill, repetirItem } = require('../wallet');
const { verificarSesion, requiereAdmin } = require('../auth');

// ---------------------------------------------
// CLIENTE — cuenta y catálogo
// ---------------------------------------------

router.get('/me', verificarSesion, async (req, res) => {
  const r = await pool.query('SELECT email, nombre, creado_en, es_admin FROM users WHERE id = $1', [req.userId]);
  if (r.rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });
  res.json(r.rows[0]);
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
    `SELECT id, plataforma, tipo, nombre_publico, precio_creditos_por_1000, cantidad_min, cantidad_max
     FROM services WHERE activo = true ORDER BY plataforma, tipo`
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

router.get('/admin/services/pendientes', verificarSesion, requiereAdmin, async (req, res) => {
  const r = await pool.query(
    `SELECT id, plataforma, tipo, nombre_publico, costo_provider_por_1000, precio_creditos_por_1000
     FROM services WHERE activo = false ORDER BY ultima_sincronizacion DESC`
  );
  res.json(r.rows);
});

router.patch('/admin/services/:id', verificarSesion, requiereAdmin, async (req, res) => {
  const { nombrePublico, plataforma, tipo, margenMultiplicador, activo } = req.body;
  const servicioRes = await pool.query('SELECT costo_provider_por_1000 FROM services WHERE id = $1', [req.params.id]);
  const costo = parseFloat(servicioRes.rows[0].costo_provider_por_1000);
  // Los créditos valen ~$0.01 c/u ($10 = 1000 créditos) — sin este factor
  // el precio quedaba en escala de dólares, casi regalando el servicio.
  const CREDITOS_POR_USD = 100;
  const nuevoPrecio = costo * CREDITOS_POR_USD * parseFloat(margenMultiplicador);

  await pool.query(
    `UPDATE services SET nombre_publico = $1, plataforma = $2, tipo = $3,
     margen_multiplicador = $4, precio_creditos_por_1000 = $5, activo = $6 WHERE id = $7`,
    [nombrePublico, plataforma, tipo, margenMultiplicador, nuevoPrecio, activo, req.params.id]
  );
  res.json({ ok: true });
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
