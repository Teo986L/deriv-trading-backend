// bot-execution-core.js
const { BOT_SHIELD_CONFIG } = require('./config');

class BotExecutionCore {
    static checkSync(dataM5, dataH4) {
        if (!dataM5 || !dataH4 || dataM5.length === 0 || dataH4.length === 0) return true;
        const timeM5 = dataM5[dataM5.length - 1]?.timestamp || 0;
        const timeH4 = dataH4[dataH4.length - 1]?.timestamp || 0;
        const diff = Math.abs(timeM5 - timeH4);
        return diff < (4 * 60 * 60 * 1000) + BOT_SHIELD_CONFIG.MAX_ALLOWED_DELAY_MS;
    }

    static isHighImpactTime() {
        if (!BOT_SHIELD_CONFIG.BLOCK_HIGH_IMPACT_TIMES) return false;
        const now = new Date();
        const hour = now.getUTCHours();
        const minute = now.getUTCMinutes();
        const day = now.getUTCDay();
        if (day === 0 || day === 6) return true;
        for (const impact of BOT_SHIELD_CONFIG.HIGH_IMPACT_TIMES) {
            const start = impact.hour * 60 + impact.minute;
            const end = start + impact.duration;
            const current = hour * 60 + minute;
            if (current >= start && current <= end) return true;
        }
        return false;
    }

    static generateEntrySuggestion(analysis, currentPrice, pullbackZone = null) {
        if (!analysis || analysis.sinal === 'HOLD') {
            return { action: "WAIT", reason: "Mercado neutro - aguardar definição", confidence: 0, entry: null, stopLoss: null, takeProfit: null };
        }
        if (this.isHighImpactTime()) {
            return { action: "WAIT", reason: "Horário de alta volatilidade (evitar entrar)", confidence: analysis.probabilidade * 0.5, entry: null, stopLoss: null, takeProfit: null };
        }
        if (analysis.probabilidade < BOT_SHIELD_CONFIG.MIN_CONFIDENCE / 100) {
            return { action: "WAIT", reason: `Confiança baixa (${(analysis.probabilidade * 100).toFixed(1)}% < ${BOT_SHIELD_CONFIG.MIN_CONFIDENCE}%)`, confidence: analysis.probabilidade, entry: null, stopLoss: null, takeProfit: null };
        }
        if (pullbackZone) {
            const inZone = (currentPrice >= pullbackZone.low && currentPrice <= pullbackZone.high);
            if (inZone) {
                return {
                    action: analysis.sinal === 'CALL' ? "BUY" : "SELL",
                    entry: currentPrice,
                    stopLoss: pullbackZone.stopLoss,
                    takeProfit: pullbackZone.takeProfit,
                    confidence: (analysis.probabilidade + pullbackZone.confidence / 100) / 2,
                    reason: `ENTRADA NA ZONA DE PULLBACK! Confiança Pullback: ${pullbackZone.confidence}%`,
                    zone: pullbackZone,
                    type: "PULLBACK_ENTRY"
                };
            } else {
                return {
                    action: "WAIT",
                    reason: `Aguardar preço entrar na zona: ${pullbackZone.low.toFixed(2)} - ${pullbackZone.high.toFixed(2)}`,
                    confidence: analysis.probabilidade,
                    entry: null,
                    stopLoss: null,
                    takeProfit: null,
                    zone: pullbackZone,
                    type: "AWAITING_ZONE"
                };
            }
        }
        const atr = analysis.atr || (currentPrice * 0.01);
        return {
            action: analysis.sinal === 'CALL' ? "BUY" : "SELL",
            entry: currentPrice,
            stopLoss: analysis.sinal === 'CALL' ? currentPrice - atr : currentPrice + atr,
            takeProfit: [
                analysis.sinal === 'CALL' ? currentPrice + (atr * 1.5) : currentPrice - (atr * 1.5),
                analysis.sinal === 'CALL' ? currentPrice + (atr * 2.5) : currentPrice - (atr * 2.5)
            ],
            confidence: analysis.probabilidade,
            reason: `Sinal ${analysis.sinal} direto - Confiança: ${(analysis.probabilidade * 100).toFixed(1)}%`,
            type: "DIRECT_ENTRY"
        };
    }

    static processSignal(analysis, candleData, pullbackZone = null) {
        const closedCandle = BOT_SHIELD_CONFIG.USE_CLOSED_CANDLES_ONLY && candleData && candleData.length > 1
            ? candleData[candleData.length - 2]
            : (candleData ? candleData[candleData.length - 1] : null);
        const currentPrice = closedCandle ? closedCandle.close : (analysis.preco_atual || 0);
        let finalConfidence = analysis.probabilidade;
        if (analysis.elliott_wave && analysis.elliott_wave.uncertainty > 0.5) {
            finalConfidence *= BOT_SHIELD_CONFIG.ELLIOTT_WEIGHT_REDUCTION;
        }
        const suggestion = this.generateEntrySuggestion(analysis, currentPrice, pullbackZone);
        const result = {
            timestamp: new Date().toISOString(),
            action: suggestion.action,
            reason: suggestion.reason,
            confidence: finalConfidence,
            entry: suggestion.entry,
            stopLoss: suggestion.stopLoss,
            takeProfit: suggestion.takeProfit,
            price: currentPrice,
            signalType: analysis.sinal,
            marketState: analysis.pesos_automaticos?.estado_mercado,
            alerts: analysis.alertas || [],
            suggestion: suggestion,
            suggestions: {
                entry: suggestion.action === "WAIT" ? suggestion.reason : `${suggestion.action} a ${suggestion.entry?.toFixed(2) || 'N/A'}`,
                stopLoss: suggestion.stopLoss ? `SL: ${suggestion.stopLoss.toFixed(2)}` : "SL: Não definido",
                takeProfit: suggestion.takeProfit ? `TP: ${suggestion.takeProfit.map(tp => tp.toFixed(2)).join(' → ')}` : "TP: Não definido",
                riskReward: suggestion.stopLoss && suggestion.entry && suggestion.takeProfit ? this.calculateRiskReward(suggestion) : "R/R: Não disponível"
            }
        };
        return result;
    }

    static calculateRiskReward(suggestion) {
        if (!suggestion.entry || !suggestion.stopLoss || !suggestion.takeProfit) return null;
        const risk = Math.abs(suggestion.entry - suggestion.stopLoss);
        const reward1 = Math.abs(suggestion.takeProfit[0] - suggestion.entry);
        const reward2 = Math.abs(suggestion.takeProfit[1] - suggestion.entry);
        return {
            firstTarget: (reward1 / risk).toFixed(2),
            secondTarget: (reward2 / risk).toFixed(2),
            average: ((reward1 + reward2) / 2 / risk).toFixed(2)
        };
    }
}

module.exports = BotExecutionCore;
