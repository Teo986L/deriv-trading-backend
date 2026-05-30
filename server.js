const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { createClient } = require('redis');
const { randomUUID } = require('crypto'); // [RETIFICADO] Movido para o topo
const DerivClient = require('./deriv-client');
const { SistemaAnaliseInteligente } = require('./analyzers/sistema-analise');
const MultiTimeframeManager = require('./multi-timeframe-manager');
const BotExecutionCore = require('./bot-execution-core');
const TraderBotAnalise = require('./analyzers/trader-bot-analyzer');
const CandleTradeAnalyzer = require('./trade-analyzer');
const { API_TOKEN, CANDLE_CLOSE_TOLERANCE } = require('./config'); // [RETIFICADO] Removido SMOOTHING (não usado)
const { detectLiquiditySweepRobusto, calculateATR: calcularATRLiquidity } = require('./analyzers/liquidity-hunter-robusto');

const app = express();

// ========== INDICADORES AUXILIARES ==========
function ema(values, period) {
  const k = 2 / (period + 1);
  const out = [values[0]];
  for (let i = 1; i < values.length; i++) {
    out.push(values[i] * k + out[i - 1] * (1 - k));
  }
  return out;
}

function trendDirection(candles) {
  if (!candles || candles.length < 21) return 'FLAT';
  const closes = candles.map(c => parseFloat(c.close));
  const e9  = ema(closes, 9);
  const e21 = ema(closes, 21);
  const last9  = e9[e9.length - 1];
  const last21 = e21[e21.length - 1];
  if (last9 > last21 * 1.0005) return 'UP';   // margem 0.05%
  if (last9 < last21 * 0.9995) return 'DOWN';
  return 'FLAT';
}

function isReversalCandle(candles, direction) {
  if (!candles || candles.length < 2) return false;
  const c = candles[candles.length - 1];
  const p = candles[candles.length - 2];
  const cOpen  = parseFloat(c.open);
  const cClose = parseFloat(c.close);
  const pOpen  = parseFloat(p.open);
  const pClose = parseFloat(p.close);
  if (direction === 'UP')   return cClose > cOpen && cClose > pOpen && pClose < pOpen; // engolfo altista
  if (direction === 'DOWN') return cClose < cOpen && cClose < pOpen && pClose > pOpen; // engolfo baixista
  return false;
}

function rsiLeaving(rsiValues, threshold, direction) {
  if (!rsiValues || rsiValues.length < 2) return false;
  const current  = rsiValues[rsiValues.length - 1];
  const previous = rsiValues[rsiValues.length - 2];
  if (direction === 'UP')   return previous <= threshold && current > threshold;
  if (direction === 'DOWN') return previous >= threshold && current < threshold;
  return false;
}

// Calcula array de RSI para as últimas `window` velas (Wilder's smoothing)
// Requer pelo menos period+window velas; devolve [] se dados insuficientes.
function calcularRSIArray(candles, period, window) {
  if (!candles || candles.length < period + window) return [];
  const closes = candles.map(c => parseFloat(c.close));
  // Calcula ganhos/perdas
  const deltas = [];
  for (let i = 1; i < closes.length; i++) {
    deltas.push(closes[i] - closes[i - 1]);
  }
  // Média inicial (SMA) para o primeiro valor
  let avgGain = 0, avgLoss = 0;
  for (let i = 0; i < period; i++) {
    if (deltas[i] > 0) avgGain += deltas[i];
    else avgLoss += Math.abs(deltas[i]);
  }
  avgGain /= period;
  avgLoss /= period;

  const rsiArr = [];
  // Primeiro RSI
  const rs0 = avgLoss === 0 ? Infinity : avgGain / avgLoss;
  rsiArr.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + rs0));

  // Wilder smoothing para o resto
  for (let i = period; i < deltas.length; i++) {
    const gain = deltas[i] > 0 ? deltas[i] : 0;
    const loss = deltas[i] < 0 ? Math.abs(deltas[i]) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    const rs = avgLoss === 0 ? Infinity : avgGain / avgLoss;
    rsiArr.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + rs));
  }

  // Devolve apenas as últimas `window` entradas
  return rsiArr.slice(-window);
}

// [RETIFICADO] Encerramento gracioso em vez de manter vivo indefinidamente
let isShuttingDown = false;
function gracefulShutdown(signal, err) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.error(`❌ ${signal}:`, err?.message || err);
  if (err?.stack) console.error(err.stack);
  // Dá tempo a pedidos em curso terminarem (2s), depois encerra
  setTimeout(() => process.exit(1), 2000);
}
process.on('uncaughtException', (err) => gracefulShutdown('uncaughtException', err));
process.on('unhandledRejection', (reason) => gracefulShutdown('unhandledRejection', reason));

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

// ========== CACHE EM MEMÓRIA COM LIMITE ANTI-OOM ==========
const memoryCache = new Map();
const MAX_MEMORY_CACHE_SIZE = 500; // [RETIFICADO] Limite máximo de entradas

function getFromMemoryCache(key) {
    const entry = memoryCache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
        memoryCache.delete(key);
        return null;
    }
    return entry.data;
}

function setToMemoryCache(key, data, ttlSeconds) {
    // [RETIFICADO] LRU simples: se cheio, remove a entrada mais antiga
    if (memoryCache.size >= MAX_MEMORY_CACHE_SIZE && !memoryCache.has(key)) {
        const firstKey = memoryCache.keys().next().value;
        memoryCache.delete(firstKey);
    }
    memoryCache.set(key, {
        data,
        expiresAt: Date.now() + ttlSeconds * 1000
    });
}

// Limpeza periódica
setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of memoryCache) {
        if (now > entry.expiresAt) memoryCache.delete(key);
    }
}, 60000);

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

const ALL_TIMEFRAMES_CONFIG_STATIC = {
  'M1':  { seconds: 60 },    'M5':  { seconds: 300 },
  'M15': { seconds: 900 },   'M30': { seconds: 1800 },
  'H1':  { seconds: 3600 },  'H4':  { seconds: 14400 },
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
  console.log('⚠️ Redis não configurado - cache em memória ativo');
}

const TRADING_MODES = {
  'CAÇADOR':  { timeframes: ['M1', 'M5', 'M15', 'H1'],          description: 'Entradas rápidas de 5-15 minutos' },
  'PESCADOR': { timeframes: ['M5', 'M15', 'H1', 'H4', 'H24'],   description: 'Grandes movimentos de horas a dias' }
};

// [RETIFICADO] Corrigida inconsistência de string: CAÇADOR com cedilha
function getATRTimeframeByMode(mode) {
  const map = { 'CAÇADOR': 'M1', 'PESCADOR': 'M5' };
  return map[mode] || 'M5';
}

const ALL_TIMEFRAMES_CONFIG = {
  'M1':  { key: 'M1',  seconds: 60,    candleCount: 100, minRequired: 50 },
  'M5':  { key: 'M5',  seconds: 300,   candleCount: 120, minRequired: 50 },
  'M15': { key: 'M15', seconds: 900,   candleCount: 100, minRequired: 50 },
  'H1':  { key: 'H1',  seconds: 3600,  candleCount: 100,  minRequired: 30 },
  'H4':  { key: 'H4',  seconds: 14400, candleCount: 60,  minRequired: 20 },
  'H24': { key: 'H24', seconds: 86400, candleCount: 40,  minRequired: 15 }
};

function isCandleClosed(candle, timeframeSeconds) {
  if (!candle || !candle.epoch) return true;
  const now = Math.floor(Date.now() / 1000);
  return now >= candle.epoch + timeframeSeconds - CANDLE_CLOSE_TOLERANCE;
}

const inFlightRequests = new Map();

// ── Detetor de tipo de ativo ─────────
function detectTipoAtivo(symbol) {
    if (/^WLD/i.test(symbol)) return 'forex';
    if (symbol.startsWith('R_') || symbol.startsWith('1HZ')) return 'volatility_index';
    if (/^BOOM/i.test(symbol))   return 'boom_index';
    if (/^CRASH/i.test(symbol))  return 'crash_index';
    if (/^JD/i.test(symbol))     return 'jump_index';
    if (/^stpRNG/i.test(symbol)) return 'step_index';
    if (/^RB\d+$/i.test(symbol) || /^RDBEAR$/i.test(symbol) || /^RDBULL$/i.test(symbol)) {
        return 'volatility_index';
    }
    if (/XAU|XAG|XPD|XPT/i.test(symbol)) return 'commodity';
    if (/^cry/i.test(symbol)) return 'criptomoeda';
    if (/^frx/i.test(symbol)) return 'forex';
    if (/^OTC_/i.test(symbol)) return 'indice_normal';
    return 'indice_normal';
}

