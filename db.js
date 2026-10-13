// ============================================
// db.js — pool de conexión compartido a Postgres (Neon)
//
// Se parsea DATABASE_URL manualmente y se pasan los campos sueltos
// en vez de `connectionString` porque combinar `connectionString`
// (que ya trae sslmode=require) con un `ssl` explícito hace que la
// negociación TLS se cuelgue contra el pooler de Neon.
// ============================================

const { Pool } = require('pg');

const url = new URL(process.env.DATABASE_URL);

const pool = new Pool({
  host: url.hostname,
  port: url.port ? Number(url.port) : 5432,
  user: decodeURIComponent(url.username),
  password: decodeURIComponent(url.password),
  database: url.pathname.replace(/^\//, ''),
  // Solo en desarrollo local (Postgres sin TLS); Neon siempre va con TLS.
  ssl: ['localhost', '127.0.0.1'].includes(url.hostname) ? false : { rejectUnauthorized: false },
  connectionTimeoutMillis: 10000, // falla rápido en vez de colgarse si la red está inestable
});

// Sin este listener, un error en una conexión inactiva del pool
// (frecuente si la red es inestable) tumba todo el proceso de Node.
pool.on('error', (err) => {
  console.error('Error inesperado en el pool de Postgres:', err.message);
});

module.exports = pool;
