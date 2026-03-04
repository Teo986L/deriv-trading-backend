// analyzers/advanced-market.js
const { MARKET_STATE, SIGNAL_TYPE } = require('../config');

class MACDStructure {
    constructor(macdLine, signalLine, histogram) {
        this.macdLine = macdLine || 0;
        this.signalLine = signalLine || 0;
        this.histogram = histogram || 0;

        this.structuralBias = this.determineStructuralBias();
        this.momentumBias = this.determineMomentumBias();
        this.isCorrection = this.detectCorrection();
        this.structuralStrength = Math.abs(this.macdLine);
        this.momentumStrength = Math.abs(this.histogram);
    }

    determineStructuralBias() {
        if (this.macdLine > 0 && this.signalLine > 0) return "BULLISH";
        if (this.macdLine < 0 && this.signalLine < 0) return "BEARISH";
        return "NEUTRAL";
    }

    determineMomentumBias() {
        if (this.histogram > 0) return "BULLISH";
        if (this.histogram < 0) return "BEARISH";
        return "NEUTRAL";
    }

    detectCorrection() {
        return ((this.structuralBias === "BULLISH" && this.momentumBias === "BEARISH") ||
                (this.structuralBias === "BEARISH" && this.momentumBias === "BULLISH"));
    }

    update(macdLine, signalLine, histogram) {
        this.macdLine = macdLine || this.macdLine;
        this.signalLine = signalLine || this.signalLine;
        this.histogram = histogram || this.histogram;

        this.structuralBias = this.determineStructuralBias();
        this.momentumBias = this.determineMomentumBias();
        this.isCorrection = this.detectCorrection();
        this.structuralStrength = Math.abs(this.macdLine);
        this.momentumStrength = Math.abs(this.histogram);

        return this;
    }

    getDescription() {
        return {
            structuralBias: this.structuralBias,
            momentumBias: this.momentumBias,
            isCorrection: this.isCorrection,
            structuralStrength: this.structuralStrength.toFixed(4),
            momentumStrength: this.momentumStrength.toFixed(4),
            macdLine: this.macdLine.toFixed(4),
            signalLine: this.signalLine.toFixed(4),
            histogram: this.histogram.toFixed(4)
        };
    }
}

class DynamicWeightsSystem {
    constructor() {
        this.currentWeights = {
            weightMACD: 25,
            weightADX: 20,
            weightRSI: 15
        };
    }

    adjustDynamicWeights(currentScore) {
        if (currentScore > 70) {
            this.currentWeights = { weightMACD: 30, weightADX: 25, weightRSI: 15 };
        } else if (currentScore < 30) {
            this.currentWeights = { weightMACD: 20, weightADX: 30, weightRSI: 20 };
        } else {
            this.currentWeights = { weightMACD: 25, weightADX: 20, weightRSI: 15 };
        }
        return this.currentWeights;
    }

    calculateWeightedScore(indicators) {
        const { macdScore = 0, adxScore = 0, rsiScore = 0, totalScore = 0 } = indicators;
        this.adjustDynamicWeights(totalScore);
        const weightedScore = (
            macdScore * (this.currentWeights.weightMACD / 100) +
            adxScore * (this.currentWeights.weightADX / 100) +
            rsiScore * (this.currentWeights.weightRSI / 100)
        );
        return Math.min(Math.max(weightedScore, 0), 100);
    }

    getWeights() {
        return { ...this.currentWeights };
    }
}

class ExhaustionDetector {
    constructor() {
        this.exhaustionSignals = [];
    }