// ========== FUNÇÃO DE CACHE UNIFICADA (MEMÓRIA + REDIS) ==========
async function getCandlesWithCache(client, symbol, tf, mode, forceFresh = false, ttlOverride = null) {
  const cacheKey = `candles:${symbol}:${tf.key}`;
  let ttl = ttlOverride !== null ? ttlOverride : getTTLAlignedToCandle(tf.seconds);
  const tipoAtivo = detectTipoAtivo(symbol);
  const isAtivoPulso = ['boom_index','crash_index','jump_index','step_index'].includes(tipoAtivo);
  if (isAtivoPulso && mode === 'CAÇADOR' && tf.key === 'M1') {
    ttl = Math.min(ttl, 10);
    console.log(`⚡ TTL reduzido para ${ttl}s (ativo de pulso + CAÇADOR)`);
  }
  // 1. Tenta cache em memória
  if (!forceFresh) {
    const memCached = getFromMemoryCache(cacheKey);
    if (memCached) {
      const entry = memoryCache.get(cacheKey);
      const remaining = entry ? Math.ceil((entry.expiresAt - Date.now()) / 1000) : ttl;
      console.log(`💾 Cache memória: ${cacheKey} (TTL: ${remaining}s)`);
      return memCached;
    }
  }

  // 2. Tenta Redis
  if (redisClient && redisClient.isReady && !forceFresh) {
    try {
      const cached = await redisClient.get(cacheKey);
      if (cached) {
        const remainingTTL = await redisClient.ttl(cacheKey);
        console.log(`✅ Cache Redis: ${cacheKey} (TTL: ${remainingTTL}s)`);

        // [RETIFICADO] Proteção contra cache corrompido no Redis
        let candles;
        try {
          candles = JSON.parse(cached);
        } catch (e) {
          console.error(`❌ Cache corrompido Redis ${cacheKey}:`, e.message);
          await redisClient.del(cacheKey);
          return null;
        }

        setToMemoryCache(cacheKey, candles, remainingTTL > 0 ? remainingTTL : ttl);

        if (remainingTTL <= CANDLE_CLOSE_MARGIN) {
          setImmediate(async () => {
            try {
              const freshCandles = await client.getCandles(symbol, tf.candleCount, tf.seconds);
              if (Array.isArray(freshCandles)) {
                const newTtl = getTTLAlignedToCandle(tf.seconds);
                await redisClient.setEx(cacheKey, newTtl, JSON.stringify(freshCandles));
                setToMemoryCache(cacheKey, freshCandles, newTtl);
              }
            } catch (err) { console.error(`❌ Erro pré-cache: ${err.message}`); }
          });
        }
        return candles;
      }
    } catch (err) { console.error(`❌ Erro Redis ${cacheKey}:`, err.message); }
  }

  // 3. Evita requisições duplicadas em voo
  if (inFlightRequests.has(cacheKey)) return inFlightRequests.get(cacheKey);

  // 4. Fetch fresco da Deriv
  const fetchPromise = (async () => {
    try {
      console.log(`🔄 Buscando ${tf.key} (${tf.candleCount} candles)`);
      const candles = await client.getCandles(symbol, tf.candleCount, tf.seconds);
      if (!Array.isArray(candles)) return candles;
      console.log(`📊 ${tf.key}: ${candles.length} candles`);

      setToMemoryCache(cacheKey, candles, ttl);

      if (redisClient && redisClient.isReady) {
        redisClient.setEx(cacheKey, ttl, JSON.stringify(candles))
          .catch(err => console.error(`❌ Erro salvando Redis: ${err.message}`));
      }
      return candles;
    } finally { inFlightRequests.delete(cacheKey); }
  })();

  inFlightRequests.set(cacheKey, fetchPromise);
  return fetchPromise;
}

const analyzeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  keyGenerator: (req) => req.user?.userId || req.ip,
  message: { error: 'Limite de requisições por minuto excedido. Aguarde.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const adminLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => req.ip, // [RETIFICADO] Explícito
  message: { error: 'Limite de geração de tokens excedido.' }
});

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  let token = authHeader && authHeader.split(' ')[1];
  if (!token && req.body && req.body.token) token = req.body.token;
  if (!token) return res.status(401).json({ error: 'Token não fornecido' });

  const secretsToTry = [
    { period: 365, key: SECRETS['365'] }, { period: 180, key: SECRETS['180'] },
    { period: 90,  key: SECRETS['90'] },  { period: 30,  key: SECRETS['30'] },
    { period: 7,   key: SECRETS['7'] }
  ];
  for (const { period, key } of secretsToTry) {
    if (!key) continue;
    try {
      const decoded = jwt.verify(token, key);
      req.user = decoded; req.tokenPeriod = period; return next();
    } catch (err) {}
  }
  return res.status(403).json({ error: 'Token inválido ou expirado' });
}

let derivClient = null;
let derivConnectionPromise = null;
let isDerivConnecting = false; // [RETIFICADO] Lock para evitar race condition
const derivWaiters = [];       // [RETIFICADO] Fila de espera

// ========== FIX 2: RECONEXÃO AUTOMÁTICA DO DERIV WEBSOCKET (COM LOCK) ==========
async function getDerivClient() {
  // Se já existe e está conectado (readyState 1 = OPEN), devolve direto
  if (derivClient && derivClient.ws?.readyState === 1) return derivClient;

  // [RETIFICADO] Se já está em processo de conexão, entra na fila
  if (isDerivConnecting) {
    return new Promise((resolve, reject) => {
      derivWaiters.push({ resolve, reject });
    });
  }

  isDerivConnecting = true;

  try {
    // Desliga cliente antigo de forma segura
    if (derivClient) {
      try {
        derivClient.disconnect();
      } catch (e) {
        console.error('⚠️ Erro ao desligar cliente Deriv antigo:', e.message);
      }
      derivClient = null;
    }
    derivConnectionPromise = null;

    derivClient = new DerivClient(API_TOKEN);
    derivConnectionPromise = derivClient.connect()
      .then(() => {
        console.log('✅ Cliente Deriv pronto');
        return derivClient;
      })
      .catch(err => {
        console.error('❌ Falha conexão Deriv:', err.message);
        derivConnectionPromise = null;
        derivClient = null;
        throw err;
      });

    const result = await derivConnectionPromise;
    // [RETIFICADO] Resolve todos os que estavam à espera
    derivWaiters.forEach(w => w.resolve(result));
    return result;
  } catch (err) {
    derivWaiters.forEach(w => w.reject(err));
    throw err;
  } finally {
    isDerivConnecting = false;
    derivWaiters.length = 0; // limpa fila
  }
}

// Vigilante de reconexão automática a cada 4 minutos
setInterval(async () => {
  try {
    const ws = derivClient?.ws;
    // [RETIFICADO] Só reconecta se não estiver conectado E não estiver a conectar
    const needsReconnect = !ws || (ws.readyState !== 1 && ws.readyState !== 0);
    if (needsReconnect && !isDerivConnecting) {
      console.log('🔄 [Watchdog] Reconectando Deriv...');
      derivConnectionPromise = null;
      if (derivClient) {
        try { derivClient.disconnect(); } catch (e) {}
        derivClient = null;
      }
      await getDerivClient();
      console.log('✅ [Watchdog] Deriv reconectado com sucesso');
    }
  } catch (err) {
    console.error('❌ [Watchdog] Reconexão Deriv falhou:', err.message);
  }
}, 4 * 60 * 1000);

// [RETIFICADO] Counter global para IDs únicos de tick
let tickRequestCounter = 0;

// ── tick com timeout reduzido (350ms) ──
async function getCurrentPrice(client, symbol) {
  return new Promise((resolve) => {
    // [RETIFICADO] Verifica capacidade do cliente antes de criar handlers
    if (typeof client.addListener !== 'function' || typeof client.removeListener !== 'function') {
      resolve(null);
      return;
    }
    if (!client.ws || client.ws.readyState !== client.ws.OPEN) {
      resolve(null);
      return;
    }

    const reqId = `price_${Date.now()}_${++tickRequestCounter}`;

    const handler = (response) => {
      if (response.error) {
        clearTimeout(timeout);
        client.removeListener(reqId, handler);
        resolve(null);
      } else if (response.tick && response.tick.symbol === symbol) {
        clearTimeout(timeout);
        client.removeListener(reqId, handler);
        resolve(response.tick.quote);
      }
    };

    const timeout = setTimeout(() => {
      client.removeListener(reqId, handler);
      resolve(null);
    }, 350);

    client.addListener(reqId, handler);
    client.ws.send(JSON.stringify({ tick: symbol, req_id: reqId }));
  });
}

// ========== FIX 4: ENDPOINT /health INFORMATIVO ==========
app.get('/health', (req, res) => {
  const ws = derivClient?.ws;
  const derivStatus = ws?.readyState === 1 ? 'connected' : ws?.readyState === 0 ? 'connecting' : 'disconnected';
  res.status(200).json({
    status: 'OK',
    uptime: Math.floor(process.uptime()),
    deriv: derivStatus,
    memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
    cacheKeys: memoryCache.size,
    timestamp: new Date().toISOString()
  });
});

app.get('/api/trading-modes', (req, res) => {
  res.json({
    success: true,
    modes: Object.keys(TRADING_MODES).map(key => ({
      id: key, name: key,
      description: TRADING_MODES[key].description,
      timeframes: TRADING_MODES[key].timeframes
    }))
  });
});

