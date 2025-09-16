// index.js - Versión sin WhatsApp para probar
const express = require('express');
const axios = require('axios');
const cron = require('node-cron');

const app = express();
app.use(express.json());

// Variables
const PHP_API_URL = process.env.PHP_API_URL || 'https://tu-dominio.com/api/whatsapp-webhook.php';
let isReady = false;

// Ruta principal
app.get('/', (req, res) => {
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
                    h1 { margin-bottom: 20px; }
                    .status { 
                        background: #fbbf24;
                        color: #000;
                        padding: 15px;
                        border-radius: 10px;
                        margin: 20px 0;
                    }
                    .info {
                        background: rgba(0,0,0,0.2);
                        padding: 15px;
                        border-radius: 10px;
                        margin: 20px 0;
                    }
                </style>
            </head>
            <body>
                <div class="container">
                    <h1>🎵 MusicMentor Bot</h1>
                    <div class="status">
                        ⚠️ WhatsApp temporalmente deshabilitado
                    </div>
                    <div class="info">
                        <p>El sistema de recordatorios está activo</p>
                        <p>Los recordatorios se ejecutan cada 6 horas</p>
                        <hr>
                        <p><a href="/test" style="color: white;">Probar conexión con PHP</a></p>
                    </div>
                </div>
            </body>
        </html>
    `);
});

// Ruta de prueba
app.get('/test', async (req, res) => {
    try {
        const response = await axios.get(PHP_API_URL + '?action=check');
        res.json({
            status: 'success',
            message: 'Conexión con PHP exitosa',
            data: response.data
        });
    } catch (error) {
        res.json({
            status: 'error',
            message: 'No se pudo conectar con PHP',
            error: error.message,
            url_configured: PHP_API_URL
        });
    }
});

// Función simulada para recordatorios
function checkReminders() {
    console.log('Verificando recordatorios...', new Date().toISOString());
    // Aquí iría la lógica de WhatsApp cuando funcione
}

// Programar verificación cada 6 horas
cron.schedule('0 */6 * * *', () => {
    checkReminders();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`✅ Servidor corriendo en puerto ${PORT}`);
    console.log(`📍 URL configurada: ${PHP_API_URL}`);
});
