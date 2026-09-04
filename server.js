// ============================================
// server.js — punto de entrada del backend
// ============================================

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { registrar, login, loginGoogle } = require('./auth');
const apiRoutes = require('./routes/api-routes');
const { chat: chatIA, limitadorIA } = require('./ia');

const app = express();
app.use(cors());
// Límite subido de 100kb (default) a 10mb — Viralizame IA acepta capturas de
// pantalla (perfil/publicación) en base64 dentro del body JSON.
app.use(express.json({ limit: '10mb' }));

// Rutas públicas
app.post('/auth/registro', registrar);
app.post('/auth/login', login);
app.post('/auth/google', loginGoogle);

// Viralizame IA — pública (landing + panel), con rate limit propio.
app.post('/ia/chat', limitadorIA, chatIA);

// Rutas protegidas (login requerido, definidas en routes/api-routes.js)
app.use('/api', apiRoutes);

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));