    detectExhaustion(candles, direction, macdHistory = []) {
        if (!candles || candles.length < 5) return { exhausted: false, signals: 0, reasons: [], strength: 0 };

        let signals = 0;
        const reasons = [];

        if (this.checkMACDLoss(macdHistory, direction)) { signals++; reasons.push("MACD losing strength"); }
        if (this.checkRejectionCandle(candles, direction)) { signals++; reasons.push("Rejection candle"); }
        if (this.checkVolumeDecline(candles)) { signals++; reasons.push("Volume declining"); }
        if (this.checkDoji(candles)) { signals++; reasons.push("Doji/indecision"); }

        const isExhausted = signals >= 2;

        if (isExhausted) {
            this.exhaustionSignals.push({
                timestamp: Date.now(),
                direction: direction,
                signals: signals,
                reasons: reasons
            });
            if (this.exhaustionSignals.length > 20) this.exhaustionSignals = this.exhaustionSignals.slice(-20);
        }

        return {
            exhausted: isExhausted,
            signals: signals,
            reasons: reasons,
            strength: signals / 4
        };
    }

    checkMACDLoss(macdHistory, direction) {
        if (!macdHistory || macdHistory.length < 3) return false;
        const hist1 = Math.abs(macdHistory[macdHistory.length - 1] || 0);
        const hist2 = Math.abs(macdHistory[macdHistory.length - 2] || 0);
        const hist3 = Math.abs(macdHistory[macdHistory.length - 3] || 0);
        return (hist1 < hist2 && hist2 < hist3);
    }

    checkRejectionCandle(candles, direction) {
        if (!candles || candles.length < 1) return false;
        const lastCandle = candles[candles.length - 1];
        const bodySize = Math.abs(lastCandle.close - lastCandle.open);
        if (bodySize === 0) return false;
        if (direction === "CALL" || direction === "BUY" || direction === "BULLISH") {
            const upperShadow = lastCandle.high - Math.max(lastCandle.close, lastCandle.open);
            return (upperShadow > bodySize * 1.5);
        } else if (direction === "PUT" || direction === "SELL" || direction === "BEARISH") {
            const lowerShadow = Math.min(lastCandle.close, lastCandle.open) - lastCandle.low;
            return (lowerShadow > bodySize * 1.5);
        }
        return false;
    }

    checkVolumeDecline(candles) {
        if (!candles || candles.length < 5) return false;
        const volumes = candles.slice(-5).map(c => c.volume || 0);
        if (volumes.some(v => v === 0)) return false;
        return (volumes[4] < volumes[3] && volumes[3] < volumes[2]);
    }

    checkDoji(candles) {
        if (!candles || candles.length < 1) return false;
        const lastCandle = candles[candles.length - 1];
        const bodySize = Math.abs(lastCandle.close - lastCandle.open);
        const totalRange = lastCandle.high - lastCandle.low;
        return (totalRange > 0 && bodySize / totalRange < 0.1);
    }

    getRecentExhaustion(minutes = 30) {
        const cutoff = Date.now() - (minutes * 60 * 1000);
        return this.exhaustionSignals.filter(s => s.timestamp > cutoff);
    }
}

class PullbackZoneCalculator {
    constructor() {
        this.activeZones = [];
    }

    calculatePullbackZone(candles, direction, atr, atrMultiplier = 0.5) {
        if (!candles || candles.length < 5) return null;

        const recent = candles.slice(-5);

        if (direction === "CALL" || direction === "BUY" || direction === "BULLISH") {
            const downCandles = recent.filter(c => c.close < c.open).length;
            const lastCandleUp = recent[recent.length - 1].close > recent[recent.length - 2].close;

            if (downCandles >= 2 && lastCandleUp) {
                const low = Math.min(...recent.map(c => c.low));
                const zone = {
                    low: low,
                    high: low + (atr * atrMultiplier),
                    type: "PULLBACK_BUY",
                    confidence: Math.min(downCandles * 20, 80),
                    timestamp: Date.now(),
                    entry: "AGUARDAR PREÇO NA ZONA",
                    stopLoss: low - (atr * 0.3),
                    takeProfit: [low + (atr * 2), low + (atr * 3)]
                };
                this.activeZones.push(zone);
                return zone;
            }
        } else if (direction === "PUT" || direction === "SELL" || direction === "BEARISH") {
            const upCandles = recent.filter(c => c.close > c.open).length;
            const lastCandleDown = recent[recent.length - 1].close < recent[recent.length - 2].close;

            if (upCandles >= 2 && lastCandleDown) {
                const high = Math.max(...recent.map(c => c.high));
                const zone = {
                    low: high - (atr * atrMultiplier),
                    high: high,
                    type: "PULLBACK_SELL",
                    confidence: Math.min(upCandles * 20, 80),
                    timestamp: Date.now(),
                    entry: "AGUARDAR PREÇO NA ZONA",
                    stopLoss: high + (atr * 0.3),
                    takeProfit: [high - (atr * 2), high - (atr * 3)]
                };
                this.activeZones.push(zone);
                return zone;
            }
        }
        return null;
    }

