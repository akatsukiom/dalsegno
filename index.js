// index.js - Versión estable sin librerías problemáticas
const express = require('express');
const axios = require('axios');
const cron = require('node-cron');

const app = express();
app.use(express.json());

// Configuración
const PHP_API_URL = process.env.PHP_API_URL || 'https://tu-dominio.com/api/whatsapp-webhook.php';
const WHATSAPP_ENABLED = false; // Por ahora deshabilitado

// Estado del sistema
let systemStatus = {
    server: 'running',
    whatsapp: 'disabled',
    lastCheck: null,
    remindersToday: 0
};

// Página principal
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>MusicMentor Bot</title>
            <meta charset="utf-8">
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
                    font-size: 2rem;
                }
                .status-card {
                    background: #f9fafb;
                    border-radius: 12px;
                    padding: 20px;
                    margin-bottom: 20px;
                }
                .status-item {
                    display: flex;
                    justify-content: space-between;
                    margin-bottom: 15px;
                    padding-bottom: 15px;
                    border-bottom: 1px solid #e5e7eb;
                }
                .status-item:last-child {
                    margin-bottom: 0;
                    padding-bottom: 0;
                    border-bottom: none;
                }
                .status-label {
                    color: #6b7280;
                    font-weight: 500;
                }
                .status-value {
                    font-weight: 600;
                }
                .status-active {
                    color: #10b981;
                }
                .status-inactive {
                    color: #ef4444;
                }
                .btn {
                    display: inline-block;
                    background: #7c3aed;
                    color: white;
                    padding: 12px 24px;
                    border-radius: 8px;
                    text-decoration: none;
                    font-weight: 600;
                    margin-top: 20px;
                    transition: background 0.2s;
                }
                .btn:hover {
                    background: #6d28d9;
                }
                .info-box {
                    background: #fef3c7;
                    border-left: 4px solid #f59e0b;
                    padding: 15px;
                    border-radius: 8px;
                    margin-top: 20px;
                }
                .info-box h3 {
                    color: #92400e;
                    margin-bottom: 10px;
                }
                .info-box p {
                    color: #78350f;
                    line-height: 1.6;
                }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>🎵 MusicMentor Bot</h1>
                
                <div class="status-card">
                    <div class="status-item">
                        <span class="status-label">Estado del Servidor</span>
                        <span class="status-value status-active">✅ Activo</span>
                    </div>
                    <div class="status-item">
                        <span class="status-label">WhatsApp</span>
                        <span class="status-value status-inactive">⏸️ En mantenimiento</span>
                    </div>
                    <div class="status-item">
                        <span class="status-label">Sistema de Recordatorios</span>
                        <span class="status-value status-active">✅ Activo</span>
                    </div>
                    <div class="status-item">
                        <span class="status-label">Última verificación</span>
                        <span class="status-value">${systemStatus.lastCheck || 'Nunca'}</span>
                    </div>
                    <div class="status-item">
                        <span class="status-label">Recordatorios hoy</span>
                        <span class="status-value">${systemStatus.remindersToday}</span>
                    </div>
                </div>
                
                <div style="text-align: center;">
                    <a href="/check" class="btn">Verificar Recordatorios Manualmente</a>
                </div>
                
                <div class="info-box">
                    <h3>ℹ️ Información del Sistema</h3>
                    <p>El bot verifica automáticamente los recordatorios cada 6 horas.</p>
                    <p>Próxima verificación automática: ${getNextCronRun()}</p>
                </div>
            </div>
        </body>
        </html>
    `);
});

// Verificar recordatorios
app.get('/check', async (req, res) => {
    try {
        console.log('Verificando recordatorios...');
        
        // Simular verificación (cuando tengas tu PHP configurado)
        // const response = await axios.get(PHP_API_URL + '?action=check');
        
        systemStatus.lastCheck = new Date().toLocaleString('es-MX');
        
        res.json({
            success: true,
            message: 'Verificación completada',
            timestamp: systemStatus.lastCheck,
            phpUrl: PHP_API_URL
        });
    } catch (error) {
        res.json({
            success: false,
            error: error.message
        });
    }
});

// Endpoint de salud
app.get('/health', (req, res) => {
    res.json({
        status: 'OK',
        uptime: process.uptime(),
        ...systemStatus
    });
});

// Función auxiliar para mostrar próxima ejecución
function getNextCronRun() {
    const now = new Date();
    const hours = now.getHours();
    const nextRun = Math.ceil(hours / 6) * 6;
    if (nextRun >= 24) {
        return 'Mañana a las 00:00';
    }
    return `Hoy a las ${nextRun}:00`;
}

// Cron job cada 6 horas
cron.schedule('0 */6 * * *', () => {
    console.log('Ejecutando verificación automática...');
    systemStatus.lastCheck = new Date().toLocaleString('es-MX');
    // Aquí irá la lógica de verificación
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`✅ Servidor iniciado en puerto ${PORT}`);
    console.log(`📍 PHP API URL: ${PHP_API_URL}`);
});
