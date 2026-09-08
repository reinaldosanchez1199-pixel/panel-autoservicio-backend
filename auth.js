// ============================================
// auth.js — registro, login, middlewares de sesión
// ============================================

const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');
const pool = require('./db');

const JWT_SECRET = process.env.JWT_SECRET; // obligatorio, generar uno largo y aleatorio
const JWT_EXPIRA = '7d';
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// ---------------------------------------------
// Resuelve un código de referido al id de su dueño — null si no viene, no
// existe, o el código está mal formado. Nunca lanza (un código inválido
// simplemente no liga el registro a ningún referente).
// ---------------------------------------------
async function buscarReferente(codigoReferido) {
  if (!codigoReferido || typeof codigoReferido !== 'string') return null;
  const r = await pool.query('SELECT id FROM users WHERE codigo_referido = $1', [codigoReferido.trim().toUpperCase()]);
  return r.rows[0]?.id || null;
}

// ---------------------------------------------
// Registro
// ---------------------------------------------
async function registrar(req, res) {
  try {
    const { email, password, nombre, codigoReferido } = req.body;
    if (!email || !password || password.length < 8) {
      return res.status(400).json({ error: 'Email y password (mínimo 8 caracteres) son requeridos' });
    }

    const existe = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existe.rows.length > 0) {
      return res.status(409).json({ error: 'Ese email ya está registrado' });
    }

    const referenteId = await buscarReferente(codigoReferido);
    const hash = await bcrypt.hash(password, 12);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const userRes = await client.query(
        'INSERT INTO users (email, password_hash, nombre, referido_por, ip_registro) VALUES ($1, $2, $3, $4, $5) RETURNING id',
        [email, hash, nombre || null, referenteId, req.ip || null]
      );
      const userId = userRes.rows[0].id;
      // Crea el wallet en 0 automáticamente
      await client.query('INSERT INTO wallets (user_id, saldo_creditos) VALUES ($1, 0)', [userId]);
      await client.query('COMMIT');

      const token = jwt.sign({ userId, esAdmin: false }, JWT_SECRET, { expiresIn: JWT_EXPIRA });
      res.json({ token });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Error en /auth/registro:', err.message);
    res.status(500).json({ error: 'Error al registrar' });
  }
}

// ---------------------------------------------
// Login
// ---------------------------------------------
async function login(req, res) {
  try {
    const { email, password } = req.body;
    const r = await pool.query(
      'SELECT id, password_hash, es_admin, activo FROM users WHERE email = $1',
      [email]
    );
    if (r.rows.length === 0) return res.status(401).json({ error: 'Credenciales inválidas' });

    const user = r.rows[0];
    if (!user.activo) return res.status(403).json({ error: 'Cuenta desactivada' });
    if (!user.password_hash) {
      return res.status(400).json({ error: 'Esta cuenta se creó con Google — inicia sesión con el botón de Google' });
    }

    const valido = await bcrypt.compare(password, user.password_hash);
    if (!valido) return res.status(401).json({ error: 'Credenciales inválidas' });

    const token = jwt.sign({ userId: user.id, esAdmin: user.es_admin }, JWT_SECRET, { expiresIn: JWT_EXPIRA });
    res.json({ token });
  } catch (err) {
    console.error('Error en /auth/login:', err.message);
    res.status(500).json({ error: 'Error al iniciar sesión' });
  }
}

// ---------------------------------------------
// Login / registro con Google — un mismo botón cubre ambos casos: si el
// email ya existe se inicia sesión, si no existe se crea la cuenta (sin
// contraseña, queda ligada a su cuenta de Google).
// ---------------------------------------------
async function loginGoogle(req, res) {
  try {
    const { credential, codigoReferido } = req.body;
    if (!credential) return res.status(400).json({ error: 'Falta el token de Google' });

    const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: process.env.GOOGLE_CLIENT_ID });
    const payload = ticket.getPayload();
    const email = payload.email;
    const nombre = payload.name || null;

    const existente = await pool.query('SELECT id, es_admin, activo FROM users WHERE email = $1', [email]);

    let userId, esAdmin;
    if (existente.rows.length > 0) {
      const user = existente.rows[0];
      if (!user.activo) return res.status(403).json({ error: 'Cuenta desactivada' });
      userId = user.id;
      esAdmin = user.es_admin;
    } else {
      const referenteId = await buscarReferente(codigoReferido);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const userRes = await client.query(
          'INSERT INTO users (email, password_hash, nombre, referido_por, ip_registro) VALUES ($1, NULL, $2, $3, $4) RETURNING id',
          [email, nombre, referenteId, req.ip || null]
        );
        userId = userRes.rows[0].id;
        await client.query('INSERT INTO wallets (user_id, saldo_creditos) VALUES ($1, 0)', [userId]);
        await client.query('COMMIT');
        esAdmin = false;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    }

    const token = jwt.sign({ userId, esAdmin }, JWT_SECRET, { expiresIn: JWT_EXPIRA });
    res.json({ token });
  } catch (err) {
    console.error('Error en /auth/google:', err.message);
    res.status(401).json({ error: 'No se pudo verificar la cuenta de Google' });
  }
}

