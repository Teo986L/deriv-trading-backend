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

const TTL_BY_TIMEFRAME = {
  'M1': 10,
  'M5': 20,
  'M15': 30,
  'M30': 45,
  'H1': 60,
  'H4': 120,
  'H24': 300
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

// ========== DEFINIÇÃO DOS MODOS DE TRADING ==========
const TRADING_MODES = {
  'SNIPER': {
    timeframes: ['M1', 'M5', 'M15'],
    description: 'Entradas cirúrgicas de 1-15 minutos'
  },
  'CACADOR': {
    timeframes: ['M5', 'M15', 'H1'],
    description: 'Ondas médias de 15-60 minutos'
  },
  'PESCADOR': {
    timeframes: ['M15', 'H1', 'H4', 'H24'],
    description: 'Grandes movimentos de horas a dias'
  }
};

// ========== FUNÇÃO PARA OBTER TIMEFRAME PARA ATR BASEADO NO MODO ==========
function getATRTimeframeByMode(mode) {
  const modeATRMap = {
    'SNIPER': 'M1',
    'CACADOR': 'M5',
    'PESCADOR': 'M15'
  };
  return modeATRMap[mode] || 'M5'; // fallback para M5
}

// ========== CONFIGURAÇÃO ATUALIZADA - ALINHADA COM SCRIPT.JS ==========
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

async function getCandlesWithCache(client, symbol, tf, forceFresh = false) {
  // Se não tiver Redis ou forçar atualização, busca direto da Deriv
  if (!redisClient || !redisClient.isReady || forceFresh) {
    console.log(`🔄 Buscando ${tf.key} direto da Deriv (${tf.candleCount} candles)`);
    
    // Pede 400 candles como no script.js original
    const candles = await client.getCandles(symbol, tf.candleCount, tf.seconds);
    
    if (!Array.isArray(candles)) {
      console.error(`❌ Resposta inválida da Deriv para ${tf.key}: não é um array`);
      return candles;
    }
    
    // Script.js NÃO filtra candles fechados, mas vamos manter o filtro
    // para usar apenas candles completos (mais seguro)
    const closedCandles = candles.filter(c => isCandleClosed(c, tf.seconds));
    
    console.log(`📊 ${tf.key}: recebidos ${candles.length} candles, ${closedCandles.length} fechados`);
    
    if (closedCandles.length < tf.minRequired) {
      console.log(`⚠️ ${tf.key}: apenas ${closedCandles.length} candles fechados, mínimo ${tf.minRequired}`);
      // Ainda assim retorna os candles fechados para análise
    }
    
    return closedCandles;
  }

  // Com Redis - usar cache
  const cacheKey = `candles:${symbol}:${tf.key}`;
  
  try {
    const cached = await redisClient.get(cacheKey);
    
    if (cached) {
      const ttl = await redisClient.ttl(cacheKey);
      console.log(`✅ Cache hit: ${cacheKey} (TTL: ${ttl}s)`);
      
      // Atualizar cache em background se estiver perto de expirar
      if (ttl < 5) {
        setTimeout(async () => {
          try {
            console.log(`🔄 Atualizando cache em background: ${cacheKey}`);
            const freshCandles = await client.getCandles(symbol, tf.candleCount, tf.seconds);
            if (Array.isArray(freshCandles)) {
              const closedCandles = freshCandles.filter(c => isCandleClosed(c, tf.seconds));
              const ttl = TTL_BY_TIMEFRAME[tf.key] || 60;
              await redisClient.setEx(cacheKey, ttl, JSON.stringify(closedCandles));
              console.log(`✅ Cache atualizado: ${cacheKey} (${closedCandles.length} candles)`);
            }
          } catch (err) {
            console.error(`❌ Erro atualizando cache em background: ${err.message}`);
          }
        }, 0);
      }
      
      return JSON.parse(cached);
    }
    
    // Cache miss - buscar da Deriv e armazenar
    console.log(`🔄 Cache miss: ${cacheKey} - buscando ${tf.candleCount} candles da Deriv`);
    const candles = await client.getCandles(symbol, tf.candleCount, tf.seconds);
    
    if (!Array.isArray(candles)) {
      console.error(`❌ Resposta inválida da Deriv para ${cacheKey}: não é um array`);
      return candles;
    }
    
    const closedCandles = candles.filter(c => isCandleClosed(c, tf.seconds));
    console.log(`📊 ${tf.key}: ${closedCandles.length} candles fechados de ${candles.length} recebidos`);
    
    if (closedCandles.length < tf.minRequired) {
      console.log(`⚠️ ${tf.key}: apenas ${closedCandles.length} candles fechados, mínimo ${tf.minRequired}`);
    }
    
    // Armazenar no cache
    const ttl = TTL_BY_TIMEFRAME[tf.key] || 60;
    await redisClient.setEx(cacheKey, ttl, JSON.stringify(closedCandles));
    
    return closedCandles;
    
  } catch (error) {
    console.error(`❌ Erro no cache para ${cacheKey}:`, error.message);
    // Fallback: buscar direto da Deriv sem cache
    const candles = await client.getCandles(symbol, tf.candleCount, tf.seconds);
    if (!Array.isArray(candles)) return candles;
    return candles.filter(c => isCandleClosed(c, tf.seconds));
  }
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

// ========== FUNÇÃO: OBTER PREÇO ATUAL VIA TICK ==========
async function getCurrentPrice(client, symbol) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      console.log(`⏱️ Timeout ao obter tick para ${symbol}`);
      resolve(null);
    }, 2000);

    const reqId = Date.now();
    const handler = (response) => {
      if (response.error) {
        console.log(`⚠️ Erro no tick: ${response.error.message}`);
        clearTimeout(timeout);
        client.removeListener(reqId);
        resolve(null);
      } else if (response.tick && response.tick.symbol === symbol) {
        clearTimeout(timeout);
        client.removeListener(reqId);
        resolve(response.tick.quote);
      }
    };
    
    client.addListener(reqId, handler);
    client.send({ tick: symbol, req_id: reqId });
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

