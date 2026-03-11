// server.js
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { createClient } = require('redis');
const DerivClient = require('./deriv-client');
const { SistemaAnaliseInteligente } = require('./analyzers/sistema-analise');
const MultiTimeframeManager = require('./multi-timeframe-manager');
const BotExecutionCore = require('./bot-execution-core');
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

// 🔥 TTLs ajustados para melhor performance
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
  'CAÇADOR': {
    timeframes: ['M5', 'M15', 'H1'],
    description: 'Ondas médias de 15-60 minutos'
  },
  'PESCADOR': {
    timeframes: ['M15', 'H1', 'H4'],
    description: 'Grandes movimentos de horas a dias'
  }
};

// Configurações completas de cada timeframe
const ALL_TIMEFRAMES_CONFIG = {
  'M1': { key: 'M1', seconds: 60, candleCount: 60, minRequired: 20 },
  'M5': { key: 'M5', seconds: 300, candleCount: 72, minRequired: 30 },
  'M15': { key: 'M15', seconds: 900, candleCount: 96, minRequired: 20 },
  'M30': { key: 'M30', seconds: 1800, candleCount: 46, minRequired: 15 },
  'H1': { key: 'H1', seconds: 3600, candleCount: 48, minRequired: 10 },
  'H4': { key: 'H4', seconds: 14400, candleCount: 42, minRequired: 8 },
  'H24': { key: 'H24', seconds: 86400, candleCount: 20, minRequired: 5 }
};

// ========== FUNÇÃO AUXILIAR PARA VERIFICAR SE CANDLE ESTÁ FECHADO ==========
function isCandleClosed(candle, timeframeSeconds) {
  if (!candle || !candle.epoch) return true;
  const now = Math.floor(Date.now() / 1000);
  const candleEnd = candle.epoch + timeframeSeconds;
  return now >= candleEnd - CANDLE_CLOSE_TOLERANCE;
}

// ========== FUNÇÃO PARA OBTER CANDLES COM CACHE (COM FALLBACK) ==========
async function getCandlesWithCache(client, symbol, tf, forceFresh = false) {
  if (!redisClient || !redisClient.isReady || forceFresh) {
    console.log(`🔄 Buscando ${tf.key} direto da Deriv (sem cache)`);
    const candles = await client.getCandles(symbol, tf.candleCount + 1, tf.seconds);
    if (!Array.isArray(candles)) {
      console.error(`❌ Resposta inválida da Deriv para ${tf.key}: não é um array`);
      return candles;
    }
    const closedCandles = candles.filter(c => isCandleClosed(c, tf.seconds));
    if (closedCandles.length < tf.minRequired) {
      console.log(`⚠️ ${tf.key}: apenas ${closedCandles.length} candles fechados, mínimo ${tf.minRequired}`);
    }
    return closedCandles;
  }

  const cacheKey = `candles:${symbol}:${tf.key}`;
  
  try {
    const cached = await redisClient.get(cacheKey);
    
    if (cached) {
      const ttl = await redisClient.ttl(cacheKey);
      console.log(`✅ Cache hit: ${cacheKey} (TTL: ${ttl}s)`);
      
      if (ttl < 5) {
        setTimeout(async () => {
          try {
            const freshCandles = await client.getCandles(symbol, tf.candleCount + 1, tf.seconds);
            if (Array.isArray(freshCandles)) {
              const closedCandles = freshCandles.filter(c => isCandleClosed(c, tf.seconds));
              const ttl = TTL_BY_TIMEFRAME[tf.key] || 60;
              await redisClient.setEx(cacheKey, ttl, JSON.stringify(closedCandles));
              console.log(`🔄 Cache atualizado em background: ${cacheKey}`);
            }
          } catch (err) {
            console.error(`❌ Erro atualizando cache em background: ${err.message}`);
          }
        }, 0);
      }
      
      return JSON.parse(cached);
    }
    
    console.log(`🔄 Cache miss: ${cacheKey} - buscando da Deriv`);
    const candles = await client.getCandles(symbol, tf.candleCount + 1, tf.seconds);
    
    if (!Array.isArray(candles)) {
      console.error(`❌ Resposta inválida da Deriv para ${cacheKey}: não é um array`);
      return candles;
    }
    
    const closedCandles = candles.filter(c => isCandleClosed(c, tf.seconds));
    
    if (closedCandles.length < tf.minRequired) {
      console.log(`⚠️ ${tf.key}: apenas ${closedCandles.length} candles fechados, mínimo ${tf.minRequired}`);
    }
    
    const ttl = TTL_BY_TIMEFRAME[tf.key] || 60;
    await redisClient.setEx(cacheKey, ttl, JSON.stringify(closedCandles));
    
    return closedCandles;
  } catch (error) {
    console.error(`❌ Erro no cache para ${cacheKey}:`, error.message);
    const candles = await client.getCandles(symbol, tf.candleCount + 1, tf.seconds);
    if (!Array.isArray(candles)) return candles;
    return candles.filter(c => isCandleClosed(c, tf.seconds));
  }
}

