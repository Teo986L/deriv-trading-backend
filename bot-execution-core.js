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
        
        // Fim de semana
        if (day === 0 || day === 6) return true;
        
        // Horários de alto impacto
        for (const impact of BOT_SHIELD_CONFIG.HIGH_IMPACT_TIMES) {
            const start = impact.hour * 60 + impact.minute;
            const end = start + impact.duration;
            const current = hour * 60 + minute;
            
            if (current >= start && current <= end) return true;
        }
        
        return false;
    }

    static calcularATRDinamico(analysis, currentPrice) {
        // Se a análise já tem ATR, usa
        if (analysis.atr && analysis.atr > 0) return analysis.atr;
        
        // Senão, calcula baseado no tipo de ativo
        const tipoAtivo = analysis.tipo_ativo || 'indice_normal';
        
        // Multiplicadores por tipo de ativo
        const multipliers = {
            'volatility_index': 0.005,  // 0.5% para Volatility
            'forex': 0.001,              // 0.1% para Forex
            'commodity': 0.002,          // 0.2% para Commodities
            'criptomoeda': 0.003,         // 0.3% para Cripto
            'indice_normal': 0.0015       // 0.15% padrão
        };
        
        const multiplier = multipliers[tipoAtivo] || 0.0015;
        return currentPrice * multiplier;
    }

    static validarSugestao(suggestion) {
        if (!suggestion) return false;
        if (suggestion.action === 'WAIT') return true;
        
        // Validar preços
        if (!suggestion.entry || suggestion.entry <= 0) return false;
        if (!suggestion.stopLoss || suggestion.stopLoss <= 0) return false;
        if (!suggestion.takeProfit || !Array.isArray(suggestion.takeProfit)) return false;
        if (suggestion.takeProfit.length < 2) return false;
        
        // Validar lógica (CALL: stop deve ser menor que entry)
        if (suggestion.action === 'BUY' && suggestion.stopLoss >= suggestion.entry) return false;
        if (suggestion.action === 'SELL' && suggestion.stopLoss <= suggestion.entry) return false;
        
        return true;
    }

    static generateEntrySuggestion(analysis, currentPrice, pullbackZone = null) {
        // Validações iniciais
        if (!analysis) {
            return { 
                action: "WAIT", 
                reason: "Análise inválida", 
                confidence: 0, 
                entry: null, 
                stopLoss: null, 
                takeProfit: null 
            };
        }
        
        if (analysis.sinal === 'HOLD') {
            return { 
                action: "WAIT", 
                reason: "Mercado neutro - aguardar definição", 
                confidence: 0, 
                entry: null, 
                stopLoss: null, 
                takeProfit: null 
            };
        }
        
        // Verificar horário de alto impacto
        if (this.isHighImpactTime()) {
            return { 
                action: "WAIT", 
                reason: "Horário de alta volatilidade (evitar entrar)", 
                confidence: analysis.probabilidade * 0.5, 
                entry: null, 
                stopLoss: null, 
                takeProfit: null 
            };
        }
        
        // Verificar confiança mínima
        const minConfidence = BOT_SHIELD_CONFIG.MIN_CONFIDENCE / 100;
        if (analysis.probabilidade < minConfidence) {
            return { 
                action: "WAIT", 
                reason: `Confiança baixa (${(analysis.probabilidade * 100).toFixed(1)}% < ${BOT_SHIELD_CONFIG.MIN_CONFIDENCE}%)`, 
                confidence: analysis.probabilidade, 
                entry: null, 
                stopLoss: null, 
                takeProfit: null 
            };
        }
        
        // Se tem zona de pullback
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
        
        // Calcular ATR dinâmico
        const atr = this.calcularATRDinamico(analysis, currentPrice);
        
        // Calcular stop loss e take profit baseados no ATR
        const stopLoss = analysis.sinal === 'CALL' 
            ? currentPrice - atr 
            : currentPrice + atr;
            
        const takeProfit = [
            analysis.sinal === 'CALL' ? currentPrice + (atr * 1.5) : currentPrice - (atr * 1.5),
            analysis.sinal === 'CALL' ? currentPrice + (atr * 2.5) : currentPrice - (atr * 2.5)
        ];
        
        // Calcular risco/recompensa
        const risk = Math.abs(currentPrice - stopLoss);
        const reward1 = Math.abs(takeProfit[0] - currentPrice);
        const reward2 = Math.abs(takeProfit[1] - currentPrice);
        const rr1 = (reward1 / risk).toFixed(2);
        const rr2 = (reward2 / risk).toFixed(2);
        
        const suggestion = {
            action: analysis.sinal === 'CALL' ? "BUY" : "SELL",
            entry: currentPrice,
            stopLoss,
            takeProfit,
            confidence: analysis.probabilidade,
            reason: `Sinal ${analysis.sinal} - Confiança: ${(analysis.probabilidade * 100).toFixed(1)}% | R/R: 1:${rr1} e 1:${rr2}`,
            type: "DIRECT_ENTRY",
            riskReward: {
                first: rr1,
                second: rr2,
                average: ((parseFloat(rr1) + parseFloat(rr2)) / 2).toFixed(2)
            }
        };
        
        // Validar sugestão
        suggestion.valid = this.validarSugestao(suggestion);
        
        return suggestion;
    }

    static processSignal(analysis, candleData, pullbackZone = null) {
        // Usar candle fechado se configurado
        const closedCandle = BOT_SHIELD_CONFIG.USE_CLOSED_CANDLES_ONLY && candleData && candleData.length > 1
            ? candleData[candleData.length - 2]
            : (candleData ? candleData[candleData.length - 1] : null);
            
        const currentPrice = closedCandle ? closedCandle.close : (analysis.preco_atual || 0);
        
        // Ajustar confiança baseado em Elliott Wave
        let finalConfidence = analysis.probabilidade;
        
        if (analysis.elliott_wave && analysis.elliott_wave.uncertainty > 0.5) {
            finalConfidence *= BOT_SHIELD_CONFIG.ELLIOTT_WEIGHT_REDUCTION;
        }
        
        const suggestion = this.generateEntrySuggestion(
            { ...analysis, probabilidade: finalConfidence }, 
            currentPrice, 
            pullbackZone
        );
        
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
                entry: suggestion.action === "WAIT" 
                    ? suggestion.reason 
                    : `${suggestion.action} a ${suggestion.entry?.toFixed(2) || 'N/A'}`,
                stopLoss: suggestion.stopLoss 
                    ? `SL: ${suggestion.stopLoss.toFixed(2)}` 
                    : "SL: Não definido",
                takeProfit: suggestion.takeProfit 
                    ? `TP: ${suggestion.takeProfit.map(tp => tp.toFixed(2)).join(' → ')}` 
                    : "TP: Não definido",
                riskReward: suggestion.stopLoss && suggestion.entry && suggestion.takeProfit 
                    ? this.calculateRiskReward(suggestion) 
                    : "R/R: Não disponível"
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
    
    static getPositionSize(accountBalance, riskPercent, stopLossPips, pipValue) {
        if (!accountBalance || !riskPercent || !stopLossPips || !pipValue) return 0;
        
        const riskAmount = accountBalance * (riskPercent / 100);
        const positionSize = riskAmount / (stopLossPips * pipValue);
        
        return Math.max(0, positionSize);
    }
}

module.exports = BotExecutionCore;