app.get('/api/connection-status', authenticateToken, (req, res) => {
  if (!derivClient) {
    return res.json({ status: 'not_initialized' });
  }
  res.json(derivClient.getConnectionStatus());
});

function calcularTimingM1(m1Analysis, primarySignal) {
  if (!m1Analysis || primarySignal === 'HOLD') {
    return {
      permitido: false,
      motivo: 'M1 não disponível',
      rsi: m1Analysis?.rsi || null,
      sinal: m1Analysis?.sinal || null,
      adx: m1Analysis?.adx || null
    };
  }

  const adx = m1Analysis.adx || 0;
  const temTendenciaForte = adx >= 25;

  if (primarySignal === 'CALL') {
    if (m1Analysis.sinal === 'CALL' && m1Analysis.rsi < 65 && temTendenciaForte) {
      return {
        permitido: true,
        motivo: `M1 confirmando CALL com tendência forte (ADX ${adx.toFixed(0)})`,
        rsi: m1Analysis.rsi,
        sinal: m1Analysis.sinal,
        adx: adx
      };
    }
    else if (m1Analysis.sinal === 'CALL' && m1Analysis.rsi < 65) {
      return {
        permitido: true,
        motivo: `M1 confirmando CALL (tendência fraca/moderada ADX ${adx.toFixed(0)})`,
        rsi: m1Analysis.rsi,
        sinal: m1Analysis.sinal,
        adx: adx
      };
    }
    else if (m1Analysis.sinal === 'PUT' && m1Analysis.rsi < 30) {
      return {
        permitido: true,
        motivo: `M1 oversold - possível reversão para CALL (ADX ${adx.toFixed(0)})`,
        rsi: m1Analysis.rsi,
        sinal: m1Analysis.sinal,
        adx: adx
      };
    }
    else {
      return {
        permitido: false,
        motivo: `M1 não confirma (${m1Analysis.sinal}, RSI ${m1Analysis.rsi?.toFixed(0)}, ADX ${adx.toFixed(0)})`,
        rsi: m1Analysis.rsi,
        sinal: m1Analysis.sinal,
        adx: adx
      };
    }
  }
  else if (primarySignal === 'PUT') {
    if (m1Analysis.sinal === 'PUT' && m1Analysis.rsi > 35 && temTendenciaForte) {
      return {
        permitido: true,
        motivo: `M1 confirmando PUT com tendência forte (ADX ${adx.toFixed(0)})`,
        rsi: m1Analysis.rsi,
        sinal: m1Analysis.sinal,
        adx: adx
      };
    }
    else if (m1Analysis.sinal === 'PUT' && m1Analysis.rsi > 35) {
      return {
        permitido: true,
        motivo: `M1 confirmando PUT (tendência fraca/moderada ADX ${adx.toFixed(0)})`,
        rsi: m1Analysis.rsi,
        sinal: m1Analysis.sinal,
        adx: adx
      };
    }
    else if (m1Analysis.sinal === 'CALL' && m1Analysis.rsi > 70) {
      return {
        permitido: true,
        motivo: `M1 overbought - possível reversão para PUT (ADX ${adx.toFixed(0)})`,
        rsi: m1Analysis.rsi,
        sinal: m1Analysis.sinal,
        adx: adx
      };
    }
    else {
      return {
        permitido: false,
        motivo: `M1 não confirma (${m1Analysis.sinal}, RSI ${m1Analysis.rsi?.toFixed(0)}, ADX ${adx.toFixed(0)})`,
        rsi: m1Analysis.rsi,
        sinal: m1Analysis.sinal,
        adx: adx
      };
    }
  }

  return {
    permitido: false,
    motivo: 'Sinal principal neutro',
    rsi: m1Analysis.rsi,
    sinal: m1Analysis.sinal,
    adx: adx
  };
}

