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
const { detectLiquiditySweepRobusto, calculateATR: calcularATRLiquidity } = require('./analyzers/liquidity-hunter-robusto');

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
'M1': 10, 'M5': 20, 'M15': 30, 'M30': 45, 'H1': 60, 'H4': 120, 'H24': 300
};

const TTL_BY_MODE = {
'SNIPER': 60, 'CAÇADOR': 300, 'PESCADOR': 900
};

function getTTLByMode(mode, timeframeKey) {
const tf = ALL_TIMEFRAMES_CONFIG_STATIC[timeframeKey];
if (tf) return getTTLAlignedToCandle(tf.seconds);
return TTL_BY_MODE[mode] || 300;
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
console.log('⚠️ Redis não configurado - cache desativado');
}

const TRADING_MODES = {
'SNIPER':   { timeframes: ['M1', 'M5', 'M15'],         description: 'Entradas cirúrgicas de 1-15 minutos' },
'CAÇADOR':  { timeframes: ['M5', 'M15', 'H1'],          description: 'Ondas médias de 15-60 minutos' },
'PESCADOR': { timeframes: ['M15', 'H1', 'H4', 'H24'],   description: 'Grandes movimentos de horas a dias' }
};

function getATRTimeframeByMode(mode) {
const map = { 'SNIPER': 'M1', 'CACADOR': 'M5', 'PESCADOR': 'M15' };
return map[mode] || 'M5';
}

