// whatsapp-bot/index.js
const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const qrcode = require('qrcode');

const app = express();
app.use(express.json());

// URL de tu sitio PHP
const PHP_API_URL = 'https://tu-dominio.com/api/whatsapp-webhook.php';

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
        console.log('QR Code recibido');
        qrCodeData = await qrcode.toDataURL(qr);
    });

    client.on('ready', () => {
        console.log('WhatsApp Bot está listo!');
        isReady = true;
        qrCodeData = '';
    });

    client.on('authenticated', () => {
        console.log('WhatsApp autenticado');
    });

    client.on('auth_failure', () => {
        console.error('Error de autenticación');
        isReady = false;
    });

    client.on('disconnected', (reason) => {
        console.log('WhatsApp desconectado:', reason);
        isReady = false;
        // Reintentar conexión
        setTimeout(() => initWhatsApp(), 5000);
    });

    client.initialize();
}

// Función para enviar mensajes
async function sendWhatsAppMessage(phone, message) {
    if (!isReady) {
        throw new Error('WhatsApp no está conectado');
    }
    
    // Formatear número para WhatsApp
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
    try {
        console.log('Revisando recordatorios...');
        
        // Obtener recordatorios del sistema PHP
        const response = await axios.get(PHP_API_URL + '?action=check');
        const data = response.data;
        
        if (data.reminders && data.reminders.length > 0) {
            console.log(`Enviando ${data.reminders.length} recordatorios`);
            
            for (const reminder of data.reminders) {
                try {
                    await sendWhatsAppMessage(reminder.phone, reminder.message);
                    console.log(`Recordatorio enviado a ${reminder.phone}`);
                    
                    // Esperar entre mensajes para evitar ser marcado como spam
                    await new Promise(resolve => setTimeout(resolve, 3000));
                } catch (error) {
                    console.error(`Error enviando a ${reminder.phone}:`, error);
                }
            }
        }
    } catch (error) {
        console.error('Error revisando recordatorios:', error);
    }
}

// Programar revisión cada día a las 9 AM
cron.schedule('0 9 * * *', () => {
    console.log('Ejecutando tarea programada de recordatorios');
    checkAndSendReminders();
});

// También revisar cada 4 horas para pruebas
cron.schedule('0 */4 * * *', () => {
    checkAndSendReminders();
});

// Endpoints de la API
app.get('/', (req, res) => {
    res.json({
        status: isReady ? 'connected' : 'disconnected',
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
});

app.get('/qr', (req, res) => {
    if (qrCodeData) {
        res.send(`
            <html>
                <body style="display: flex; justify-content: center; align-items: center; height: 100vh; flex-direction: column;">
                    <h2>Escanea el código QR con WhatsApp</h2>
                    <img src="${qrCodeData}" alt="QR Code" />
                    <p>Refresca la página después de escanear</p>
                </body>
            </html>
        `);
    } else if (isReady) {
        res.send('<h2>WhatsApp ya está conectado ✅</h2>');
    } else {
        res.send('<h2>Generando código QR... Refresca en unos segundos</h2>');
    }
});

app.post('/send', async (req, res) => {
    const { phone, message } = req.body;
    
    try {
        const result = await sendWhatsAppMessage(phone, message);
        res.json({ success: true, result });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/check-reminders', async (req, res) => {
    try {
        await checkAndSendReminders();
        res.json({ success: true, message: 'Recordatorios procesados' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor corriendo en puerto ${PORT}`);
    initWhatsApp();
});
