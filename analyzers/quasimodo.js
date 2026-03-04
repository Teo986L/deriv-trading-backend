// analyzers/quasimodo.js
class QuasimodoPattern {
    constructor(data) {
        this.data = data;
        this.swingPoints = [];
        this.qmLevels = [];
    }

    findSwingPoints(lookback = 5) {
        const swings = [];
        for (let i = lookback; i < this.data.length - lookback; i++) {
            const currentHigh = this.data[i].high;
            const currentLow = this.data[i].low;
            let isHighSwing = true, isLowSwing = true;
            for (let j = 1; j <= lookback; j++) {
                if (this.data[i - j].high >= currentHigh || this.data[i + j].high >= currentHigh) { isHighSwing = false; break; }
            }
            for (let j = 1; j <= lookback; j++) {
                if (this.data[i - j].low <= currentLow || this.data[i + j].low <= currentLow) { isLowSwing = false; break; }
            }
            if (isHighSwing) swings.push({ index: i, price: currentHigh, type: 'high', time: this.data[i].time });
            if (isLowSwing) swings.push({ index: i, price: currentLow, type: 'low', time: this.data[i].time });
        }
        this.swingPoints = swings.sort((a, b) => a.index - b.index);
        return this.swingPoints;
    }

    findQuasimodoPatterns() {
        const patterns = [];
        const swings = this.swingPoints;
        for (let i = 2; i < swings.length - 2; i++) {
            if (swings[i].type === 'high') {
                const leftLow = swings[i - 1], centerHigh = swings[i], rightLow = swings[i + 1];
                if (leftLow.type === 'low' && rightLow.type === 'low') {
                    if (rightLow.price > leftLow.price && centerHigh.price > leftLow.price && centerHigh.price > rightLow.price) {
                        patterns.push({
                            type: 'resistance',
                            leftLow: leftLow.price,
                            centerHigh: centerHigh.price,
                            rightLow: rightLow.price,
                            index: centerHigh.index,
                            price: centerHigh.price,
                            entryZone: centerHigh.price,
                            invalidation: Math.max(leftLow.price, rightLow.price),
                            target: leftLow.price - (centerHigh.price - leftLow.price),
                            strength: Math.abs(centerHigh.price - leftLow.price)
                        });
                    }
                }
            } else if (swings[i].type === 'low') {
                const leftHigh = swings[i - 1], centerLow = swings[i], rightHigh = swings[i + 1];
                if (leftHigh.type === 'high' && rightHigh.type === 'high') {
                    if (rightHigh.price < leftHigh.price && centerLow.price < leftHigh.price && centerLow.price < rightHigh.price) {
                        patterns.push({
                            type: 'support',
                            leftHigh: leftHigh.price,
                            centerLow: centerLow.price,
                            rightHigh: rightHigh.price,
                            index: centerLow.index,
                            price: centerLow.price,
                            entryZone: centerLow.price,
                            invalidation: Math.min(leftHigh.price, rightHigh.price),
                            target: leftHigh.price + (leftHigh.price - centerLow.price),
                            strength: Math.abs(leftHigh.price - centerLow.price)
                        });
                    }
                }
            }
        }
        this.qmLevels = patterns;
        return patterns;
    }

    detectDiamondPattern(lookback = 20) {
        const patterns = [];
        for (let i = lookback; i < this.data.length - lookback; i++) {
            const window = this.data.slice(i - lookback, i + lookback);
            const highs = window.map(c => c.high);
            const lows = window.map(c => c.low);
            const maxHigh = Math.max(...highs), minLow = Math.min(...lows), range = maxHigh - minLow;
            const midPoint = Math.floor(window.length / 2);
            const firstHalfVol = this.calculateVolatility(window.slice(0, midPoint));
            const secondHalfVol = this.calculateVolatility(window.slice(midPoint));
            if (firstHalfVol > secondHalfVol * 1.5 && range > 0) {
                patterns.push({
                    type: 'diamond',
                    startIndex: i - lookback,
                    endIndex: i + lookback,
                    resistance: maxHigh,
                    support: minLow,
                    breakout: this.detectBreakout(i, maxHigh, minLow),
                    center: (maxHigh + minLow) / 2
                });
            }
        }
        return patterns;
    }

    confirmSignalWithQM(sinal, currentPrice, candles, marginPercent = 0.5) {
        if (!candles || candles.length < 30) return { confirmed: false, reason: "Dados insuficientes" };
        const formattedData = candles.map((c, idx) => ({
            high: parseFloat(c.high),
            low: parseFloat(c.low),
            open: parseFloat(c.open),
            close: parseFloat(c.close),
            time: idx
        }));
        this.data = formattedData;
        this.findSwingPoints(3);
        const qmPatterns = this.findQuasimodoPatterns();
        if (qmPatterns.length === 0) return { confirmed: false, reason: "Nenhum padrão QM encontrado" };
        const recentPatterns = qmPatterns.filter(p => p.index >= formattedData.length - 20);
        if (recentPatterns.length === 0) return { confirmed: false, reason: "Nenhum padrão QM recente" };
        let bestMatch = null, minDistance = Infinity;
        const margin = currentPrice * (marginPercent / 100);
        for (const pattern of recentPatterns) {
            const distance = Math.abs(currentPrice - pattern.price);
            if (distance < minDistance && distance <= margin) {
                minDistance = distance;
                bestMatch = pattern;
            }
        }
        if (!bestMatch) return { confirmed: false, reason: "Nenhum nível QM próximo do preço atual", patterns: recentPatterns };
        let confirmed = false, confirmationType = "";
        if (bestMatch) {
            if (sinal === "CALL" && bestMatch.type === "support") {
                confirmed = true;
                confirmationType = "Suporte QM confirmado";
            } else if (sinal === "PUT" && bestMatch.type === "resistance") {
                confirmed = true;
                confirmationType = "Resistência QM confirmado";
            } else {
                confirmed = false;
                confirmationType = `QM não confirma (Tipo: ${bestMatch.type})`;
            }
        } else {
            confirmed = false;
            confirmationType = "Nenhum padrão QM próximo encontrado";
        }
        return {
            confirmed,
            pattern: bestMatch,
            confirmationType,
            distance: minDistance,
            distancePercent: (minDistance / currentPrice * 100).toFixed(2),
            allPatterns: recentPatterns
        };
    }

