/**
 * MusicMentor Bot – WhatsApp Web.js para Railway
 * - QR en pantalla (auto-refresh)
 * - Persistencia LocalAuth (en filesystem del contenedor)
 * - Envío de webhooks a PHP_API_URL
 * - Endpoints: /, /qr.png, /status, /send, /logout, /restart
 * - Reintentos y manejo de desconexión
 * - Keep-alive con cron y healthcheck
 */

const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const morgan = require('morgan');

// =========================
// Config
// =========================
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'production';

// URL de tu endpoint PHP (recibe los webhooks entrantes desde este bot)
const PHP_API_URL =
  process.env.PHP_API_URL || 'https://tu-dominio.com/api/whatsapp-webhook.php';

// Envia logs de mensajes recibidos al webhook
const ENABLE_INCOMING_WEBHOOK = (process.env.ENABLE_INCOMING_WEBHOOK || 'true') === 'true';

// Seguridad básica para endpoints sensibles (opcional)
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'cambia-este-token';

// Reintentos
const RECONNECT_DELAY_MS = 6000;

// Control de estado global
let client = null;
let qrString = '';
let qrPngDataUrl = '';
let connectionStatus = 'iniciando'; // iniciando | esperando-qr | conectando | conectado | desconectado | error
let readyOnce = false;

// =========================
// App HTTP
// =========================
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(helmet({ contentSecurityPolicy: false }));
app.use(morgan('combined'));

const limiter = rateLimit({
  windowMs: 30 * 1000,
  max: 60
});
app.use(limiter);

// =========================
// Utilidades
// =========================
function assertAdmin(req, res) {
  const token = req.header('x-admin-token') || req.query.token || '';
  if (token !== ADMIN_TOKEN) {
    res.status(401).json({ ok: false, error: 'Unauthorized' });
    return false;
  }
  return true;
}

function shortStatus() {
  return {
    status: connectionStatus,
    ready: connectionStatus === 'conectado',
    phpWebhook: PHP_API_URL,
    hasQR: !!qrString
  };
}

// =========================
/** Inicializa el cliente de WhatsApp */
// =========================
async function initWhatsApp() {
  if (client) {
    try { await client.destroy(); } catch (_) {}
    client = null;
  }

  connectionStatus = 'conectando';
  readyOnce = false;
  qrString = '';
  qrPngDataUrl = '';

  client = new Client({
    authStrategy: new LocalAuth({ clientId: 'musicmentor' }),
    puppeteer: {
      headless: true,
      // Con puppeteer instalado como dependencia, trae Chromium adecuado para Railway.
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--window-size=1280,720'
      ]
      // executablePath: se deja en blanco para que puppeteer use su Chromium empaquetado
    },
    webVersionCache: {
      // Cachear la web version para evitar cambios repentinos
      type: 'local'
    }
  });

  // Eventos
  client.on('qr', async (qr) => {
    try {
      qrString = qr;
      qrPngDataUrl = await qrcode.toDataURL(qrString);
      connectionStatus = 'esperando-qr';
      console.log('[QR] Nuevo código QR generado');
    } catch (err) {
      console.error('[QR] Error generando PNG:', err.message);
    }
  });

  client.on('loading_screen', (percent, message) => {
    console.log(`[WWebJS] Cargando ${percent}% - ${message || ''}`);
  });

  client.on('ready', () => {
    connectionStatus = 'conectado';
    readyOnce = true;
    qrString = '';
    qrPngDataUrl = '';
    console.log('[WWebJS] Listo y conectado');
  });

  client.on('authenticated', () => {
    console.log('[WWebJS] Autenticado');
  });

  client.on('auth_failure', (m) => {
    connectionStatus = 'error';
    console.error('[WWebJS] Fallo de autenticación:', m);
  });

  client.on('change_state', (state) => {
    console.log('[WWebJS] Estado:', state);
  });

  client.on('disconnected', (reason) => {
    console.warn('[WWebJS] Desconectado:', reason);
    connectionStatus = 'desconectado';
    // Reintento controlado
    setTimeout(() => {
      console.log('[WWebJS] Reintentando conexión...');
      initWhatsApp();
    }, RECONNECT_DELAY_MS);
  });

  // Mensajes entrantes
  client.on('message', async (msg) => {
    try {
      // Ejemplo simple: ping -> pong
      if (msg.body && msg.body.trim().toLowerCase() === 'ping') {
        await client.sendMessage(msg.from, 'pong');
      }

      if (ENABLE_INCOMING_WEBHOOK && PHP_API_URL) {
        // Enviar webhook a tu API PHP
        await axios.post(
          PHP_API_URL,
          {
            from: msg.from,
            to: msg.to,
            body: msg.body,
            timestamp: msg.timestamp,
            type: msg.type,
            id: msg.id?._serialized || msg.id,
            hasMedia: msg.hasMedia || false
          },
          { timeout: 5000 }
        ).catch((err) => {
          console.error('[Webhook] Error enviando al PHP:', err?.message || err);
        });
      }
    } catch (err) {
      console.error('[message] Error manejando mensaje:', err?.message || err);
    }
  });

  // Media entrante (si necesitas descargar, aquí puedes hacerlo)
  client.on('message_create', async (msg) => {
    // placeholder para lógica adicional de mensajes salientes/entrantes propios
  });

  try {
    await client.initialize();
  } catch (err) {
    console.error('[WWebJS] Error al inicializar:', err?.message || err);
    connectionStatus = 'error';
    // Reintentar luego de un pequeño delay
    setTimeout(initWhatsApp, RECONNECT_DELAY_MS);
  }
}

