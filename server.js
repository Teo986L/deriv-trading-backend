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
app.set('trust proxy', 1);

// ========== CONFIGURAÇÃO DO REDIS (OPCIONAL) ==========
let redisClient = null;

// 🔥 TTLs ajustados para melhor performance
const TTL_BY_TIMEFRAME = {
  'M1': 10,      // Reduzido para 10s (dados muito voláteis)
  'M5': 20,      // Reduzido para 20s
  'M15': 30,     // Reduzido para 30s
  'M30': 45,     // Reduzido para 45s
  'H1': 60,      // Reduzido para 60s
  'H4': 120,     // Reduzido para 120s
  'H24': 300     // Reduzido para 300s (5 minutos)
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

// ========== FUNÇÃO PARA OBTER CANDLES COM CACHE (COM FALLBACK) ==========
async function getCandlesWithCache(client, symbol, tf, forceFresh = false) {
  // Se Redis não está disponível ou força dados frescos, busca direto
  if (!redisClient || !redisClient.isReady || forceFresh) {
    console.log(`🔄 Buscando ${tf.key} direto da Deriv (sem cache)`);
    return await client.getCandles(symbol, tf.candleCount, tf.seconds);
  }

  const cacheKey = `candles:${symbol}:${tf.key}`;
  
  try {
    // Verificar se há dados em cache
    const cached = await redisClient.get(cacheKey);
    
    if (cached) {
      // Verificar TTL restante
      const ttl = await redisClient.ttl(cacheKey);
      console.log(`✅ Cache hit: ${cacheKey} (TTL: ${ttl}s)`);
      
      // Se TTL for muito baixo, busca novos dados em background (não bloqueante)
      if (ttl < 5) {
        setTimeout(async () => {
          try {
            const freshCandles = await client.getCandles(symbol, tf.candleCount, tf.seconds);
            if (Array.isArray(freshCandles)) {
              const ttl = TTL_BY_TIMEFRAME[tf.key] || 60;
              await redisClient.setEx(cacheKey, ttl, JSON.stringify(freshCandles));
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
    const candles = await client.getCandles(symbol, tf.candleCount, tf.seconds);
    
    if (!Array.isArray(candles)) {
      console.error(`❌ Resposta inválida da Deriv para ${cacheKey}: não é um array`);
      return candles;
    }
    
    // Salvar no cache
    const ttl = TTL_BY_TIMEFRAME[tf.key] || 60;
    await redisClient.setEx(cacheKey, ttl, JSON.stringify(candles));
    
    return candles;
  } catch (error) {
    console.error(`❌ Erro no cache para ${cacheKey}:`, error.message);
    // Fallback: busca direto da Deriv
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

// ========== FUNÇÃO PARA CALCULAR TIMING DE ENTRADA M1 (SNIPER) ==========
function calcularTimingM1(m1Analysis, primarySignal) {
  if (!m1Analysis || primarySignal === 'HOLD') {
    return {
      permitido: false,
      motivo: 'M1 não disponível',
      rsi: m1Analysis?.rsi || null,
      sinal: m1Analysis?.sinal || null
    };
  }

  if (primarySignal === 'CALL') {
    if (m1Analysis.sinal === 'CALL' && m1Analysis.rsi < 65) {
      return {
        permitido: true,
        motivo: 'M1 confirmando CALL',
        rsi: m1Analysis.rsi,
        sinal: m1Analysis.sinal
      };
    }
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
    if (m1Analysis.sinal === 'PUT' && m1Analysis.rsi > 35) {
      return {
        permitido: true,
        motivo: 'M1 confirmando PUT',
        rsi: m1Analysis.rsi,
        sinal: m1Analysis.sinal
      };
    }
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

  return {
    permitido: false,
    motivo: 'Sinal principal neutro',
    rsi: m1Analysis.rsi,
    sinal: m1Analysis.sinal
  };
}

// ========== NOVA FUNÇÃO: TIMING DO CAÇADOR (baseado no M5) ==========
function calcularTimingCacador(m5Analysis, h1Analysis) {
  if (!m5Analysis || !h1Analysis) {
    return {
      permitido: false,
      motivo: 'Dados insuficientes',
      rsi: m5Analysis?.rsi || null,
      adx: m5Analysis?.adx || null
    };
  }

  // Regra 1: Mesma direção do H1
  if (m5Analysis.sinal !== h1Analysis.sinal) {
    return { 
      permitido: false, 
      motivo: `M5 (${m5Analysis.sinal}) contra H1 (${h1Analysis.sinal})`,
      rsi: m5Analysis.rsi,
      adx: m5Analysis.adx
    };
  }

  // Regra 2: RSI em zona segura
  if (m5Analysis.sinal === 'CALL' && m5Analysis.rsi > 65) {
    return { 
      permitido: false, 
      motivo: `RSI alto (${m5Analysis.rsi.toFixed(0)}) - sobrecomprado`,
      rsi: m5Analysis.rsi,
      adx: m5Analysis.adx
    };
  }

  if (m5Analysis.sinal === 'PUT' && m5Analysis.rsi < 35) {
    return { 
      permitido: false, 
      motivo: `RSI baixo (${m5Analysis.rsi.toFixed(0)}) - sobrevendido`,
      rsi: m5Analysis.rsi,
      adx: m5Analysis.adx
    };
  }

  // Regra 3: ADX mínimo
  if (m5Analysis.adx < 15) {
    return { 
      permitido: false, 
      motivo: `ADX baixo (${m5Analysis.adx.toFixed(1)}) - sem força`,
      rsi: m5Analysis.rsi,
      adx: m5Analysis.adx
    };
  }

  // Tudo ok!
  return {
    permitido: true,
    motivo: 'M5 confirmando H1',
    rsi: m5Analysis.rsi,
    adx: m5Analysis.adx
  };
}

// ========== NOVA FUNÇÃO: TIMING DO PESCADOR (baseado no M15) ==========
function calcularTimingPescador(m15Analysis, h4Analysis) {
  if (!m15Analysis || !h4Analysis) {
    return {
      permitido: false,
      motivo: 'Dados insuficientes',
      rsi: m15Analysis?.rsi || null,
      adx: m15Analysis?.adx || null
    };
  }

  // Regra 1: Mesma direção do H4
  if (m15Analysis.sinal !== h4Analysis.sinal) {
    return { 
      permitido: false, 
      motivo: `M15 (${m15Analysis.sinal}) contra H4 (${h4Analysis.sinal})`,
      rsi: m15Analysis.rsi,
      adx: m15Analysis.adx
    };
  }

  // Regra 2: RSI em zona segura
  if (m15Analysis.sinal === 'CALL' && m15Analysis.rsi > 70) {
    return { 
      permitido: false, 
      motivo: `RSI alto (${m15Analysis.rsi.toFixed(0)}) - sobrecomprado`,
      rsi: m15Analysis.rsi,
      adx: m15Analysis.adx
    };
  }

  if (m15Analysis.sinal === 'PUT' && m15Analysis.rsi < 30) {
    return { 
      permitido: false, 
      motivo: `RSI baixo (${m15Analysis.rsi.toFixed(0)}) - sobrevendido`,
      rsi: m15Analysis.rsi,
      adx: m15Analysis.adx
    };
  }

  // Regra 3: ADX mínimo
  if (m15Analysis.adx < 14) {
    return { 
      permitido: false, 
      motivo: `ADX baixo (${m15Analysis.adx.toFixed(1)}) - sem força`,
      rsi: m15Analysis.rsi,
      adx: m15Analysis.adx
    };
  }

  // Tudo ok!
  return {
    permitido: true,
    motivo: 'M15 confirmando H4',
    rsi: m15Analysis.rsi,
    adx: m15Analysis.adx
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

    // Filtra apenas os timeframes do modo selecionado
    const timeframesToAnalyze = TRADING_MODES[mode].timeframes
      .map(tfKey => ALL_TIMEFRAMES_CONFIG[tfKey]);

    const mtfManager = new MultiTimeframeManager();
    
    // 🔥 Detectar tipo de ativo para passar ao sistema de análise
    const tipoAtivo = symbol.startsWith('R_') ? 'volatility_index' : 
                     (symbol.includes('frx') ? 'forex' : 'indice_normal');
    
    const sistemaBase = new SistemaAnaliseInteligente(symbol);
    
    // 🔥 Passar tipo de ativo para o sistema de pesos
    if (sistemaBase.sistemaPesos && sistemaBase.sistemaPesos.setTipoAtivo) {
      sistemaBase.sistemaPesos.setTipoAtivo(tipoAtivo);
    }

    // Processa timeframes sequencialmente
    for (frames sequencialmente
    for (const tf of timeframesToconst tf of timeframesToAnalyze) {
      try {
        console.logAnalyze) {
      try {
        console.log(`🔍 Analisando ${tf(`🔍 Analisando ${tf.key}...`);
        
        // 🔥 Forçar dados frescos para time.key}...`);
        
        // 🔥 Forçar dados frescos para timeframes curtos a cada 2 análframes curtos a cada 2 análises
        const forceFresh = (tf.key === 'ises
        const forceFresh = (tf.key === 'M1M1' || tf.key === 'M5') && (Math.random() > ' || tf.key === 'M5') && (Math.random() > 0.5);
        
        const candles = await getCandlesWith0.5);
        
        const candles = await getCandlesWithCache(client, symbol, tf, forceFresh);
        
Cache(client, symbol, tf, forceFresh);
        
        if (!Array.isArray(cand        if (!Array.isArray(candles)) {
          console.error(`❌ Resles)) {
          console.error(`❌ Resposta inválida para ${tf.key}: nãoposta inválida para ${tf.key}: não é um é um array`);
          continue;
        array`);
          continue;
        }
        
        if (candles.length < tf.min }
        
        if (candles.length < tf.minRequired) {
          console.logRequired) {
          console.log(`⚠(`⚠️ ${tf.key}: apenas ${candles.length} candles, mínimo ${tf.minRequired}`);
️ ${tf.key}: apenas ${candles.length} candles, mínimo ${tf.minRequired}`);
          continue          continue;
        }

        const analysis = await sistemaBase.anal;
        }

        const analysis = await sistemaBaseisar(c.analisar(candles, tf.key);
        
        if (analysis &&andles, tf.key);
        
        if (analysis && !analysis.erro) {
          mtfManager.add !analysis.erro) {
          mtfManager.addAnalysis(tAnalysis(tf.key, analysis);
          console.log(`✅ ${tff.key, analysis);
          console.log(`✅ ${tf.key} analisado com sucesso.key} analisado com sucesso`);
        }
      } catch (err`);
        }
      } catch (err) {
        console.error(`❌ Erro) {
        console.error(`❌ Erro ao buscar/analisar ${tf.key}:`, err.message);
      }
    }

    ao buscar/analisar ${tf.key}:`, err.message);
      }
    const consolidated = mtfManager }

    const consolidated = mtfManager.consolidateSignals();
    const agreement = mt.consolidateSignals();
    const agreement = mtfManager.calculateAgreement();

    // Preço base para sugestão
    const firstfManager.calculateAgreement();

    // Preço base para sugestão
    const firstTf = timeframesToAnalyze[0]?.Tf = timeframesToAnalyze[0]?.key || 'M5';
    const basePrice = mtfManager.timeframes[firstTf]?.analysis?.preco_atual || 0;
    
    const suggestion = BotExecutionCore.generateEntrySuggestion(
      { sinal: consolidated.simpleMajority.signal, probabilidadekey || 'M5';
    const basePrice = mtfManager.timeframes[firstTf]?.analysis?.preco_atual || 0;
    
    const suggestion = BotExecutionCore.generateEntrySuggestion(
      { sinal: consolidated.simpleMajority.signal, probabilidade: agreement.agreement / 100 },
      basePrice: agreement.agreement / 100 },
      basePrice
    );

    // ========== CALCULAR TIMINGS ESPECÍFICOS PARA
    );

    // ========== CALCULAR TIMINGS ESPECÍFICOS PARA CADA MODO ==========
    let m1Timing = null;
    let m5Timing CADA MODO ==========
    let m1Tim = null;
    let m15Timing =ing = null;
    let m5Timing = null;
    let m15Timing = null null;

    // Timing do SNIPER (M1)
    if (TRADING_MOD;

    // Timing do SNIPER (M1)
    if (TRADES[mode].timeframes.includes('M1')) {
ING_MODES[mode].timeframes.includes('M1')) {
      const m1Analysis =      const m1Analysis = mtfManager.timeframes['M1'] mtfManager.timeframes['M1']?.analysis;
      const primarySignal = consolidated.simpleMajority?.analysis;
      const primarySignal = consolidated.simpleMajority.signal;
      m1Timing = calcular.signal;
      m1Timing = calcularTimingM1(m1TimingM1(m1Analysis, primarySignal);
    }

    // Timing do CAÇADOR (Analysis, primarySignal);
    }

    // Timing do CAÇADOR (M5)
   M5)
    if (mode === 'CAÇAD if (mode === 'CAÇADOR') {
      const mOR') {
      const m5Analysis = mtfManager.timeframes['M5']?.analysis5Analysis = mtfManager.timeframes['M5']?.analysis;
      const h;
      const h1Analysis = mtfManager1Analysis = mtfManager.timeframes['H.timeframes['H1']?.analysis;
      m5Timing = calcular1']?.analysis;
      m5Timing = calcularTimingCacador(mTimingCacador(m5Analysis, h1Analysis5Analysis, h1Analysis);
   );
    }

    }

    // Timing do PESCADOR ( // Timing do PESCADOR (M15)
    if (mode === 'PESCADOR') {
      const mM15)
    if (mode === 'PESCADOR') {
      const m15Analysis = mt15Analysis = mtfManager.timeframes['M15']?.analysisfManager.timeframes['M15']?.analysis;
      const h4Analysis = mtfManager.timeframes['H;
      const h4Analysis = mtfManager.timeframes['H4']4']?.analysis;
      m15Timing = calcularTimingPescador(m15Analysis?.analysis;
      m15Timing = calcularTimingPescador(m15Analysis, h4Analysis);
   , h4Analysis);
    }

    // Montar resposta apenas com os time }

    // Montar resposta apenas com os timeframes do modo selecionado
    const responseTimeframes = {};
    TRframes do modo selecionado
    const responseTimeframes = {};
    TRADING_MODESADING_MODES[mode].timeframes.forEach(tfKey =>[mode].timeframes.forEach(tfKey => {
      const tfData = mtfManager.timeframes[tfKey {
      const tfData = mtfManager.timeframes[tfKey];
      if (tfData?.analysis];
      if (tfData?.analysis) {
        const timeframeObj = {
          s) {
        const timeframeObj = {
          sinal: tfData.analysisinal: tfData.analysis.sinal,
          probabilidade: tfData.analysis.probabilidade,
          adx: tfData.analysis.adx,
          rsi: tfData.analysis.rsi,
          preco_atual: tfData.analysis.preco_atual
        };
        
        // 🔥 Ad.sinal,
          probabilidade: tfData.analysis.probabilidade,
          adx: tfData.analysis.adx,
          rsi: tfData.analysis.rsi,
          preco_atual: tfData.analysis.preco_atual
        };
        
        // 🔥 Adicionar timing APENAS para o timeframe relevante de cada modo
        if (mode === 'SNIPER' && tfKeyicionar timing APENAS para o timeframe relevante de cada modo
        if (mode === 'SNIPER' && tfKey === 'M1') {
          timeframeObj.timing = m1Timing;
        === 'M1') {
          timeframeObj.timing = m1Timing;
        } else if ( } else if (mode === 'CAÇADOR' && tfKey ===mode === 'CAÇADOR' && tfKey === 'M5') {
          timeframeObj.timing 'M5') {
          timeframeObj.timing = m5Timing;
        } = m5Timing;
        } else if (mode === 'PES else if (mode === 'PESCADOR' && tfKeyCADOR' && tfKey === 'M15') {
          timeframeObj.timing = === 'M15') {
          timeframeObj.timing = m15Timing;
        m15Timing;
        }
        
        responseTimeframes[tfKey] }
        
        responseTimeframes[tfKey] = timeframeObj;
      }
    });

    const responseTime = timeframeObj;
      }
    });

    const responseTime = Date.now() - start = Date.now() - startTime;
    
    const response = {
      success: trueTime;
    
    const response = {
      success: true,
      mode: mode,
      modeDescription: TRAD,
      mode: mode,
      modeDescription: TRADING_MODES[mode].ING_MODES[mode].description,
      consolidated: {
        signaldescription,
      consolidated: {
        signal: consolidated.signal,
        confidence: consolidated.confidence,
: consolidated.signal,
        confidence: consolidated.confidence,
        agreement: agreement.ag        agreement: agreement.agreement,
reement,
        simpleMajority: consolidated.simpleMajority,
        timeframes        simpleMajority: consolidated.simpleMajority,
        timeframesAnalyzed: agreement.totalTimeAnalyzed: agreement.totalTimeframes,
        sinal_premium: consolidated.sframes,
        sinal_premium: consolidated.sinal_premium || null
      },
      agreementinal_premium || null
      },
      agreement: {
        agreement: agreement: {
        agreement: agreement.agreement,
        primarySignal:.agreement,
        primarySignal: agreement.primarySignal,
        callCount agreement.primarySignal,
        callCount: agreement.callCount,
        putCount: agreement.callCount,
        putCount: agreement.putCount,
        totalTime: agreement.putCount,
        totalTimeframes: agreement.totalTimeframes
     frames: agreement.totalTimeframes
      },
      suggestion: {
        action: suggestion.action,
        },
      suggestion: {
        action: suggestion.action,
        reason: suggestion.reason,
        entry: suggestion reason: suggestion.reason,
        entry: suggestion.entry,
        stopLoss: suggestion.stopLoss.entry,
        stopLoss: suggestion.stopLoss,
        takeProfit: suggestion.take,
        takeProfit: suggestion.takeProfit
      },
      timeframes:Profit
      },
      timeframes: responseTimeframes,
      // responseTimeframes,
      // 🔥 NOVO: Timings específicos por 🔥 NOVO: Timings específicos por modo no objeto global também
      timing: {
        modo no objeto global também
      timing: {
        m1: m m1: m1Timing,
        m5: m5Timing1Timing,
        m5: m5Timing,
        m15: m15Timing
      },
,
        m15: m15Timing
      },
      metadata: {
      metadata: {
        responseTimeMs: responseTime,
        timestamp: new Date().toISOString()
      }
    };

        responseTimeMs: responseTime,
        timestamp: new Date().toISOString()
      }
    };

    console.log(`✅ Análise concluída em ${response    console.log(`✅ Análise concluída em ${responseTime}Time}ms para modo ${mode} - ${agreement.totalTimems para modo ${mode} - ${agreement.totalTimeframes} TFs analisados`);
    resframes} TFs analisados`);
    res.json(response);

  } catch (error.json(response);

  } catch (error) {
    console) {
    console.error('❌ Erro na análise:', error.error('❌ Erro na análise:', error);
    res.status(500).json({ 
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// =);
    res.status(500).json({ 
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// ========== TRATAMENTO DE ROTAS NÃO ENCONTRADAS ==========
app.use((req, res) =>========= TRATAMENTO DE ROTAS NÃO ENCONTRADAS ==========
app.use((req, res) => {
  res.status(404).json {
  res.status(404).json({ error: 'Rota não encontrada' });
});

// ========== MIDDLE({ error: 'Rota não encontrada' });
});

// =WARE DE ERRO GLOBAL ================== MIDDLEWARE DE ERRO GLOBAL ==========
app.use((err, req, res, next)=
app.use((err, req, res, next) => {
  console.error('❌ Erro global:', => {
  console.error('❌ Erro err);
  res.status(500).json({ 
    error: global:', err);
  res.status(500).json({ 
    error: 'Erro interno do servidor',
    message 'Erro interno do servidor',
    message: process: process.env.NODE_ENV === 'development' ?.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// ========== INICIALIZAÇÃO DO SERVIDOR ==========
const PORT = process.env.PORT err.message : undefined
  });
});

// ========== INICIALIZAÇÃO DO SERVIDOR ==========
const PORT = process.env.PORT || 3000;

const server = || 3000;

const server = app.listen(PORT app.listen(PORT, async () => {
  console.log, async () => {
 (`\n🚀 Servidor rod console.log(`\n🚀 Servidor rodando na porta ${PORT}`);
  console.log(`ando na porta ${PORT}`);
  console🎯 Modos.log(`🎯 Modos de trading disponíveis: ${Object.keys(TRADING_MODES de trading disponíveis: ${Object.keys(TRADING_MODES).join).join(', ')}`);
  console.log(`(', ')}`);
  console.log(`⚙️ Modo: ${process.env.NODE_EN⚙️ Modo: ${process.env.NODE_ENV || 'development'}`);
  
  // Inicia a conexão com a Deriv
V || 'development'}`);
  
  // Inicia a conexão com a Deriv
  try {
    console.log('🔄 In  try {
    console.log('🔄 Iniciando conexão persistente com aiciando conexão persistente com a Deriv...');
    await getDeriv Deriv...');
    await getDerivClient();
    console.log('✅ ConexãoClient();
    console.log('✅ Conexão persistente estabelecida e mantida');
 persistente estabelecida e mantida');
  } catch (err) {
     } catch (err) {
    console.error('❌ Falha ao console.error('❌ Falha ao estabelecer conexão persistente:', err);
  estabelecer conexão persistente:', err);
  }
});

// Graceful shutdown
process.on('SIG }
});

// Graceful shutdown
process.on('SIGTERM', () => {
  consoleTERM', () => {
  console.log('\.log('\n🛑 Recebido SIGTERMn🛑 Recebido SIGTERM, encerrando conexões...');
  
  server.close, encerrando conexões...');
  
  server.close(() => {
    console.log(() => {
    console.log('✅ Servidor HTTP encerrado');
    
    if('✅ Servidor HTTP encerrado');
    
 (derivClient) {
      deriv    if (derivClient) {
      derivClient.disconnect();
      console.log('✅ Cliente DerivClient.disconnect();
      console.log('✅ Cliente Deriv desconectado');
    }
    
    if (redisClient desconectado');
    }
    
    if (redisClient) {
      redisClient.) {
      redisClient.quit();
      console.log('✅ Clquit();
      console.log('✅ Cliente Redis desconectadoiente Redis desconectado');
    }
    
    process.exit(');
    }
    
    process.exit(0);
  });
});

process.on('SIGINT', () =>0);
  });
});

process.on('SIGINT', () => {
  console.log('\n {
  console.log('\n🛑 Recebido SIGINT, encerrando...');
🛑 Recebido SIGINT, encerrando  process.emit('SIGTERM');
});

module.exports = app;
