// ============================================
// server.js — punto de entrada del backend
// ============================================

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { registrar, login } = require('./auth');
const apiRoutes = require('./routes/api-routes');
const { chat: chatIA, limitadorIA } = require('./ia');

const app = express();
app.use(cors());
app.use(express.json());

// Rutas públicas
app.post('/auth/registro', registrar);
app.post('/auth/login', login);

// Viralizame IA — pública (landing + panel), con rate limit propio.
app.post('/ia/chat', limitadorIA, chatIA);

// Rutas protegidas (login requerido, definidas en routes/api-routes.js)
app.use('/api', apiRoutes);

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));