    isPriceInZone(price, zone) {
        if (!zone) return false;
        return (price >= zone.low && price <= zone.high);
    }

    getActiveZones(maxAgeSeconds = 300) {
        const cutoff = Date.now() - (maxAgeSeconds * 1000);
        return this.activeZones.filter(z => z.timestamp > cutoff);
    }

    clearOldZones(maxAgeSeconds = 300) {
        const cutoff = Date.now() - (maxAgeSeconds * 1000);
        this.activeZones = this.activeZones.filter(z => z.timestamp > cutoff);
    }

    calculateDynamicATR(candles, period = 14) {
        if (!candles || candles.length < period) return 0.001;
        const recent = candles.slice(-period);
        const trs = [];
        for (let i = 1; i < recent.length; i++) {
            const high = recent[i].high;
            const low = recent[i].low;
            const prevClose = recent[i - 1].close;
            const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
            trs.push(tr);
        }
        return trs.reduce((a, b) => a + b, 0) / trs.length;
    }

    getSuggestion(zone, currentPrice) {
        if (!zone) return "Sem zona de pullback ativa";
        if (currentPrice < zone.low) {
            return `💰 Preço abaixo da zona. Aguardar entrada entre ${zone.low.toFixed(2)} - ${zone.high.toFixed(2)}`;
        } else if (currentPrice > zone.high) {
            return `📈 Preço acima da zona. Aguardar pullback para ${zone.low.toFixed(2)} - ${zone.high.toFixed(2)}`;
        } else {
            return `🎯 PREÇO NA ZONA! Confiança: ${zone.confidence}% | SL: ${zone.stopLoss.toFixed(2)} | TP: ${zone.takeProfit.join(' → ')}`;
        }
    }
}

class TrendResolver {
    constructor() {
        this.result = {
            marketState: "UNDEFINED",
            signalType: "NONE",
            tradeAllowed: false,
            reasonBlocked: "",
            confidenceScore: 0,
            finalBias: "NEUTRAL",
            h1Confirmation: "",
            m15Quality: ""
        };
    }

