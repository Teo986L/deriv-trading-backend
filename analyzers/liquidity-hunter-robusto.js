// liquidity-hunter-robusto.js
// Caça à liquidez profissional para Deriv (dados reais)
// Versão 2.3 - Calibragem equilibrada (mais sinais, mesma qualidade)

const MODE_CONFIG = {
    SNIPER: {
        primaryTimeframe: 'M1',
        secondaryTimeframe: 'M5',
        tertiaryTimeframe: 'M15',
        lookbacks: [20, 50],
        thresholdATRMultiplier: 0.5,
        thresholdPercent: 0.003,
        confirmCandles: 2,
        minTouchCount: 2,
        maxSweepAgeSeconds: 60,
        minAdxToOverride: 25,
        useTickVolume: true,
        minTickVolumeSpike: 1.5,
        psychologicalPrecision: null
    },
    CAÇADOR: {
        primaryTimeframe: 'M5',
        secondaryTimeframe: 'M15',
        tertiaryTimeframe: 'H1',
        lookbacks: [50, 100],
        thresholdATRMultiplier: 0.75,
        thresholdPercent: 0.005,
        confirmCandles: 1,
        minTouchCount: 2,
        maxSweepAgeSeconds: 180,
        minAdxToOverride: 22,
        useTickVolume: true,
        minTickVolumeSpike: 1.5,
        psychologicalPrecision: null
    },
    PESCADOR: {
        primaryTimeframe: 'H1',
        secondaryTimeframe: 'H4',
        tertiaryTimeframe: 'H24',
        lookbacks: [50, 80],
        thresholdATRMultiplier: 1.0,
        thresholdPercent: 0.01,
        confirmCandles: 1,
        minTouchCount: 2,
        maxSweepAgeSeconds: 3600,
        minAdxToOverride: 20,
        useTickVolume: true,
        minTickVolumeSpike: 1.5,
        psychologicalPrecision: null
    }
};

// Pesos para escolha do melhor nível dentro de uma zona
const LEVEL_TYPE_WEIGHT = {
    'HIGH': 3,
    'LOW': 3,
    'SR': 2,
    'PSYCHOLOGICAL': 1
};

function getDynamicPrecision(price) {
    if (price >= 10000) return 10.0;
    if (price >= 1000) return 1.0;
    if (price >= 100) return 0.1;
    if (price >= 10) return 0.01;
    return 0.001;
}

function calculateATR(candles, period = 14) {
    if (!candles || candles.length < period + 1) return null;
    let trSum = 0;
    for (let i = 1; i <= period; i++) {
        const high = candles[i].high;
        const low = candles[i].low;
        const prevClose = candles[i-1].close;
        const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
        trSum += tr;
    }
    return trSum / period;
}

function getTickVolume(candle) {
    return candle.tick_count || candle.tick_volume || 0;
}

function getAverageTickVolume(candles, lookback = 20) {
    const recent = candles.slice(-lookback);
    let sum = 0, count = 0;
    for (const c of recent) {
        const vol = getTickVolume(c);
        if (vol > 0) { sum += vol; count++; }
    }
    return count > 0 ? sum / count : 0;
}

function getMultiLevelHighLow(candles, lookbacks) {
    const resultHighs = {};
    const resultLows = {};
    const len = candles.length;

    for (const lb of lookbacks) {
        if (len >= lb) {
            let maxHigh = -Infinity, minLow = Infinity;
            const startIdx = len - lb;
            for (let i = startIdx; i < len; i++) {
                const c = candles[i];
                if (c.high > maxHigh) maxHigh = c.high;
                if (c.low < minLow) minLow = c.low;
            }
            resultHighs[lb] = maxHigh;
            resultLows[lb] = minLow;
        } else {
            resultHighs[lb] = null;
            resultLows[lb] = null;
        }
    }
    return { highs: resultHighs, lows: resultLows };
}

function detectSupportResistanceLevels(candles, lookback, tolerance = 0.002, minTouches = 2) {
    const recent = candles.slice(-lookback);
    const levels = new Map();
    for (const candle of recent) {
        const candidates = [candle.high, candle.low, candle.close];
        for (const price of candidates) {
            const rounded = Math.round(price / tolerance) * tolerance;
            if (!levels.has(rounded)) levels.set(rounded, { price: rounded, touches: 0 });
            levels.get(rounded).touches++;
        }
    }
    const result = [];
    for (const [_, level] of levels) {
        if (level.touches >= minTouches) {
            result.push({ price: level.price, touches: level.touches, type: 'support_resistance' });
        }
    }
    result.sort((a, b) => a.price - b.price);
    return result;
}

function getPsychologicalLevels(currentPrice, precision, rangePercent = 0.015) {
    const levels = [];
    const step = precision || getDynamicPrecision(currentPrice);
    const range = currentPrice * rangePercent;
    let start = currentPrice - range;
    start = Math.floor(start / step) * step;
    let end = currentPrice + range;
    for (let p = start; p <= end; p += step) {
        if (Math.abs(p - currentPrice) > step * 0.1) levels.push(p);
    }
    return levels;
}