// =========================
// Rutas HTTP
// =========================

// Página principal (muestra QR o estado)
app.get('/', (req, res) => {
  const isReady = connectionStatus === 'conectado';
  const autoRefresh = !isReady ? '<meta http-equiv="refresh" content="5">' : '';
  const qrHtml = qrPngDataUrl
    ? `<img src="${qrPngDataUrl}" alt="QR" style="max-width: 300px; width: 100%; height: auto; border:1px solid #e5e7eb; border-radius: 12px;" />`
    : '<div style="padding: 20px; background:#f8fafc; border-radius: 12px;">Generando código QR...</div>';

  res.send(`<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  ${autoRefresh}
  <title>MusicMentor Bot</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, Noto Sans, Helvetica Neue, Arial;
      background: linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%);
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 24px;
    }
    .card {
      width: 100%;
      max-width: 760px;
      background: #fff;
      border-radius: 16px;
      box-shadow: 0 20px 60px rgba(0,0,0,.15);
      padding: 28px;
    }
    h1 { margin: 0 0 12px; color: #111827; font-weight: 800; }
    .muted { color: #6b7280; margin: 0 0 16px; }
    .status { padding: 10px 14px; border-radius: 10px; font-weight: 600; margin: 16px 0; display:inline-block; }
    .ok { background:#10b981; color:#fff; }
    .wait { background:#fbbf24; color:#111; }
    .err { background:#ef4444; color:#fff; }
    .grid { display:grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    .box { background:#f9fafb; border:1px solid #e5e7eb; border-radius: 12px; padding: 16px; }
    .btn {
      display:inline-block; background:#7c3aed; color:#fff; text-decoration:none;
      padding:10px 16px; border-radius:10px; font-weight:600; margin-right:8px;
    }
    .row { display:flex; flex-wrap:wrap; gap:12px; align-items:center; }
    input, button {
      font: inherit;
      padding: 10px 12px;
      border-radius: 8px;
      border: 1px solid #d1d5db;
    }
    button { background:#111827; color:#fff; border-color:#111827; cursor:pointer; }
    form { display:flex; gap:10px; flex-wrap:wrap; align-items:center; }
  </style>
</head>
<body>
  <div class="card">
    <h1>MusicMentor Bot</h1>
    <p class="muted">Conecta tu WhatsApp escaneando el QR y usa los endpoints para enviar mensajes o consultar estado.</p>

    <div class="row">
      <span class="status ${isReady ? 'ok' : connectionStatus === 'error' ? 'err' : 'wait'}">
        Estado: ${connectionStatus}
      </span>
      <a class="btn" href="/status">Ver /status</a>
      <a class="btn" href="/qr.png">Ver /qr.png</a>
    </div>

    ${isReady ? `
      <div class="box">
        <h3>Enviar mensaje de prueba</h3>
        <form method="get" action="/send">
          <input required type="tel" name="phone" placeholder="521234567890" />
          <input type="text" name="text" placeholder="Mensaje" value="Prueba de MusicMentor" />
          <button type="submit">Enviar</button>
        </form>
      </div>
      <div class="row" style="margin-top:12px;">
        <a class="btn" href="/logout?token=${ADMIN_TOKEN}">Cerrar sesión</a>
        <a class="btn" href="/restart?token=${ADMIN_TOKEN}">Reiniciar cliente</a>
      </div>
    ` : `
      <div class="grid">
        <div class="box">
          <h3>Escanear QR</h3>
          <div style="display:grid; place-items:center; padding:10px;">
            ${qrHtml}
          </div>
          <p class="muted">Abre WhatsApp > Dispositivos vinculados > Vincular dispositivo > Escanea el QR.</p>
        </div>
        <div class="box">
          <h3>Consejos</h3>
          <ul style="margin:0; padding-left:18px; color:#374151;">
            <li>Si el QR expira, la página se actualizará sola.</li>
            <li>Si ves "desconectado", el bot intentará reconectar.</li>
            <li>Para cerrar sesión desde el servidor, usa <code>/logout</code>.</li>
          </ul>
        </div>
      </div>
    `}
  </div>
</body>
</html>`);
});

