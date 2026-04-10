const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { createClient } = require('redis');
const DerivClient = require('./deriv-client');
const { SistemaAnaliseInteligente } = require('./analyzers/sistema-analise');
const MultiTimeframeManager = require('./multi-timeframe-manager');
const BotExecutionCore = require('./bot-execution-core');
const TraderBotAnalise = require('./analyzers/trader-bot-analyzer');
const { API_TOKEN, CANDLE_CLOSE_TOLERANCE, SMOOTHING } = require('./config');

const app = express();

// ========== CONFIGURAÇÕES DE SEGURANÇA ==========
const SECRETS = {
'7': process.env.SECRET_KEY_7_DAYS,
'30': process.env.SECRET_KEY_30_DAYS,
'90': process.env.SECRET_KEY_90_DAYS,
'180': process.env.SECRET_KEY_180_DAYS,
'365': process.env.SECRET_KEY_365_DAYS
};
const ADMIN_SECRET = process.env.ADMIN_SECRET;

const allowedOrigins = process.env.CORS_ORIGINS
? process.env.CORS_ORIGINS.split(',')
: ['http://localhost:3000'];

app.use(cors({
origin: (origin, callback) => {
if (!origin || allowedOrigins.includes(origin)) {
callback(null, true);
} else {
callback(new Error('Origem não permitida pelo CORS'));
}
},
optionsSuccessStatus: 200
}));

app.use(express.json());
app.set('trust proxy', 1);

// ========== CONFIGURAÇÃO DO REDIS (OPCIONAL) ==========
let redisClient = null;

const CANDLE_CLOSE_MARGIN = 5;

function getTTLAlignedToCandle(timeframeSeconds) {
const nowSec = Math.floor(Date.now() / 1000);
const elapsedInCandle = nowSec % timeframeSeconds;
const secondsUntilClose = timeframeSeconds - elapsedInCandle;
const ttl = Math.max(secondsUntilClose - CANDLE_CLOSE_MARGIN, 3);
return ttl;
}

const TTL_BY_TIMEFRAME = {
'M1': 10,
'M5': 20,
'M15': 30,
'M30': 45,
'H1': 60,
'H4': 120,
'H24': 300
};

const TTL_BY_MODE = {
'SNIPER': 60,
'CAÇADOR': 300,
'PESCADOR': 900
};

function getTTLByMode(mode, timeframeKey) {
const tf = ALL_TIMEFRAMES_CONFIG_STATIC[timeframeKey];
if (tf) return getTTLAlignedToCandle(tf.seconds);
const baseTTL = TTL_BY_MODE[mode] || 300;
return baseTTL;
}

const ALL_TIMEFRAMES_CONFIG_STATIC = {
'M1':  { seconds: 60 },
'M5':  { seconds: 300 },
'M15': { seconds: 900 },
'M30': { seconds: 1800 },
'H1':  { seconds: 3600 },
'H4':  { seconds: 14400 },
'H24': { seconds: 86400 }
};

if (process.env.REDIS_URL) {
try {
redisClient = createClient({ url: process.env.REDIS_URL });
redisClient.on('error', (err) => console.error('❌ Redis error:', err));

(async () => {
await redisClient.connect();
console.log('✅ Conectado ao Redis');
})();
} catch (err) {
console.error('❌ Falha ao conectar Redis:', err);
redisClient = null;
}
} else {
console.log('⚠️ Redis não configurado - cache desativado');
}

const TRADING_MODES = {
'SNIPER': {
timeframes: ['M1', 'M5', 'M15'],
description: 'Entradas cirúrgicas de 1-15 minutos'
},
'CAÇADOR': {
timeframes: ['M5', 'M15', 'H1'],
description: 'Ondas médias de 15-60 minutos'
},
'PESCADOR': {
timeframes: ['M15', 'H1', 'H4', 'H24'],
description: 'Grandes movimentos de horas a dias'
}
};

function getATRTimeframeByMode(mode) {
const modeATRMap = {
'SNIPER': 'M1',
'CACADOR': 'M5',
'PESCADOR': 'M15'
};
return modeATRMap[mode] || 'M5';
}

const ALL_TIMEFRAMES_CONFIG = {
'M1': { key: 'M1', seconds: 60, candleCount: 400, minRequired: 50 },
'M5': { key: 'M5', seconds: 300, candleCount: 400, minRequired: 50 },
'M15': { key: 'M15', seconds: 900, candleCount: 400, minRequired: 50 },
'M30': { key: 'M30', seconds: 1800, candleCount: 400, minRequired: 50 },
'H1': { key: 'H1', seconds: 3600, candleCount: 400, minRequired: 50 },
'H4': { key: 'H4', seconds: 14400, candleCount: 400, minRequired: 50 },
'H24': { key: 'H24', seconds: 86400, candleCount: 400, minRequired: 50 }
};

function isCandleClosed(candle, timeframeSeconds) {
if (!candle || !candle.epoch) return true;
const now = Math.floor(Date.now() / 1000);
const candleEnd = candle.epoch + timeframeSeconds;
return now >= candleEnd - CANDLE_CLOSE_TOLERANCE;
}

const inFlightRequests = new Map();

