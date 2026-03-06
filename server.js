// server.js
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { randomUUID } = require('crypto');
const DerivClient = require('./deriv-client');
const { SistemaAnaliseInteligente } = require('./analyzers/sistema-analise');
const MultiTimeframeManager = require('./multi-timeframe-manager');
const BotExecutionCore = require('./bot-execution-core');
const { API_TOKEN } = require('./config');

const app = express();

// ========== CONFIGURAÇÕES DE SEGURANÇA ==========
// Carrega segredos do ambiente
const SECRETS = {
  '7': process.env.SECRET_KEY_7_DAYS,
  '30': process.env.SECRET_KEY_30_DAYS,
  '90': process.env.SECRET_KEY_90_DAYS,
  '180': process.env.SECRET_KEY_180_DAYS,
  '365': process.env.SECRET_KEY_365_DAYS
};
const ADMIN_SECRET = process.env.ADMIN_SECRET;

// Lista de origens permitidas (CORS)
const allowedOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',')
  : ['http://localhost:3000']; // fallback para desenvolvimento

// Middleware CORS customizado
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

// Rate limiters
const analyzeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 100, // limite por IP
  message: { error: 'Muitas requisições, tente novamente mais tarde.' }
});

const adminLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hora
  max: 10, // apenas 10 tentativas de geração por hora
  message: { error: 'Limite de geração de tokens excedido.' }
});

// ========== MIDDLEWARE DE AUTENTICAÇÃO ==========
function authenticateToken(req, res, next) {
  // Extrai token do header Authorization ou do corpo da requisição
  const authHeader = req.headers['authorization'];
  let token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN
  if (!token && req.body && req.body.token) {
    token = req.body.token; // fallback para envio no corpo
  }
  if (!token) {
    return res.status(401).json({ error: 'Token não fornecido' });
  }

  // Tenta validar com todas as chaves disponíveis
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
      req.user = decoded; // anexa dados do token
      req.tokenPeriod = period; // opcional
      return next();
    } catch (err) {
      // continua tentando outras chaves
    }
  }

  // Nenhuma chave funcionou
  return res.status(403).json({ error: 'Token inválido ou expirado' });
}

// ========== INSTÂNCIA DO CLIENTE DERIV ==========
let derivClient = null;

async function getDerivClient() {
  if (!derivClient || !derivClient.connected) {
    derivClient = new DerivClient(API_TOKEN);
    await derivClient.connect();
  }
  return derivClient;
}

// ========== ROTAS PÚBLICAS ==========
// Health check (pública)
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// Validação de token (pública)
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
    } catch (err) {
      // continua
    }
  }

  return res.status(401).json({ valid: false, message: 'Token inválido ou expirado' });
});

// ========== ROTAS PROTEGIDAS POR ADMIN ==========
// Geração de token (somente admin)
app.post('/api/admin/generate-token', adminLimiter, (req, res) => {
  const { adminKey, periodDays, userId } = req.body;

  // Valida chave de administrador
  if (!adminKey || adminKey !== ADMIN_SECRET) {
    return res.status(403).json({ error: 'Chave de administrador inválida' });
  }

  // Valida período
  const period = parseInt(periodDays);
  if (![7, 30, 90, 180, 365].includes(period)) {
    return res.status(400).json({ error: 'Período inválido. Use 7, 30, 90, 180 ou 365.' });
  }

  const secret = SECRETS[period.toString()];
  if (!secret) {
    return res.status(500).json({ error: 'Chave para o período não configurada no servidor' });
  }

  // Gera identificadores únicos
  const finalUserId = userId || randomUUID(); // se não enviar, cria um UUID
  const jti = randomUUID(); // identificador único do token (pode ser usado para revogação futura)

  const payload = {
    userId: finalUserId,
    period,
    jti
  };

  const expiresInSeconds = period * 24 * 60 * 60; // período em segundos
  const token = jwt.sign(payload, secret, { expiresIn: expiresInSeconds });

  res.json({
    success: true,
    token,
    periodDays: period,
    expiresIn: expiresInSeconds,
    userId: finalUserId // opcional: retorna o ID gerado
  });
});

// ========== ROTAS SENSÍVEIS (ANÁLISE) ==========
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
        const candles = await client.getCandles(symbol, tf.candleCount, tf.seconds);
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

      const analysis = await sistemaBase.analisar(candles, key);
      if (analysis && !analysis.erro) {
        mtfManager.addAnalysis(key, analysis);
      }
    }

    const consolidated = mtfManager.consolidateSignals();
    const agreement = mtfManager.calculateAgreement();

    const m5Price = mtfManager.timeframes['M5']?.analysis?.preco_atual || 0;
    const suggestion = BotExecutionCore.generateEntrySuggestion(
      { sinal: consolidated.simpleMajority.signal, probabilidade: agreement.agreement / 100 },
      m5Price
    );

    const response = {
      success: true,
      consolidated: {
        signal: consolidated.signal,
        confidence: consolidated.confidence,
        agreement: agreement.agreement,
        simpleMajority: consolidated.simpleMajority,
        timeframesAnalyzed: agreement.totalTimeframes,
        sinal_premium: consolidated.sinal_premium || null
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
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});
