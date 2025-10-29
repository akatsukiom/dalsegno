/**
 * MusicMentor Bot – WhatsApp Web.js para Railway + IA
 * - QR en pantalla (auto-refresh)
 * - Persistencia LocalAuth (en filesystem del contenedor)
 * - Webhooks a PHP_API_URL (si ENABLE_INCOMING_WEBHOOK=true)
 * - Endpoints: /, /qr.png, /status, /send, /logout, /restart, /health
 * - Reintentos y manejo de desconexión
 * - Keep-alive con cron y healthcheck
 * - IA: Chat + Transcripción de audios (OpenAI)
 * - Router de comandos que llama a API PHP (Hostinger)
 */

const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const morgan = require('morgan');
const fs = require('fs');
const path = require('path');

// =========================
// IA (OpenAI)
// =========================
const OpenAI = require('openai');
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// =========================
// Config
// =========================
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'production';

// URL de tu endpoint/base PHP (para comandos y/o webhook)
const PHP_API_URL = process.env.PHP_API_URL || 'https://tu-dominio.com/api/whatsapp-webhook.php';
const PHP_BASE = process.env.PHP_BASE || (process.env.PHP_API_URL?.replace(/\/[^/]+$/, '/api') || 'https://tu-dominio.com/api');

// Enviar webhook con todos los mensajes entrantes a tu PHP
const ENABLE_INCOMING_WEBHOOK = (process.env.ENABLE_INCOMING_WEBHOOK || 'true') === 'true';

// Seguridad básica para endpoints sensibles (opcional)
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'cambia-este-token';

// Reintentos
const RECONNECT_DELAY_MS = 6000;

// Estado global
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

const limiter = rateLimit({ windowMs: 30 * 1000, max: 60 });
app.use(limiter);

// =========================
// Helpers
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

// === IA: chat ===
async function askAI(prompt) {
  try {
    const r = await openai.chat.completions.create({
      model: 'gpt-4o-mini', // puedes usar 'gpt-4o'
      messages: [
        { role: 'system', content: 'Eres Memorae, asistente de recordatorios/notas. Responde breve, claro y en español.' },
        { role: 'user', content: prompt }
      ]
    });
    return r.choices?.[0]?.message?.content?.trim() || 'No tengo respuesta.';
  } catch (e) {
    console.error('[AI] Error:', e?.message || e);
    return 'No pude procesar tu mensaje con IA ahora mismo.';
  }
}

// === IA: transcripción de audio (ogg/opus) ===
async function transcribeOgg(filePath) {
  try {
    const resp = await openai.audio.transcriptions.create({
      file: fs.createReadStream(filePath),
      model: 'gpt-4o-mini-transcribe' // o 'whisper-1' si prefieres
    });
    return (resp.text || '').trim();
  } catch (e) {
    console.error('[Transcribe] Error:', e?.message || e);
    return '';
  }
}

// === Router de comandos → tu API PHP (Hostinger) ===
// Ajusta los paths si tus endpoints se llaman distinto.
async function handleCommand(wa_id, text) {
  const lower = (text || '').toLowerCase().trim();

  // guardar <nota>
  if (lower.startsWith('guardar ')) {
    const nota = text.slice(8).trim();
    const { data } = await axios.post(`${PHP_BASE}/reminders-send-now.php`, { wa_id, text: nota }, { timeout: 8000 });
    return data?.ok ? `Guardé/mandé: ${nota}` : `Error: ${data?.error || 'no se pudo'}`;
  }

  // recordar <consulta>
  if (lower.startsWith('recordar ')) {
    const q = text.slice(9).trim();
    const { data } = await axios.post(`${PHP_BASE}/reminders-report.php`, { wa_id, query: q }, { timeout: 8000 });
    if (!data?.items?.length) return 'Sin coincidencias.';
    return data.items.map(i => `#${i.id} · ${i.text}`).join('\n');
  }

  // lista
  if (lower === 'lista') {
    const { data } = await axios.post(`${PHP_BASE}/reminders-report.php`, { wa_id, limit: 5 }, { timeout: 8000 });
    if (!data?.items?.length) return 'No tienes notas aún.';
    return data.items.map(i => `#${i.id} · ${i.text}`).join('\n');
  }

  // enviar ahora (procesar pendientes)
  if (lower === 'enviar ahora') {
    const { data } = await axios.post(`${PHP_BASE}/reminders-due.php`, { wa_id }, { timeout: 12000 });
    return data?.ok ? 'Procesé pendientes ✅' : `Error: ${data?.error || 'no se pudo'}`;
  }

  // ayuda
  if (lower === 'ayuda' || lower === 'help') {
    return 'Comandos: "guardar <nota>", "recordar <texto>", "lista", "enviar ahora". Si no usas comando, te respondo con IA.';
  }

  return null; // no era un comando conocido
}