async function getCandlesWithCache(client, symbol, tf, mode, forceFresh = false) {
const cacheKey = `candles:${symbol}:${tf.key}`;
const ttl = getTTLAlignedToCandle(tf.seconds);
console.log(`⏱️ TTL ${tf.key}: ${ttl}s (candle fecha em ~${ttl + CANDLE_CLOSE_MARGIN}s)`);

if (redisClient && redisClient.isReady && !forceFresh) {
try {
const cached = await redisClient.get(cacheKey);
if (cached) {
const remainingTTL = await redisClient.ttl(cacheKey);
console.log(`✅ Cache hit: ${cacheKey} (TTL restante: ${remainingTTL}s)`);

if (remainingTTL <= CANDLE_CLOSE_MARGIN) {
setImmediate(async () => {
try {
console.log(`🔄 Pré-carregando novo candle em background: ${cacheKey}`);
const freshCandles = await client.getCandles(symbol, tf.candleCount, tf.seconds);
if (Array.isArray(freshCandles)) {
const newTtl = getTTLAlignedToCandle(tf.seconds);
await redisClient.setEx(cacheKey, newTtl, JSON.stringify(freshCandles));
console.log(`✅ Cache pré-carregado: ${cacheKey} (novo TTL: ${newTtl}s)`);
}
} catch (err) {
console.error(`❌ Erro pré-carregando cache: ${err.message}`);
}
});
}

return JSON.parse(cached);
}
} catch (err) {
console.error(`❌ Erro lendo Redis para ${cacheKey}:`, err.message);
}
}

if (inFlightRequests.has(cacheKey)) {
console.log(`⏳ Aguardando requisição em voo para ${cacheKey}`);
return inFlightRequests.get(cacheKey);
}

const fetchPromise = (async () => {
try {
console.log(`🔄 Buscando ${tf.key} direto da Deriv (${tf.candleCount} candles) - modo ${mode}`);
const candles = await client.getCandles(symbol, tf.candleCount, tf.seconds);

if (!Array.isArray(candles)) {
console.error(`❌ Resposta inválida da Deriv para ${tf.key}: não é um array`);
return candles;
}

console.log(`📊 ${tf.key}: recebidos ${candles.length} candles`);

if (candles.length < tf.minRequired) {
console.log(`⚠️ ${tf.key}: apenas ${candles.length} candles, mínimo ${tf.minRequired}`);
}

if (redisClient && redisClient.isReady) {
redisClient.setEx(cacheKey, ttl, JSON.stringify(candles))
.then(() => console.log(`✅ Cache salvo: ${cacheKey} (TTL: ${ttl}s)`))
.catch(err => console.error(`❌ Erro salvando cache: ${err.message}`));
}

return candles;
} finally {
inFlightRequests.delete(cacheKey);
}
})();

inFlightRequests.set(cacheKey, fetchPromise);
return fetchPromise;
}

const analyzeLimiter = rateLimit({
windowMs: 15 * 60 * 1000,
max: 100,
message: { error: 'Muitas requisições, tente novamente mais tarde.' }
});

const adminLimiter = rateLimit({
windowMs: 60 * 60 * 1000,
max: 10,
message: { error: 'Limite de geração de tokens excedido.' }
});

function authenticateToken(req, res, next) {
const authHeader = req.headers['authorization'];
let token = authHeader && authHeader.split(' ')[1];

if (!token && req.body && req.body.token) {
token = req.body.token;
}

if (!token) {
return res.status(401).json({ error: 'Token não fornecido' });
}

const secretsToTry = [
{ period: 365, key: SECRETS['365'] },
{ period: 180, key: SECRETS['180'] },
{ period: 90, key: SECRETS['90'] },
{ period: 30, key: SECRETS['30'] },
{ period: 7, key: SECRETS['7'] }
];

for (const { period, key } of secretsToTry) {
if (!key) continue;
try {
const decoded = jwt.verify(token, key);
req.user = decoded;
req.tokenPeriod = period;
return next();
} catch (err) {}
}

return res.status(403).json({ error: 'Token inválido ou expirado' });
}

let derivClient = null;
let derivConnectionPromise = null;

async function getDerivClient() {
if (derivConnectionPromise) {
return derivConnectionPromise;
}

if (!derivClient) {
derivClient = new DerivClient(API_TOKEN);
}

derivConnectionPromise = derivClient.connect()
.then(() => {
console.log('✅ Cliente Deriv pronto com conexão persistente');
return derivClient;
})
.catch(err => {
console.error('❌ Falha na conexão persistente:', err);
derivConnectionPromise = null;
throw err;
});

return derivConnectionPromise;
}

async function getCurrentPrice(client, symbol) {
return new Promise((resolve) => {
const reqId = Date.now();

const handler = (response) => {
if (response.error) {
console.log(`⚠️ Erro no tick: ${response.error.message}`);
clearTimeout(timeout);
if (typeof client.removeListener === 'function') client.removeListener(reqId, handler);
resolve(null);
} else if (response.tick && response.tick.symbol === symbol) {
clearTimeout(timeout);
if (typeof client.removeListener === 'function') client.removeListener(reqId, handler);
resolve(response.tick.quote);
}
};

const timeout = setTimeout(() => {
console.log(`⏱️ Timeout ao obter tick para ${symbol}`);
if (typeof client.removeListener === 'function') client.removeListener(reqId, handler);
resolve(null);
}, 800);

if (typeof client.addListener !== 'function') {
console.log(`⚠️ DerivClient não suporta addListener`);
clearTimeout(timeout);
resolve(null);
return;
}

client.addListener(reqId, handler);

if (client.ws && client.ws.readyState === client.ws.OPEN) {
client.ws.send(JSON.stringify({ tick: symbol, req_id: reqId }));
} else {
console.log(`⚠️ WebSocket não conectado para tick de ${symbol}`);
clearTimeout(timeout);
if (typeof client.removeListener === 'function') client.removeListener(reqId, handler);
resolve(null);
}
});
}

app.get('/health', (req, res) => {
res.status(200).send('OK');
});

app.get('/api/trading-modes', (req, res) => {
res.json({
success: true,
modes: Object.keys(TRADING_MODES).map(key => ({
id: key,
name: key,
description: TRADING_MODES[key].description,
timeframes: TRADING_MODES[key].timeframes
}))
});
});

app.post('/api/validate-token', (req, res) => {
const { token } = req.body;

if (!token) {
return res.status(400).json({ valid: false, message: 'Token não fornecido' });
}

const secretsToTry = [
{ period: 365, key: SECRETS['365'] },
{ period: 180, key: SECRETS['180'] },
{ period: 90, key: SECRETS['90'] },
{ period: 30, key: SECRETS['30'] },
{ period: 7, key: SECRETS['7'] }
];

for (const { period, key } of secretsToTry) {
if (!key) continue;
try {
const decoded = jwt.verify(token, key);
return res.json({
valid: true,
periodDays: period,
expiresAt: decoded.exp,
userId: decoded.userId || null
});
} catch (err) {}
}

return res.status(401).json({ valid: false, message: 'Token inválido ou expirado' });
});

app.post('/api/admin/generate-token', adminLimiter, (req, res) => {
const { adminKey, periodDays, userId } = req.body;

if (!adminKey || adminKey !== ADMIN_SECRET) {
return res.status(403).json({ error: 'Chave de administrador inválida' });
}

const period = parseInt(periodDays);
if (![7, 30, 90, 180, 365].includes(period)) {
return res.status(400).json({ error: 'Período inválido. Use 7, 30, 90, 180 ou 365.' });
}

const secret = SECRETS[period.toString()];
if (!secret) {
return res.status(500).json({ error: 'Chave para o período não configurada no servidor' });
}

const { randomUUID } = require('crypto');
const finalUserId = userId || randomUUID();
const jti = randomUUID();

const payload = {
userId: finalUserId,
period,
jti
};

const expiresInSeconds = period * 24 * 60 * 60;
const token = jwt.sign(payload, secret, { expiresIn: expiresInSeconds });

res.json({
success: true,
token,
periodDays: period,
expiresIn: expiresInSeconds,
userId: finalUserId
});
});

