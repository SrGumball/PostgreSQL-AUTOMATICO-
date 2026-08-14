const express = require('express');
const cors = require('cors');
const { Client } = require('pg');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = 4554;
const CONFIG_FILE = path.join(__dirname, 'config.json');

// Estado interno do serviço
let serverStatus = "🔴 SERVIDOR OFF — Aguardando configuração";
let isConnected = false;
let dbConfig = null;

// Função para carregar a configuração local
function loadConfig() {
    if (fs.existsSync(CONFIG_FILE)) {
        try {
            dbConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
            checkConnection();
        } catch (e) {
            console.error("Erro ao ler arquivo de configuração:", e);
        }
    }
}

// Função para salvar configuração
function saveConfig(config) {
    dbConfig = config;
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

// Função para testar a conexão com o PostgreSQL
async function testDbConnection(config) {
    const client = new Client({
        host: config.host,
        port: config.port,
        database: config.db,
        user: config.user,
        password: config.pass,
        connectionTimeoutMillis: 5000
    });

    try {
        await client.connect();
        await client.query('SELECT 1');
        await client.end();
        return { success: true, message: "Conexão bem-sucedida" };
    } catch (error) {
        return { success: false, message: error.message };
    }
}

// Loop de Monitoramento
async function checkConnection() {
    if (!dbConfig) return;
    
    const result = await testDbConnection(dbConfig);
    if (result.success) {
        if (!isConnected) console.log("🟢 PostgreSQL Online!");
        serverStatus = "🟢 SERVIDOR ON — PostgreSQL conectado";
        isConnected = true;
    } else {
        if (isConnected) console.log("🔴 PostgreSQL Offline!");
        serverStatus = `🔴 SERVIDOR OFF — ${result.message}`;
        isConnected = false;
    }
}

// Monitora a conexão a cada 30 segundos
setInterval(checkConnection, 30000);

// Agendador de Backups (Exemplo diário à 02:00)
cron.schedule('0 2 * * *', () => {
    if (isConnected) {
        console.log("Executando backup automático...");
        // Aqui vai o comando child_process rodando o pg_dump
    } else {
        console.log("Tentativa de backup falhou: Servidor Offline");
    }
});


// ======== ENDPOINTS PARA O TAURI (PAINEL) ========

app.get('/api/status', (req, res) => {
    res.json({
        status: serverStatus,
        connected: isConnected,
        hasConfig: !!dbConfig
    });
});

app.post('/api/test-connection', async (req, res) => {
    const config = req.body;
    const result = await testDbConnection(config);
    
    if (result.success) {
        saveConfig(config);
        serverStatus = "🟢 SERVIDOR ON — PostgreSQL conectado";
        isConnected = true;
    }
    
    res.json(result);
});

// Inicialização
app.listen(PORT, () => {
    console.log(`🚀 Motor de Backup iniciado na porta ${PORT}`);
    console.log(`O robô está rodando de forma independente da interface gráfica.`);
    loadConfig();
});
