// ============================================
// recargas-routes.js — Recargas v2: el cliente ve las instrucciones de pago y
// adjunta su comprobante dentro de la plataforma (sin pasar por WhatsApp).
//
// Reglas que se mantienen:
//  - Los créditos y montos SIEMPRE salen del paquete en la base de datos
//    (el cliente solo manda paqueteId y método).
//  - Un comprobante NUNCA acredita nada: la aprobación sigue siendo manual del
//    admin (aprobarRecargaManual, que acredita una sola vez con FOR UPDATE).
//  - Los comprobantes viven en la base (tabla comprobantes_recarga) y solo se
//    sirven por endpoint autenticado al dueño o a un admin.
// ============================================

const express = require('express');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const pool = require('../db');
const { aprobarRecargaManual } = require('../wallet');
const { verificarSesion, requiereAdmin } = require('../auth');

const router = express.Router();

// Métodos que se pagan con enlace de pago (el admin lo manda por chat): no
// llevan datos de transferencia ni exigen comprobante en la plataforma.
const METODOS_ENLACE = ['Tarjeta', 'Apple Pay', 'Google Pay', 'Amazon Pay', 'Cash App', 'Cuotas'];
const METODOS_MANUALES = [
  'Zelle', 'PayPal', 'Binance', 'Criptomonedas', 'Banesco Panamá', 'Towerbank',
  'Yappy', 'Bancolombia', 'Nequi', 'BancoEstado',
];
// Comisión que el cliente suma al monto (PayPal cobra al que envía).
const COMISION_PCT = { PayPal: 6 };

const ESTADOS_ABIERTOS = ['pendiente', 'pendiente_pago', 'en_verificacion'];
const TAMANO_MAX_BYTES = 5 * 1024 * 1024; // 5 MB
const TIPOS_PERMITIDOS = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);

// Verifica los primeros bytes: el mime que declara el navegador no es confiable.
function tipoRealDelArchivo(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (buf.slice(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  return null;
}

const subida = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: TAMANO_MAX_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    if (TIPOS_PERMITIDOS.has(file.mimetype)) return cb(null, true);
    cb(new Error('Formato no permitido. Usa JPG, PNG, WEBP o PDF.'));
  },
});

// Máximo 20 subidas por IP por hora — evita llenar la base con archivos.
const limitadorSubidas = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos de subida. Espera un rato e intenta de nuevo.' },
});

function recibirArchivo(req, res, next) {
  subida.single('comprobante')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'El archivo supera los 5 MB.' });
    return res.status(400).json({ error: err.message || 'No se pudo recibir el archivo.' });
  });
}

const CAMPOS_CLIENTE = `rm.id, rm.estado, rm.metodo, rm.creditos_a_acreditar, rm.monto_declarado,
       COALESCE(rm.monto_a_pagar, rm.monto_declarado) AS monto_a_pagar, rm.motivo_rechazo,
       rm.creado_en, rm.enviado_en, rm.revisado_en,
       EXISTS (SELECT 1 FROM comprobantes_recarga c WHERE c.recarga_id = rm.id) AS tiene_comprobante`;

function montoAPagar(precioUsd, metodo) {
  const pct = COMISION_PCT[metodo] || 0;
  return Math.round(Number(precioUsd) * (1 + pct / 100) * 100) / 100;
}

// ---------------------------------------------
// CLIENTE
// ---------------------------------------------

// Crea (o reutiliza) la solicitud al elegir monto + método. Idempotente: si ya
// hay una sin pagar del mismo paquete y método (últimas 24 h), se devuelve esa
// en vez de crear duplicados cada vez que el cliente entra a la pantalla.
router.post('/recargas/iniciar', verificarSesion, async (req, res) => {
  const { paqueteId, metodo } = req.body || {};
  if (!paqueteId) return res.status(400).json({ error: 'Falta el paquete' });
  if (!METODOS_MANUALES.includes(metodo) && !METODOS_ENLACE.includes(metodo)) {
    return res.status(400).json({ error: 'Método de pago no válido' });
  }
  try {
    const paqueteRes = await pool.query(
      'SELECT id, precio_usd, creditos_otorgados FROM paquetes_recarga WHERE id = $1 AND activo = true',
      [paqueteId]
    );
    if (paqueteRes.rows.length === 0) return res.status(400).json({ error: 'Paquete inválido' });
    const paquete = paqueteRes.rows[0];

    const existente = await pool.query(
      `SELECT ${CAMPOS_CLIENTE} FROM recargas_manuales rm
       WHERE rm.user_id = $1 AND rm.paquete_id = $2 AND rm.metodo = $3 AND rm.estado = 'pendiente_pago'
         AND rm.creado_en > now() - interval '24 hours'
       ORDER BY rm.creado_en DESC LIMIT 1`,
      [req.userId, paquete.id, metodo]
    );
    if (existente.rows.length > 0) return res.json({ ...existente.rows[0], requiere_comprobante: METODOS_MANUALES.includes(metodo) });

    const ins = await pool.query(
      `INSERT INTO recargas_manuales (user_id, paquete_id, monto_declarado, monto_a_pagar, creditos_a_acreditar, metodo, estado)
       VALUES ($1, $2, $3, $4, $5, $6, 'pendiente_pago') RETURNING id`,
      [req.userId, paquete.id, paquete.precio_usd, montoAPagar(paquete.precio_usd, metodo), paquete.creditos_otorgados, metodo]
    );
    const r = await pool.query(`SELECT ${CAMPOS_CLIENTE} FROM recargas_manuales rm WHERE rm.id = $1`, [ins.rows[0].id]);
    res.json({ ...r.rows[0], requiere_comprobante: METODOS_MANUALES.includes(metodo) });
  } catch (err) {
    console.error('Error en /recargas/iniciar:', err.message);
    res.status(500).json({ error: 'No se pudo crear la solicitud' });
  }
});

