// analyzers/elliott-wave.js
class ElliottWaveMaster {
    constructor() {
        this.waves = [];
        this.currentWave = null;
        this.waveCount = 0;
        this.fibLevels = {};
        this.trend = 'NEUTRAL';
    }

    analyzeFull(data) {
        if (!data || data.length < 100) {
            return {
                waves: [],
                currentWave: null,
                trend: 'NEUTRAL',
                fibonacci: {},
                tradingSignals: [],
                confidence: 0,
                structure: { pattern: 'INCOMPLETE', phase: 'UNKNOWN', trend: 'NEUTRAL', waveCount: 0 }
            };
        }

        const prices = data.map(c => parseFloat(c.close));
        const highs = data.map(c => parseFloat(c.high));
        const lows = data.map(c => parseFloat(c.low));

        const pivots = this.findPivotPoints(prices, highs, lows);
        const waves = this.identifyWaves(pivots);
        const waveStructure = this.analyzeWaveStructure(waves);

        this.trend = waveStructure.trend;
        const fibonacci = this.calculateFibonacciLevels(waves);
        const tradingSignals = this.generateTradingSignals(waves, waveStructure, fibonacci, data[data.length - 1]);
        const confidence = this.calculateConfidence(waveStructure, tradingSignals);

        return {
            waves: waves,
            currentWave: waveStructure.currentWave,
            trend: waveStructure.trend,
            fibonacci: fibonacci,
            tradingSignals: tradingSignals,
            confidence: confidence,
            waveCount: waves.length,
            structure: waveStructure
        };
    }

    findPivotPoints(prices, highs, lows, lookback = 5) {
        const pivots = [];
        for (let i = lookback; i < prices.length - lookback; i++) {
            let isHighPivot = true, isLowPivot = true;
            for (let j = 1; j <= lookback; j++) {
                if (highs[i - j] >= highs[i] || highs[i + j] >= highs[i]) { isHighPivot = false; break; }
            }
            for (let j = 1; j <= lookback; j++) {
                if (lows[i - j] <= lows[i] || lows[i + j] <= lows[i]) { isLowPivot = false; break; }
            }
            if (isHighPivot) pivots.push({ index: i, price: highs[i], type: 'HIGH', time: i });
            if (isLowPivot) pivots.push({ index: i, price: lows[i], type: 'LOW', time: i });
        }
        return pivots.sort((a, b) => a.index - b.index);
    }

    identifyWaves(pivots) {
        if (pivots.length < 6) return [];
        const waves = [];
        for (let i = 2; i < pivots.length - 3; i++) {
            const p1 = pivots[i - 2], p2 = pivots[i - 1], p3 = pivots[i];
            if (p1.type === 'LOW' && p2.type === 'HIGH' && p3.type === 'LOW') {
                if (p3.price > p1.price) {
                    waves.push({ start: p1, end: p2, type: 'IMPULSE', number: waves.length + 1, trend: 'BULLISH' });
                    waves.push({ start: p2, end: p3, type: 'CORRECTION', number: waves.length + 1, trend: 'BULLISH' });
                }
            } else if (p1.type === 'HIGH' && p2.type === 'LOW' && p3.type === 'HIGH') {
                if (p3.price < p1.price) {
                    waves.push({ start: p1, end: p2, type: 'IMPULSE', number: waves.length + 1, trend: 'BEARISH' });
                    waves.push({ start: p2, end: p3, type: 'CORRECTION', number: waves.length + 1, trend: 'BEARISH' });
                }
            }
        }
        return waves.slice(-10);
    }

    analyzeWaveStructure(waves) {
        if (waves.length < 3) return { currentWave: null, trend: 'NEUTRAL', pattern: 'INCOMPLETE', phase: 'UNKNOWN' };
        const lastWave = waves[waves.length - 1];
        const prevWave = waves[waves.length - 2];
        let pattern = 'UNKNOWN', phase = 'UNKNOWN', trend = lastWave.trend;
        if (lastWave.type === 'CORRECTION' && prevWave.type === 'IMPULSE') {
            pattern = 'ABC_CORRECTION';
            phase = 'CORRECTION_PHASE';
        } else if (lastWave.type === 'IMPULSE' && prevWave.type === 'CORRECTION') {
            pattern = 'IMPULSE_WAVE';
            phase = 'IMPULSE_PHASE';
            if (waves.length >= 5) {
                const impulseWaves = waves.filter(w => w.type === 'IMPULSE');
                if (impulseWaves.length === 3) { pattern = 'WAVE_3_EXTENSION'; phase = 'STRONG_TREND'; }
            }
        }
        return { currentWave: lastWave, previousWave: prevWave, pattern, phase, trend, waveCount: waves.length };
    }