app.post('/api/validate-token', (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ valid: false, message: 'Token não fornecido' });
  const secretsToTry = [
    { period: 365, key: SECRETS['365'] }, { period: 180, key: SECRETS['180'] },
    { period: 90,  key: SECRETS['90'] },  { period: 30,  key: SECRETS['30'] },
    { period: 7,   key: SECRETS['7'] }
  ];
  for (const { period, key } of secretsToTry) {
    if (!key) continue;
    try {
      const decoded = jwt.verify(token, key);
      return res.json({ valid: true, periodDays: period, expiresAt: decoded.exp, userId: decoded.userId || null });
    } catch (err) {}
  }
  return res.status(401).json({ valid: false, message: 'Token inválido ou expirado' });
});

app.post('/api/admin/generate-token', adminLimiter, (req, res) => {
  const { adminKey, periodDays, userId } = req.body;
  if (!adminKey || adminKey !== ADMIN_SECRET) return res.status(403).json({ error: 'Chave de administrador inválida' });
  const period = parseInt(periodDays);
  if (![7, 30, 90, 180, 365].includes(period)) return res.status(400).json({ error: 'Período inválido.' });
  const secret = SECRETS[period.toString()];
  if (!secret) return res.status(500).json({ error: 'Chave não configurada' });
  const finalUserId = userId || randomUUID();
  const token = jwt.sign({ userId: finalUserId, period, jti: randomUUID() }, secret, { expiresIn: period * 86400 });
  res.json({ success: true, token, periodDays: period, expiresIn: period * 86400, userId: finalUserId });
});

