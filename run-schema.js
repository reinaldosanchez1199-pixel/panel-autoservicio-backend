// Script de una sola vez: aplica schema.sql contra DATABASE_URL usando el paquete `pg`.
// Uso: node run-schema.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL no está definida en .env');
    process.exit(1);
  }

  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');

  // Se parsea manualmente y se quitan los parámetros de query (sslmode, channel_binding)
  // porque chocan con la config explícita de ssl de abajo y causaban ECONNRESET.
  const url = new URL(connectionString);
  const client = new Client({
    host: url.hostname,
    port: url.port ? Number(url.port) : 5432,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, ''),
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();
  console.log('Conectado a la base de datos.');
  try {
    await client.query(sql);
    console.log('schema.sql aplicado correctamente.');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('Error aplicando schema.sql:', err.message);
  process.exit(1);
});
