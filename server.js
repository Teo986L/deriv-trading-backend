// server.js
const express = require('express');
const cors = require('cors');
const DerivClient = require('./deriv-client');
const { SistemaAnaliseInteligente } = require('./analyzers/sistema-analise');
const MultiTimeframeManager = require('./multi-timeframe-manager');
const BotExecutionCore = require('./bot-execution-core');
const { API_TOKEN } = require('./config');

const app = express();
app.use(cors());
app.use(express.json());

// Mantém uma única instância do cliente Deriv
let derivClient = null;

async function getDerivClient() {
    if (!derivClient || !derivClient.connected) {
        derivClient = new DerivClient(API_TOKEN);
        await derivClient.connect();
    }
    return derivClient;
}

// Rota de análise
app.post('/api/analyze', async (req, res) => {
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

        // Preparar resposta
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

// Rota simples para health check (usada pelo UptimeRobot)
app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Servidor rodando na porta ${PORT}`);
});