    generateCombinedSignal(candles, macdHistograma, rsi) {
        if (!candles || candles.length < 50) return { signal: "HOLD", confidence: 0, reason: "Dados insuficientes" };
        const formattedData = candles.map((c, idx) => ({
            high: parseFloat(c.high),
            low: parseFloat(c.low),
            open: parseFloat(c.open),
            close: parseFloat(c.close),
            time: idx
        }));
        this.data = formattedData;
        this.findSwingPoints(3);
        const qmPatterns = this.findQuasimodoPatterns();
        const diamondPatterns = this.detectDiamondPattern(15);
        const currentPrice = formattedData[formattedData.length - 1].close;
        const recentCandles = formattedData.slice(-5);
        let priceActionSignal = "NEUTRAL", priceActionConfidence = 0.5;
        const greenCandles = recentCandles.filter(c => c.close > c.open).length;
        const redCandles = recentCandles.filter(c => c.close < c.open).length;
        if (greenCandles >= 4) { priceActionSignal = "BULLISH"; priceActionConfidence = 0.7; }
        else if (redCandles >= 4) { priceActionSignal = "BEARISH"; priceActionConfidence = 0.7; }

        let qmSignal = "NEUTRAL", qmConfidence = 0.5, qmReason = "Sem padrões QM fortes";
        if (qmPatterns.length > 0) {
            const recentQM = qmPatterns[qmPatterns.length - 1];
            const distance = Math.abs(currentPrice - recentQM.price) / currentPrice * 100;
            if (distance < 1) {
                if (recentQM.type === "support") {
                    qmSignal = "BULLISH";
                    qmConfidence = 0.65;
                    qmReason = "Próximo a suporte QM";
                } else if (recentQM.type === "resistance") {
                    qmSignal = "BEARISH";
                    qmConfidence = 0.65;
                    qmReason = "Próximo a resistência QM";
                }
            }
        }

        let finalSignal = "HOLD", finalConfidence = 0, finalReason = "";
        const macdThreshold = Math.abs(macdHistograma) * 0.1;

        if (macdHistograma > macdThreshold && qmSignal === "BULLISH") {
            finalSignal = "CALL";
            finalConfidence = Math.min(0.8, (0.6 + qmConfidence) / 2);
            finalReason = "MACD positivo + Suporte QM";
        } else if (macdHistograma < -macdThreshold && qmSignal === "BEARISH") {
            finalSignal = "PUT";
            finalConfidence = Math.min(0.8, (0.6 + qmConfidence) / 2);
            finalReason = "MACD negativo + Resistência QM";
        } else if (priceActionSignal === "BULLISH" && qmSignal === "BULLISH") {
            finalSignal = "CALL";
            finalConfidence = (priceActionConfidence + qmConfidence) / 2;
            finalReason = `Price Action + ${qmReason}`;
        } else if (priceActionSignal === "BEARISH" && qmSignal === "BEARISH") {
            finalSignal = "PUT";
            finalConfidence = (priceActionConfidence + qmConfidence) / 2;
            finalReason = `Price Action + ${qmReason}`;
        } else if (Math.abs(macdHistograma) > 0.002) {
            finalSignal = macdHistograma > 0 ? "CALL" : "PUT";
            finalConfidence = 0.65;
            finalReason = "MACD forte";
        } else if (Math.abs(rsi - 50) > 20) {
            finalSignal = rsi < 30 ? "CALL" : "PUT";
            finalConfidence = 0.6;
            finalReason = "RSI extremo";
        }

        if (diamondPatterns.length > 0) {
            const diamond = diamondPatterns[diamondPatterns.length - 1];
            const inDiamond = currentPrice >= diamond.support && currentPrice <= diamond.resistance;
            if (inDiamond) {
                finalConfidence *= 1.1;
                finalReason += " | Dentro de Diamond Pattern";
            }
        }

        return {
            signal: finalSignal,
            confidence: Math.min(0.85, finalConfidence),
            reason: finalReason,
            qmPatterns,
            diamondPatterns,
            priceAction: priceActionSignal
        };
    }

    calculateVolatility(data) {
        if (!data || data.length === 0) return 0;
        const returns = [];
        for (let i = 1; i < data.length; i++) {
            returns.push(Math.abs(data[i].close - data[i - 1].close) / data[i - 1].close);
        }
        return returns.reduce((a, b) => a + b, 0) / returns.length;
    }

    detectBreakout(index, resistance, support) {
        const lookahead = 5;
        if (index + lookahead >= this.data.length) return 'NO_BREAKOUT';
        const futureCandles = this.data.slice(index, index + lookahead);
        for (let candle of futureCandles) {
            if (candle.close > resistance) return 'BULLISH_BREAKOUT';
            if (candle.close < support) return 'BEARISH_BREAKOUT';
        }
        return 'NO_BREAKOUT';
    }
}

module.exports = QuasimodoPattern;