    calculateFibonacciLevels(waves) {
        if (waves.length < 2) return {};

        const impulseWaves = waves.filter(w => w.type === 'IMPULSE');
        if (impulseWaves.length < 1) return {};

        const lastImpulse = impulseWaves[impulseWaves.length - 1];
        const start = lastImpulse.start.price;
        const end = lastImpulse.end.price;
        const diff = end - start;

        return {
            '0.236': start + diff * 0.236,
            '0.382': start + diff * 0.382,
            '0.5': start + diff * 0.5,
            '0.618': start + diff * 0.618,
            '0.786': start + diff * 0.786,
            '1.0': end,
            '1.272': start + diff * 1.272,
            '1.618': start + diff * 1.618
        };
    }

    generateTradingSignals(waves, structure, fibonacci, currentCandle) {
        const signals = [];
        const currentPrice = parseFloat(currentCandle.close);
        const atr = Math.abs(currentCandle.high - currentCandle.low);

        if (waves.length < 3) return signals;
        const lastWave = waves[waves.length - 1];

        if (structure.phase === 'STRONG_TREND' && structure.pattern === 'WAVE_3_EXTENSION') {
            if (structure.trend === 'BULLISH') {
                signals.push({
                    type: 'BUY',
                    reason: 'Onda 3 de Elliott em progresso',
                    strength: 'STRONG',
                    entry: currentPrice,
                    stopLoss: currentPrice - atr * 1.5,
                    takeProfit: currentPrice + atr * 2,
                    confidence: 0.75
                });
            } else {
                signals.push({
                    type: 'SELL',
                    reason: 'Onda 3 de Elliott em progresso',
                    strength: 'STRONG',
                    entry: currentPrice,
                    stopLoss: currentPrice + atr * 1.5,
                    takeProfit: currentPrice - atr * 2,
                    confidence: 0.75
                });
            }
        }

        if (Object.keys(fibonacci).length > 0) {
            for (const [level, price] of Object.entries(fibonacci)) {
                const threshold = currentPrice * 0.005;
                if (Math.abs(currentPrice - price) < threshold) {
                    if (level === '0.618' || level === '0.5') {
                        const signalType = structure.trend === 'BULLISH' ? 'BUY' : 'SELL';
                        signals.push({
                            type: signalType,
                            reason: `Preço no nível Fibonacci ${level}`,
                            strength: 'MEDIUM',
                            entry: currentPrice,
                            stopLoss: signalType === 'BUY' ? currentPrice - atr * 1.5 : currentPrice + atr * 1.5,
                            takeProfit: signalType === 'BUY' ? currentPrice + atr * 2 : currentPrice - atr * 2,
                            confidence: 0.65
                        });
                    }
                }
            }
        }

        if (structure.pattern === 'ABC_CORRECTION') {
            if (lastWave.trend === 'BULLISH' && structure.trend === 'BULLISH') {
                signals.push({
                    type: 'BUY',
                    reason: 'Fim da correção ABC, retomada da tendência',
                    strength: 'MEDIUM',
                    entry: currentPrice,
                    stopLoss: currentPrice - atr * 1.5,
                    takeProfit: currentPrice + atr * 2,
                    confidence: 0.7
                });
            } else if (lastWave.trend === 'BEARISH' && structure.trend === 'BEARISH') {
                signals.push({
                    type: 'SELL',
                    reason: 'Fim da correção ABC, retomada da tendência',
                    strength: 'MEDIUM',
                    entry: currentPrice,
                    stopLoss: currentPrice + atr * 1.5,
                    takeProfit: currentPrice - atr * 2,
                    confidence: 0.7
                });
            }
        }
        return signals;
    }

    calculateConfidence(structure, signals) {
        let confidence = 0.5;
        if (structure.pattern === 'WAVE_3_EXTENSION') confidence = 0.8;
        else if (structure.pattern === 'ABC_CORRECTION') confidence = 0.7;
        else if (structure.pattern === 'IMPULSE_WAVE') confidence = 0.65;
        if (signals.length > 0) confidence += 0.1;
        return Math.min(0.9, confidence);
    }

    getWavePosition(currentPrice, fibonacci) {
        if (!fibonacci || typeof fibonacci !== 'object' || Object.keys(fibonacci).length === 0) return 'NEUTRAL';
        let position = 'NEUTRAL';
        for (const [level, price] of Object.entries(fibonacci)) {
            const threshold = currentPrice * 0.01;
            if (Math.abs(currentPrice - price) < threshold) {
                if (level === '0.618' || level === '0.5') position = 'FIBONACCI_SUPPORT';
                else if (level === '1.618' || level === '1.272') position = 'FIBONACCI_RESISTANCE';
                else if (level === '0.236' || level === '0.382') position = 'FIBONACCI_RETRACEMENT';
                break;
            }
        }
        return position;
    }
}

module.exports = ElliottWaveMaster;
