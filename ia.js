// ============================================
// ia.js — "Viralizame IA": asistente conversacional con la API de Claude.
// Disponible tanto en la landing pública como dentro del panel logueado.
// La API key de Anthropic vive solo aquí (backend); nunca se expone al frontend.
// ============================================

const Anthropic = require('@anthropic-ai/sdk');
const rateLimit = require('express-rate-limit');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `Eres "Viralizame IA", el asistente de Viralizame — una plataforma que usa inteligencia
artificial para ayudar a creadores y negocios a impulsar su presencia en Instagram, TikTok, YouTube,
Facebook y Twitter (X), usando un saldo interno llamado "Viral Credits".

Cómo debes actuar:
- Da consejos genuinamente útiles y específicos sobre contenido, formato, horarios de publicación,
  hooks, biografía de perfil, etc. — ayuda de verdad, no solo vendas.
- Cuando sea relevante y natural para la conversación, recomienda usar Viral Credits de Viralizame
  para impulsar alcance, seguidores, likes o reproducciones de una publicación o cuenta específica.
  Hazlo de forma orgánica, nunca de forma forzada, repetitiva ni en cada mensaje.
- Si el cliente comparte una captura de su perfil o publicación, coméntala como lo haría un experto
  real (qué se ve bien, qué mejorarías del bio/formato/miniatura) y usa lo que ves (seguidores, likes,
  vistas visibles) para sugerir una cantidad concreta y razonable de Viral Credits que la reforzaría
  — ej. si ves ~80 likes, sugiere algo como "unos 500 likes le darían ese empujón de prueba social".
  Que sea una sugerencia que suene genuina y calculada para esa imagen en concreto, no un número
  genérico repetido siempre.
- Nunca prometas resultados de negocio garantizados (ventas, clientes, ingresos). El servicio mejora
  la percepción y el alcance de un perfil; no garantiza resultados comerciales.
- Nunca pidas ni sugieras compartir contraseñas de redes sociales — Viralizame solo necesita el
  usuario público.
- Sé breve (2-4 frases normalmente), cálido, directo y en español.
- Si preguntan algo fuera de redes sociales/marketing de contenido, responde brevemente y redirige
  la conversación hacia cómo Viralizame puede ayudar.`;

const TIPOS_IMAGEN_PERMITIDOS = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

// Máximo 12 mensajes por IP cada 15 minutos — la landing es pública y sin login.
const limitadorIA = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 12,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados mensajes. Espera unos minutos e intenta de nuevo.' },
});

async function chat(req, res) {
  const { mensaje, historial, imagen } = req.body;
  if ((!mensaje || typeof mensaje !== 'string') && !imagen) {
    return res.status(400).json({ error: 'Falta el mensaje' });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'IA no configurada' });
  }
  if (imagen && (!imagen.mediaType || !TIPOS_IMAGEN_PERMITIDOS.has(imagen.mediaType) || !imagen.data)) {
    return res.status(400).json({ error: 'Formato de imagen no soportado (usa PNG, JPG, WEBP o GIF)' });
  }

  // El frontend manda su propio historial corto (stateless); lo saneamos a { role, content }.
  // Las imágenes de turnos pasados no se reenvían (ya quedaron comentadas en el
  // texto de la respuesta) — solo el mensaje actual puede traer una imagen nueva.
  const historialSano = Array.isArray(historial)
    ? historial
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
        .slice(-12)
    : [];

  const contenidoUsuario = imagen
    ? [
        { type: 'image', source: { type: 'base64', media_type: imagen.mediaType, data: imagen.data } },
        { type: 'text', text: mensaje || '¿Qué opinas de esto y qué me recomiendas?' },
      ]
    : mensaje;

  const messages = [...historialSano, { role: 'user', content: contenidoUsuario }];

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  try {
    const stream = client.messages.stream({
      model: 'claude-opus-5',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages,
    });

    stream.on('text', (delta) => {
      res.write(`data: ${JSON.stringify({ delta })}\n\n`);
    });

    await stream.finalMessage();
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    console.error('Error en /ia/chat:', err.message);
    res.write(`data: ${JSON.stringify({ error: 'Error al conectar con la IA' })}\n\n`);
    res.end();
  }
}

module.exports = { chat, limitadorIA };
