const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const qrcode = require('qrcode');

const app = express();
app.use(express.json());

// URL de tu PHP (reemplaza con tu dominio real)
const PHP_API_URL = process.env.PHP_API_URL || 'https://tu-dominio.com/api/whatsapp-webhook.php';

let client;
let qrCodeData = '';
let isReady = false;

// Inicializar WhatsApp
function initWhatsApp() {
    client = new Client({
        authStrategy: new LocalAuth({
            dataPath: './whatsapp-sessions'
        }),
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--single-process',
                '--disable-gpu'
            ]
        }
    });

    client.on('qr', async (qr) => {
        console.log('QR Code recibido, visita /qr para escanearlo');
        qrCodeData = await qrcode.toDataURL(qr);
    });

    client.on('ready', () => {
        console.log('✅ WhatsApp Bot está listo!');
        isReady = true;
        qrCodeData = '';
    });

    client.on('authenticated', () => {
        console.log('✅ WhatsApp autenticado exitosamente');
    });

    client.initialize();
}

// Ruta principal - muestra estado
app.get('/', (req, res) => {
    if (!isReady && qrCodeData) {
        // Si hay QR, redirige automáticamente
        res.redirect('/qr');
    } else if (isReady) {
        res.send(`
            <html>
                <head>
                    <title>MusicMentor WhatsApp Bot</title>
                    <style>
                        body {
                            font-family: Arial, sans-serif;
                            display: flex;
                            justify-content: center;
                            align-items: center;
                            height: 100vh;
                            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                            color: white;
                            margin: 0;
                        }
                        .container {
                            text-align: center;
                            padding: 2rem;
                            background: rgba(255,255,255,0.1);
                            border-radius: 15px;
                        }
                        h1 { margin-bottom: 1rem; }
                        .status { 
                            background: #10b981; 
                            padding: 1rem 2rem; 
                            border-radius: 10px;
                            font-size: 1.2rem;
                        }
                        a {
                            color: white;
                            margin-top: 1rem;
                            display: inline-block;
                        }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <h1>🎵 MusicMentor WhatsApp Bot</h1>
                        <div class="status">✅ Conectado y funcionando</div>
                        <a href="/check">Revisar recordatorios manualmente</a>
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
                        <p>Espera unos segundos...</p>
                    </div>
                </body>
            </html>
        `);
    }
});

// Ruta para mostrar QR
app.get('/qr', (req, res) => {
    if (qrCodeData) {
        res.send(`
            <html>
                <head>
                    <title>Escanea el código QR</title>
                    <meta http-equiv="refresh" content="5">
                    <style>
                        body {
                            font-family: Arial, sans-serif;
                            display: flex;
                            justify-content: center;
                            align-items: center;
                            min-height: 100vh;
                            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                            margin: 0;
                            color: white;
                        }
                        .container {
                            text-align: center;
                            background: white;
                            padding: 2rem;
                            border-radius: 15px;
                            box-shadow: 0 20px 25px rgba(0,0,0,0.1);
                            color: #333;
                        }
                        h2 { 
                            color: #7c3aed;
                            margin-bottom: 1rem;
                        }
                        .instructions {
                            background: #f3f4f6;
                            padding: 1rem;
                            border-radius: 10px;
                            margin-top: 1rem;
                        }
                        img {
                            border: 5px solid #e5e7eb;
                            border-radius: 10px;
                            padding: 10px;
                            background: white;
                        }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <h2>🎵 MusicMentor - Conectar WhatsApp</h2>
                        <img src="${qrCodeData}" alt="QR Code" />
                        <div class="instructions">
                            <p><strong>Instrucciones:</strong></p>
                            <ol style="text-align: left;">
                                <li>Abre WhatsApp en tu teléfono</li>
                                <li>Ve a Configuración > Dispositivos vinculados</li>
                                <li>Toca "Vincular dispositivo"</li>
                                <li>Escanea este código QR</li>
                            </ol>
                            <p><small>La página se actualizará automáticamente</small></p>
                        </div>
                    </div>
                </body>
            </html>
        `);
    } else if (isReady) {
        res.redirect('/');
    } else {
        res.redirect('/');
    }
});

// Función para enviar mensajes
async function sendWhatsAppMessage(phone, message) {
    if (!isReady) {
        throw new Error('WhatsApp no está conectado');
    }
    
    let formattedPhone = phone.replace(/\D/g, '');
    if (!formattedPhone.startsWith('52')) {
        formattedPhone = '52' + formattedPhone;
    }
    formattedPhone = formattedPhone + '@c.us';
    
    try {
        await client.sendMessage(formattedPhone, message);
        return { success: true, phone: formattedPhone };
    } catch (error) {
        console.error('Error enviando mensaje:', error);
        throw error;
    }
}

// Función para revisar y enviar recordatorios
async function checkAndSendReminders() {
    if (!isReady) {
        console.log('WhatsApp no está listo aún');
        return { error: 'WhatsApp no conectado' };
    }

    try {
        console.log('Revisando recordatorios...');
        const response = await axios.get(PHP_API_URL + '?action=check');
        const data = response.data;
        
        if (data.reminders && data.reminders.length > 0) {
            console.log(`Enviando ${data.reminders.length} recordatorios`);
            
            for (const reminder of data.reminders) {
                try {
                    await sendWhatsAppMessage(reminder.phone, reminder.message);
                    console.log(`✅ Recordatorio enviado a ${reminder.phone}`);
                    await new Promise(resolve => setTimeout(resolve, 2000));
                } catch (error) {
                    console.error(`❌ Error enviando a ${reminder.phone}:`, error);
                }
            }
            return { success: true, count: data.reminders.length };
        }
        return { success: true, count: 0 };
    } catch (error) {
        console.error('Error revisando recordatorios:', error);
        return { error: error.message };
    }
}

// Ruta para revisar manualmente
app.get('/check', async (req, res) => {
    const result = await checkAndSendReminders();
    res.json(result);
});

// Programar revisión automática cada día a las 9 AM
cron.schedule('0 9 * * *', () => {
    console.log('Ejecutando revisión programada');
    checkAndSendReminders();
});

// También revisar cada 6 horas
cron.schedule('0 */6 * * *', () => {
    checkAndSendReminders();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
    initWhatsApp();
});