// ═══════════════════════════════════════════════════════
// NOVA ROTA: REINICIAR SERVIÇO RENDER
// ═══════════════════════════════════════════════════════
app.post('/api/admin/restart-render', adminLimiter, async (req, res) => {
  try {
    const { adminKey } = req.body;
    
    // Validar chave de administrador
    if (!adminKey || adminKey !== ADMIN_SECRET) {
      return res.status(403).json({ 
        success: false, 
        error: 'Chave de administrador inválida' 
      });
    }
    
    const RENDER_SERVICE_ID = process.env.RENDER_SERVICE_ID;
    const RENDER_API_KEY = process.env.RENDER_API_KEY;
    
    if (!RENDER_SERVICE_ID || !RENDER_API_KEY) {
      return res.status(500).json({ 
        success: false, 
        error: 'Configuração do Render não encontrada no servidor. Verifique as variáveis de ambiente.' 
      });
    }
    
    console.log(`🔄 Reiniciando serviço Render: ${RENDER_SERVICE_ID}`);
    
    const response = await fetch(`https://api.render.com/v1/services/${RENDER_SERVICE_ID}/restart`, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${RENDER_API_KEY}`
      }
    });
    
    if (response.ok) {
      console.log(`✅ Serviço Render reiniciado com sucesso`);
      res.json({ 
        success: true, 
        message: 'Serviço Render reiniciado com sucesso! O servidor estará disponível em alguns segundos.' 
      });
    } else {
      const errorText = await response.text();
      console.error(`❌ Erro Render API (${response.status}):`, errorText);
      res.status(response.status).json({ 
        success: false, 
        error: `Erro ${response.status} da API Render: ${errorText}` 
      });
    }
  } catch (error) {
    console.error('❌ Erro ao reiniciar Render:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// ═══════════════════════════════════════════════════════
// ROTA EXISTENTE: CONNECTION STATUS
// ═══════════════════════════════════════════════════════

app.get('/api/connection-status', authenticateToken, (req, res) => {
if (!derivClient) {
return res.json({ status: 'not_initialized' });
}
res.json(derivClient.getConnectionStatus());
});

const RSI_LIMITS_BY_ASSET = {
  'forex':          { pullback: 30, extremo: 25, sobrecompra: 70, sobrevenda: 30, descricao: 'Forex' },
  'volatility_index':{ pullback: 35, extremo: 30, sobrecompra: 80, sobrevenda: 20, descricao: 'Volatility' },
  'commodity':      { pullback: 35, extremo: 30, sobrecompra: 75, sobrevenda: 25, descricao: 'Commodity' },
  'criptomoeda':    { pullback: 30, extremo: 25, sobrecompra: 80, sobrevenda: 20, descricao: 'Criptomoeda' },
  'indice_normal':  { pullback: 35, extremo: 30, sobrecompra: 75, sobrevenda: 25, descricao: 'Índice Normal' }
};

// ========== FUNÇÃO CORRIGIDA: GERAR ALERTA DE PULLBACK ==========
// Detecta pullback independente do primarySignal (funciona mesmo com HOLD)
function gerarAlertaPullback(rsi, primarySignal, tipoAtivo, timeframeLabel) {
  const limite = RSI_LIMITS_BY_ASSET[tipoAtivo] || RSI_LIMITS_BY_ASSET.indice_normal;
  let alertaPullback = null;

  // 1. DETECÇÃO PARA SOBREVENDA (RSI BAIXO) - independente do sinal
  if (rsi < limite.pullback) {
    if (rsi < limite.extremo) {
      const excesso = limite.pullback - rsi;
      alertaPullback = {
        tipo: 'PULLBACK_EXTREMO',
        mensagem: `🚨 [EXTREMO] RSI ${timeframeLabel} em ${rsi.toFixed(0)} - EXTREMA SOBREVENDA (${excesso.toFixed(0)} pontos abaixo do limite)! Pullback FORTE iminente!`,
        acao: 'AGUARDAR_RETOMADA_OBRIGATORIO',
        nivel: 'EXTREMO',
        tipo_ativo: tipoAtivo,
        rsi_atual: rsi,
        excesso: excesso,
        tempo_estimado: 'imediato'
      };
    }
    else if (rsi >= limite.extremo && rsi < limite.pullback) {
      alertaPullback = {
        tipo: 'PULLBACK_IMINENTE',
        mensagem: `⚠️ [IMINENTE] RSI ${timeframeLabel} em ${rsi.toFixed(0)} - ZONA DE SOBREVENDA! Pullback iminente a qualquer momento!`,
        acao: 'AGUARDAR_RETOMADA',
        nivel: 'IMINENTE',
        tipo_ativo: tipoAtivo,
        rsi_atual: rsi,
        distancia_limite: rsi - limite.pullback,
        tempo_estimado: 'próximo candle'
      };
    }
  }
  // 2. DETECÇÃO PARA SOBRECOMPRA (RSI ALTO) - independente do sinal
  else if (rsi > limite.sobrecompra) {
    if (rsi > limite.sobrecompra + 5) {
      const excesso = rsi - limite.sobrecompra;
      alertaPullback = {
        tipo: 'PULLBACK_EXTREMO',
        mensagem: `🚨 [EXTREMO] RSI ${timeframeLabel} em ${rsi.toFixed(0)} - EXTREMA SOBRECOMPRA (${excesso.toFixed(0)} pontos acima do limite)! Pullback FORTE iminente!`,
        acao: 'AGUARDAR_RETOMADA_OBRIGATORIO',
        nivel: 'EXTREMO',
        tipo_ativo: tipoAtivo,
        rsi_atual: rsi,
        excesso: excesso,
        tempo_estimado: 'imediato'
      };
    }
    else if (rsi <= limite.sobrecompra + 5 && rsi > limite.sobrecompra) {
      alertaPullback = {
        tipo: 'PULLBACK_IMINENTE',
        mensagem: `⚠️ [IMINENTE] RSI ${timeframeLabel} em ${rsi.toFixed(0)} - ZONA DE SOBRECOMPRA! Pullback iminente a qualquer momento!`,
        acao: 'AGUARDAR_RETOMADA',
        nivel: 'IMINENTE',
        tipo_ativo: tipoAtivo,
        rsi_atual: rsi,
        distancia_limite: limite.sobrecompra - rsi,
        tempo_estimado: 'próximo candle'
      };
    }
  }
  // 3. DETECÇÃO PREVENTIVA (aproximando das zonas críticas)
  else {
    if (rsi < limite.pullback + 12 && rsi >= limite.pullback) {
      alertaPullback = {
        tipo: 'PULLBACK_PREVENTIVO',
        mensagem: `⚠️ [PREVENTIVO] RSI ${timeframeLabel} em ${rsi.toFixed(0)} - aproximando da sobrevenda (${limite.pullback}). Pullback em breve!`,
        acao: 'PREPARAR_PULLBACK',
        nivel: 'PREVENTIVO',
        tipo_ativo: tipoAtivo,
        rsi_atual: rsi,
        distancia_limite: rsi - limite.pullback,
        tempo_estimado: 'próximos 1-3 candles'
      };
    }
    else if (rsi > limite.sobrecompra - 12 && rsi <= limite.sobrecompra) {
      alertaPullback = {
        tipo: 'PULLBACK_PREVENTIVO',
        mensagem: `⚠️ [PREVENTIVO] RSI ${timeframeLabel} em ${rsi.toFixed(0)} - aproximando da sobrecompra (${limite.sobrecompra}). Pullback em breve!`,
        acao: 'PREPARAR_PULLBACK',
        nivel: 'PREVENTIVO',
        tipo_ativo: tipoAtivo,
        rsi_atual: rsi,
        distancia_limite: limite.sobrecompra - rsi,
        tempo_estimado: 'próximos 1-3 candles'
      };
    }
  }

  if (alertaPullback) {
    console.log(`🔔 ${timeframeLabel} - ${alertaPullback.nivel}: RSI=${rsi.toFixed(0)} | ${alertaPullback.mensagem.substring(0, 80)}...`);
  }

  return alertaPullback;
}

function calcularTimingM1(m1Analysis, primarySignal) {
  if (!m1Analysis) {
    return {
      permitido: false,
      motivo: 'M1 não disponível',
      rsi: null,
      sinal: null,
      adx: null,
      alerta_pullback: null
    };
  }

  const adx = m1Analysis.adx || 0;
  const rsi = m1Analysis.rsi || 50;
  const temTendencia = adx >= 22;

  const tipoAtivo = m1Analysis.tipo_ativo || 'indice_normal';
  const alertaPullback = gerarAlertaPullback(rsi, primarySignal, tipoAtivo, 'M1');

  if (primarySignal === 'HOLD') {
    return {
      permitido: false,
      motivo: 'Sinal principal HOLD - aguardar definição',
      rsi: rsi,
      sinal: m1Analysis.sinal,
      adx: adx,
      alerta_pullback: alertaPullback
    };
  }

  if (primarySignal === 'CALL') {
    if (m1Analysis.sinal === 'CALL' && rsi < 75 && temTendencia) {
      return {
        permitido: true,
        motivo: `M1 confirmando CALL com tendência (ADX ${adx.toFixed(0)})`,
        rsi, sinal: m1Analysis.sinal, adx,
        alerta_pullback: alertaPullback
      };
    }
    else if (m1Analysis.sinal === 'CALL' && rsi < 75) {
      return {
        permitido: true,
        motivo: `M1 confirmando CALL (tendência fraca/moderada ADX ${adx.toFixed(0)})`,
        rsi, sinal: m1Analysis.sinal, adx,
        alerta_pullback: alertaPullback
      };
    }
    else if (m1Analysis.sinal === 'PUT' && rsi < 38) {
      return {
        permitido: true,
        motivo: `M1 oversold - possível reversão para CALL (ADX ${adx.toFixed(0)})`,
        rsi, sinal: m1Analysis.sinal, adx,
        alerta_pullback: alertaPullback
      };
    }
    else if (temTendencia && m1Analysis.sinal === 'CALL') {
      return {
        permitido: true,
        motivo: `M1 em tendência de CALL (ADX ${adx.toFixed(0)})`,
        rsi, sinal: m1Analysis.sinal, adx,
        alerta_pullback: alertaPullback
      };
    }
    else {
      return {
        permitido: false,
        motivo: `M1 não confirma (${m1Analysis.sinal}, RSI ${rsi.toFixed(0)}, ADX ${adx.toFixed(0)})`,
        rsi, sinal: m1Analysis.sinal, adx,
        alerta_pullback: alertaPullback
      };
    }
  }
  else if (primarySignal === 'PUT') {
    if (m1Analysis.sinal === 'PUT' && rsi > 25 && temTendencia) {
      return {
        permitido: true,
        motivo: `M1 confirmando PUT com tendência (ADX ${adx.toFixed(0)})`,
        rsi, sinal: m1Analysis.sinal, adx,
        alerta_pullback: alertaPullback
      };
    }
    else if (m1Analysis.sinal === 'PUT' && rsi > 25) {
      return {
        permitido: true,
        motivo: `M1 confirmando PUT (tendência fraca/moderada ADX ${adx.toFixed(0)})`,
        rsi, sinal: m1Analysis.sinal, adx,
        alerta_pullback: alertaPullback
      };
    }
    else if (m1Analysis.sinal === 'CALL' && rsi > 62) {
      return {
        permitido: true,
        motivo: `M1 overbought - possível reversão para PUT (ADX ${adx.toFixed(0)})`,
        rsi, sinal: m1Analysis.sinal, adx,
        alerta_pullback: alertaPullback
      };
    }
    else if (temTendencia && m1Analysis.sinal === 'PUT') {
      return {
        permitido: true,
        motivo: `M1 em tendência de PUT (ADX ${adx.toFixed(0)})`,
        rsi, sinal: m1Analysis.sinal, adx,
        alerta_pullback: alertaPullback
      };
    }
    else {
      return {
        permitido: false,
        motivo: `M1 não confirma (${m1Analysis.sinal}, RSI ${rsi.toFixed(0)}, ADX ${adx.toFixed(0)})`,
        rsi, sinal: m1Analysis.sinal, adx,
        alerta_pullback: alertaPullback
      };
    }
  }

  return {
    permitido: false,
    motivo: 'Sinal principal neutro',
    rsi, sinal: m1Analysis.sinal, adx,
    alerta_pullback: alertaPullback
  };
}

function calcularTimingM5(m5Analysis, primarySignal) {
  if (!m5Analysis) {
    return {
      permitido: false,
      motivo: 'M5 não disponível',
      rsi: null,
      sinal: null,
      adx: null,
      alerta_pullback: null
    };
  }

  const adx = m5Analysis.adx || 0;
  const rsi = m5Analysis.rsi || 50;
  const temTendencia = adx >= 22;

  const tipoAtivo = m5Analysis.tipo_ativo || 'indice_normal';
  const alertaPullback = gerarAlertaPullback(rsi, primarySignal, tipoAtivo, 'M5');

  if (primarySignal === 'HOLD') {
    return {
      permitido: false,
      motivo: 'Sinal principal HOLD - aguardar definição',
      rsi: rsi,
      sinal: m5Analysis.sinal,
      adx: adx,
      alerta_pullback: alertaPullback
    };
  }

  if (primarySignal === 'CALL') {
    if (m5Analysis.sinal === 'CALL' && rsi < 75 && temTendencia) {
      return {
        permitido: true,
        motivo: `M5 confirmando CALL com tendência (ADX ${adx.toFixed(0)})`,
        rsi, sinal: m5Analysis.sinal, adx,
        alerta_pullback: alertaPullback
      };
    }
    else if (m5Analysis.sinal === 'CALL' && rsi < 75) {
      return {
        permitido: true,
        motivo: `M5 confirmando CALL (tendência fraca/moderada ADX ${adx.toFixed(0)})`,
        rsi, sinal: m5Analysis.sinal, adx,
        alerta_pullback: alertaPullback
      };
    }
    else if (m5Analysis.sinal === 'PUT' && rsi < 38) {
      return {
        permitido: true,
        motivo: `M5 oversold - possível reversão para CALL (ADX ${adx.toFixed(0)})`,
        rsi, sinal: m5Analysis.sinal, adx,
        alerta_pullback: alertaPullback
      };
    }
    else if (temTendencia && m5Analysis.sinal === 'CALL') {
      return {
        permitido: true,
        motivo: `M5 em tendência de CALL (ADX ${adx.toFixed(0)})`,
        rsi, sinal: m5Analysis.sinal, adx,
        alerta_pullback: alertaPullback
      };
    }
    else {
      return {
        permitido: false,
        motivo: `M5 não confirma (${m5Analysis.sinal}, RSI ${rsi.toFixed(0)}, ADX ${adx.toFixed(0)})`,
        rsi, sinal: m5Analysis.sinal, adx,
        alerta_pullback: alertaPullback
      };
    }
  }
  else if (primarySignal === 'PUT') {
    if (m5Analysis.sinal === 'PUT' && rsi > 25 && temTendencia) {
      return {
        permitido: true,
        motivo: `M5 confirmando PUT com tendência (ADX ${adx.toFixed(0)})`,
        rsi, sinal: m5Analysis.sinal, adx,
        alerta_pullback: alertaPullback
      };
    }
    else if (m5Analysis.sinal === 'PUT' && rsi > 25) {
      return {
        permitido: true,
        motivo: `M5 confirmando PUT (tendência fraca/moderada ADX ${adx.toFixed(0)})`,
        rsi, sinal: m5Analysis.sinal, adx,
        alerta_pullback: alertaPullback
      };
    }
    else if (m5Analysis.sinal === 'CALL' && rsi > 62) {
      return {
        permitido: true,
        motivo: `M5 overbought - possível reversão para PUT (ADX ${adx.toFixed(0)})`,
        rsi, sinal: m5Analysis.sinal, adx,
        alerta_pullback: alertaPullback
      };
    }
    else if (temTendencia && m5Analysis.sinal === 'PUT') {
      return {
        permitido: true,
        motivo: `M5 em tendência de PUT (ADX ${adx.toFixed(0)})`,
        rsi, sinal: m5Analysis.sinal, adx,
        alerta_pullback: alertaPullback
      };
    }
    else {
      return {
        permitido: false,
        motivo: `M5 não confirma (${m5Analysis.sinal}, RSI ${rsi.toFixed(0)}, ADX ${adx.toFixed(0)})`,
        rsi, sinal: m5Analysis.sinal, adx,
        alerta_pullback: alertaPullback
      };
    }
  }

  return {
    permitido: false,
    motivo: 'Sinal principal neutro',
    rsi, sinal: m5Analysis.sinal, adx,
    alerta_pullback: alertaPullback
  };
}

function calcularTimingM15(m15Analysis, primarySignal) {
  if (!m15Analysis) {
    return {
      permitido: false,
      motivo: 'M15 não disponível',
      rsi: null,
      sinal: null,
      adx: null,
      alerta_pullback: null
    };
  }

  const adx = m15Analysis.adx || 0;
  const rsi = m15Analysis.rsi || 50;
  const temTendencia = adx >= 22;

  const tipoAtivo = m15Analysis.tipo_ativo || 'indice_normal';
  const alertaPullback = gerarAlertaPullback(rsi, primarySignal, tipoAtivo, 'M15');

  if (primarySignal === 'HOLD') {
    return {
      permitido: false,
      motivo: 'Sinal principal HOLD - aguardar definição',
      rsi: rsi,
      sinal: m15Analysis.sinal,
      adx: adx,
      alerta_pullback: alertaPullback
    };
  }

  if (primarySignal === 'CALL') {
    if (m15Analysis.sinal === 'CALL' && rsi < 72 && temTendencia) {
      return {
        permitido: true,
        motivo: `M15 confirmando CALL com tendência (ADX ${adx.toFixed(0)})`,
        rsi, sinal: m15Analysis.sinal, adx,
        alerta_pullback: alertaPullback
      };
    }
    else if (m15Analysis.sinal === 'CALL' && rsi < 72) {
      return {
        permitido: true,
        motivo: `M15 confirmando CALL (tendência fraca/moderada ADX ${adx.toFixed(0)})`,
        rsi, sinal: m15Analysis.sinal, adx,
        alerta_pullback: alertaPullback
      };
    }
    else if (m15Analysis.sinal === 'PUT' && rsi < 36) {
      return {
        permitido: true,
        motivo: `M15 oversold - possível reversão para CALL (ADX ${adx.toFixed(0)})`,
        rsi, sinal: m15Analysis.sinal, adx,
        alerta_pullback: alertaPullback
      };
    }
    else if (temTendencia && m15Analysis.sinal === 'CALL') {
      return {
        permitido: true,
        motivo: `M15 em tendência de CALL (ADX ${adx.toFixed(0)})`,
        rsi, sinal: m15Analysis.sinal, adx,
        alerta_pullback: alertaPullback
      };
    }
    else {
      return {
        permitido: false,
        motivo: `M15 não confirma (${m15Analysis.sinal}, RSI ${rsi.toFixed(0)}, ADX ${adx.toFixed(0)})`,
        rsi, sinal: m15Analysis.sinal, adx,
        alerta_pullback: alertaPullback
      };
    }
  }
  else if (primarySignal === 'PUT') {
    if (m15Analysis.sinal === 'PUT' && rsi > 28 && temTendencia) {
      return {
        permitido: true,
        motivo: `M15 confirmando PUT com tendência (ADX ${adx.toFixed(0)})`,
        rsi, sinal: m15Analysis.sinal, adx,
        alerta_pullback: alertaPullback
      };
    }
    else if (m15Analysis.sinal === 'PUT' && rsi > 28) {
      return {
        permitido: true,
        motivo: `M15 confirmando PUT (tendência fraca/moderada ADX ${adx.toFixed(0)})`,
        rsi, sinal: m15Analysis.sinal, adx,
        alerta_pullback: alertaPullback
      };
    }
    else if (m15Analysis.sinal === 'CALL' && rsi > 65) {
      return {
        permitido: true,
        motivo: `M15 overbought - possível reversão para PUT (ADX ${adx.toFixed(0)})`,
        rsi, sinal: m15Analysis.sinal, adx,
        alerta_pullback: alertaPullback
      };
    }
    else if (temTendencia && m15Analysis.sinal === 'PUT') {
      return {
        permitido: true,
        motivo: `M15 em tendência de PUT (ADX ${adx.toFixed(0)})`,
        rsi, sinal: m15Analysis.sinal, adx,
        alerta_pullback: alertaPullback
      };
    }
    else {
      return {
        permitido: false,
        motivo: `M15 não confirma (${m15Analysis.sinal}, RSI ${rsi.toFixed(0)}, ADX ${adx.toFixed(0)})`,
        rsi, sinal: m15Analysis.sinal, adx,
        alerta_pullback: alertaPullback
      };
    }
  }

  return {
    permitido: false,
    motivo: 'Sinal principal neutro',
    rsi, sinal: m15Analysis.sinal, adx,
    alerta_pullback: alertaPullback
  };
}

// ========== FUNÇÕES ADICIONADAS: TIMING H1 E H4 (APENAS ALERTAS) ==========
function calcularTimingH1(h1Analysis, primarySignal) {
  if (!h1Analysis) {
    return {
      permitido: false,
      motivo: 'H1 não disponível',
      rsi: null,
      sinal: null,
      adx: null,
      alerta_pullback: null
    };
  }

  const adx = h1Analysis.adx || 0;
  const rsi = h1Analysis.rsi || 50;

  const tipoAtivo = h1Analysis.tipo_ativo || 'indice_normal';
  const alertaPullback = gerarAlertaPullback(rsi, primarySignal, tipoAtivo, 'H1');

  return {
    permitido: false,
    motivo: 'H1 é timeframe de tendência',
    rsi: rsi,
    sinal: h1Analysis.sinal,
    adx: adx,
    alerta_pullback: alertaPullback
  };
}

function calcularTimingH4(h4Analysis, primarySignal) {
  if (!h4Analysis) {
    return {
      permitido: false,
      motivo: 'H4 não disponível',
      rsi: null,
      sinal: null,
      adx: null,
      alerta_pullback: null
    };
  }

  const adx = h4Analysis.adx || 0;
  const rsi = h4Analysis.rsi || 50;

  const tipoAtivo = h4Analysis.tipo_ativo || 'indice_normal';
  const alertaPullback = gerarAlertaPullback(rsi, primarySignal, tipoAtivo, 'H4');

  return {
    permitido: false,
    motivo: 'H4 é timeframe de tendência principal',
    rsi: rsi,
    sinal: h4Analysis.sinal,
    adx: adx,
    alerta_pullback: alertaPullback
  };
}

function getPriceSource(mtfManager) {
if (mtfManager.timeframes['M1']?.analysis?.preco_atual) return 'M1';
if (mtfManager.timeframes['M5']?.analysis?.preco_atual) return 'M5';
if (mtfManager.timeframes['M15']?.analysis?.preco_atual) return 'M15';
if (mtfManager.timeframes['H1']?.analysis?.preco_atual) return 'H1';
if (mtfManager.timeframes['H4']?.analysis?.preco_atual) return 'H4';
return 'unknown';
}

app.post('/api/analyze', authenticateToken, analyzeLimiter, async (req, res) => {
const startTime = Date.now();

try {
const { symbol, mode } = req.body;

if (!symbol) {
return res.status(400).json({ error: 'Símbolo é obrigatório' });
}

if (!mode || !TRADING_MODES[mode]) {
return res.status(400).json({
error: 'Modo de trading inválido. Use: SNIPER, CAÇADOR ou PESCADOR',
availableModes: Object.keys(TRADING_MODES)
});
}

console.log(`\n🎯 Modo selecionado: ${mode} - ${TRADING_MODES[mode].description}`);
console.log(`📊 Timeframes a analisar: ${TRADING_MODES[mode].timeframes.join(', ')}`);

const client = await getDerivClient();

const timeframesToAnalyze = TRADING_MODES[mode].timeframes
.map(tfKey => ALL_TIMEFRAMES_CONFIG[tfKey]);

const mtfManager = new MultiTimeframeManager(symbol);

const tipoAtivo = symbol.startsWith('R_') ? 'volatility_index' :
(symbol.includes('frx') ? 'forex' : 'indice_normal');

const sistemaBase = new SistemaAnaliseInteligente(symbol);

if (sistemaBase.sistemaPesos && sistemaBase.sistemaPesos.setTipoAtivo) {
sistemaBase.sistemaPesos.setTipoAtivo(tipoAtivo);
}

const atrTimeframeKey = getATRTimeframeByMode(mode);
console.log(`📊 Modo ${mode} - usando ${atrTimeframeKey} para cálculo de ATR/volatilidade`);

const allTfKeysToFetch = Array.from(
new Set([atrTimeframeKey, ...TRADING_MODES[mode].timeframes])
);

console.log(`⚡ Buscando ${allTfKeysToFetch.length} timeframes em paralelo: ${allTfKeysToFetch.join(', ')}`);

const candlesMap = {};
await Promise.all(
allTfKeysToFetch.map(async (tfKey) => {
const tf = ALL_TIMEFRAMES_CONFIG[tfKey];
if (!tf) return;
try {
const candles = await getCandlesWithCache(client, symbol, tf, mode, false);
if (Array.isArray(candles) && candles.length > 0) {
candlesMap[tfKey] = candles;
console.log(`✅ ${tfKey}: ${candles.length} candles prontos`);
} else {
console.log(`⚠️ ${tfKey}: sem candles válidos`);
}
} catch (err) {
console.error(`❌ Erro ao buscar ${tfKey}:`, err.message);
}
})
);

let historicalCandles = candlesMap[atrTimeframeKey] || null;
if (!historicalCandles) {
const fallbackMap = {
'M1': ['M5', 'M15'],
'M5': ['M1', 'M15'],
'M15': ['M5', 'H1']
};
for (const fbKey of (fallbackMap[atrTimeframeKey] || ['M5', 'M15'])) {
if (candlesMap[fbKey]) {
historicalCandles = candlesMap[fbKey];
console.log(`🔄 Fallback ATR: usando ${fbKey}`);
break;
}
}
}

console.log(`⚡ Analisando ${timeframesToAnalyze.length} timeframes em paralelo`);

await Promise.all(
timeframesToAnalyze.map(async (tf) => {
try {
const candles = candlesMap[tf.key];
if (!candles) {
console.log(`⚠️ ${tf.key}: candles não disponíveis, pulando análise`);
return;
}
if (candles.length < tf.minRequired) {
console.log(`⚠️ ${tf.key}: apenas ${candles.length} candles, mínimo ${tf.minRequired}`);
return;
}
const analysis = await sistemaBase.analisar(candles, tf.key);
if (analysis && !analysis.erro) {
mtfManager.addAnalysis(tf.key, analysis);
console.log(`✅ ${tf.key} analisado com sucesso`);
}
} catch (err) {
console.error(`❌ Erro ao analisar ${tf.key}:`, err.message);
}
})
);

const consolidated = mtfManager.consolidateSignals();
const agreement = mtfManager.calculateAgreement();

const timeframesSignals = [];
for (const tfKey of TRADING_MODES[mode].timeframes) {
const analysis = mtfManager.timeframes[tfKey]?.analysis;
if (analysis && analysis.sinal && analysis.sinal !== 'HOLD') {
timeframesSignals.push(analysis.sinal);
}
}

const callCountDiv = timeframesSignals.filter(s => s === 'CALL').length;
const putCountDiv = timeframesSignals.filter(s => s === 'PUT').length;

if (callCountDiv > 0 && putCountDiv > 0) {
console.log(`⚠️ Divergência de timeframes detectada: ${callCountDiv} CALL vs ${putCountDiv} PUT - forçando HOLD`);
consolidated.simpleMajority.signal = "HOLD";
consolidated.signal = "HOLD";
consolidated.confidence = Math.min(consolidated.confidence, 0.3);
}

let hasMacdDivergence = false;
for (const tfKey of TRADING_MODES[mode].timeframes) {
const analysis = mtfManager.timeframes[tfKey]?.analysis;
if (analysis && analysis.divergencia_macd && analysis.divergencia_macd.divergencia) {
hasMacdDivergence = true;
console.log(`⚠️ Divergência MACD detectada em ${tfKey} - forçando HOLD (${analysis.divergencia_macd.tipo})`);
break;
}
}
if (hasMacdDivergence) {
consolidated.simpleMajority.signal = "HOLD";
consolidated.signal = "HOLD";
consolidated.confidence = Math.min(consolidated.confidence, 0.3);
}

let currentPrice = 0;
let priceSource = 'unknown';

const tickResult = await getCurrentPrice(client, symbol);
if (tickResult) {
currentPrice = tickResult;
priceSource = 'tick';
console.log(`💰 Preço via tick: ${currentPrice}`);
} else if (mtfManager.timeframes['M1']?.analysis?.preco_atual) {
currentPrice = mtfManager.timeframes['M1'].analysis.preco_atual;
priceSource = 'M1';
console.log(`💰 Preço via M1: ${currentPrice}`);
} else if (mtfManager.timeframes['M5']?.analysis?.preco_atual) {
currentPrice = mtfManager.timeframes['M5'].analysis.preco_atual;
priceSource = 'M5';
console.log(`💰 Preço via M5: ${currentPrice}`);
} else {
const firstTf = timeframesToAnalyze[0]?.key || 'M5';
currentPrice = mtfManager.timeframes[firstTf]?.analysis?.preco_atual || 0;
priceSource = firstTf;
console.log(`💰 Preço via fallback (${firstTf}): ${currentPrice}`);
}

const suggestion = BotExecutionCore.generateEntrySuggestion(
{ sinal: consolidated.signal, probabilidade: consolidated.confidence },
currentPrice
);

let m1Timing = null, m5Timing = null, m15Timing = null;
let h1Timing = null, h4Timing = null;
const primarySignal = consolidated.simpleMajority.signal;

if (TRADING_MODES[mode].timeframes.includes('M1')) {
const m1Analysis = mtfManager.timeframes['M1']?.analysis;
m1Timing = calcularTimingM1(m1Analysis, primarySignal);
}
if (TRADING_MODES[mode].timeframes.includes('M5')) {
const m5Analysis = mtfManager.timeframes['M5']?.analysis;
m5Timing = calcularTimingM5(m5Analysis, primarySignal);
}
if (TRADING_MODES[mode].timeframes.includes('M15')) {
const m15Analysis = mtfManager.timeframes['M15']?.analysis;
m15Timing = calcularTimingM15(m15Analysis, primarySignal);
}
if (TRADING_MODES[mode].timeframes.includes('H1')) {
const h1Analysis = mtfManager.timeframes['H1']?.analysis;
h1Timing = calcularTimingH1(h1Analysis, primarySignal);
}
if (TRADING_MODES[mode].timeframes.includes('H4')) {
const h4Analysis = mtfManager.timeframes['H4']?.analysis;
h4Timing = calcularTimingH4(h4Analysis, primarySignal);
}

let timingEspecial = null;
if (mtfManager.tipoAtivo !== 'DEFAULT') {
const m1Analysis = mtfManager.timeframes['M1']?.analysis;
if (m1Analysis) {
timingEspecial = mtfManager.calcularTimingEspecial('M1', m1Analysis);
}
}

let analiseRefinada = null;
let validacaoRisco = null;

try {
const modeMap = {
'SNIPER': 'SNIPER',
'CAÇADOR': 'CACADOR',
'PESCADOR': 'PESCADOR'
};
const modoIngles = modeMap[mode] || 'CACADOR';
console.log(`🔄 Mapeando modo: ${mode} → ${modoIngles}`);

const dadosMercado = {
ativo: symbol,
precoAtual: currentPrice,
volume: 0,
precosHistoricos: historicalCandles || [],
timeframes: {}
};

for (const tfKey of TRADING_MODES[mode].timeframes) {
const analysis = mtfManager.timeframes[tfKey]?.analysis;
if (analysis) {
dadosMercado.timeframes[tfKey] = {
adx: analysis.adx || 25,
rsi: analysis.rsi || 50,
tendencia: analysis.sinal || 'HOLD',
volatilidade: analysis.volatilidade || 1.0,
precoAtual: analysis.preco_atual || currentPrice,
precos: []
};
}
}

const botAnalise = new TraderBotAnalise({
confiancaMinimaOperar: 60,
confiancaAlta: 75,
adxTendenciaForte: 25,
adxSemTendencia: 20
});

analiseRefinada = botAnalise.gerarAnalise(dadosMercado, modoIngles);

const saldoUsuario = req.user?.saldo || 1000;
validacaoRisco = botAnalise.validarOperacao(analiseRefinada, saldoUsuario, 2);

console.log(`📊 Análise refinada: sinal=${analiseRefinada.sinal.direcao}, confiança=${analiseRefinada.sinal.confianca}%`);

} catch (err) {
console.error('❌ Erro na análise refinada:', err.message);
analiseRefinada = { erro: err.message };
}

const responseTimeframes = {};
TRADING_MODES[mode].timeframes.forEach(tfKey => {
const tfData = mtfManager.timeframes[tfKey];
if (tfData?.analysis) {
responseTimeframes[tfKey] = {
sinal: tfData.analysis.sinal,
probabilidade: tfData.analysis.probabilidade,
adx: tfData.analysis.adx,
rsi: tfData.analysis.rsi,
preco_atual: tfData.analysis.preco_atual,
macd_phase: tfData.analysis.macd_phase,
divergencia_macd: tfData.analysis.divergencia_macd,
};
}
});

console.log('🔍 [SERVER] allAnalyses FINAL antes da resposta:');
for (const [key, analysis] of Object.entries(mtfManager.allAnalyses)) {
console.log(`   ${key}: sinal=${analysis.sinal}, fase=${analysis.macd_phase?.phase}`);
}

const responseTime = Date.now() - startTime;

const response = {
success: true,
mode: mode,
modeDescription: TRADING_MODES[mode].description,
consolidated: {
signal: consolidated.signal,
confidence: consolidated.confidence,
agreement: agreement.agreement,
simpleMajority: consolidated.simpleMajority,
timeframesAnalyzed: agreement.totalTimeframes,
sinal_premium: consolidated.sinal_premium || null,
price: currentPrice,
priceSource: priceSource,
...(m1Timing && { m1_timing: m1Timing }),
...(m5Timing && { m5_timing: m5Timing }),
...(m15Timing && { m15_timing: m15Timing }),
...(h1Timing && { h1_timing: h1Timing }),
...(h4Timing && { h4_timing: h4Timing }),
tipo_ativo: consolidated.tipo_ativo,
config_ativo: consolidated.config_ativo,
ciclo_completo: consolidated.ciclo_completo,
ponto_franco: consolidated.ponto_franco,
alinhamento_pescador: consolidated.alinhamento_pescador,
timing_especial: timingEspecial
},
agreement: {
agreement: agreement.agreement,
primarySignal: agreement.primarySignal,
callCount: agreement.callCount,
putCount: agreement.putCount,
totalTimeframes: agreement.totalTimeframes
},
suggestion: {
action: suggestion.action,
reason: suggestion.reason,
entry: suggestion.entry,
stopLoss: suggestion.stopLoss,
takeProfit: suggestion.takeProfit
},
timeframes: responseTimeframes,
refined_analysis: analiseRefinada,
risk_validation: validacaoRisco,
metadata: {
responseTimeMs: responseTime,
timestamp: new Date().toISOString()
}
};

console.log(`✅ Análise concluída em ${responseTime}ms para modo ${mode} - ${agreement.totalTimeframes} TFs analisados | Tipo ativo: ${consolidated.tipo_ativo}`);
res.json(response);

} catch (error) {
console.error('❌ Erro na análise:', error);
res.status(500).json({
error: error.message,
stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
});
}
});

app.use((req, res) => {
res.status(404).json({ error: 'Rota não encontrada' });
});

app.use((err, req, res, next) => {
console.error('❌ Erro global:', err);
res.status(500).json({
error: 'Erro interno do servidor',
message: process.env.NODE_ENV === 'development' ? err.message : undefined
});
});

const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, async () => {
console.log(`\n🚀 Servidor rodando na porta ${PORT}`);
console.log(`🎯 Modos de trading disponíveis: ${Object.keys(TRADING_MODES).join(', ')}`);
console.log(`⚙️ Modo: ${process.env.NODE_ENV || 'development'}`);
console.log(`📊 Configuração de candles: 400 para todos os timeframes (igual ao script.js)`);
console.log(`🤖 TraderBotAnalise integrado com análise refinada de confiança`);
console.log(`📈 ATR por modo: SNIPER→M1, CAÇADOR→M5, PESCADOR→M15`);
console.log(`⚡ Busca e análise de timeframes em paralelo (Promise.all)`);
console.log(`🔔 Alerta de pullback ativo em M1, M5, M15, H1 e H4 (com detecção rápida - PREVENTIVO/IMINENTE/EXTREMO)`);

try {
console.log('🔄 Iniciando conexão persistente com a Deriv...');
await getDerivClient();
console.log('✅ Conexão persistente estabelecida e mantida');
} catch (err) {
console.error('❌ Falha ao estabelecer conexão persistente:', err);
}
});

process.on('SIGTERM', () => {
console.log('\n🛑 Recebido SIGTERM, encerrando conexões...');

server.close(() => {
console.log('✅ Servidor HTTP encerrado');

if (derivClient) {
derivClient.disconnect();
console.log('✅ Cliente Deriv desconectado');
}

if (redisClient) {
redisClient.quit();
console.log('✅ Cliente Redis desconectado');
}

process.exit(0);
});
});

process.on('SIGINT', () => {
console.log('\n🛑 Recebido SIGINT, encerrando...');
process.emit('SIGTERM');
});

module.exports = app;