    resolveMarketState(params) {
        const {
            h4MACDStructure,
            h1MACDStructure,
            h4ADX = 25,
            h4RSI = 50,
            d1Context = null,
            totalScore = 50
        } = params;

        const result = {
            marketState: "UNDEFINED",
            signalType: "NONE",
            tradeAllowed: false,
            reasonBlocked: "",
            confidenceScore: 0,
            finalBias: "NEUTRAL",
            h1Confirmation: "",
            m15Quality: ""
        };

        if (d1Context && d1Context.blockAllTrades) {
            result.marketState = MARKET_STATE.NO_TRADE;
            result.tradeAllowed = false;
            result.reasonBlocked = "D1 Block All Trades";
            return result;
        }

        const h4StructuralBullish = (h4MACDStructure.structuralBias === "BULLISH");
        const h4StructuralBearish = (h4MACDStructure.structuralBias === "BEARISH");
        const h4TrendStrength = (h4ADX > 25);
        const h4Range = (h4ADX < 20);
        const h4ExhaustionBull = (h4RSI > 70);
        const h4ExhaustionBear = (h4RSI < 30);
        const h1MomentumBullish = (h1MACDStructure.momentumBias === "BULLISH");
        const h1MomentumBearish = (h1MACDStructure.momentumBias === "BEARISH");

        if (h4StructuralBearish && h4TrendStrength && !h4ExhaustionBear) {
            result.finalBias = "BEARISH";
            if (h1MomentumBullish) {
                result.marketState = MARKET_STATE.BULLISH_CORRECTION;
                result.signalType = SIGNAL_TYPE.PULLBACK;
                result.h1Confirmation = "BEARISH_CORRECTION";
                result.tradeAllowed = true;
            } else if (h1MomentumBearish) {
                result.marketState = MARKET_STATE.STRONG_BEAR_TREND;
                result.signalType = SIGNAL_TYPE.TREND_CONTINUATION;
                result.h1Confirmation = "BEARISH_CONFIRMED";
                result.tradeAllowed = true;
            }
        }
        else if (h4StructuralBullish && h4TrendStrength && !h4ExhaustionBull) {
            result.finalBias = "BULLISH";
            if (h1MomentumBearish) {
                result.marketState = MARKET_STATE.BEARISH_CORRECTION;
                result.signalType = SIGNAL_TYPE.PULLBACK;
                result.h1Confirmation = "BULLISH_CORRECTION";
                result.tradeAllowed = true;
            } else if (h1MomentumBullish) {
                result.marketState = MARKET_STATE.STRONG_BULL_TREND;
                result.signalType = SIGNAL_TYPE.TREND_CONTINUATION;
                result.h1Confirmation = "BULLISH_CONFIRMED";
                result.tradeAllowed = true;
            }
        }
        else if (h4MACDStructure.isCorrection && h4TrendStrength) {
            result.marketState = MARKET_STATE.TRANSITION;
            result.signalType = SIGNAL_TYPE.TRANSITION;
            result.tradeAllowed = false;
            result.reasonBlocked = "Market in Transition (Structure vs Momentum)";
            result.h1Confirmation = "TRANSITION";
        }
        else if (h4Range) {
            result.marketState = MARKET_STATE.RANGE;
            result.signalType = SIGNAL_TYPE.RANGE_BREAKOUT;
            result.tradeAllowed = false;
            result.finalBias = "NEUTRAL";
            result.h1Confirmation = "RANGE";
            if (!result.tradeAllowed) result.reasonBlocked = "Range - Low ADX";
        }
        else if (h4ExhaustionBull || h4ExhaustionBear) {
            result.marketState = MARKET_STATE.EXHAUSTION;
            result.signalType = SIGNAL_TYPE.NONE;
            result.tradeAllowed = false;
            result.reasonBlocked = "Exhaustion Detected (RSI extreme)";
            result.h1Confirmation = "EXHAUSTION";
        }
        else {
            result.marketState = MARKET_STATE.NO_TRADE;
            result.signalType = SIGNAL_TYPE.NONE;
            result.tradeAllowed = false;
            result.reasonBlocked = "No clear market structure";
            result.h1Confirmation = "UNCLEAR";
        }

        if (h4StructuralBearish && h1MomentumBullish && result.signalType === SIGNAL_TYPE.TREND_CONTINUATION) {
            result.tradeAllowed = false;
            result.reasonBlocked = "Hist positive with MACD negative = No CALL trend (only pullback)";
        }
        if (h4StructuralBullish && h1MomentumBearish && result.signalType === SIGNAL_TYPE.TREND_CONTINUATION) {
            result.tradeAllowed = false;
            result.reasonBlocked = "Hist negative with MACD positive = No PUT trend (only pullback)";
        }

        if (d1Context && d1Context.context === "NEUTRAL" && result.tradeAllowed) {
            if (totalScore < 60) {
                result.tradeAllowed = false;
                result.reasonBlocked = "D1 Neutral - Score < 60";
            }
        }

        result.confidenceScore = this.calculateConfidenceScore(result, h4MACDStructure, h1MACDStructure);
        return result;
    }