// ========== RATE LIMITERS ==========
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

// ========== MIDDLEWARE DE AUTENTICAÇÃO ==========
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

// ========== INSTÂNCIA DO CLIENTE DERIV COM CONEXÃO PERSISTENTE ==========
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

// ========== ROTAS PÚBLICAS ==========
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

// ========== ROTA DE ADMIN PARA GERAR TOKENS ==========
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

// ========== ROTA PARA VERIFICAR STATUS DA CONEXÃO ==========
app.get('/api/connection-status', authenticateToken, (req, res) => {
  if (!derivClient) {
    return res.json({ status: 'not_initialized' });
  }
  res.json(derivClient.getConnectionStatus());
});

// ========== FUNÇÕES PARA CALCULAR TIMING DE ENTRADA COM ADX ==========
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

// ========== ROTA PRINCIPAL DE ANÁLISE ==========
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

    const mtfManager = new MultiTimeframeManager();
    
    const tipoAtivo = symbol.startsWith('R_') ? 'volatility_index' : 
                     (symbol.includes('frx') ? 'forex' : 'indice_normal');
    
    const sistemaBase = new SistemaAnaliseInteligente(symbol);
    
    if (sistemaBase.sistemaPesos && sistemaBase.sistemaPesos.setTipoAtivo) {
      sistemaBase.sistemaPesos.setTipoAtivo(tipoAtivo);
    }

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

    const firstTf = timeframesToAnalyze[0]?.key || 'M5';
    const basePrice = mtfManager.timeframes[firstTf]?.analysis?.preco_atual || 0;
    
    const suggestion = BotExecutionCore.generateEntrySuggestion(
      { sinal: consolidated.simpleMajority.signal, probabilidade: agreement.agreement / 100 },
      basePrice
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

    const responseTimeframes = {};
    TRADING_MODES[mode].timeframes.forEach(tfKey => {
      const tfData = mtfManager.timeframes[tfKey];
      if (tfData?.analysis) {
        responseTimeframes[tfKey] = {
          sinal: tfData.analysis.sinal,
          probabilidade: tfData.analysis.probabilidade,
          adx: tfData.analysis.adx,
          rsi: tfData.analysis.rsi,
          preco_atual: tfData.analysis.preco_atual
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
        ...(m1Timing && { m1_timing: m1Timing }),
        ...(m5Timing && { m5_timing: m5Timing }),
        ...(m15Timing && { m15_timing: m15Timing })
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
      metadata: {
        responseTimeMs: responseTime,
        timestamp: new Date().toISOString()
      }
    };

    console.log(`✅ Análise concluída em ${responseTime}ms para modo ${mode} - ${agreement.totalTimeframes} TFs analisados`);
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