function calcularTimingM5(m5Analysis, primarySignal) {
  if (!m5Analysis || primarySignal === 'HOLD') {
    return {
      permitido: false,
      motivo: 'M5 não disponível',
      rsi: m5Analysis?.rsi || null,
      sinal: m5Analysis?.sinal || null,
      adx: m5Analysis?.adx || null
    };
  }

  const adx = m5Analysis.adx || 0;
  const temTendenciaForte = adx >= 25;

  if (primarySignal === 'CALL') {
    if (m5Analysis.sinal === 'CALL' && m5Analysis.rsi < 65 && temTendenciaForte) {
      return {
        permitido: true,
        motivo: `M5 confirmando CALL com tendência forte (ADX ${adx.toFixed(0)})`,
        rsi: m5Analysis.rsi,
        sinal: m5Analysis.sinal,
        adx: adx
      };
    }
    else if (m5Analysis.sinal === 'CALL' && m5Analysis.rsi < 65) {
      return {
        permitido: true,
        motivo: `M5 confirmando CALL (tendência fraca/moderada ADX ${adx.toFixed(0)})`,
        rsi: m5Analysis.rsi,
        sinal: m5Analysis.sinal,
        adx: adx
      };
    }
    else if (m5Analysis.sinal === 'PUT' && m5Analysis.rsi < 30) {
      return {
        permitido: true,
        motivo: `M5 oversold - possível reversão para CALL (ADX ${adx.toFixed(0)})`,
        rsi: m5Analysis.rsi,
        sinal: m5Analysis.sinal,
        adx: adx
      };
    }
    else {
      return {
        permitido: false,
        motivo: `M5 não confirma (${m5Analysis.sinal}, RSI ${m5Analysis.rsi?.toFixed(0)}, ADX ${adx.toFixed(0)})`,
        rsi: m5Analysis.rsi,
        sinal: m5Analysis.sinal,
        adx: adx
      };
    }
  }
  else if (primarySignal === 'PUT') {
    if (m5Analysis.sinal === 'PUT' && m5Analysis.rsi > 35 && temTendenciaForte) {
      return {
        permitido: true,
        motivo: `M5 confirmando PUT com tendência forte (ADX ${adx.toFixed(0)})`,
        rsi: m5Analysis.rsi,
        sinal: m5Analysis.sinal,
        adx: adx
      };
    }
    else if (m5Analysis.sinal === 'PUT' && m5Analysis.rsi > 35) {
      return {
        permitido: true,
        motivo: `M5 confirmando PUT (tendência fraca/moderada ADX ${adx.toFixed(0)})`,
        rsi: m5Analysis.rsi,
        sinal: m5Analysis.sinal,
        adx: adx
      };
    }
    else if (m5Analysis.sinal === 'CALL' && m5Analysis.rsi > 70) {
      return {
        permitido: true,
        motivo: `M5 overbought - possível reversão para PUT (ADX ${adx.toFixed(0)})`,
        rsi: m5Analysis.rsi,
        sinal: m5Analysis.sinal,
        adx: adx
      };
    }
    else {
      return {
        permitido: false,
        motivo: `M5 não confirma (${m5Analysis.sinal}, RSI ${m5Analysis.rsi?.toFixed(0)}, ADX ${adx.toFixed(0)})`,
        rsi: m5Analysis.rsi,
        sinal: m5Analysis.sinal,
        adx: adx
      };
    }
  }

  return {
    permitido: false,
    motivo: 'Sinal principal neutro',
    rsi: m5Analysis.rsi,
    sinal: m5Analysis.sinal,
    adx: adx
  };
}

