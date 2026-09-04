// ============================================
// auth.js — registro, login, middlewares de sesión
// ============================================

const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const pool = require('./db');

const JWT_SECRET = process.env.JWT_SECRET; // obligatorio, generar uno largo y aleatorio
const JWT_EXPIRA = '7d';
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// ---------------------------------------------
// Registro
// ---------------------------------------------
async function registrar(req, res) {
  try {
    const { email, password, nombre } = req.body;
    if (!email || !password || password.length < 8) {
      return res.status(400).json({ error: 'Email y password (mínimo 8 caracteres) son requeridos' });
    }

    const existe = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existe.rows.length > 0) {
      return res.status(409).json({ error: 'Ese email ya está registrado' });
    }

    const hash = await bcrypt.hash(password, 12);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const userRes = await client.query(
        'INSERT INTO users (email, password_hash, nombre) VALUES ($1, $2, $3) RETURNING id',
        [email, hash, nombre || null]
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
    const { credential } = req.body;
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
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const userRes = await client.query(
          'INSERT INTO users (email, password_hash, nombre) VALUES ($1, NULL, $2) RETURNING id',
          [email, nombre]
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

module.exports = { registrar, login, loginGoogle, verificarSesion, requiereAdmin };

// ---------------------------------------------
// Nota: agregar a schema.sql
// ---------------------------------------------
// ALTER TABLE users ADD COLUMN es_admin BOOLEAN DEFAULT false;
// Luego, para hacerte admin a ti mismo desde psql:
// UPDATE users SET es_admin = true WHERE email = 'tu_email@ejemplo.com';