function isStrongRejection(candle, direction) {
    const body = Math.abs(candle.close - candle.open);
    if (body === 0) return true;
    if (direction === 'above') {
        const wick = candle.high - Math.max(candle.open, candle.close);
        return wick > body * 1.2;   // ← Relaxado de 1.5 para 1.2
    } else {
        const wick = Math.min(candle.open, candle.close) - candle.low;
        return wick > body * 1.2;
    }
}

function isRealSweep(candles, level, direction, threshold) {
    if (!candles || candles.length < 2) return false;
    const lastClosed = candles[candles.length - 2];
    
    if (direction === 'above') {
        if (lastClosed.high > level + threshold && lastClosed.close < level) {
            return isStrongRejection(lastClosed, 'above');
        }
    } else {
        if (lastClosed.low < level - threshold && lastClosed.close > level) {
            return isStrongRejection(lastClosed, 'below');
        }
    }
    return false;
}

function confirmFollowThrough(candles, direction, threshold) {
    if (candles.length < 2) return false;
    const sweepCandle = candles[candles.length - 2];
    const currentCandle = candles[candles.length - 1];
    
    const move = Math.abs(currentCandle.close - sweepCandle.close);
    const minMove = threshold * 0.15;   // ← Relaxado de 0.3 para 0.15
    
    if (direction === 'PUT') {
        return currentCandle.close < sweepCandle.close && move >= minMove;
    } else {
        return currentCandle.close > sweepCandle.close && move >= minMove;
    }
}

function getCandleEpochSec(candle) {
    if (!candle) return null;
    let epoch = candle.epoch || candle.open_time;
    if (!epoch) return null;
    return epoch > 1e12 ? Math.floor(epoch / 1000) : epoch;
}

function groupNearbyLevels(levels, threshold) {
    if (levels.length === 0) return [];
    const sorted = [...levels].sort((a, b) => a.price - b.price);
    const zones = [];
    let currentZone = [sorted[0]];
    
    for (let i = 1; i < sorted.length; i++) {
        const prev = currentZone[currentZone.length - 1];
        if (Math.abs(sorted[i].price - prev.price) <= threshold * 2) {
            currentZone.push(sorted[i]);
        } else {
            zones.push(currentZone);
            currentZone = [sorted[i]];
        }
    }
    zones.push(currentZone);
    
    return zones.map(zone => {
        const best = zone.reduce((a, b) => {
            const weightA = (LEVEL_TYPE_WEIGHT[a.type?.split('_')[0]] || 1) + (a.touches || 0) * 0.5;
            const weightB = (LEVEL_TYPE_WEIGHT[b.type?.split('_')[0]] || 1) + (b.touches || 0) * 0.5;
            return weightA > weightB ? a : b;
        });
        return { ...best, zoneSize: zone.length };
    });
}