// =========================
// Inicializa WhatsApp
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
    },
    webVersionCache: { type: 'local' }
  });

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

  client.on('authenticated', () => console.log('[WWebJS] Autenticado'));

  client.on('auth_failure', (m) => {
    connectionStatus = 'error';
    console.error('[WWebJS] Fallo de autenticación:', m);
  });

  client.on('change_state', (state) => console.log('[WWebJS] Estado:', state));

  client.on('disconnected', (reason) => {
    console.warn('[WWebJS] Desconectado:', reason);
    connectionStatus = 'desconectado';
    setTimeout(() => {
      console.log('[WWebJS] Reintentando conexión...');
      initWhatsApp();
    }, RECONNECT_DELAY_MS);
  });

  // =========================
  // Mensajes entrantes
  // =========================
  client.on('message', async (msg) => {
    try {
      const wa_id = msg.from;

      // 1) AUDIO: transcribe y procesa (comando o IA)
      if (msg.hasMedia && (msg.type === 'ptt' || msg.type === 'audio')) {
        const media = await msg.downloadMedia();
        const tmpDir = path.join(__dirname, 'tmp');
        if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
        const oggPath = path.join(tmpDir, `v_${Date.now()}.ogg`);
        fs.writeFileSync(oggPath, Buffer.from(media.data, 'base64'));

        const texto = await transcribeOgg(oggPath);
        const reply = (await handleCommand(wa_id, texto)) || (await askAI(texto));
        await client.sendMessage(msg.from, reply);
      } else {
        // 2) TEXTO: comandos → PHP; si no, IA
        const text = (msg.body || '').trim();

        if (text.toLowerCase() === 'ping') {
          await client.sendMessage(msg.from, 'pong');
        } else {
          const handled = await handleCommand(wa_id, text);
          await client.sendMessage(msg.from, handled || (await askAI(text)));
        }
      }

      // 3) (Opcional) enviar webhook a tu PHP como ya hacías
      if (ENABLE_INCOMING_WEBHOOK && PHP_API_URL) {
        axios.post(
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
      try { await client.sendMessage(msg.from, 'Ocurrió un error al procesar tu mensaje 🙏'); } catch {}
    }
  });

  client.on('message_create', async (_msg) => {
    // placeholder para lógica de mensajes salientes/entrantes propios si la necesitas
  });

  try {
    await client.initialize();
  } catch (err) {
    console.error('[WWebJS] Error al inicializar:', err?.message || err);
    connectionStatus = 'error';
    setTimeout(initWhatsApp, RECONNECT_DELAY_MS);
  }
}

// =========================
// Rutas HTTP
// =========================
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
      display: grid; place-items: center; padding: 24px;
    }
    .card { width: 100%; max-width: 760px; background: #fff; border-radius: 16px; box-shadow: 0 20px 60px rgba(0,0,0,.15); padding: 28px; }
    h1 { margin: 0 0 12px; color: #111827; font-weight: 800; }
    .muted { color: #6b7280; margin: 0 0 16px; }
    .status { padding: 10px 14px; border-radius: 10px; font-weight: 600; margin: 16px 0; display:inline-block; }
    .ok { background:#10b981; color:#fff; }
    .wait { background:#fbbf24; color:#111; }
    .err { background:#ef4444; color:#fff; }
    .grid { display:grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    .box { background:#f9fafb; border:1px solid #e5e7eb; border-radius: 12px; padding: 16px; }
    .btn { display:inline-block; background:#7c3aed; color:#fff; text-decoration:none; padding:10px 16px; border-radius:10px; font-weight:600; margin-right:8px; }
    .row { display:flex; flex-wrap:wrap; gap:12px; align-items:center; }
    input, button { font: inherit; padding: 10px 12px; border-radius: 8px; border: 1px solid #d1d5db; }
    button { background:#111827; color:#fff; border-color:#111827; cursor:pointer; }
    form { display:flex; gap:10px; flex-wrap:wrap; align-items:center; }
  </style>
</head>
<body>
  <div class="card">
    <h1>MusicMentor Bot</h1>
    <p class="muted">Conecta tu WhatsApp escaneando el QR y usa los endpoints para enviar mensajes o consultar estado.</p>

    <div class="row">
      <span class="status ${isReady ? 'ok' : connectionStatus === 'error' ? 'err' : 'wait'}">Estado: ${connectionStatus}</span>
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

// QR como imagen PNG
app.get('/qr.png', async (req, res) => {
  if (!qrString) return res.status(404).send('QR no disponible');
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
  res.json({ ok: true, ...shortStatus(), env: { NODE_ENV, PORT } });
});

// Enviar mensaje: GET /send?phone=521234...&text=Hola
app.get('/send', async (req, res) => {
  try {
    if (connectionStatus !== 'conectado') {
      return res.status(503).json({ ok: false, error: 'WhatsApp no conectado' });
    }
    let phone = (req.query.phone || '').replace(/\D/g, '');
    const text = (req.query.text || '').toString().slice(0, 4096);

    if (!phone || !/^\d{10,15}$/.test(phone)) {
      return res.status(400).json({ ok: false, error: 'Número inválido. Use 52 + número (sin +).' });
    }
    if (phone.startsWith('52') && !phone.startsWith('521')) {
      phone = '521' + phone.slice(2); // 🇲🇽 MX
    }

    const id = await client.getNumberId(phone);
    if (!id) return res.status(400).json({ ok: false, error: 'El número no está en WhatsApp' });

    await client.sendMessage(id._serialized, text || 'Mensaje de prueba');
    res.json({ ok: true, to: id._serialized, sent: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || 'Error enviando' });
  }
});

// Cerrar sesión
app.get('/logout', async (req, res) => {
  if (!assertAdmin(req, res)) return;
  try {
    if (client) await client.logout();
    res.json({ ok: true, message: 'Logout solicitado. Reiniciando...' });
    setTimeout(initWhatsApp, 1500);
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || 'Error en logout' });
  }
});

// Reiniciar cliente
app.get('/restart', async (req, res) => {
  if (!assertAdmin(req, res)) return;
  try {
    res.json({ ok: true, message: 'Reinicio solicitado' });
    setTimeout(initWhatsApp, 500);
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || 'Error en restart' });
  }
});

// Healthcheck
app.get('/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime(), ...shortStatus() });
});

// Keep-alive
cron.schedule('*/5 * * * *', async () => {
  console.log('[cron] keep-alive');
});

// Señales
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

// Start
app.listen(PORT, async () => {
  console.log(`Servidor HTTP en puerto ${PORT}`);
  await initWhatsApp();
});
