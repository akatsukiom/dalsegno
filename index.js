const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');

const app = express();
app.use(express.json());

const PHP_API_URL = process.env.PHP_API_URL || 'https://tu-dominio.com/api/whatsapp-webhook.php';

let client;
let qrCodeData = '';
let isReady = false;
let connectionStatus = 'iniciando';

// Inicializar WhatsApp con configuración mínima
function initWhatsApp() {
    try {
        client = new Client({
            authStrategy: new LocalAuth({ clientId: "musicmentor" }),
            puppeteer: {
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--no-first-run',
                    '--no-zygote',
                    '--disable-gpu'
                ]
            }
        });

        client.on('qr', async (qr) => {
            console.log('QR recibido');
            qrCodeData = await qrcode.toDataURL(qr);
            connectionStatus = 'esperando-qr';
        });

        client.on('ready', () => {
            console.log('WhatsApp listo');
            isReady = true;
            qrCodeData = '';
            connectionStatus = 'conectado';
        });

        client.on('disconnected', () => {
            isReady = false;
            connectionStatus = 'desconectado';
            setTimeout(() => initWhatsApp(), 5000);
        });

        client.initialize();
    } catch (error) {
        console.error('Error iniciando WhatsApp:', error);
        connectionStatus = 'error';
    }
}

// Página principal con QR
app.get('/', (req, res) => {
    const html = `
        <!DOCTYPE html>
        <html>
        <head>
            <title>MusicMentor Bot</title>
            <meta charset="utf-8">
            ${connectionStatus === 'esperando-qr' ? '<meta http-equiv="refresh" content="5">' : ''}
            <style>
                * { margin: 0; padding: 0; box-sizing: border-box; }
                body {
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    min-height: 100vh;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    padding: 20px;
                }
                .container {
                    background: white;
                    border-radius: 20px;
                    padding: 40px;
                    max-width: 600px;
                    width: 100%;
                    box-shadow: 0 20px 60px rgba(0,0,0,0.3);
                }
                h1 {
                    color: #7c3aed;
                    margin-bottom: 30px;
                    text-align: center;
                }
                .qr-container {
                    text-align: center;
                    padding: 20px;
                    background: #f9fafb;
                    border-radius: 15px;
                    margin: 20px 0;
                }
                .status {
                    padding: 15px;
                    border-radius: 10px;
                    margin: 20px 0;
                    text-align: center;
                    font-weight: 600;
                }
                .status.connected {
                    background: #10b981;
                    color: white;
                }
                .status.waiting {
                    background: #fbbf24;
                    color: #000;
                }
                .instructions {
                    background: #f3f4f6;
                    padding: 20px;
                    border-radius: 10px;
                    margin-top: 20px;
                }
                .btn {
                    display: inline-block;
                    background: #7c3aed;
                    color: white;
                    padding: 12px 24px;
                    border-radius: 8px;
                    text-decoration: none;
                    margin: 10px;
                }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>🎵 MusicMentor Bot</h1>
                
                ${isReady ? `
                    <div class="status connected">
                        ✅ WhatsApp Conectado y Funcionando
                    </div>
                    <div style="text-align: center;">
                        <a href="/test" class="btn">Enviar Mensaje de Prueba</a>
                        <a href="/check" class="btn">Verificar Recordatorios</a>
                    </div>
                ` : qrCodeData ? `
                    <div class="qr-container">
                        <h2>Escanea el código QR</h2>
                        <img src="${qrCodeData}" alt="QR Code" />
                    </div>
                    <div class="instructions">
                        <h3>Pasos:</h3>
                        <ol>
                            <li>Abre WhatsApp en tu teléfono</li>
                            <li>Ve a Configuración > Dispositivos vinculados</li>
                            <li>Toca "Vincular dispositivo"</li>
                            <li>Escanea este código</li>
                        </ol>
                        <p style="margin-top: 10px; opacity: 0.7;">La página se actualizará automáticamente...</p>
                    </div>
                ` : `
                    <div class="status waiting">
                        ⏳ Iniciando WhatsApp...
                    </div>
                    <p style="text-align: center; margin-top: 20px;">
                        Por favor espera, generando código QR...
                    </p>
                    <meta http-equiv="refresh" content="3">
                `}
            </div>
        </body>
        </html>
    `;
    res.send(html);
});

// Ruta de prueba
app.get('/test', (req, res) => {
    if (!isReady) {
        return res.json({ error: 'WhatsApp no conectado' });
    }
    res.send(`
        <html>
            <body style="font-family: Arial; padding: 50px;">
                <h2>Enviar Mensaje de Prueba</h2>
                <form action="/send-test" method="get">
                    <input type="tel" name="phone" placeholder="521234567890" required 
                           style="padding: 10px; width: 300px;">
                    <button type="submit" style="padding: 10px 20px;">Enviar</button>
                </form>
                <p>Ingresa el número sin el +</p>
            </body>
        </html>
    `);
});

app.get('/send-test', async (req, res) => {
    if (!isReady) {
        return res.json({ error: 'WhatsApp no conectado' });
    }
    
    const phone = req.query.phone + '@c.us';
    try {
        await client.sendMessage(phone, '🎵 Prueba de MusicMentor\n\nEste es un mensaje de prueba del sistema de recordatorios.');
        res.json({ success: true, message: 'Mensaje enviado' });
    } catch (error) {
        res.json({ error: error.message });
    }
});

// Verificar recordatorios
app.get('/check', async (req, res) => {
    // Por ahora solo mostrar estado
    res.json({
        status: isReady ? 'conectado' : 'desconectado',
        message: 'Sistema de recordatorios activo',
        phpUrl: PHP_API_URL
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`✅ Servidor en puerto ${PORT}`);
    initWhatsApp();
});