    calculateConfidenceScore(resolver, h4MACD, h1MACD) {
        let score = 0;
        switch (resolver.marketState) {
            case MARKET_STATE.STRONG_BULL_TREND:
            case MARKET_STATE.STRONG_BEAR_TREND:
                score += 40;
                break;
            case MARKET_STATE.BULLISH_CORRECTION:
            case MARKET_STATE.BEARISH_CORRECTION:
                score += 25;
                break;
            case MARKET_STATE.TRANSITION:
                score += 10;
                break;
            case MARKET_STATE.RANGE:
                score += 15;
                break;
            case MARKET_STATE.EXHAUSTION:
            case MARKET_STATE.NO_TRADE:
                return 0;
        }
        if (h4MACD.structuralBias !== "NEUTRAL" && h1MACD.momentumBias !== "NEUTRAL") {
            if ((h4MACD.structuralBias === "BULLISH" && h1MACD.momentumBias === "BULLISH") ||
                (h4MACD.structuralBias === "BEARISH" && h1MACD.momentumBias === "BEARISH")) {
                score += 30;
            } else if (h4MACD.isCorrection && h4MACD.structuralStrength > 0.0005) {
                score += 20;
            }
        }
        if (resolver.h1Confirmation.includes("CONFIRMED")) score += 20;
        if (resolver.marketState === MARKET_STATE.EXHAUSTION) score *= 0.7;
        return Math.min(Math.max(score, 0), 100);
    }
}

class AdvancedMarketAnalyzer {
    constructor() {
        this.macdStructure = new MACDStructure(0, 0, 0);
        this.trendResolver = new TrendResolver();
        this.dynamicWeights = new DynamicWeightsSystem();
        this.exhaustionDetector = new ExhaustionDetector();
        this.pullbackZoneCalc = new PullbackZoneCalculator();
        this.lastAnalysis = null;
    }

    analyze(candles, indicators) {
        const {
            macdLine = 0,
            macdSignal = 0,
            macdHist = 0,
            adx = 25,
            rsi = 50,
            h4ADX = 25,
            h4RSI = 50,
            totalScore = 50
        } = indicators;

        this.macdStructure.update(macdLine, macdSignal, macdHist);

        const trendParams = {
            h4MACDStructure: this.macdStructure,
            h1MACDStructure: this.macdStructure,
            h4ADX: h4ADX,
            h4RSI: h4RSI,
            totalScore: totalScore
        };

        const marketState = this.trendResolver.resolveMarketState(trendParams);
        const weights = this.dynamicWeights.adjustDynamicWeights(totalScore);

        let exhaustion = null;
        if (marketState.finalBias !== "NEUTRAL") {
            exhaustion = this.exhaustionDetector.detectExhaustion(candles, marketState.finalBias, [macdHist]);
        }

        let pullbackZone = null;
        if (marketState.signalType === SIGNAL_TYPE.PULLBACK) {
            const atr = this.pullbackZoneCalc.calculateDynamicATR(candles);
            pullbackZone = this.pullbackZoneCalc.calculatePullbackZone(candles, marketState.finalBias, atr);
        }

        this.lastAnalysis = {
            timestamp: Date.now(),
            macdStructure: this.macdStructure.getDescription(),
            marketState: marketState,
            weights: weights,
            exhaustion: exhaustion,
            pullbackZone: pullbackZone,
            summary: {
                bias: marketState.finalBias,
                state: marketState.marketState,
                signalType: marketState.signalType,
                tradeAllowed: marketState.tradeAllowed,
                confidence: marketState.confidenceScore,
                reason: marketState.reasonBlocked || "OK to trade"
            }
        };

        return this.lastAnalysis;
    }

    getSummary() {
        if (!this.lastAnalysis) return null;
        const s = this.lastAnalysis.summary;
        return {
            signal: s.bias === "BULLISH" ? "CALL" : s.bias === "BEARISH" ? "PUT" : "HOLD",
            confidence: s.confidence,
            tradeAllowed: s.tradeAllowed,
            state: s.state,
            reason: s.reason
        };
    }
}

module.exports = AdvancedMarketAnalyzer;
