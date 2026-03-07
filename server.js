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
const { API_TOKEN } = require('./config');

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
app.set('trust proxy', 1); // Resolve aviso do rate limit

// ========== CONFIGURAÇÃO DO REDIS ==========
let redisClient = null;

const TTL_BY_TIMEFRAME = {
  'M1': 30,
  'M5': 60,
  'M15': 120,
  'M30': 180,
  'H1': 300,
  'H4': 600,
  'H24': 1800
};

if (process.env.REDIS_URL) {
  redisClient = createClient({ url: process.env.REDIS_URL });
  redisClient.on('error', (err) => console.error('❌ Redis error:', err));
  (async () => {
    await redisClient.connect();
    console.log('✅ Conectado ao Redis');
  })();
} else {
  console.log('⚠️ Redis não configurado - cache desativado');
}

// ========== FUNÇÃO PARA OBTER CANDLES COM CACHE ==========
async function getCandlesWithCache(client, symbol, tf) {
  if (!redisClient || !redisClient.isReady) {
    return await client.getCandles(symbol, tf.candleCount, tf.seconds);
  }

  const cacheKey = `candles:${symbol}:${tf.key}`;
  
  try {
    const cached = await redisClient.get(cacheKey);
    
    if (cached) {
      console.log(`✅ Cache hit: ${cacheKey}`);
      return JSON.parse(cached);
    }
    
    console.log(`🔄 Cache miss: ${cacheKey} - buscando da Deriv`);
    const candles = await client.getCandles(symbol, tf.candleCount, tf.seconds);
    
    if (!Array.isArray(candles)) {
      console.error(`❌ Resposta inválida da Deriv para ${cacheKey}: não é um array`);
      return candles;
    }
    
    const ttl = TTL_BY_TIMEFRAME[tf.key] || 60;
    await redisClient.setEx(cacheKey, ttl, JSON.stringify(candles));
    
    return candles;
  } catch (error) {
    console.error(`❌ Erro no cache para ${cacheKey}:`, error.message);
    return await client.getCandles(symbol, tf.candleCount, tf.seconds);
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

// ========== ROTA PARA VERIFICAR STATUS DA CONEXÃO (DEBUG) ==========
app.get('/api/connection-status', authenticateToken, (req, res) => {
  if (!derivClient) {
    return res.json({ status: 'not_initialized' });
  }
  res.json(derivClient.getConnectionStatus());
});

// ========== FUNÇÃO PARA CALCULAR TIMING DE ENTRADA M1 ==========
function calcularTimingM1(m1Analysis, primarySignal) {
  // Se não há análise M1 ou sinal principal é HOLD, retorna neutro
  if (!m1Analysis || primarySignal === 'HOLD') {
    return {
      permitido: false,
      motivo: 'M1 não disponível',
      rsi: m1Analysis?.rsi || null,
      sinal: m1Analysis?.sinal || null
    };
  }

  // Regras de timing baseadas no sinal principal
  if (primarySignal === 'CALL') {
    // Para CALL, M1 deve estar em CALL e RSI < 65 (não sobrecomprado)
    if (m1Analysis.sinal === 'CALL' && m1Analysis.rsi < 65) {
      return {
        permitido: true,
        motivo: 'M1 confirmando CALL',
        rsi: m1Analysis.rsi,
        sinal: m1Analysis.sinal
      };
    }
    // Se M1 está PUT mas RSI oversold, pode ser oportunidade de reversão
    else if (m1Analysis.sinal === 'PUT' && m1Analysis.rsi < 30) {
      return {
        permitido: true,
        motivo: 'M1 oversold - possível reversão',
        rsi: m1Analysis.rsi,
        sinal: m1Analysis.sinal
      };
    }
    else {
      return {
        permitido: false,
        motivo: `M1 não confirma (${m1Analysis.sinal}, RSI ${m1Analysis.rsi?.toFixed(0)})`,
        rsi: m1Analysis.rsi,
        sinal: m1Analysis.sinal
      };
    }
  }
  else if (primarySignal === 'PUT') {
    // Para PUT, M1 deve estar em PUT e RSI > 35 (não sobrevendido)
    if (m1Analysis.sinal === 'PUT' && m1Analysis.rsi > 35) {
      return {
        permitido: true,
        motivo: 'M1 confirmando PUT',
        rsi: m1Analysis.rsi,
        sinal: m1Analysis.sinal
      };
    }
    // Se M1 está CALL mas RSI overbought, pode ser oportunidade de reversão
    else if (m1Analysis.sinal === 'CALL' && m1Analysis.rsi > 70) {
      return {
        permitido: true,
        motivo: 'M1 overbought - possível reversão',
        rsi: m1Analysis.rsi,
        sinal: m1Analysis.sinal
      };
    }
    else {
      return {
        permitido: false,
        motivo: `M1 não confirma (${m1Analysis.sinal}, RSI ${m1Analysis.rsi?.toFixed(0)})`,
        rsi: m1Analysis.rsi,
        sinal: m1Analysis.sinal
      };
    }
  }

  // Fallback para qualquer outro caso
  return {
    permitido: false,
    motivo: 'Sinal principal neutro',
    rsi: m1Analysis.rsi,
    sinal: m1Analysis.sinal
  };
}

// ========== ROTA PRINCIPAL DE ANÁLISE ==========
app.post('/api/analyze', authenticateToken, analyzeLimiter, async (req, res) => {
  try {
    const { symbol } = req.body;
    if (!symbol) {
      return res.status(400).json({ error: 'Símbolo é obrigatório' });
    }

    const client = await getDerivClient();

    const timeframesToAnalyze = [
      { key: 'M1', seconds: 60, candleCount: 60, minRequired: 20 },
      { key: 'M5', seconds: 300, candleCount: 72, minRequired: 30 },
      { key: 'M15', seconds: 900, candleCount: 96, minRequired: 20 },
      { key: 'M30', seconds: 1800, candleCount: 46, minRequired: 15 },
      { key: 'H1', seconds: 3600, candleCount: 48, minRequired: 10 },
      { key: 'H4', seconds: 14400, candleCount: 42, minRequired: 8 },
      { key: 'H24', seconds: 86400, candleCount: 20, minRequired: 5 }
    ];

    const mtfManager = new MultiTimeframeManager();
    const sistemaBase = new SistemaAnaliseInteligente(symbol);

    const promises = timeframesToAnalyze.map(async (tf) => {
      try {
        const candles = await getCandlesWithCache(client, symbol, tf);
        
        if (!Array.isArray(candles)) {
          console.error(`❌ Resposta inválida para ${tf.key}: não é um array`, typeof candles);
          return null;
        }
        
        return { key: tf.key, candles };
      } catch (err) {
        console.error(`Erro ao buscar ${tf.key}:`, err.message);
        return null;
      }
    });

    const results = await Promise.all(promises);

    for (const result of results) {
      if (!result) continue;
      
      const { key, candles } = result;
      const tfConfig = timeframesToAnalyze.find(t => t.key === key);
      
      if (!candles || candles.length < tfConfig.minRequired) {
        console.log(`⚠️ ${key}: apenas ${candles?.length || 0} candles, mínimo ${tfConfig.minRequired}`);
        continue;
      }

      try {
        const analysis = await sistemaBase.analisar(candles, key);
        if (analysis && !analysis.erro) {
          mtfManager.addAnalysis(key, analysis);
        }
      } catch (analysisError) {
        console.error(`❌ Erro na análise do timeframe ${key}:`, analysisError.message);
      }
    }

    const consolidated = mtfManager.consolidateSignals();
    const agreement = mtfManager.calculateAgreement();

    const m5Price = mtfManager.timeframes['M5']?.analysis?.preco_atual || 0;
    const suggestion = BotExecutionCore.generateEntrySuggestion(
      { sinal: consolidated.simpleMajority.signal, probabilidade: agreement.agreement / 100 },
      m5Price
    );

    // ========== CALCULAR TIMING DE ENTRADA M1 ==========
    const m1Analysis = mtfManager.timeframes['M1']?.analysis;
    const primarySignal = consolidated.simpleMajority.signal;
    const m1Timing = calcularTimingM1(m1Analysis, primarySignal);

    // Montar resposta com timing M1
    const response = {
      success: true,
      consolidated: {
        signal: consolidated.signal,
        confidence: consolidated.confidence,
        agreement: agreement.agreement,
        simpleMajority: consolidated.simpleMajority,
        timeframesAnalyzed: agreement.totalTimeframes,
        sinal_premium: consolidated.sinal_premium || null,
        m1_timing: m1Timing // 👈 NOVO: timing de entrada M1
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
      timeframes: Object.fromEntries(
        Object.entries(mtfManager.timeframes).map(([key, tf]) => [
          key,
          tf.analysis ? {
            sinal: tf.analysis.sinal,
            probabilidade: tf.analysis.probabilidade,
            adx: tf.analysis.adx,
            rsi: tf.analysis.rsi,
            preco_atual: tf.analysis.preco_atual
          } : null
        ])
      )
    };

    res.json(response);

  } catch (error) {
    console.error('Erro na análise:', error);
    res.status(500).json({ error: error.message });
  }
});

// ========== TRATAMENTO DE ROTAS NÃO ENCONTRADAS ==========
app.use((req, res) => {
  res.status(404).json({ error: 'Rota não encontrada' });
});

// ========== INICIALIZAÇÃO DO SERVIDOR ==========
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  
  // Inicia a conexão com a Deriv assim que o servidor subir
  try {
    console.log('🔄 Iniciando conexão persistente com a Deriv...');
    await getDerivClient();
    console.log('✅ Conexão persistente estabelecida e mantida');
  } catch (err) {
    console.error('❌ Falha ao estabelecer conexão persistente:', err);
  }
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('🛑 Recebido SIGTERM, encerrando conexões...');
  if (derivClient) {
    derivClient.disconnect();
  }
  if (redisClient) {
    redisClient.quit();
  }
  process.exit(0);
});