app.post('/api/admin/restart-render', adminLimiter, async (req, res) => {
  try {
    // [RETIFICADO] Verifica se fetch existe (Node.js 18+)
    if (typeof fetch !== 'function') {
      return res.status(500).json({ success: false, error: 'fetch não disponível (requer Node.js 18+)' });
    }
    const { adminKey } = req.body;
    if (!adminKey || adminKey !== ADMIN_SECRET) return res.status(403).json({ success: false, error: 'Chave inválida' });
    const RENDER_SERVICE_ID = process.env.RENDER_SERVICE_ID;
    const RENDER_API_KEY = process.env.RENDER_API_KEY;
    if (!RENDER_SERVICE_ID || !RENDER_API_KEY) return res.status(500).json({ success: false, error: 'Variáveis Render não configuradas' });
    const response = await fetch(`https://api.render.com/v1/services/${RENDER_SERVICE_ID}/restart`, {
      method: 'POST', headers: { 'Accept': 'application/json', 'Authorization': `Bearer ${RENDER_API_KEY}` }
    });
    if (response.ok) res.json({ success: true, message: 'Serviço reiniciado!' });
    else { const txt = await response.text(); res.status(response.status).json({ success: false, error: txt }); }
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.get('/api/connection-status', authenticateToken, (req, res) => {
  if (!derivClient) return res.json({ status: 'not_initialized' });
  res.json(derivClient.getConnectionStatus());
});

// ========== RSI LIMITS POR TIPO DE ATIVO ==========
const RSI_LIMITS_BY_ASSET = {
  'forex':           { pullback: 30, extremo: 25, sobrecompra: 70, sobrevenda: 30 },
  'volatility_index':{ pullback: 35, extremo: 30, sobrecompra: 80, sobrevenda: 20 },
  'commodity':       { pullback: 35, extremo: 30, sobrecompra: 75, sobrevenda: 25 },
  'criptomoeda':     { pullback: 30, extremo: 25, sobrecompra: 80, sobrevenda: 20 },
  'indice_normal':   { pullback: 35, extremo: 30, sobrecompra: 75, sobrevenda: 25 },
  'boom_index':      { pullback: 35, extremo: 30, sobrecompra: 85, sobrevenda: 20 },
  'crash_index':     { pullback: 20, extremo: 15, sobrecompra: 80, sobrevenda: 15 },
  'jump_index':      { pullback: 22, extremo: 18, sobrecompra: 82, sobrevenda: 18 },
  'step_index':      { pullback: 32, extremo: 28, sobrecompra: 72, sobrevenda: 28 }
};

// ========== RSI LIMITS DINÂMICOS POR ATIVO + MODO ==========
const RSI_PULSO_LIMITS = {
  'boom_index': {
    'CAÇADOR':  { callMax: 60, callMin: 40, putOSell: 35, putOBuy: 68 },
    'PESCADOR': { callMax: 65, callMin: 45, putOSell: 35, putOBuy: 68 }
  },
  'crash_index': {
    'CAÇADOR':  { callMax: 60, callMin: 40, putOSell: 32, putOBuy: 62 },
    'PESCADOR': { callMax: 55, callMin: 35, putOSell: 32, putOBuy: 62 }
  },
  'jump_index': {
    'CAÇADOR':  { callMax: 55, callMin: 45, putOSell: 40, putOBuy: 60 },
    'PESCADOR': { callMax: 60, callMin: 40, putOSell: 40, putOBuy: 60 }
  },
  'step_index': {
    'CAÇADOR':  { callMax: 60, callMin: 40, putOSell: 40, putOBuy: 58 },
    'PESCADOR': { callMax: 62, callMin: 42, putOSell: 40, putOBuy: 58 }
  }
};

function gerarAlertaPullback(rsi, primarySignal, tipoAtivo, timeframeLabel) {
  const limite = RSI_LIMITS_BY_ASSET[tipoAtivo] || RSI_LIMITS_BY_ASSET.indice_normal;
  let alerta = null;

  if (rsi < limite.pullback) {
    const nivel = rsi < limite.extremo ? 'EXTREMO' : 'IMINENTE';
    const excesso = rsi < limite.extremo ? limite.pullback - rsi : 0;
    alerta = {
      tipo: nivel === 'EXTREMO' ? 'PULLBACK_EXTREMO' : 'PULLBACK_IMINENTE',
      mensagem: nivel === 'EXTREMO'
        ? `🚨 [EXTREMO] RSI ${timeframeLabel} em ${rsi.toFixed(0)} - EXTREMA SOBREVENDA (${excesso.toFixed(0)}pts abaixo)!`
        : `⚠️ [IMINENTE] RSI ${timeframeLabel} em ${rsi.toFixed(0)} - ZONA DE SOBREVENDA!`,
      acao: nivel === 'EXTREMO' ? 'AGUARDAR_RETOMADA_OBRIGATORIO' : 'AGUARDAR_RETOMADA',
      nivel, tipo_ativo: tipoAtivo, rsi_atual: rsi
    };
  } else if (rsi > limite.sobrecompra) {
    const nivel = rsi > limite.sobrecompra + 5 ? 'EXTREMO' : 'IMINENTE';
    const excesso = rsi > limite.sobrecompra + 5 ? rsi - limite.sobrecompra : 0;
    alerta = {
      tipo: nivel === 'EXTREMO' ? 'PULLBACK_EXTREMO' : 'PULLBACK_IMINENTE',
      mensagem: nivel === 'EXTREMO'
        ? `🚨 [EXTREMO] RSI ${timeframeLabel} em ${rsi.toFixed(0)} - EXTREMA SOBRECOMPRA (${excesso.toFixed(0)}pts acima)!`
        : `⚠️ [IMINENTE] RSI ${timeframeLabel} em ${rsi.toFixed(0)} - ZONA DE SOBRECOMPRA!`,
      acao: nivel === 'EXTREMO' ? 'AGUARDAR_RETOMADA_OBRIGATORIO' : 'AGUARDAR_RETOMADA',
      nivel, tipo_ativo: tipoAtivo, rsi_atual: rsi
    };
  } else if (rsi < limite.pullback + 12) {
    alerta = {
      tipo: 'PULLBACK_PREVENTIVO',
      mensagem: `⚠️ [PREVENTIVO] RSI ${timeframeLabel} em ${rsi.toFixed(0)} - aproximando sobrevenda (${limite.pullback})`,
      acao: 'PREPARAR_PULLBACK', nivel: 'PREVENTIVO', tipo_ativo: tipoAtivo, rsi_atual: rsi
    };
  } else if (rsi > limite.sobrecompra - 12) {
    alerta = {
      tipo: 'PULLBACK_PREVENTIVO',
      mensagem: `⚠️ [PREVENTIVO] RSI ${timeframeLabel} em ${rsi.toFixed(0)} - aproximando sobrecompra (${limite.sobrecompra})`,
      acao: 'PREPARAR_PULLBACK', nivel: 'PREVENTIVO', tipo_ativo: tipoAtivo, rsi_atual: rsi
    };
  }

  if (alerta) console.log(`🔔 ${timeframeLabel} ${alerta.nivel}: RSI=${rsi.toFixed(0)}`);
  return alerta;
}

// ── Funções de timing ────────
function buildTimingResult(analysis, signal, tf, label, mode) {
  if (!analysis) return { permitido: false, motivo: `${label} não disponível`, rsi: null, sinal: null, adx: null, alerta_pullback: null };

  const adx       = analysis.adx || 0;
  const rsi       = analysis.rsi || 50;
  const tipoAtivo = analysis.tipo_ativo || 'indice_normal';
  const alerta_pullback = gerarAlertaPullback(rsi, signal, tipoAtivo, label);

  if (signal === 'HOLD') return { permitido: false, motivo: 'Sinal HOLD - aguardar', rsi, sinal: analysis.sinal, adx, alerta_pullback };

  let rsiMax, rsiMin, rsiOSell, rsiOBuy;

  // ✅ Usar RSI_PULSO_LIMITS global (não recriar a cada chamada)
  const limite = RSI_PULSO_LIMITS[tipoAtivo]?.[mode];
  if (limite) {
    rsiMax = limite.callMax;
    rsiMin = limite.callMin;
    rsiOSell = limite.putOSell;
    rsiOBuy = limite.putOBuy;
  } else {
    // Fallback para ativos normais (mantém lógica original)
    if (label === 'M15') {
      rsiMax = 72; rsiMin = 28; rsiOSell = 36; rsiOBuy = 65;
    } else {
      rsiMax = 75; rsiMin = 25; rsiOSell = 38; rsiOBuy = 62;
    }
  }

  if (signal === 'CALL') {
    if (analysis.sinal === 'CALL' && rsi < rsiMax) return { permitido: true, motivo: `${label} confirmando CALL (RSI ${rsi.toFixed(0)}, ADX ${adx.toFixed(0)})`, rsi, sinal: analysis.sinal, adx, alerta_pullback };
    if (analysis.sinal === 'PUT'  && rsi < rsiOSell) return { permitido: true, motivo: `${label} oversold - reversão CALL (RSI ${rsi.toFixed(0)}, ADX ${adx.toFixed(0)})`, rsi, sinal: analysis.sinal, adx, alerta_pullback };

    let motivoBloqueio;
    if (tipoAtivo === 'boom_index'  && rsi >= rsiMax) motivoBloqueio = `${label} BLOQUEADO — RSI ${rsi.toFixed(0)} > ${rsiMax} no Boom (spike já ocorreu, aguardar retração)`;
    else if (tipoAtivo === 'jump_index'  && rsi >= rsiMax) motivoBloqueio = `${label} BLOQUEADO — RSI ${rsi.toFixed(0)} > ${rsiMax} no Jump (pulso de alta já ocorreu)`;
    else if (tipoAtivo === 'step_index'  && rsi >= rsiMax) motivoBloqueio = `${label} BLOQUEADO — RSI ${rsi.toFixed(0)} > ${rsiMax} no Step (pressão compradora esgotada, aguardar recuo)`;
    else motivoBloqueio = `${label} não confirma (${analysis.sinal}, RSI ${rsi.toFixed(0)}, ADX ${adx.toFixed(0)})`;
    return { permitido: false, motivo: motivoBloqueio, rsi, sinal: analysis.sinal, adx, alerta_pullback };
  }

  if (signal === 'PUT') {
    if (analysis.sinal === 'PUT'  && rsi > rsiMin) return { permitido: true, motivo: `${label} confirmando PUT (RSI ${rsi.toFixed(0)}, ADX ${adx.toFixed(0)})`, rsi, sinal: analysis.sinal, adx, alerta_pullback };
    if (analysis.sinal === 'CALL' && rsi > rsiOBuy) return { permitido: true, motivo: `${label} overbought - reversão PUT (RSI ${rsi.toFixed(0)}, ADX ${adx.toFixed(0)})`, rsi, sinal: analysis.sinal, adx, alerta_pullback };

    let motivoBloqueio;
    if (tipoAtivo === 'crash_index' && rsi <= rsiMin) motivoBloqueio = `${label} BLOQUEADO — RSI ${rsi.toFixed(0)} < ${rsiMin} no Crash (crash já ocorreu, aguardar recuperação)`;
    else if (tipoAtivo === 'jump_index'  && rsi <= rsiMin) motivoBloqueio = `${label} BLOQUEADO — RSI ${rsi.toFixed(0)} < ${rsiMin} no Jump (pulso de baixa já ocorreu)`;
    else if (tipoAtivo === 'step_index'  && rsi <= rsiMin) motivoBloqueio = `${label} BLOQUEADO — RSI ${rsi.toFixed(0)} < ${rsiMin} no Step (pressão vendedora esgotada, aguardar recuperação)`;
    else motivoBloqueio = `${label} não confirma (${analysis.sinal}, RSI ${rsi.toFixed(0)}, ADX ${adx.toFixed(0)})`;
    return { permitido: false, motivo: motivoBloqueio, rsi, sinal: analysis.sinal, adx, alerta_pullback };
  }

  return { permitido: false, motivo: `${label} sinal indeterminado (RSI ${rsi.toFixed(0)}, ADX ${adx.toFixed(0)})`, rsi, sinal: analysis.sinal, adx, alerta_pullback };
}

// [RETIFICADO] Adicionar parâmetro mode em M5 e M15
function calcularTimingM1(a, s, mode)  { return buildTimingResult(a, s, 'M1',  'M1', mode); }
function calcularTimingM5(a, s, mode)  { return buildTimingResult(a, s, 'M5',  'M5', mode); }
function calcularTimingM15(a, s, mode) { return buildTimingResult(a, s, 'M15', 'M15', mode); }
function calcularTimingH1(a, s) {
  if (!a) return { permitido: false, motivo: 'H1 não disponível', rsi: null, sinal: null, adx: null, alerta_pullback: null };
  return { permitido: false, motivo: 'H1 é TF de tendência', rsi: a.rsi || 50, sinal: a.sinal, adx: a.adx || 0, alerta_pullback: gerarAlertaPullback(a.rsi || 50, s, a.tipo_ativo || 'indice_normal', 'H1') };
}
function calcularTimingH4(a, s) {
  if (!a) return { permitido: false, motivo: 'H4 não disponível', rsi: null, sinal: null, adx: null, alerta_pullback: null };
  return { permitido: false, motivo: 'H4 é TF de tendência', rsi: a.rsi || 50, sinal: a.sinal, adx: a.adx || 0, alerta_pullback: gerarAlertaPullback(a.rsi || 50, s, a.tipo_ativo || 'indice_normal', 'H4') };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ROTA PRINCIPAL — /api/analyze
// ═══════════════════════════════════════════════════════════════════════════════
function detectarPulsoRecente(candles, tipoAtivo) {
  if (!['boom_index','crash_index'].includes(tipoAtivo)) return null;
  if (!candles || candles.length < 10) return null;
  
  const ultimo = candles[candles.length - 1];
  const anterior = candles[candles.length - 2];
  
  const bodyUltimo = Math.abs(parseFloat(ultimo.close) - parseFloat(ultimo.open));
  const bodyAnterior = Math.abs(parseFloat(anterior.close) - parseFloat(anterior.open));
  const mediaBody = candles.slice(-10, -1).reduce((s, c) => 
    s + Math.abs(parseFloat(c.close) - parseFloat(c.open)), 0) / 9;
  
  if (bodyAnterior > mediaBody * 3) {
    const direcao = parseFloat(anterior.close) > parseFloat(anterior.open) ? 'CALL' : 'PUT';
    const tipoPulso = tipoAtivo === 'boom_index' ? 'BOOM' : 'CRASH';
    return {
      detectado: true,
      direcao,
      tipo: tipoPulso,
      magnitude: (bodyAnterior / mediaBody).toFixed(1) + 'x',
      mensagem: `⚠️ ${tipoPulso} ${direcao} detectado no candle anterior (${(bodyAnterior/mediaBody).toFixed(1)}× média). Aguarde retração antes de entrar.`
    };
  }
  return null;
}

// [RETIFICADO] tradeAnalyzer agora é criado dinamicamente dentro da função
function calcularStopTakePorModo(candlesMap, mode, timing, tipoAtivo) {
    const PRIMARY_TF_BY_MODE = { 'CAÇADOR': 'M1', 'PESCADOR': 'M5' };
    const primaryTf = PRIMARY_TF_BY_MODE[mode] || 'M5';
    if (!primaryTf || !timing || !timing.permitido) return null;
  
    const candles = candlesMap[primaryTf];
    if (!candles || candles.length === 0) return null;

    const ultimoCandle = candles[candles.length - 1];
    // Garantir valores numéricos
    ultimoCandle.open = parseFloat(ultimoCandle.open);
    ultimoCandle.high = parseFloat(ultimoCandle.high);
    ultimoCandle.low = parseFloat(ultimoCandle.low);
    ultimoCandle.close = parseFloat(ultimoCandle.close);

    const sinalTiming = timing.sinal;   // 'CALL' ou 'PUT'

    // ✅ Criar tradeAnalyzer dinamicamente baseado no tipo de ativo
    const isAtivoPulso = ['boom_index','crash_index','jump_index','step_index'].includes(tipoAtivo);
    const margem = isAtivoPulso ? 0.02 : 0.002; // 2% vs 0.2%
    const riscoMult = isAtivoPulso ? 2 : 3;
    const tradeAnalyzer = new CandleTradeAnalyzer(margem, riscoMult);

    if (sinalTiming === 'CALL') {
        return tradeAnalyzer.calcularNiveisLong(ultimoCandle);
    } else if (sinalTiming === 'PUT') {
        return tradeAnalyzer.calcularNiveisShort(ultimoCandle);
    }
    return null;
}

function calcularPontoFranco(mtfManager, tipoAtivo) {
  if (!['boom_index','crash_index'].includes(tipoAtivo)) return null;
  
  const h4 = mtfManager.timeframes['H4']?.analysis;
  const m1 = mtfManager.timeframes['M1']?.analysis;
  const m5 = mtfManager.timeframes['M5']?.analysis;
  const m15 = mtfManager.timeframes['M15']?.analysis;
  
  if (!h4 || !m1 || !m5 || !m15) return null;
  
  const alinhado = h4.sinal === m1.sinal && m1.sinal === m5.sinal && m5.sinal === m15.sinal;
  const h4Forte = h4.adx > 30;
  const m1Forte = m1.adx > 35;
  
  if (alinhado && h4Forte && m1Forte && h4.sinal !== 'HOLD') {
    return {
      tipo: `PONTO_FRANCO_${h4.sinal}`,
      confianca: 0.95,
      detalhes: {
        h4_adx: h4.adx,
        m1_adx: m1.adx,
        direcao: h4.sinal,
        timeframes_alinhados: ['H4','M15','M5','M1']
      }
    };
  }
  return null;
}

// ========== FUNÇÕES DE SCORE POR MODO (CAÇADOR E PESCADOR) ==========
function calcularScoreCacador(candlesMap, mtfManager, tipoAtivo) {
  const reasons = [];
  let score = 0;

  const tf  = (key) => mtfManager.timeframes[key]?.analysis;
  const cvs = (key) => candlesMap[key];

  // Verificar disponibilidade mínima
  if (!tf('H1') || !tf('M15') || !tf('M5') || !tf('M1') ||
      !cvs('H1') || !cvs('M15') || !cvs('M5') || !cvs('M1')) {
    return { signal: 'HOLD', confidence: 0, reasons: ['Dados insuficientes'], simpleMajority: { signal: 'HOLD' }, score: 0 };
  }

  // Direção definida pelo H1 via EMA
  const trendH1 = trendDirection(cvs('H1'));
  if (trendH1 === 'FLAT') {
    reasons.push('H1 sem tendência clara (EMA9/EMA21)');
    return { signal: 'HOLD', confidence: 0, reasons, simpleMajority: { signal: 'HOLD' }, score: 0 };
  }
  const dir          = trendH1;                          // 'UP' ou 'DOWN'
  const signalTarget = dir === 'UP' ? 'CALL' : 'PUT';
  const dirInverse   = dir === 'UP' ? 'DOWN' : 'UP';

  // 1. H1: ADX > 25 e RSI entre 40-65
  const h1 = tf('H1');
  if (h1.adx <= 25) {
    reasons.push(`H1 ADX fraco (${h1.adx.toFixed(1)} ≤ 25)`);
  } else if (h1.rsi < 40 || h1.rsi > 65) {
    reasons.push(`H1 RSI fora de 40-65 (${h1.rsi.toFixed(1)})`);
  } else {
    score += 25;
    reasons.push(`✅ H1 tendência ${dir} (ADX ${h1.adx.toFixed(1)}, RSI ${h1.rsi.toFixed(1)})`);
  }

   // 2. M15: alinhamento com H1 + ADX > 20 (com penalização se MACD fraco)
  const trendM15 = trendDirection(cvs('M15'));
  const m15 = tf('M15');
  if (trendM15 !== dir) {
    reasons.push(`M15 tendência desalinhada (${trendM15})`);
  } else if (m15.adx <= 20) {
    reasons.push(`M15 ADX fraco (${m15.adx.toFixed(1)} ≤ 20)`);
  } else {
    const m15Phase = m15.macd_phase?.name || '';
    const isWeak = m15Phase.startsWith('WEAK'); // WEAK_BULL ou WEAK_BEAR
    if (isWeak) {
      score += 10;
      reasons.push(`⚠️ M15 alinhado ${dir} mas MACD enfraquecendo (ADX ${m15.adx.toFixed(1)}) → +10 pts`);
    } else {
      score += 20;
      reasons.push(`✅ M15 alinhado ${dir} (ADX ${m15.adx.toFixed(1)})`);
    }
  }
  // 3. M5: RSI < 45 (CALL) ou > 55 (PUT) — pullback
  const m5 = tf('M5');
  const m5PullbackOk = dir === 'UP' ? m5.rsi < 45 : m5.rsi > 55;
  if (!m5PullbackOk) {
    reasons.push(`M5 RSI sem pullback (${m5.rsi.toFixed(1)})`);
  } else {
    score += 20;
    reasons.push(`✅ M5 pullback (RSI ${m5.rsi.toFixed(1)})`);
  }

  // 4. M1: vela de reversão + RSI a sair de zona crítica (cálculo real com histórico)
  const m1        = tf('M1');
  const rsiM1     = m1 ? m1.rsi : 50;
  const threshold = dir === 'UP' ? 35 : 65;
  const reversal  = isReversalCandle(cvs('M1'), dir);

  // Calcula as últimas 3 amostras de RSI(14) a partir dos candles do M1
  const rsiHistM1  = calcularRSIArray(cvs('M1'), 14, 3);
  // rsiLeaving verifica se o RSI anterior estava dentro da zona E agora saiu
  const rsiExited  = rsiHistM1.length >= 2
    ? rsiLeaving(rsiHistM1, threshold, dir)
    : (dir === 'UP' ? rsiM1 > threshold : rsiM1 < threshold); // fallback se candles insuficientes

  if (!reversal) {
    reasons.push(`M1 sem vela de reversão ${dir === 'UP' ? 'altista' : 'baixista'}`);
  } else if (!rsiExited) {
    reasons.push(`M1 RSI não saiu da zona crítica (atual ${rsiM1.toFixed(0)}, threshold ${threshold})`);
  } else {
    score += 25;
    reasons.push(`✅ M1 reversão + RSI saiu de zona (${rsiM1.toFixed(0)} > ${threshold})`);
  }

  const finalSignal = score >= 80 ? signalTarget : 'HOLD';
  const confidence  = score >= 80 ? Math.min(score / 100, 0.99) : 0;
  console.log(`🏹 CAÇADOR Score: ${score}/100 → ${finalSignal} (conf ${(confidence * 100).toFixed(0)}%)`);
  return {
    signal: finalSignal,
    confidence,
    reasons,
    simpleMajority: { signal: finalSignal, confidence },
    score
  };
}

function calcularScorePescador(candlesMap, mtfManager, tipoAtivo) {
  const reasons = [];
  let score = 0;

  const tf  = (key) => mtfManager.timeframes[key]?.analysis;
  const cvs = (key) => candlesMap[key];

  // Verificar disponibilidade mínima
  if (!tf('H24') || !tf('H4') || !tf('H1') || !tf('M15') || !tf('M5') ||
      !cvs('H24') || !cvs('H4') || !cvs('H1') || !cvs('M15') || !cvs('M5')) {
    return { signal: 'HOLD', confidence: 0, reasons: ['Dados insuficientes'], simpleMajority: { signal: 'HOLD' }, score: 0 };
  }

  // Alinhamento dos 3 TFs maiores
  const trendD1 = trendDirection(cvs('H24'));  // H24 representa o diário
  const trendH4 = trendDirection(cvs('H4'));
  const trendH1 = trendDirection(cvs('H1'));

  if (trendD1 === 'FLAT' || trendH4 !== trendD1 || trendH1 !== trendD1) {
    reasons.push(`TFs maiores desalinhados (D1:${trendD1} H4:${trendH4} H1:${trendH1})`);
    return { signal: 'HOLD', confidence: 0, reasons, simpleMajority: { signal: 'HOLD' }, score: 0 };
  }

  const dir          = trendD1;
  const signalTarget = dir === 'UP' ? 'CALL' : 'PUT';
  score += 35;
  reasons.push(`✅ D1+H4+H1 alinhados em ${dir}`);

  // H1: ADX > 25
  const h1 = tf('H1');
  if (h1.adx <= 25) {
    reasons.push(`H1 ADX fraco (${h1.adx.toFixed(1)} ≤ 25)`);
  } else {
    score += 20;
    reasons.push(`✅ H1 ADX forte (${h1.adx.toFixed(1)})`);
  }

   // M15: pullback — RSI < 45 (CALL) ou > 55 (PUT) — penalização se MACD fraco
  const m15 = tf('M15');
  const m15PullbackOk = dir === 'UP' ? m15.rsi < 45 : m15.rsi > 55;
  if (!m15PullbackOk) {
    reasons.push(`M15 RSI sem pullback (${m15.rsi.toFixed(1)})`);
  } else {
    const m15Phase = m15.macd_phase?.name || '';
    const isWeak = m15Phase.startsWith('WEAK');
    if (isWeak) {
      score += 8;
      reasons.push(`⚠️ M15 pullback (RSI ${m15.rsi.toFixed(1)}) mas MACD enfraquecendo → +8 pts`);
    } else {
      score += 15;
      reasons.push(`✅ M15 pullback (RSI ${m15.rsi.toFixed(1)})`);
    }
  }

  // M5: vela de reversão + RSI a sair de zona (<40 CALL, >60 PUT) — cálculo real com histórico
  const m5         = tf('M5');
  const rsiM5      = m5 ? m5.rsi : 50;
  const thresholdM5 = dir === 'UP' ? 40 : 60;
  const reversal    = isReversalCandle(cvs('M5'), dir);

  // Calcula as últimas 3 amostras de RSI(14) a partir dos candles do M5
  const rsiHistM5  = calcularRSIArray(cvs('M5'), 14, 3);
  const rsiExited  = rsiHistM5.length >= 2
    ? rsiLeaving(rsiHistM5, thresholdM5, dir)
    : (dir === 'UP' ? rsiM5 > thresholdM5 : rsiM5 < thresholdM5); // fallback

  if (!reversal) {
    reasons.push(`M5 sem vela de reversão ${dir === 'UP' ? 'altista' : 'baixista'}`);
  } else if (!rsiExited) {
    reasons.push(`M5 RSI não saiu da zona (atual ${rsiM5.toFixed(0)}, threshold ${thresholdM5})`);
  } else {
    score += 20;
    reasons.push(`✅ M5 reversão + RSI saiu de zona (${rsiM5.toFixed(0)} > ${thresholdM5})`);
  }

  const finalSignal = score >= 85 ? signalTarget : 'HOLD';
  const confidence  = score >= 85 ? Math.min(score / 100, 0.99) : 0;
  console.log(`🎣 PESCADOR Score: ${score}/100 → ${finalSignal} (conf ${(confidence * 100).toFixed(0)}%)`);
  return {
    signal: finalSignal,
    confidence,
    reasons,
    simpleMajority: { signal: finalSignal, confidence },
    score
  };
}

app.post('/api/analyze', authenticateToken, analyzeLimiter, async (req, res) => {
  const startTime = Date.now();

  try {
    const { symbol, mode } = req.body;

    // [RETIFICADO] Validação robusta do símbolo
    if (!symbol || typeof symbol !== 'string' || symbol.length > 20 || !/^[A-Za-z0-9_]+$/.test(symbol)) {
      return res.status(400).json({ error: 'Símbolo inválido ou não permitido' });
    }
    if (!mode || !TRADING_MODES[mode]) return res.status(400).json({ error: 'Modo inválido. Use: CAÇADOR ou PESCADOR', availableModes: Object.keys(TRADING_MODES) });

    console.log(`\n🎯 ${mode} | ${symbol}`);

    const client = await getDerivClient();

    const tipoAtivo = detectTipoAtivo(symbol);
    console.log(`🏷️  ${tipoAtivo}`);

    const modeTimeframes = TRADING_MODES[mode].timeframes;
    const atrTfKey = getATRTimeframeByMode(mode);
    const allTfKeys = Array.from(new Set([atrTfKey, ...modeTimeframes]));

    const timeframesToAnalyze = modeTimeframes.map(tfKey => {
      const tf = { ...ALL_TIMEFRAMES_CONFIG[tfKey] };
      if (tipoAtivo === 'criptomoeda') tf.candleCount = 60;
      return tf;
    });

    const tickPromise = getCurrentPrice(client, symbol);

    const candlesMap = {};
    await Promise.all(
      allTfKeys.map(async (tfKey) => {
        const tf = timeframesToAnalyze.find(t => t.key === tfKey) || ALL_TIMEFRAMES_CONFIG[tfKey];
        if (!tf) return;
        try {
          // ✅ SEMPRE FRESCO para os timeframes do modo atual (evita sinais congelados)
          const isModeTimeframe = modeTimeframes.includes(tfKey);
          const candles = await getCandlesWithCache(client, symbol, tf, mode, isModeTimeframe);
          if (Array.isArray(candles) && candles.length > 0) candlesMap[tfKey] = candles;
        } catch (err) { console.error(`❌ ${tfKey}:`, err.message); }
      })
    );

    let historicalCandles = candlesMap[atrTfKey] || null;
    if (!historicalCandles) {
      for (const fbKey of ['M5', 'M15', 'M1']) {
        if (candlesMap[fbKey]) { historicalCandles = candlesMap[fbKey]; break; }
      }
    }

    const mtfManager = new MultiTimeframeManager(symbol);
    if (typeof mtfManager.setTipoAtivo === 'function') mtfManager.setTipoAtivo(tipoAtivo);
    else if (mtfManager.tipoAtivo !== undefined) mtfManager.tipoAtivo = tipoAtivo;

    const sistemaBase = new SistemaAnaliseInteligente(symbol);
    if (sistemaBase.sistemaPesos?.setTipoAtivo) sistemaBase.sistemaPesos.setTipoAtivo(tipoAtivo);

    // ✅ HOT-UPDATE PREP: Resolve preço actual antes de analisar (para actualizar candles em aberto)
    let currentPrice = null;
    let priceSource = 'tick';
    try {
      currentPrice = await tickPromise;
    } catch (e) {
      currentPrice = null;
    }

    await Promise.all(
      timeframesToAnalyze.map(async (tf) => {
        try {
          const candles = candlesMap[tf.key];
          if (!candles || candles.length < tf.minRequired) return;

          // ✅ HOT UPDATE: Actualiza o candle em aberto com o preço do tick em tempo real
          if (currentPrice && candles.length > 0) {
            const last = candles[candles.length - 1];
            if (!isCandleClosed(last, tf.seconds)) {
              const price = parseFloat(currentPrice);
              last.close = price.toString();
              if (price > parseFloat(last.high)) last.high = price.toString();
              if (price < parseFloat(last.low)) last.low = price.toString();
            }
          }

          const analysis = await sistemaBase.analisar(candles, tf.key);
          if (analysis && !analysis.erro) {
            mtfManager.addAnalysis(tf.key, analysis);
            console.log(`✅ ${tf.key} OK`);
          }
        } catch (err) { console.error(`❌ análise ${tf.key}:`, err.message); }
      })
    );

    // ========== CONSOLIDAÇÃO BASEADA EM SCORE (substitui consolidateSignals genérico) ==========
    let consolidated;
    if (mode === 'CAÇADOR') {
      consolidated = calcularScoreCacador(candlesMap, mtfManager, tipoAtivo);
    } else if (mode === 'PESCADOR') {
      consolidated = calcularScorePescador(candlesMap, mtfManager, tipoAtivo);
    } else {
      // fallback de segurança (não esperado com apenas 2 modos)
      consolidated = mtfManager.consolidateSignals();
    }
    // Garantir campos que o resto do código espera
    consolidated.tipo_ativo    = tipoAtivo;
    consolidated.sinal_premium = consolidated.signal || null;
    // simpleMajority já é preenchido pelas funções de score

    // Ponto franco (mantém lógica existente)
    const pontoFranco = calcularPontoFranco(mtfManager, tipoAtivo);
    if (pontoFranco) {
      consolidated.ponto_franco = pontoFranco;
      console.log(`⚡ ${pontoFranco.tipo} detectado!`);
    }

    // Agreement simplificado baseado no score
    const agreement = {
      agreement: consolidated.score != null ? `${consolidated.score}/100` : 'N/A',
      primarySignal: consolidated.signal,
      callCount: consolidated.signal === 'CALL' ? 1 : 0,
      putCount:  consolidated.signal === 'PUT'  ? 1 : 0,
      totalTimeframes: TRADING_MODES[mode].timeframes.length
    };
    // Mantém callCountDiv/putCountDiv para as verificações de divergência abaixo
    const timeframesSignals = modeTimeframes
      .map(tfKey => mtfManager.timeframes[tfKey]?.analysis?.sinal)
      .filter(s => s && s !== 'HOLD');
    const callCountDiv = timeframesSignals.filter(s => s === 'CALL').length;
    const putCountDiv  = timeframesSignals.filter(s => s === 'PUT').length;

    // Nota: a divergência de TFs já é tratada internamente pelas funções de score
    // (trendDirection + alinhamento de EMAs). O bloco abaixo é mantido apenas como
    // filtro extra de segurança para divergências MACD detectadas pelo sistema base.
    let hasMacdDivergence = false;
    for (const tfKey of modeTimeframes) {
      const a = mtfManager.timeframes[tfKey]?.analysis;
      if (a?.divergencia_macd?.divergencia) {
        hasMacdDivergence = true;
        console.log(`⚠️ Divergência MACD em ${tfKey} → forçar HOLD`);
        break;
      }
    }
    if (hasMacdDivergence) {
      consolidated.simpleMajority.signal = 'HOLD';
      consolidated.signal = 'HOLD';
      consolidated.confidence = Math.min(consolidated.confidence, 0.3);
    }

    const PRIMARY_TF_MAP = { 'CAÇADOR': 'M1', 'PESCADOR': 'M5' };
    const primaryTf = PRIMARY_TF_MAP[mode] || 'M5';

    const primaryCandles = candlesMap[primaryTf];
    const recentPulse = detectarPulsoRecente(primaryCandles, tipoAtivo);
    if (recentPulse) {
      console.log(`🚨 ${recentPulse.mensagem}`);
    }
    
    const currentOpenCandle = primaryCandles?.at(-1);
    const candleOpenPrice = currentOpenCandle?.open ?? null;
    const primaryOpenTf = primaryTf;

    // Se o tick falhou no hot-update, tenta fallbacks
    if (!currentPrice) {
      for (const tf of [primaryTf, 'M1', 'M5', 'M15', 'H1', 'H4']) {
        const p = mtfManager.timeframes[tf]?.analysis?.preco_atual;
        if (p) { currentPrice = p; priceSource = `fallback_${tf}`; break; }
      }
      if (!currentPrice) {
        try {
          const freshM1 = await client.getCandles(symbol, 1, 60);
          if (freshM1 && freshM1.length > 0) {
            currentPrice = parseFloat(freshM1[freshM1.length - 1].close);
            priceSource = 'fallback_freshM1';
            console.log(`⚠️ Tick falhou, usando último M1 fechado: ${currentPrice}`);
          }
        } catch (err) {
          console.error('❌ Fallback M1 falhou:', err.message);
        }
      }
      if (!currentPrice && candleOpenPrice) {
        currentPrice = candleOpenPrice;
        priceSource = 'fallback_open';
      }
    }

    const priceMovedFromOpen = (candleOpenPrice && currentPrice)
      ? parseFloat((currentPrice - candleOpenPrice).toFixed(5))
      : null;

    const priceMovedDirection = priceMovedFromOpen !== null
      ? (priceMovedFromOpen > 0 ? 'SUBIU' : priceMovedFromOpen < 0 ? 'CAIU' : 'LATERAL')
      : null;

    console.log(`🕯️  Open ${primaryTf}: ${candleOpenPrice} | 💰 Atual: ${currentPrice} | ${priceMovedDirection} ${priceMovedFromOpen}`);

    const PRIMARY_TF_BY_MODE = { 'CAÇADOR': 'M1', 'PESCADOR': 'M5' };
    const modePrimaryTf = PRIMARY_TF_BY_MODE[mode] || 'M5';
    const allTfsAgree = callCountDiv === modeTimeframes.length || putCountDiv === modeTimeframes.length;
    // Alerta informativo – sem penalizar confiança
    for (const tfKey of modeTimeframes) {
        const phase = mtfManager.timeframes[tfKey]?.analysis?.macd_phase?.name;
        if (phase && phase.includes('PERDENDO FORÇA')) {
            console.warn(`⚠️ Alerta: ${tfKey} com ${phase} — monitorar perda de força`);
        }
    }
    
    let primaryTrendNote = null;
    if (consolidated.signal === 'HOLD') {
        const trendTFMap = { 'CAÇADOR': 'H1', 'PESCADOR': 'H24' };
        let tfKey = trendTFMap[mode];
        if (mode === 'PESCADOR') {
            const h24 = mtfManager.timeframes['H24']?.analysis;
            if (!h24 || h24.adx <= 20 || h24.sinal === 'HOLD') {
                const h4 = mtfManager.timeframes['H4']?.analysis;
                if (h4 && h4.adx > 20 && h4.sinal !== 'HOLD') {
                    tfKey = 'H4';
                }
            }
        }
        const analysis = mtfManager.timeframes[tfKey]?.analysis;
        if (analysis && analysis.adx > 20 && analysis.sinal !== 'HOLD') {
            const directionText = analysis.sinal === 'PUT' ? 'BAIXA' : 'ALTA';
            const actionText = analysis.sinal === 'PUT' ? 'venda' : 'compra';
            primaryTrendNote = `Tendência primária (${tfKey}): ${directionText}. Aguarde pullback para ${actionText}.`;
            console.log(`🧭 ${primaryTrendNote}`);
        }
    }

    const suggestion = BotExecutionCore.generateEntrySuggestion(
      { sinal: consolidated.signal, probabilidade: consolidated.confidence }, currentPrice
    );

    const primarySignal = consolidated.simpleMajority.signal;

    const analiseRefinadaPromise = (async () => {
      try {
const modeMap = { 'CAÇADOR': 'CAÇADOR', 'PESCADOR': 'PESCADOR' };
        const dadosMercado = {
          ativo: symbol, precoAtual: currentPrice, volume: 0,
          precosHistoricos: historicalCandles || [], timeframes: {}
        };
        for (const tfKey of modeTimeframes) {
          const a = mtfManager.timeframes[tfKey]?.analysis;
          if (a) dadosMercado.timeframes[tfKey] = {
            adx: a.adx || 25, rsi: a.rsi || 50, tendencia: a.sinal || 'HOLD',
            volatilidade: a.volatilidade || 1.0, precoAtual: a.preco_atual || currentPrice, precos: []
          };
        }
        const bot = new TraderBotAnalise({ confiancaMinimaOperar: 60, confiancaAlta: 75, adxTendenciaForte: 25, adxSemTendencia: 20 });
        const analise = bot.gerarAnalise(dadosMercado, modeMap[mode] || 'CACADOR');
        const risco   = bot.validarOperacao(analise, req.user?.saldo || 1000, 2);

        const direcao   = analise?.sinal?.direcao   ?? 'N/A';
        const confianca = analise?.sinal?.confianca ?? 0;
        console.log(`📊 Refinada: ${direcao} ${confianca}%`);

        return { analiseRefinada: analise, validacaoRisco: risco };
      } catch (err) {
        console.error('❌ analiseRefinada:', err.message);
        return { analiseRefinada: { erro: err.message }, validacaoRisco: null };
      }
    })();

    let m1Timing = null, m5Timing = null, m15Timing = null, h1Timing = null, h4Timing = null;
    if (modeTimeframes.includes('M1'))  m1Timing  = calcularTimingM1(mtfManager.timeframes['M1']?.analysis,  primarySignal, mode);
    if (modeTimeframes.includes('M5'))  m5Timing  = calcularTimingM5(mtfManager.timeframes['M5']?.analysis,  primarySignal, mode);
    if (modeTimeframes.includes('M15')) m15Timing = calcularTimingM15(mtfManager.timeframes['M15']?.analysis, primarySignal, mode);
    // [RETIFICADO] Remover vírgula solta antes de mode
    if (modeTimeframes.includes('H1'))  h1Timing  = calcularTimingH1(mtfManager.timeframes['H1']?.analysis,  primarySignal);
    if (modeTimeframes.includes('H4'))  h4Timing  = calcularTimingH4(mtfManager.timeframes['H4']?.analysis,  primarySignal);

    let timingEspecial = null;
    if (mtfManager.tipoAtivo !== 'DEFAULT') {
      const m1a = mtfManager.timeframes['M1']?.analysis;
      if (m1a && typeof mtfManager.calcularTimingEspecial === 'function')
        timingEspecial = mtfManager.calcularTimingEspecial('M1', m1a);
    }

    let timingRiskWarning = null;

    if (consolidated.signal !== 'HOLD') {
        const modeTimingMap = {
            'CAÇADOR': m1Timing,
            'PESCADOR': m5Timing
        };
        const primaryTiming = modeTimingMap[mode];

        if (primaryTiming && !primaryTiming.permitido) {
            const previousConf = consolidated.confidence;
            consolidated.confidence = Math.min(consolidated.confidence, 0.35);
            timingRiskWarning = `⛔ ENTRADA DE RISCO — timing do ${primaryTf} não confirma`;

            console.log(
                `⛔ Timing primário (${primaryTf}) NÃO OK → confiança limitada a 35% ` +
                `(${(previousConf * 100).toFixed(1)}% → ${(consolidated.confidence * 100).toFixed(1)}%)`
            );
        }
    }

    let liquidityResult = { sweepDetected: false };
    try {
      const analysisMap = {};
      for (const tfKey of modeTimeframes) {
        const a = mtfManager.timeframes[tfKey]?.analysis;
        if (a) analysisMap[tfKey] = a;
      }
      liquidityResult = detectLiquiditySweepRobusto({
        mode, currentPrice, candlesMap, analysisMap,
        atrValue: historicalCandles ? calcularATRLiquidity(historicalCandles, 14) : null
      });
      console.log(`💧 ${liquidityResult.sweepDetected ? `SWEEP ${liquidityResult.direction} ${liquidityResult.confidence}%` : 'sem sweep'}`);
    } catch (err) { console.error('❌ liquidez:', err.message); }

    const isAtivoPulso = ['boom_index','crash_index','jump_index','step_index'].includes(tipoAtivo);
    const hasTfDivergenceForLiquidity = callCountDiv > 0 && putCountDiv > 0;
    let timingOk = false;
    if (mode === 'CAÇADOR'  && m1Timing?.permitido)  timingOk = true;
    if (mode === 'PESCADOR' && m5Timing?.permitido)  timingOk = true;

   if (!isAtivoPulso && !hasTfDivergenceForLiquidity && 
    liquidityResult.sweepDetected && liquidityResult.confidence >= 75 && timingOk) {
    // override permitido apenas para ativos normais
    console.log(`⚠️ Liquidez substitui sinal → ${liquidityResult.direction} ${liquidityResult.confidence.toFixed(0)}%`);
    consolidated.signal = liquidityResult.direction;
    consolidated.confidence = liquidityResult.confidence / 100;
    consolidated.simpleMajority.signal = liquidityResult.direction;
} else if (liquidityResult.sweepDetected && isAtivoPulso) {
    // Apenas log informativo, nunca override
    console.log(`💧 Liquidez detectada em ativo de pulso — apenas alerta informativo, não substitui sinal`);
}
    // Obter o timing correspondente ao modo atual
    const modeTiming = (() => {
        if (mode === 'CAÇADOR') return m1Timing;
        if (mode === 'PESCADOR') return m5Timing;
        return null;
    })();
    
    const stopTakeLevels = calcularStopTakePorModo(candlesMap, mode, modeTiming, tipoAtivo);
    const { analiseRefinada, validacaoRisco } = await analiseRefinadaPromise;

    const responseTimeframes = {};
    modeTimeframes.forEach(tfKey => {
      const d = mtfManager.timeframes[tfKey];
      if (d?.analysis) responseTimeframes[tfKey] = {
        sinal: d.analysis.sinal, probabilidade: d.analysis.probabilidade,
        adx: d.analysis.adx, rsi: d.analysis.rsi, preco_atual: d.analysis.preco_atual,
        macd_phase: d.analysis.macd_phase, divergencia_macd: d.analysis.divergencia_macd
      };
    });

    const responseTime = Date.now() - startTime;
    console.log(`✅ ${responseTime}ms | ${mode} | ${tipoAtivo} | ${agreement.totalTimeframes} TFs`);

    res.json({
      success: true,
      mode, modeDescription: TRADING_MODES[mode].description,
      consolidated: {
        signal: consolidated.signal,
        confidence: consolidated.confidence,
        agreement: agreement.agreement,
        simpleMajority: consolidated.simpleMajority,
        timeframesAnalyzed: agreement.totalTimeframes,
        sinal_premium: consolidated.sinal_premium || null,
        price: currentPrice, priceSource,
        candleOpenPrice,
        candleOpenTf: primaryOpenTf,
        priceMovedFromOpen,
        priceMovedDirection,
        tipo_ativo: tipoAtivo,
        recentPulse: recentPulse || null,
        ...(m1Timing  && { m1_timing:  m1Timing  }),
        ...(m5Timing  && { m5_timing:  m5Timing  }),
        ...(m15Timing && { m15_timing: m15Timing }),
        ...(h1Timing  && { h1_timing:  h1Timing  }),
        ...(h4Timing  && { h4_timing:  h4Timing  }),
        config_ativo: consolidated.config_ativo,
        ponto_franco: consolidated.ponto_franco || null,
        timing_especial: timingEspecial,
        primaryTrendNote: primaryTrendNote || null,
        timingRiskWarning: timingRiskWarning || null,
        score: consolidated.score ?? null,
        score_reasons: consolidated.reasons || []
      },
      agreement: {
        agreement: agreement.agreement, primarySignal: agreement.primarySignal,
        callCount: agreement.callCount, putCount: agreement.putCount,
        totalTimeframes: agreement.totalTimeframes
      },
      suggestion: stopTakeLevels
        ? {
            action: 'ENTRADA',
            reason: `Stop e Take calculados para o modo ${mode}`,
            entry: stopTakeLevels.precoEntrada,
            stopLoss: stopTakeLevels.stopLoss,
            takeProfit: stopTakeLevels.takeProfit
          }
        : {
            action: suggestion.action,
            reason: suggestion.reason,
            entry: suggestion.entry,
            stopLoss: suggestion.stopLoss,
            takeProfit: suggestion.takeProfit
          },
      timeframes: responseTimeframes,
      refined_analysis: analiseRefinada,
      risk_validation: validacaoRisco,
      liquidity: liquidityResult.sweepDetected ? {
        sweepDetected: true,
        direction: liquidityResult.direction,
        confidence: liquidityResult.confidence,
        liquidityZone: liquidityResult.liquidityZone || null,
        details: liquidityResult.details || null,
        timingOk,
        overrodeSignal: (!isAtivoPulso && !hasTfDivergenceForLiquidity && liquidityResult.sweepDetected && liquidityResult.confidence >= 75 && timingOk)
      } : { sweepDetected: false },
      metadata: { responseTimeMs: responseTime, timestamp: new Date().toISOString() }
    });

  } catch (error) {
    console.error('❌ Erro na análise:', error);
    // [RETIFICADO] Não expõe stack em produção
    const isDev = process.env.NODE_ENV === 'development';
    res.status(500).json({ error: isDev ? error.message : 'Erro interno no processamento da análise' });
  }
});

app.use((req, res) => res.status(404).json({ error: 'Rota não encontrada' }));
app.use((err, req, res, next) => {
  console.error('❌ Erro global:', err);
  const isDev = process.env.NODE_ENV === 'development';
  res.status(500).json({ error: 'Erro interno', message: isDev ? err.message : undefined });
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, '0.0.0.0', async () => {
  console.log(`\n🚀 Porta ${PORT}`);
  console.log(`🎯 Modos: ${Object.keys(TRADING_MODES).join(', ')}`);
  console.log(`📊 Candles: M1→100 | M5/M15→120 | M30→100 | H1→80 | H4→60 | H24→40 (cripto→60)`);
  console.log(`⚡ Tick timeout: 350ms | Candles + Tick em paralelo | analiseRefinada em paralelo`);
  console.log(`🏷️  Deteção de ativo: 9 tipos (volatility/boom/crash/jump/step/commodity/cripto/forex/normal)`);
  console.log(`💧 Liquidity Hunter Robusto ativo`);
  console.log(`💾 Cache em memória anti-ruído ativo (max ${MAX_MEMORY_CACHE_SIZE} entradas)`);
  console.log(`ℹ️ "Perdendo Força": apenas alerta informativo.`);
  console.log(`🔧 FIX: liquidityResult.confidence normalizado para escala 0-1`);
  console.log(`🧭 Nota de tendência primária ativa`);
  console.log(`⛔ Penalização de Timing: limitada a 35% se o TF primário não confirma`);
  console.log(`🛡️  FIX 1: uncaughtException + unhandledRejection com graceful shutdown`);
  console.log(`🔄 FIX 2: Watchdog de reconexão Deriv com lock a cada 4 minutos`);
  console.log(`💓 FIX 3: Self-ping anti-hibernação a cada 10 minutos`);
  console.log(`❤️  FIX 4: /health com status detalhado ativo`);
  console.log(`🔌 FIX: disconnect() seguro antes de abandonar cliente Deriv`);
  console.log(`🔌 FIX: optional chaining em analise.sinal ativo`);
  console.log(`⏱️  FIX: timeout getCandles reduzido para 12s`);
  console.log(`🔒 FIX: Cache Redis com validação JSON e LRU em memória`);
  console.log(`⚡ TTL reduzido para ativos de pulso no CAÇADOR (10s max)`);
  console.log(`🎯 RSI dinâmico por modo implementado`);
  console.log(`💠 Stop Loss dinâmico: 2% pulso / 0.2% normal`);
  console.log(`🛡️  Override de liquidez bloqueado em ativos de pulso`);
  console.log(`👁️  Detecção de pulso recente ativa`);
  console.log(`⚡ Ponto Franco calculado automaticamente`);
  console.log(`🏹 CAÇADOR: M1+M5+M15+H1 | TF primário M1 | expiração 5-15 min`);
  console.log(`🎣 PESCADOR: M5+M15+H1+H4+H24 | TF primário M5 | expiração 15-60 min`);
  console.log(`🎯 Score CAÇADOR: limiar ≥80 | Score PESCADOR: limiar ≥85`);
  try { await getDerivClient(); console.log('✅ Conexão Deriv OK'); }
  catch (err) { console.error('❌ Conexão Deriv:', err); }
});

// ========== FIX 3: SELF-PING ANTI-HIBERNAÇÃO ==========
const SELF_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

setInterval(async () => {
  try {
    if (typeof fetch !== 'function') {
      console.warn('⚠️ fetch não disponível para self-ping');
      return;
    }
    const res = await fetch(`${SELF_URL}/health`);
    console.log(`💓 Self-ping OK: ${res.status} | uptime: ${Math.floor(process.uptime())}s`);
  } catch (err) {
    console.error('⚠️ Self-ping falhou:', err.message);
  }
}, 10 * 60 * 1000);

server.keepAliveTimeout = 120000;
server.headersTimeout   = 120000;

process.on('SIGTERM', () => {
  console.log('\n🛑 SIGTERM - encerrando...');
  server.close(() => {
    if (derivClient) {
      try { derivClient.disconnect(); } catch (e) {}
    }
    if (redisClient) redisClient.quit();
    process.exit(0);
  });
});
process.on('SIGINT', () => process.emit('SIGTERM'));

module.exports = app;