// ---------------------------------------------
// Recuperación de contraseña mediada por WhatsApp — no hay servicio de correo
// configurado, así que el cliente pide el reset desde la app, un admin lo
// verifica (por WhatsApp, como ya hace con las recargas) y genera una
// contraseña temporal para pasarle. Nunca revela si el email existe o no.
// ---------------------------------------------
async function solicitarResetPassword(req, res) {
  const { email } = req.body;
  const RESPUESTA_GENERICA = { ok: true, mensaje: 'Si el correo existe, un administrador te contactará por WhatsApp para verificarte y darte acceso de nuevo.' };
  if (!email) return res.status(400).json({ error: 'Falta el email' });

  try {
    const r = await pool.query('SELECT id FROM users WHERE email = $1 AND activo = true', [email]);
    if (r.rows.length > 0) {
      await pool.query('INSERT INTO solicitudes_reset_password (user_id) VALUES ($1)', [r.rows[0].id]);
    }
    res.json(RESPUESTA_GENERICA);
  } catch (err) {
    console.error('Error en /auth/olvide-password:', err.message);
    res.status(500).json({ error: 'No se pudo procesar la solicitud' });
  }
}

// Genera una contraseña temporal legible (ej. "VRL-7K2M9P") para relayar por
// WhatsApp — no usa el generador random completo para que sea fácil de
// dictar/copiar sin ambigüedad (sin 0/O ni 1/I).
function generarPasswordTemporal() {
  const alfabeto = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let codigo = '';
  for (let i = 0; i < 8; i++) codigo += alfabeto[crypto.randomInt(alfabeto.length)];
  return `VRL-${codigo}`;
}

async function resolverSolicitudReset(solicitudId, adminUserId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query('SELECT user_id, estado FROM solicitudes_reset_password WHERE id = $1 FOR UPDATE', [solicitudId]);
    if (r.rows.length === 0 || r.rows[0].estado !== 'pendiente') throw new Error('Solicitud no válida o ya procesada');

    const passwordTemporal = generarPasswordTemporal();
    const hash = await bcrypt.hash(passwordTemporal, 12);
    await client.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, r.rows[0].user_id]);
    await client.query(
      "UPDATE solicitudes_reset_password SET estado = 'resuelto', resuelto_por = $1, resuelto_en = now() WHERE id = $2",
      [adminUserId, solicitudId]
    );
    await client.query('COMMIT');
    return passwordTemporal;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------
// Middleware: valida el JWT y adjunta el userId a la request
// ---------------------------------------------
function verificarSesion(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No autenticado' });
  }
  const token = header.split(' ')[1];
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.userId;
    req.esAdmin = payload.esAdmin;
    next();
  } catch {
    return res.status(401).json({ error: 'Token inválido o expirado' });
  }
}

// ---------------------------------------------
// Middleware: exige que el usuario sea admin (usar después de verificarSesion)
// ---------------------------------------------
function requiereAdmin(req, res, next) {
  if (!req.esAdmin) return res.status(403).json({ error: 'Requiere permisos de administrador' });
  next();
}

module.exports = { registrar, login, loginGoogle, verificarSesion, requiereAdmin, solicitarResetPassword, resolverSolicitudReset };

// ---------------------------------------------
// Nota: agregar a schema.sql
// ---------------------------------------------
// ALTER TABLE users ADD COLUMN es_admin BOOLEAN DEFAULT false;
// Luego, para hacerte admin a ti mismo desde psql:
// UPDATE users SET es_admin = true WHERE email = 'tu_email@ejemplo.com';
