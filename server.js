// ============================================
// server.js — punto de entrada del backend
// ============================================

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { registrar, login, loginGoogle, solicitarResetPassword } = require('./auth');
const apiRoutes = require('./routes/api-routes');
const { chat: chatIA, limitadorIA } = require('./ia');

// Máximo 5 solicitudes de reset por IP cada 15 minutos — evita que alguien
// use este endpoint para adivinar qué emails están registrados.
const limitadorResetPassword = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes. Espera unos minutos e intenta de nuevo.' },
});

// Red de seguridad: un error de base de datos no capturado dentro de una ruta
// async (ej. un valor fuera de rango) tumbaba TODO el servidor para TODOS los
// clientes en simultáneo, en vez de fallar solo esa petición. Node solo mata
// el proceso si no hay ningún listener de 'unhandledRejection'.
process.on('unhandledRejection', (err) => {
  console.error('Rechazo no manejado (el servidor sigue corriendo):', err);
});

const app = express();
// Railway pone la app detrás de un proxy — sin esto, req.ip da la IP interna
// del proxy (igual para todos los usuarios) en vez de la real del cliente.
// Necesario para el rate limit de IA y para detectar registros duplicados.
app.set('trust proxy', true);
app.use(cors());
// Límite subido de 100kb (default) a 10mb — Viralizame IA acepta capturas de
// pantalla (perfil/publicación) en base64 dentro del body JSON.
app.use(express.json({ limit: '10mb' }));

// Rutas públicas
app.post('/auth/registro', registrar);
app.post('/auth/login', login);
app.post('/auth/google', loginGoogle);
app.post('/auth/olvide-password', limitadorResetPassword, solicitarResetPassword);

// Viralizame IA — pública (landing + panel), con rate limit propio.
app.post('/ia/chat', limitadorIA, chatIA);

// Rutas protegidas (login requerido, definidas en routes/api-routes.js)
app.use('/api', apiRoutes);

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));