function calcularTimingM15(m15Analysis, primarySignal) {
  if (!m15Analysis || primarySignal === 'HOLD') {
    return {
      permitido: false,
      motivo: 'M15 não disponível',
      rsi: m15Analysis?.rsi || null,
      sinal: m15Analysis?.sinal || null,
      adx: m15Analysis?.adx || null
    };
  }

  const adx = m15Analysis.adx || 0;
  const temTendenciaForte = adx >= 25;

  if (primarySignal === 'CALL') {
    if (m15Analysis.sinal === 'CALL' && m15Analysis.rsi < 65 && temTendenciaForte) {
      return {
        permitido: true,
        motivo: `M15 confirmando CALL com tendência forte (ADX ${adx.toFixed(0)})`,
        rsi: m15Analysis.rsi,
        sinal: m15Analysis.sinal,
        adx: adx
      };
    }
    else if (m15Analysis.sinal === 'CALL' && m15Analysis.rsi < 65) {
      return {
        permitido: true,
        motivo: `M15 confirmando CALL (tendência fraca/moderada ADX ${adx.toFixed(0)})`,
        rsi: m15Analysis.rsi,
        sinal: m15Analysis.sinal,
        adx: adx
      };
    }
    else if (m15Analysis.sinal === 'PUT' && m15Analysis.rsi < 30) {
      return {
        permitido: true,
        motivo: `M15 oversold - possível reversão para CALL (ADX ${adx.toFixed(0)})`,
        rsi: m15Analysis.rsi,
        sinal: m15Analysis.sinal,
        adx: adx
      };
    }
    else {
      return {
        permitido: false,
        motivo: `M15 não confirma (${m15Analysis.sinal}, RSI ${m15Analysis.rsi?.toFixed(0)}, ADX ${adx.toFixed(0)})`,
        rsi: m15Analysis.rsi,
        sinal: m15Analysis.sinal,
        adx: adx
      };
    }
  }
  else if (primarySignal === 'PUT') {
    if (m15Analysis.sinal === 'PUT' && m15Analysis.rsi > 35 && temTendenciaForte) {
      return {
        permitido: true,
        motivo: `M15 confirmando PUT com tendência forte (ADX ${adx.toFixed(0)})`,
        rsi: m15Analysis.rsi,
        sinal: m15Analysis.sinal,
        adx: adx
      };
    }
    else if (m15Analysis.sinal === 'PUT' && m15Analysis.rsi > 35) {
      return {
        permitido: true,
        motivo: `M15 confirmando PUT (tendência fraca/moderada ADX ${adx.toFixed(0)})`,
        rsi: m15Analysis.rsi,
        sinal: m15Analysis.sinal,
        adx: adx
      };
    }
    else if (m15Analysis.sinal === 'CALL' && m15Analysis.rsi > 70) {
      return {
        permitido: true,
        motivo: `M15 overbought - possível reversão para PUT (ADX ${adx.toFixed(0)})`,
        rsi: m15Analysis.rsi,
        sinal: m15Analysis.sinal,
        adx: adx
      };
    }
    else {
      return {
        permitido: false,
        motivo: `M15 não confirma (${m15Analysis.sinal}, RSI ${m15Analysis.rsi?.toFixed(0)}, ADX ${adx.toFixed(0)})`,
        rsi: m15Analysis.rsi,
        sinal: m15Analysis.sinal,
        adx: adx
      };
    }
  }

  return {
    permitido: false,
    motivo: 'Sinal principal neutro',
    rsi: m15Analysis.rsi,
    sinal: m15Analysis.sinal,
    adx: adx
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

    // ========== PASSA O SÍMBOLO PARA O MTF MANAGER ==========
    const mtfManager = new MultiTimeframeManager(symbol);
    
    const tipoAtivo = symbol.startsWith('R_') ? 'volatility_index' : 
                     (symbol.includes('frx') ? 'forex' : 'indice_normal');
    
    const sistemaBase = new SistemaAnaliseInteligente(symbol);
    
    if (sistemaBase.sistemaPesos && sistemaBase.sistemaPesos.setTipoAtivo) {
      sistemaBase.sistemaPesos.setTipoAtivo(tipoAtivo);
    }

    // ========== COLETAR CANDLES PARA ANÁLISE REFINADA POR MODO ==========
    let historicalCandles = null;
    const atrTimeframe = getATRTimeframeByMode(mode);

    console.log(`📊 Modo ${mode} - usando ${atrTimeframe} para cálculo de ATR/volatilidade`);

    // Primeiro, tentar buscar o timeframe específico para ATR
    try {
      const tfForATR = ALL_TIMEFRAMES_CONFIG[atrTimeframe];
      if (tfForATR) {
        console.log(`🔍 Buscando candles do ${atrTimeframe} para ATR...`);
        const atrCandles = await getCandlesWithCache(client, symbol, tfForATR, true);
        if (atrCandles && Array.isArray(atrCandles) && atrCandles.length > 0) {
          historicalCandles = atrCandles;
          console.log(`✅ Obtidos ${historicalCandles.length} candles do ${atrTimeframe} para ATR`);
        } else {
          console.log(`⚠️ Não foi possível obter candles do ${atrTimeframe}, tentando fallback...`);
        }
      }
    } catch (err) {
      console.error(`❌ Erro ao buscar ${atrTimeframe}: ${err.message}`);
    }

    // Fallback: se não conseguiu, tenta o próximo timeframe mais granular
    if (!historicalCandles || historicalCandles.length === 0) {
      const fallbackMap = {
        'M1': ['M5', 'M15'],      // Sniper fallback: M5, M15
        'M5': ['M1', 'M15'],      // Caçador fallback: M1, M15
        'M15': ['M5', 'H1']       // Pescador fallback: M5, H1
      };
      
      const fallbacks = fallbackMap[atrTimeframe] || ['M5', 'M15'];
      
      for (const fallbackTf of fallbacks) {
        if (historicalCandles && historicalCandles.length > 0) break;
        
        try {
          const tfConfig = ALL_TIMEFRAMES_CONFIG[fallbackTf];
          if (tfConfig) {
            console.log(`🔄 Fallback: tentando ${fallbackTf} para ATR...`);
            const fallbackCandles = await getCandlesWithCache(client, symbol, tfConfig, true);
            if (fallbackCandles && Array.isArray(fallbackCandles) && fallbackCandles.length > 0) {
              historicalCandles = fallbackCandles;
              console.log(`✅ Fallback: usando ${fallbackTf} para ATR (${historicalCandles.length} candles)`);
            }
          }
        } catch (err) {
          console.error(`❌ Erro no fallback ${fallbackTf}: ${err.message}`);
        }
      }
    }

    // Agora, processar todos os timeframes do modo normalmente
    for (const tf of timeframesToAnalyze) {
      try {
        console.log(`🔍 Analisando ${tf.key}...`);
        
        const forceFresh = (tf.key === 'M1' || tf.key === 'M5') && (Math.random() > 0.5);
        
        const candles = await getCandlesWithCache(client, symbol, tf, forceFresh);
        
        if (!Array.isArray(candles)) {
          console.error(`❌ Resposta inválida para ${tf.key}: não é um array`);
          continue;
        }
        
        if (candles.length < tf.minRequired) {
          console.log(`⚠️ ${tf.key}: apenas ${candles.length} candles, mínimo ${tf.minRequired}`);
          continue;
        }

        const analysis = await sistemaBase.analisar(candles, tf.key);
        
        if (analysis && !analysis.erro) {
          mtfManager.addAnalysis(tf.key, analysis);
          console.log(`✅ ${tf.key} analisado com sucesso`);
        }
      } catch (err) {
        console.error(`❌ Erro ao buscar/analisar ${tf.key}:`, err.message);
      }
    }

    const consolidated = mtfManager.consolidateSignals();
    const agreement = mtfManager.calculateAgreement();

    // ========== BLOQUEIO POR DIVERGÊNCIA MACD ==========
    // Verifica qualquer timeframe do modo atual
    let hasMacdDivergence = false;
    for (const tfKey of TRADING_MODES[mode].timeframes) {
      const analysis = mtfManager.timeframes[tfKey]?.analysis;
      if (analysis && analysis.divergencia_macd && analysis.divergencia_macd.divergencia) {
        hasMacdDivergence = true;
        console.log(`⚠️ Divergência MACD detectada em ${tfKey} - forçando HOLD (${analysis.divergencia_macd.tipo})`);
        break; // basta uma divergência para bloquear
      }
    }
    if (hasMacdDivergence) {
      // Força sinal HOLD e reduz confiança
      consolidated.simpleMajority.signal = "HOLD";
      consolidated.signal = "HOLD";
      consolidated.confidence = Math.min(consolidated.confidence, 0.3);
      // NÃO inclui motivo na resposta (apenas log)
    }
    // =================================================

    // ========== PREÇO EM TEMPO REAL (VIA TICK) ==========
    let currentPrice = 0;
    let priceSource = 'unknown';

    try {
      const tickPrice = await getCurrentPrice(client, symbol);
      if (tickPrice) {
        currentPrice = tickPrice;
        priceSource = 'tick';
        console.log(`💰 Preço via tick: ${currentPrice}`);
      }
    } catch (error) {
      console.log(`⚠️ Erro ao obter tick: ${error.message}`);
    }

    if (!currentPrice) {
      if (mtfManager.timeframes['M1']?.analysis?.preco_atual) {
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
    }

    const suggestion = BotExecutionCore.generateEntrySuggestion(
      { sinal: consolidated.simpleMajority.signal, probabilidade: agreement.agreement / 100 },
      currentPrice
    );

    let m1Timing = null, m5Timing = null, m15Timing = null;
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

    // ========== CALCULAR TIMING ESPECIAL ==========
    let timingEspecial = null;
    if (mtfManager.tipoAtivo !== 'DEFAULT') {
      const m1Analysis = mtfManager.timeframes['M1']?.analysis;
      if (m1Analysis) {
        timingEspecial = mtfManager.calcularTimingEspecial('M1', m1Analysis);
      }
    }

    // ========== ANÁLISE REFINADA COM TRADER BOT ANALYZER ==========
    let analiseRefinada = null;
    let validacaoRisco = null;

    try {
      // Construir dados no formato esperado pelo TraderBotAnalise
      const dadosMercado = {
        ativo: symbol,
        precoAtual: currentPrice,
        volume: 0, // Volume não está disponível via API da Deriv
        precosHistoricos: historicalCandles || [], // Usar candles do timeframe específico do modo
        timeframes: {}
      };

      // Preencher timeframes com as análises já existentes
      for (const tfKey of TRADING_MODES[mode].timeframes) {
        const analysis = mtfManager.timeframes[tfKey]?.analysis;
        if (analysis) {
          dadosMercado.timeframes[tfKey] = {
            adx: analysis.adx || 25,
            rsi: analysis.rsi || 50,
            tendencia: analysis.sinal || 'HOLD',
            volatilidade: analysis.volatilidade || 1.0,
            precoAtual: analysis.preco_atual || currentPrice,
            precos: [] // não necessário pois já temos os valores prontos
          };
        }
      }

      // Criar instância do analisador refinado
      const botAnalise = new TraderBotAnalise({
        confiancaMinimaOperar: 60,
        confiancaAlta: 75,
        adxTendenciaForte: 25,
        adxSemTendencia: 20
      });

      // Gerar análise refinada
      analiseRefinada = botAnalise.gerarAnalise(dadosMercado, mode);
      
      // Validar operação com base no risco (assumindo saldo padrão de $1000)
      const saldoUsuario = req.user?.saldo || 1000;
      validacaoRisco = botAnalise.validarOperacao(analiseRefinada, saldoUsuario, 2);
      
      console.log(`📊 Análise refinada: sinal=${analiseRefinada.sinal.direcao}, confiança=${analiseRefinada.sinal.confianca}%`);
      
    } catch (err) {
      console.error('❌ Erro na análise refinada:', err.message);
      // Não falha a requisição principal se a análise refinada falhar
      analiseRefinada = { erro: err.message };
    }

    // ========== CONSTRUIR OBJETO DE TIMEFRAMES COM TODOS OS DETALHES ==========
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
          // ========== NOVOS CAMPOS ==========
          macd_phase: tfData.analysis.macd_phase,
          divergencia_macd: tfData.analysis.divergencia_macd,
        };
      }
    });

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
        // ========== NOVAS INFORMAÇÕES ==========
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
      // ========== ANÁLISE REFINADA ADICIONADA ==========
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