function detectLiquiditySweepRobusto({
    mode,
    currentPrice,
    candlesMap,
    analysisMap,
    atrValue = null
}) {
    const config = MODE_CONFIG[mode];
    if (!config) {
        return { sweepDetected: false, error: `Modo ${mode} inválido` };
    }

    const primaryTF = config.primaryTimeframe;
    const candles = candlesMap[primaryTF];

    const maxLookback = Math.max(...config.lookbacks);
    if (!candles || candles.length < Math.max(20, maxLookback)) {
        return { sweepDetected: false, reason: `Candles insuficientes para ${primaryTF}` };
    }

    const effectiveLookbacks = config.lookbacks.map(lb => Math.min(lb, candles.length - 2)).filter(lb => lb >= 10);
    if (effectiveLookbacks.length === 0) {
        return { sweepDetected: false, reason: `Lookbacks inválidos para ${primaryTF}` };
    }

    let threshold = atrValue && atrValue > 0
        ? atrValue * config.thresholdATRMultiplier
        : currentPrice * config.thresholdPercent;
    threshold = Math.max(threshold, currentPrice * 0.0005);

    const { highs, lows } = getMultiLevelHighLow(candles, effectiveLookbacks);
    let allLevels = [];

    for (const lb of effectiveLookbacks) {
        if (highs[lb] !== null) allLevels.push({ price: highs[lb], type: `HIGH_${lb}`, lookback: lb, direction: 'above', touches: 1 });
        if (lows[lb] !== null) allLevels.push({ price: lows[lb], type: `LOW_${lb}`, lookback: lb, direction: 'below', touches: 1 });
    }

    const srLookback = Math.min(100, candles.length - 1);
    const srLevels = detectSupportResistanceLevels(candles, srLookback, threshold * 0.5, config.minTouchCount);
    for (const lvl of srLevels) {
        allLevels.push({ price: lvl.price, type: 'SR', touches: lvl.touches, direction: 'both' });
    }

    const precision = getDynamicPrecision(currentPrice);
    const psyLevels = getPsychologicalLevels(currentPrice, precision, 0.015); // range reduzido
    for (const pl of psyLevels) {
        allLevels.push({ price: pl, type: 'PSYCHOLOGICAL', touches: 1, direction: 'both' });
    }

    const groupedLevels = groupNearbyLevels(allLevels, threshold);
    let bestSweep = null;

    const primaryAnalysis = analysisMap[primaryTF];
    const primaryADX = primaryAnalysis?.adx || 0;
    const primaryTrend = primaryAnalysis?.sinal || 'HOLD';

    for (const level of groupedLevels) {
        let direction = null;
        let isSweep = false;

        if (level.direction === 'above' || level.direction === 'both') {
            if (isRealSweep(candles, level.price, 'above', threshold)) {
                direction = 'PUT';
                isSweep = true;
            }
        }
        if (!isSweep && (level.direction === 'below' || level.direction === 'both')) {
            if (isRealSweep(candles, level.price, 'below', threshold)) {
                direction = 'CALL';
                isSweep = true;
            }
        }
        if (!isSweep) continue;

        if (!confirmFollowThrough(candles, direction, threshold)) {
            continue;
        }

        let confidence = 60;  // ← Base ligeiramente menor
        let reasons = [`Sweep real c/ rejeição`];

        const lastClosed = candles[candles.length - 2];
        const epochSec = getCandleEpochSec(lastClosed);
        if (!epochSec) continue;
        
        const nowSec = Math.floor(Date.now() / 1000);
        const candleAgeSec = nowSec - epochSec;
        if (candleAgeSec > config.maxSweepAgeSeconds) continue;

        // Filtro de tendência: só reduz se for CONTRA uma tendência forte
        if (primaryADX > 30) {
            if ((direction === 'CALL' && primaryTrend === 'PUT') || (direction === 'PUT' && primaryTrend === 'CALL')) {
                confidence -= 20;
                reasons.push(`Contra tendência forte (ADX ${primaryADX.toFixed(1)})`);
            } else if ((direction === 'CALL' && primaryTrend === 'CALL') || (direction === 'PUT' && primaryTrend === 'PUT')) {
                confidence += 15;
                reasons.push(`A favor da tendência forte`);
            }
        }

        const distance = direction === 'PUT' ? currentPrice - level.price : level.price - currentPrice;
        if (distance < threshold * 1.0) {   // ← Mais flexível
            confidence += 10;
            reasons.push(`Preço próximo ao nível`);
        } else if (distance > threshold * 3) {  // ← Penalidade mais distante
            confidence -= 10;
        }

        if (config.useTickVolume) {
            const avgVolume = getAverageTickVolume(candles, 20);
            const lastVolume = getTickVolume(lastClosed);
            if (avgVolume > 0 && lastVolume > avgVolume * config.minTickVolumeSpike) {
                confidence += 5;   // ← Peso reduzido
                reasons.push(`Volume elevado`);
            } else if (avgVolume > 0 && lastVolume < avgVolume * 0.5) {
                confidence -= 8;
                reasons.push(`Volume baixo`);
            }
        }

        const secondaryTF = config.secondaryTimeframe;
        const tertiaryTF = config.tertiaryTimeframe;
        if (analysisMap[secondaryTF]?.adx > config.minAdxToOverride) {
            const trendSec = analysisMap[secondaryTF].sinal;
            if (trendSec !== 'HOLD') {
                if ((direction === 'CALL' && trendSec === 'PUT') || (direction === 'PUT' && trendSec === 'CALL')) {
                    confidence -= 20;
                    reasons.push(`Contra tendência no ${secondaryTF}`);
                } else {
                    confidence += 12;
                    reasons.push(`A favor da tendência no ${secondaryTF}`);
                }
            }
        }
        if (analysisMap[tertiaryTF]?.adx > 25) {
            const trendTer = analysisMap[tertiaryTF].sinal;
            if ((direction === 'CALL' && trendTer === 'PUT') || (direction === 'PUT' && trendTer === 'CALL')) {
                confidence -= 10;
            } else {
                confidence += 8;
            }
        }

        if (analysisMap[primaryTF]?.rsi) {
            const rsi = analysisMap[primaryTF].rsi;
            if (direction === 'PUT' && rsi > 70) confidence += 8;
            if (direction === 'CALL' && rsi < 30) confidence += 8;
        }

        confidence = Math.min(100, Math.max(0, confidence));

        if (confidence >= 55 && (!bestSweep || confidence > bestSweep.confidence)) {
            bestSweep = {
                direction,
                confidence,
                level: level.price,
                levelType: level.type,
                threshold,
                distance,
                candleAgeSec,
                reasons: reasons.join('; ')
            };
        }
    }

    if (!bestSweep) {
        return { sweepDetected: false, reason: 'Nenhum sweep real confirmado' };
    }

    return {
        sweepDetected: true,
        direction: bestSweep.direction,
        confidence: bestSweep.confidence,
        liquidityZone: {
            level: bestSweep.level,
            type: bestSweep.levelType,
            direction: bestSweep.direction,
            threshold: bestSweep.threshold,
            distance: bestSweep.distance
        },
        details: {
            primaryTimeframe: primaryTF,
            lookbacks: effectiveLookbacks,
            candleAgeSec: bestSweep.candleAgeSec,
            reasons: bestSweep.reasons
        }
    };
}

module.exports = {
    detectLiquiditySweepRobusto,
    calculateATR,
    MODE_CONFIG
};