// QR como imagen PNG (útil si incrustas en otro panel)
app.get('/qr.png', async (req, res) => {
  if (!qrString) {
    res.status(404).send('QR no disponible');
    return;
  }
  try {
    const png = await qrcode.toBuffer(qrString, { width: 512 });
    res.setHeader('Content-Type', 'image/png');
    res.send(png);
  } catch (err) {
    res.status(500).send('Error generando QR');
  }
});

// Estado
app.get('/status', (req, res) => {
  res.json({
    ok: true,
    ...shortStatus(),
    env: {
      NODE_ENV,
      PORT
    }
  });
});

// Enviar mensaje: GET /send?phone=521234...&text=Hola
app.get('/send', async (req, res) => {
  try {
    if (connectionStatus !== 'conectado') {
      return res.status(503).json({ ok: false, error: 'WhatsApp no conectado' });
    }
    const phone = (req.query.phone || '').trim();
    const text = (req.query.text || '').toString().slice(0, 4096);
    if (!phone || !/^\d{10,15}$/.test(phone)) {
      return res.status(400).json({ ok: false, error: 'phone inválido. Use 52 + número (sin +).' });
    }
    const jid = `${phone}@c.us`;
    await client.sendMessage(jid, text || 'Mensaje de prueba');
    res.json({ ok: true, to: jid, sent: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || 'Error enviando' });
  }
});

// Cerrar sesión (borra sesión local y fuerza reconexión)
app.get('/logout', async (req, res) => {
  if (!assertAdmin(req, res)) return;
  try {
    if (client) {
      await client.logout();
    }
    res.json({ ok: true, message: 'Logout solicitado. Reiniciando...' });
    setTimeout(initWhatsApp, 1500);
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || 'Error en logout' });
  }
});

// Reiniciar cliente manualmente
app.get('/restart', async (req, res) => {
  if (!assertAdmin(req, res)) return;
  try {
    res.json({ ok: true, message: 'Reinicio solicitado' });
    setTimeout(initWhatsApp, 500);
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || 'Error en restart' });
  }
});

// Healthcheck (para Railway)
app.get('/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime(), ...shortStatus() });
});

// =========================
// Keep-alive & mantenimiento
// =========================
cron.schedule('*/5 * * * *', async () => {
  // Ping opcional a tu propia app para mantener instancias vivas
  // En Railway normalmente no hace falta, pero no estorba.
  console.log('[cron] keep-alive');
});

// Manejo elegante de señales
process.on('SIGTERM', async () => {
  console.log('[proc] SIGTERM recibido. Cerrando...');
  try { if (client) await client.destroy(); } catch (_) {}
  process.exit(0);
});
process.on('SIGINT', async () => {
  console.log('[proc] SIGINT recibido. Cerrando...');
  try { if (client) await client.destroy(); } catch (_) {}
  process.exit(0);
});

// =========================
// Inicio del servidor
// =========================
app.listen(PORT, async () => {
  console.log(`Servidor HTTP en puerto ${PORT}`);
  await initWhatsApp();
});
