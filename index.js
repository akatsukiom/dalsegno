// index.js - Con Baileys (más estable)
const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const { makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');

const app = express();
app.use(express.json());

const PHP_API_URL = process.env.PHP_API_URL || 'https://tu-dominio.com/api/whatsapp-webhook.php';

let sock = null;
let qrCodeData = '';
let isConnected = false;

// Inicializar WhatsApp con Baileys
async function connectWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    
    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log('Nuevo QR generado');
            qrCodeData = await qrcode.toDataURL(qr);
        }
        
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Conexión cerrada, reconectando:', shouldReconnect);
            if (shouldReconnect) {
                connectWhatsApp();
            }
        } else if (connection === 'open') {
            console.log('✅ WhatsApp conectado!');
            isConnected = true;
            qrCodeData = '';
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

// Función para enviar mensaje
async function sendMessage(phone, message) {
    if (!sock || !isConnected) {
        throw new Error('WhatsApp no conectado');
    }
    
    let formattedPhone = phone.replace(/\D/g, '');
    if (!formattedPhone.startsWith('52')) {
        formattedPhone = '52' + formattedPhone;
    }
    
    const jid = formattedPhone + '@s.whatsapp.net';
    await sock.sendMessage(jid, { text: message });
    return { success: true };
}

// Ruta principal
app.get('/', (req, res) => {
    if (qrCodeData && !isConnected) {
        res.send(`
            <html>
                <head>
                    <title>Conectar WhatsApp</title>
                    <meta http-equiv="refresh" content="5">
                    <style>
                        body {
                            font-family: Arial;
                            display: flex;
                            justify-content: center;
                            align-items: center;
                            min-height: 100vh;
                            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                            margin: 0;
                        }
                        .container {
                            background: white;
                            padding: 30px;
                            border-radius: 15px;
                            text-align: center;
                            box-shadow: 0 20px 40px rgba(0,0,0,0.1);
                        }
                        h1 { color: #7c3aed; }
                        .qr-container {
                            margin: 20px 0;
                            padding: 20px;
                            background: #f9fafb;
                            border-radius: 10px;
                        }
                        .instructions {
                            background: #f3f4f6;
                            padding: 15px;
                            border-radius: 10px;
                            margin-top: 20px;
                            text-align: left;
                        }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <h1>🎵 MusicMentor - Conectar WhatsApp</h1>
                        <div class="qr-container">
                            <img src="${qrCodeData}" alt="QR Code" />
                        </div>
                        <div class="instructions">
                            <strong>Pasos:</strong>
                            <ol>
                                <li>Abre WhatsApp en tu teléfono</li>
                                <li>Ve a Configuración > Dispositivos vinculados</li>
                                <li>Toca "Vincular dispositivo"</li>
                                <li>Escanea este código QR</li>
                            </ol>
                            <small>La página se actualizará automáticamente...</small>
                        </div>
                    </div>
                </body>
            </html>
        `);
    } else if (isConnected) {
        res.send(`
            <html>
                <head>
                    <title>MusicMentor Bot</title>
                    <style>
                        body {
                            font-family: Arial;
                            text-align: center;
                            padding: 50px;
                            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                            color: white;
                        }
                        .container {
                            background: rgba(255,255,255,0.1);
                            padding: 30px;
                            border-radius: 15px;
                            max-width: 500px;
                            margin: 0 auto;
                        }
                        .status {
                            background: #10b981;
                            padding: 15px;
                            border-radius: 10px;
                            margin: 20px 0;
                        }
                        a { color: white; text-decoration: underline; }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <h1>🎵 MusicMentor Bot</h1>
                        <div class="status">
                            ✅ WhatsApp Conectado y Funcionando
                        </div>
                        <p>Sistema de recordatorios activo</p>
                        <p>Próxima revisión automática: cada 6 horas</p>
                        <hr style="opacity: 0.3; margin: 20px 0;">
                        <p><a href="/test">Probar envío de mensaje</a></p>
                        <p><a href="/check">Revisar recordatorios manualmente</a></p>
                    </div>
                </body>
            </html>
        `);
    } else {
        res.send(`
            <html>
                <head>
                    <title>Iniciando...</title>
                    <meta http-equiv="refresh" content="3">
                </head>
                <body style="display: flex; justify-content: center; align-items: center; height: 100vh;">
                    <div style="text-align: center;">
                        <h2>Iniciando WhatsApp Bot...</h2>
                        <p>Por favor espera...</p>
                    </div>
                </body>
            </html>
        `);
    }
});

// Ruta para revisar recordatorios
app.get('/check', async (req, res) => {
    try {
        const response = await axios.get(PHP_API_URL + '?action=check');
        const data = response.data;
        
        if (data.reminders && data.reminders.length > 0) {
            for (const reminder of data.reminders) {
                try {
                    await sendMessage(reminder.phone, reminder.message);
                    console.log(`Recordatorio enviado a ${reminder.phone}`);
                } catch (error) {
                    console.error(`Error enviando a ${reminder.phone}:`, error);
                }
            }
            res.json({ success: true, sent: data.reminders.length });
        } else {
            res.json({ success: true, message: 'No hay recordatorios pendientes' });
        }
    } catch (error) {
        res.json({ error: error.message });
    }
});

// Test de mensaje
app.get('/test', (req, res) => {
    res.send(`
        <html>
            <body style="font-family: Arial; padding: 50px;">
                <h2>Prueba de Envío</h2>
                <form action="/send-test" method="get">
                    <input type="tel" name="phone" placeholder="+521234567890" required 
                           style="padding: 10px; width: 200px;">
                    <button type="submit" style="padding: 10px 20px;">Enviar Mensaje de Prueba</button>
                </form>
            </body>
        </html>
    `);
});

app.get('/send-test', async (req, res) => {
    const phone = req.query.phone;
    try {
        await sendMessage(phone, 'Hola! Este es un mensaje de prueba de MusicMentor 🎵');
        res.json({ success: true, message: 'Mensaje enviado' });
    } catch (error) {
        res.json({ error: error.message });
    }
});

// Cron job
cron.schedule('0 */6 * * *', async () => {
    console.log('Revisando recordatorios programados...');
    try {
        const response = await axios.get(PHP_API_URL + '?action=check');
        // Procesar recordatorios
    } catch (error) {
        console.error('Error en cron:', error);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`✅ Servidor corriendo en puerto ${PORT}`);
    connectWhatsApp();
});