// Historial del cliente (más recientes primero).
router.get('/recargas', verificarSesion, async (req, res) => {
  const r = await pool.query(
    `SELECT ${CAMPOS_CLIENTE} FROM recargas_manuales rm
     WHERE rm.user_id = $1 ORDER BY rm.creado_en DESC LIMIT 50`,
    [req.userId]
  );
  res.json(r.rows.map((x) => ({ ...x, requiere_comprobante: METODOS_MANUALES.includes(x.metodo) })));
});

async function cargarRecargaPropia(id, userId) {
  const r = await pool.query(
    `SELECT ${CAMPOS_CLIENTE}, rm.user_id FROM recargas_manuales rm WHERE rm.id = $1 AND rm.user_id = $2`,
    [id, userId]
  );
  return r.rows[0] || null;
}

// Adjunta el comprobante y pasa la solicitud a "en verificación". No acredita nada.
router.post('/recargas/:id/comprobante', verificarSesion, limitadorSubidas, recibirArchivo, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Adjunta un comprobante (JPG, PNG, WEBP o PDF).' });
  const real = tipoRealDelArchivo(req.file.buffer);
  if (!real || !TIPOS_PERMITIDOS.has(real)) {
    return res.status(400).json({ error: 'El archivo no parece ser una imagen o PDF válido.' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const rec = await client.query(
      'SELECT estado FROM recargas_manuales WHERE id = $1 AND user_id = $2 FOR UPDATE',
      [req.params.id, req.userId]
    );
    if (rec.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Solicitud no encontrada' }); }
    if (!['pendiente', 'pendiente_pago', 'en_verificacion'].includes(rec.rows[0].estado)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Esta solicitud ya fue procesada.' });
    }
    await client.query(
      `INSERT INTO comprobantes_recarga (recarga_id, mime, nombre_original, tamano_bytes, datos)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (recarga_id) DO UPDATE SET mime = EXCLUDED.mime, nombre_original = EXCLUDED.nombre_original,
         tamano_bytes = EXCLUDED.tamano_bytes, datos = EXCLUDED.datos, creado_en = now()`,
      [req.params.id, real, String(req.file.originalname || '').slice(0, 255), req.file.size, req.file.buffer]
    );
    await client.query(
      "UPDATE recargas_manuales SET estado = 'en_verificacion', enviado_en = COALESCE(enviado_en, now()) WHERE id = $1",
      [req.params.id]
    );
    await client.query('COMMIT');
    res.json(await cargarRecargaPropia(req.params.id, req.userId));
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error en /recargas/:id/comprobante:', err.message);
    res.status(500).json({ error: 'No se pudo guardar el comprobante' });
  } finally {
    client.release();
  }
});

// Para métodos con enlace de pago (sin comprobante): "ya pagué con el enlace".
// Los métodos de transferencia SÍ exigen comprobante, así que no pasan por aquí.
router.post('/recargas/:id/enviar', verificarSesion, async (req, res) => {
  const rec = await cargarRecargaPropia(req.params.id, req.userId);
  if (!rec) return res.status(404).json({ error: 'Solicitud no encontrada' });
  if (METODOS_MANUALES.includes(rec.metodo)) {
    return res.status(400).json({ error: 'Para este método debes adjuntar tu comprobante.' });
  }
  if (!['pendiente', 'pendiente_pago'].includes(rec.estado)) {
    return res.status(400).json({ error: 'Esta solicitud ya fue enviada o procesada.' });
  }
  await pool.query(
    "UPDATE recargas_manuales SET estado = 'en_verificacion', enviado_en = now() WHERE id = $1 AND user_id = $2",
    [req.params.id, req.userId]
  );
  res.json(await cargarRecargaPropia(req.params.id, req.userId));
});

// Comprobante: solo su dueño o un admin. Nunca se cachea ni se sirve como HTML.
router.get('/recargas/:id/comprobante', verificarSesion, async (req, res) => {
  const r = await pool.query(
    `SELECT c.mime, c.datos, rm.user_id FROM comprobantes_recarga c
     JOIN recargas_manuales rm ON rm.id = c.recarga_id WHERE c.recarga_id = $1`,
    [req.params.id]
  );
  const fila = r.rows[0];
  if (!fila || (fila.user_id !== req.userId && !req.esAdmin)) {
    return res.status(404).json({ error: 'Comprobante no encontrado' });
  }
  res.setHeader('Content-Type', fila.mime);
  res.setHeader('Content-Disposition', 'inline; filename="comprobante"');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(fila.datos);
});

// ---------------------------------------------
// ADMIN
// ---------------------------------------------

const FILTROS_ESTADO = {
  abiertas: ['pendiente', 'pendiente_pago', 'en_verificacion'],
  pendiente_pago: ['pendiente', 'pendiente_pago'],
  en_verificacion: ['en_verificacion'],
  aprobado: ['aprobado'],
  rechazado: ['rechazado'],
};

router.get('/admin/recargas/lista', verificarSesion, requiereAdmin, async (req, res) => {
  const estados = FILTROS_ESTADO[req.query.estado] || FILTROS_ESTADO.abiertas;
  const r = await pool.query(
    `SELECT rm.id, rm.user_id, u.email, rm.estado, rm.metodo, rm.creditos_a_acreditar, rm.monto_declarado,
            COALESCE(rm.monto_a_pagar, rm.monto_declarado) AS monto_a_pagar, rm.motivo_rechazo,
            rm.comprobante_url, rm.creado_en, rm.enviado_en, rm.revisado_en, adm.email AS revisado_por_email,
            EXISTS (SELECT 1 FROM comprobantes_recarga c WHERE c.recarga_id = rm.id) AS tiene_comprobante
     FROM recargas_manuales rm
     JOIN users u ON u.id = rm.user_id
     LEFT JOIN users adm ON adm.id = rm.revisado_por
     WHERE rm.estado = ANY($1)
     ORDER BY COALESCE(rm.enviado_en, rm.creado_en) DESC
     LIMIT 200`,
    [estados]
  );
  res.json(r.rows);
});

// Conteos por filtro, para los contadores de las pestañas del panel.
router.get('/admin/recargas/conteos', verificarSesion, requiereAdmin, async (req, res) => {
  const r = await pool.query('SELECT estado, COUNT(*)::int AS n FROM recargas_manuales GROUP BY estado');
  const por = Object.fromEntries(r.rows.map((x) => [x.estado, x.n]));
  const suma = (...ks) => ks.reduce((a, k) => a + (por[k] || 0), 0);
  res.json({
    abiertas: suma('pendiente', 'pendiente_pago', 'en_verificacion'),
    pendiente_pago: suma('pendiente', 'pendiente_pago'),
    en_verificacion: suma('en_verificacion'),
    aprobado: suma('aprobado'),
    rechazado: suma('rechazado'),
  });
});

router.post('/admin/recargas/:id/aprobar-v2', verificarSesion, requiereAdmin, async (req, res) => {
  try {
    const nuevoSaldo = await aprobarRecargaManual(req.params.id, req.userId);
    console.log(`[recargas] aprobada ${req.params.id} por admin ${req.userId}`);
    res.json({ ok: true, nuevoSaldo });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Rechazo con motivo (visible para el cliente). Solo sobre solicitudes abiertas:
// una recarga aprobada no se puede "rechazar" después (ya se acreditó).
router.post('/admin/recargas/:id/rechazar-v2', verificarSesion, requiereAdmin, async (req, res) => {
  const motivo = String(req.body?.motivo || '').trim().slice(0, 500);
  if (!motivo) return res.status(400).json({ error: 'Indica el motivo del rechazo' });
  const r = await pool.query(
    `UPDATE recargas_manuales SET estado = 'rechazado', motivo_rechazo = $1, revisado_por = $2, revisado_en = now()
     WHERE id = $3 AND estado = ANY($4) RETURNING id`,
    [motivo, req.userId, req.params.id, ESTADOS_ABIERTOS]
  );
  if (r.rows.length === 0) return res.status(400).json({ error: 'La solicitud no existe o ya fue procesada' });
  console.log(`[recargas] rechazada ${req.params.id} por admin ${req.userId}: ${motivo}`);
  res.json({ ok: true });
});

module.exports = router;