// ── candleCount calibrado por velocidade + precisão ──────────────────────────
// SNIPER usa menos candles (mais rápido); PESCADOR usa mais (TFs maiores)
const ALL_TIMEFRAMES_CONFIG = {
'M1':  { key: 'M1',  seconds: 60,    candleCount: 100, minRequired: 50 },
'M5':  { key: 'M5',  seconds: 300,   candleCount: 120, minRequired: 50 },
'M15': { key: 'M15', seconds: 900,   candleCount: 120, minRequired: 50 },
'M30': { key: 'M30', seconds: 1800,  candleCount: 100, minRequired: 50 },
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

async function getCandlesWithCache(client, symbol, tf, mode, forceFresh = false) {
const cacheKey = `candles:${symbol}:${tf.key}`;
const ttl = getTTLAlignedToCandle(tf.seconds);

if (redisClient && redisClient.isReady && !forceFresh) {
try {
const cached = await redisClient.get(cacheKey);
if (cached) {
const remainingTTL = await redisClient.ttl(cacheKey);
console.log(`✅ Cache hit: ${cacheKey} (TTL: ${remainingTTL}s)`);

if (remainingTTL <= CANDLE_CLOSE_MARGIN) {
setImmediate(async () => {
try {
const freshCandles = await client.getCandles(symbol, tf.candleCount, tf.seconds);
if (Array.isArray(freshCandles)) {
const newTtl = getTTLAlignedToCandle(tf.seconds);
await redisClient.setEx(cacheKey, newTtl, JSON.stringify(freshCandles));
}
} catch (err) { console.error(`❌ Erro pré-cache: ${err.message}`); }
});
}
return JSON.parse(cached);
}
} catch (err) { console.error(`❌ Erro Redis ${cacheKey}:`, err.message); }
}

if (inFlightRequests.has(cacheKey)) return inFlightRequests.get(cacheKey);

const fetchPromise = (async () => {
try {
console.log(`🔄 Buscando ${tf.key} (${tf.candleCount} candles)`);
const candles = await client.getCandles(symbol, tf.candleCount, tf.seconds);
if (!Array.isArray(candles)) return candles;
console.log(`📊 ${tf.key}: ${candles.length} candles`);
if (redisClient && redisClient.isReady) {
redisClient.setEx(cacheKey, ttl, JSON.stringify(candles))
.catch(err => console.error(`❌ Erro salvando cache: ${err.message}`));
}
return candles;
} finally { inFlightRequests.delete(cacheKey); }
})();

inFlightRequests.set(cacheKey, fetchPromise);
return fetchPromise;
}

const analyzeLimiter = rateLimit({
windowMs: 15 * 60 * 1000, max: 100,
message: { error: 'Muitas requisições, tente novamente mais tarde.' }
});

const adminLimiter = rateLimit({
windowMs: 60 * 60 * 1000, max: 10,
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

async function getDerivClient() {
if (derivConnectionPromise) return derivConnectionPromise;
if (!derivClient) derivClient = new DerivClient(API_TOKEN);
derivConnectionPromise = derivClient.connect()
.then(() => { console.log('✅ Cliente Deriv pronto'); return derivClient; })
.catch(err => { console.error('❌ Falha conexão:', err); derivConnectionPromise = null; throw err; });
return derivConnectionPromise;
}

// ── tick com timeout reduzido (350ms) — fallback imediato para preço de candle ──
async function getCurrentPrice(client, symbol) {
return new Promise((resolve) => {
const reqId = Date.now();

const handler = (response) => {
if (response.error) {
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
if (typeof client.removeListener === 'function') client.removeListener(reqId, handler);
resolve(null);
}, 350); // ← reduzido de 800ms para 350ms

if (typeof client.addListener !== 'function') { clearTimeout(timeout); resolve(null); return; }
client.addListener(reqId, handler);
if (client.ws && client.ws.readyState === client.ws.OPEN) {
client.ws.send(JSON.stringify({ tick: symbol, req_id: reqId }));
} else {
clearTimeout(timeout);
if (typeof client.removeListener === 'function') client.removeListener(reqId, handler);
resolve(null);
}
});
}

app.get('/health', (req, res) => res.status(200).send('OK'));

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
const { randomUUID } = require('crypto');
const finalUserId = userId || randomUUID();
const token = jwt.sign({ userId: finalUserId, period, jti: randomUUID() }, secret, { expiresIn: period * 86400 });
res.json({ success: true, token, periodDays: period, expiresIn: period * 86400, userId: finalUserId });
});

app.post('/api/admin/restart-render', adminLimiter, async (req, res) => {
try {
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

// ── Funções de timing (compactas, mesma lógica) ──────────────────────────────
function buildTimingResult(analysis, signal, tf, label) {
if (!analysis) return { permitido: false, motivo: `${label} não disponível`, rsi: null, sinal: null, adx: null, alerta_pullback: null };
const adx = analysis.adx || 0;
const rsi = analysis.rsi || 50;
const temTendencia = adx >= 22;
const tipoAtivo = analysis.tipo_ativo || 'indice_normal';
const alerta_pullback = gerarAlertaPullback(rsi, signal, tipoAtivo, label);

if (signal === 'HOLD') return { permitido: false, motivo: 'Sinal HOLD - aguardar', rsi, sinal: analysis.sinal, adx, alerta_pullback };

const rsiMax   = label === 'M15' ? 72 : 75;
const rsiMin   = label === 'M15' ? 28 : 25;
const rsiOSell = label === 'M15' ? 36 : 38;
const rsiOBuy  = label === 'M15' ? 65 : 62;

if (signal === 'CALL') {
if (analysis.sinal === 'CALL' && rsi < rsiMax) return { permitido: true, motivo: `${label} confirmando CALL (ADX ${adx.toFixed(0)})`, rsi, sinal: analysis.sinal, adx, alerta_pullback };
if (analysis.sinal === 'PUT'  && rsi < rsiOSell) return { permitido: true, motivo: `${label} oversold - reversão CALL (ADX ${adx.toFixed(0)})`, rsi, sinal: analysis.sinal, adx, alerta_pullback };
}
if (signal === 'PUT') {
if (analysis.sinal === 'PUT'  && rsi > rsiMin) return { permitido: true, motivo: `${label} confirmando PUT (ADX ${adx.toFixed(0)})`, rsi, sinal: analysis.sinal, adx, alerta_pullback };
if (analysis.sinal === 'CALL' && rsi > rsiOBuy) return { permitido: true, motivo: `${label} overbought - reversão PUT (ADX ${adx.toFixed(0)})`, rsi, sinal: analysis.sinal, adx, alerta_pullback };
}
return { permitido: false, motivo: `${label} não confirma (${analysis.sinal}, RSI ${rsi.toFixed(0)}, ADX ${adx.toFixed(0)})`, rsi, sinal: analysis.sinal, adx, alerta_pullback };
}

function calcularTimingM1(a, s)  { return buildTimingResult(a, s, 'M1',  'M1'); }
function calcularTimingM5(a, s)  { return buildTimingResult(a, s, 'M5',  'M5'); }
function calcularTimingM15(a, s) { return buildTimingResult(a, s, 'M15', 'M15'); }
function calcularTimingH1(a, s) {
if (!a) return { permitido: false, motivo: 'H1 não disponível', rsi: null, sinal: null, adx: null, alerta_pullback: null };
return { permitido: false, motivo: 'H1 é TF de tendência', rsi: a.rsi || 50, sinal: a.sinal, adx: a.adx || 0, alerta_pullback: gerarAlertaPullback(a.rsi || 50, s, a.tipo_ativo || 'indice_normal', 'H1') };
}
function calcularTimingH4(a, s) {
if (!a) return { permitido: false, motivo: 'H4 não disponível', rsi: null, sinal: null, adx: null, alerta_pullback: null };
return { permitido: false, motivo: 'H4 é TF de tendência', rsi: a.rsi || 50, sinal: a.sinal, adx: a.adx || 0, alerta_pullback: gerarAlertaPullback(a.rsi || 50, s, a.tipo_ativo || 'indice_normal', 'H4') };
}

// ── Detetor de tipo de ativo (9 tipos, todos os símbolos do frontend) ─────────
function detectTipoAtivo(symbol) {
if (symbol.startsWith('R_') || symbol.startsWith('1HZ')) return 'volatility_index';
if (/^BOOM/i.test(symbol))   return 'boom_index';
if (/^CRASH/i.test(symbol))  return 'crash_index';
if (/^JD/i.test(symbol))     return 'jump_index';
if (/^stpRNG/i.test(symbol)) return 'step_index';
if (symbol.includes('XAU') || symbol.includes('XAG')) return 'commodity';
if (/^cry/i.test(symbol))    return 'criptomoeda';
if (/^frx/i.test(symbol))    return 'forex';
return 'indice_normal';
}

// ═══════════════════════════════════════════════════════════════════════════════
// ROTA PRINCIPAL — /api/analyze (OTIMIZADA)
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/api/analyze', authenticateToken, analyzeLimiter, async (req, res) => {
const startTime = Date.now();

try {
const { symbol, mode } = req.body;
if (!symbol) return res.status(400).json({ error: 'Símbolo é obrigatório' });
if (!mode || !TRADING_MODES[mode]) return res.status(400).json({ error: 'Modo inválido. Use: SNIPER, CAÇADOR ou PESCADOR', availableModes: Object.keys(TRADING_MODES) });

console.log(`\n🎯 ${mode} | ${symbol}`);

const client = await getDerivClient();

// ── 1. Detetar tipo de ativo ─────────────────────────────────────────────────
const tipoAtivo = detectTipoAtivo(symbol);
console.log(`🏷️  ${tipoAtivo}`);

// ── 2. Montar lista de TFs e aplicar candleCount para cripto ─────────────────
const modeTimeframes = TRADING_MODES[mode].timeframes;
const atrTfKey = getATRTimeframeByMode(mode);
const allTfKeys = Array.from(new Set([atrTfKey, ...modeTimeframes]));

const timeframesToAnalyze = modeTimeframes.map(tfKey => {
const tf = { ...ALL_TIMEFRAMES_CONFIG[tfKey] };
if (tipoAtivo === 'criptomoeda') tf.candleCount = 60; // cripto: ainda mais rápido
return tf;
});

// ── 3. Fetch candles + tick em PARALELO ──────────────────────────────────────
// O tick começa a resolver enquanto os candles ainda estão a chegar.
const tickPromise = getCurrentPrice(client, symbol); // 🔑 sem await aqui

const candlesMap = {};
await Promise.all(
allTfKeys.map(async (tfKey) => {
const tf = timeframesToAnalyze.find(t => t.key === tfKey) || ALL_TIMEFRAMES_CONFIG[tfKey];
if (!tf) return;
try {
const candles = await getCandlesWithCache(client, symbol, tf, mode, false);
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

// ── 4. Criar mtfManager + sistemaBase ────────────────────────────────────────
const mtfManager = new MultiTimeframeManager(symbol);
if (typeof mtfManager.setTipoAtivo === 'function') mtfManager.setTipoAtivo(tipoAtivo);
else if (mtfManager.tipoAtivo !== undefined) mtfManager.tipoAtivo = tipoAtivo;

const sistemaBase = new SistemaAnaliseInteligente(symbol);
if (sistemaBase.sistemaPesos?.setTipoAtivo) sistemaBase.sistemaPesos.setTipoAtivo(tipoAtivo);

// ── 5. Analisar todos os TFs em PARALELO ─────────────────────────────────────
await Promise.all(
timeframesToAnalyze.map(async (tf) => {
try {
const candles = candlesMap[tf.key];
if (!candles || candles.length < tf.minRequired) return;
const analysis = await sistemaBase.analisar(candles, tf.key);
if (analysis && !analysis.erro) {
mtfManager.addAnalysis(tf.key, analysis);
console.log(`✅ ${tf.key} OK`);
}
} catch (err) { console.error(`❌ análise ${tf.key}:`, err.message); }
})
);

// ── 6. Consolidar sinais ─────────────────────────────────────────────────────
const consolidated = mtfManager.consolidateSignals();
const agreement    = mtfManager.calculateAgreement();
consolidated.tipo_ativo = tipoAtivo;

const timeframesSignals = modeTimeframes
.map(tfKey => mtfManager.timeframes[tfKey]?.analysis?.sinal)
.filter(s => s && s !== 'HOLD');
const callCountDiv = timeframesSignals.filter(s => s === 'CALL').length;
const putCountDiv  = timeframesSignals.filter(s => s === 'PUT').length;

if (callCountDiv > 0 && putCountDiv > 0) {
console.log(`⚠️ Divergência TF: ${callCountDiv}C vs ${putCountDiv}P → HOLD`);
consolidated.simpleMajority.signal = 'HOLD';
consolidated.signal = 'HOLD';
consolidated.confidence = Math.min(consolidated.confidence, 0.3);
}

let hasMacdDivergence = false;
for (const tfKey of modeTimeframes) {
const a = mtfManager.timeframes[tfKey]?.analysis;
if (a?.divergencia_macd?.divergencia) {
hasMacdDivergence = true;
console.log(`⚠️ Divergência MACD em ${tfKey} → HOLD`);
break;
}
}
if (hasMacdDivergence) {
consolidated.simpleMajority.signal = 'HOLD';
consolidated.signal = 'HOLD';
consolidated.confidence = Math.min(consolidated.confidence, 0.3);
}

// ── 7. Preço: tick já deve ter resolvido (ou cai no fallback do candle) ───────
const tickResult = await tickPromise;
let currentPrice = 0, priceSource = 'unknown';
if (tickResult) {
currentPrice = tickResult; priceSource = 'tick';
console.log(`💰 tick: ${currentPrice}`);
} else {
for (const tf of ['M1','M5','M15','H1','H4']) {
const p = mtfManager.timeframes[tf]?.analysis?.preco_atual;
if (p) { currentPrice = p; priceSource = tf; break; }
}
console.log(`💰 fallback (${priceSource}): ${currentPrice}`);
}

const suggestion = BotExecutionCore.generateEntrySuggestion(
{ sinal: consolidated.signal, probabilidade: consolidated.confidence }, currentPrice
);

// ── 8. Timing + analiseRefinada em PARALELO ──────────────────────────────────
const primarySignal = consolidated.simpleMajority.signal;

// analiseRefinada roda em paralelo com timing e liquidez
const analiseRefinadaPromise = (async () => {
try {
const modeMap = { 'SNIPER': 'SNIPER', 'CAÇADOR': 'CACADOR', 'PESCADOR': 'PESCADOR' };
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
console.log(`📊 Refinada: ${analise.sinal.direcao} ${analise.sinal.confianca}%`);
return { analiseRefinada: analise, validacaoRisco: risco };
} catch (err) {
console.error('❌ analiseRefinada:', err.message);
return { analiseRefinada: { erro: err.message }, validacaoRisco: null };
}
})();

// Timing (síncrono, rápido)
let m1Timing = null, m5Timing = null, m15Timing = null, h1Timing = null, h4Timing = null;
if (modeTimeframes.includes('M1'))  m1Timing  = calcularTimingM1(mtfManager.timeframes['M1']?.analysis,  primarySignal);
if (modeTimeframes.includes('M5'))  m5Timing  = calcularTimingM5(mtfManager.timeframes['M5']?.analysis,  primarySignal);
if (modeTimeframes.includes('M15')) m15Timing = calcularTimingM15(mtfManager.timeframes['M15']?.analysis, primarySignal);
if (modeTimeframes.includes('H1'))  h1Timing  = calcularTimingH1(mtfManager.timeframes['H1']?.analysis,  primarySignal);
if (modeTimeframes.includes('H4'))  h4Timing  = calcularTimingH4(mtfManager.timeframes['H4']?.analysis,  primarySignal);

let timingEspecial = null;
if (mtfManager.tipoAtivo !== 'DEFAULT') {
const m1a = mtfManager.timeframes['M1']?.analysis;
if (m1a && typeof mtfManager.calcularTimingEspecial === 'function')
timingEspecial = mtfManager.calcularTimingEspecial('M1', m1a);
}

// ── 9. Deteção de Liquidez ────────────────────────────────────────────────────
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

// Trava: não substitui se TFs em divergência
const hasTfDivergenceForLiquidity = callCountDiv > 0 && putCountDiv > 0;
let timingOk = false;
if (mode === 'SNIPER'   && m1Timing?.permitido)  timingOk = true;
if (mode === 'CAÇADOR'  && m5Timing?.permitido)  timingOk = true;
if (mode === 'PESCADOR' && m15Timing?.permitido) timingOk = true;

if (!hasTfDivergenceForLiquidity && liquidityResult.sweepDetected && liquidityResult.confidence >= 75 && timingOk) {
console.log(`⚠️ Liquidez substitui sinal → ${liquidityResult.direction} ${liquidityResult.confidence.toFixed(0)}%`);
consolidated.signal = liquidityResult.direction;
consolidated.confidence = liquidityResult.confidence;
consolidated.simpleMajority.signal = liquidityResult.direction;
} else if (liquidityResult.sweepDetected && liquidityResult.confidence >= 75 && !timingOk) {
console.log(`💧 Liquidez forte mas TIMING NÃO OK - mantendo sinal`);
} else if (hasTfDivergenceForLiquidity && liquidityResult.sweepDetected) {
console.log(`🔒 Liquidez detectada mas TFs divergem - mantendo sinal`);
}

// ── 10. Aguardar analiseRefinada (já estava a correr em paralelo) ─────────────
const { analiseRefinada, validacaoRisco } = await analiseRefinadaPromise;

// ── 11. Montar resposta ───────────────────────────────────────────────────────
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
tipo_ativo: tipoAtivo,
...(m1Timing  && { m1_timing:  m1Timing  }),
...(m5Timing  && { m5_timing:  m5Timing  }),
...(m15Timing && { m15_timing: m15Timing }),
...(h1Timing  && { h1_timing:  h1Timing  }),
...(h4Timing  && { h4_timing:  h4Timing  }),
config_ativo: consolidated.config_ativo,
ciclo_completo: consolidated.ciclo_completo,
ponto_franco: consolidated.ponto_franco,
alinhamento_pescador: consolidated.alinhamento_pescador,
timing_especial: timingEspecial
},
agreement: {
agreement: agreement.agreement, primarySignal: agreement.primarySignal,
callCount: agreement.callCount, putCount: agreement.putCount,
totalTimeframes: agreement.totalTimeframes
},
suggestion: {
action: suggestion.action, reason: suggestion.reason,
entry: suggestion.entry, stopLoss: suggestion.stopLoss, takeProfit: suggestion.takeProfit
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
overrodeSignal: (!hasTfDivergenceForLiquidity && liquidityResult.sweepDetected && liquidityResult.confidence >= 75 && timingOk)
} : { sweepDetected: false },
metadata: { responseTimeMs: responseTime, timestamp: new Date().toISOString() }
});

} catch (error) {
console.error('❌ Erro na análise:', error);
res.status(500).json({ error: error.message, stack: process.env.NODE_ENV === 'development' ? error.stack : undefined });
}
});

app.use((req, res) => res.status(404).json({ error: 'Rota não encontrada' }));
app.use((err, req, res, next) => {
console.error('❌ Erro global:', err);
res.status(500).json({ error: 'Erro interno', message: process.env.NODE_ENV === 'development' ? err.message : undefined });
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, '0.0.0.0', async () => {
console.log(`\n🚀 Porta ${PORT}`);
console.log(`🎯 Modos: ${Object.keys(TRADING_MODES).join(', ')}`);
console.log(`📊 Candles: M1→100 | M5/M15→120 | M30→100 | H1→80 | H4→60 | H24→40 (cripto→60)`);
console.log(`⚡ Tick timeout: 350ms | Candles + Tick em paralelo | analiseRefinada em paralelo`);
console.log(`🏷️  Deteção de ativo: 9 tipos (volatility/boom/crash/jump/step/commodity/cripto/forex/normal)`);
console.log(`💧 Liquidity Hunter Robusto ativo`);
try { await getDerivClient(); console.log('✅ Conexão Deriv OK'); }
catch (err) { console.error('❌ Conexão Deriv:', err); }
});

server.keepAliveTimeout = 120000;
server.headersTimeout   = 120000;

process.on('SIGTERM', () => {
console.log('\n🛑 SIGTERM - encerrando...');
server.close(() => {
if (derivClient) derivClient.disconnect();
if (redisClient) redisClient.quit();
process.exit(0);
});
});
process.on('SIGINT', () => process.emit('SIGTERM'));

module.exports = app;
