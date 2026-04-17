// liquidity-hunter-robusto.js
// Caça à liquidez profissional para Deriv (dados reais)
// Funciona com SNIPER, CAÇADOR, PESCADOR

/**
 * CONFIGURAÇÕES POR MODO
 *
 * IMPORTANTE — lookbacks devem ser SEMPRE menores que o candleCount
 * configurado em ALL_TIMEFRAMES_CONFIG no server.js:
 *   M1/M5/M15 = 150 candles  → lookbacks máx ~130
 *   M30        = 120 candles  → lookbacks máx ~100
 *   H1         = 100 candles  → lookbacks máx ~85
 *   H4         =  80 candles  → lookbacks máx ~65
 *   H24        =  60 candles  → lookbacks máx ~45
 *
 * Se lookback > candleCount disponível, o módulo retorna
 * "Candles insuficientes" e a liquidez não é calculada.
 */
const MODE_CONFIG = {
    SNIPER: {
        primaryTimeframe: 'M1',
        secondaryTimeframe: 'M5',
        tertiaryTimeframe: 'M15',
        // M1 tem 150 candles → lookbacks seguros abaixo de 130
        lookbacks: [20, 50],
        thresholdATRMultiplier: 0.5,
        thresholdPercent: 0.003,
        confirmCandles: 2,
        minTouchCount: 2,
        maxSweepAgeSeconds: 60,
        minAdxToOverride: 25,
        useTickVolume: true,
        minTickVolumeSpike: 1.5,
        psychologicalPrecision: 0.001
    },
    CAÇADOR: {
        primaryTimeframe: 'M5',
        secondaryTimeframe: 'M15',
        tertiaryTimeframe: 'H1',
        // M5 tem 150 candles → lookbacks seguros abaixo de 130
        lookbacks: [50, 100],
        thresholdATRMultiplier: 0.75,
        thresholdPercent: 0.005,
        confirmCandles: 1,
        minTouchCount: 2,
        maxSweepAgeSeconds: 180,
        minAdxToOverride: 22,
        useTickVolume: true,
        minTickVolumeSpike: 1.5,
        psychologicalPrecision: 0.001
    },
    PESCADOR: {
        primaryTimeframe: 'H1',
        secondaryTimeframe: 'H4',
        tertiaryTimeframe: 'H24',
        // FIX: H1 tem apenas 100 candles.
        // Lookbacks anteriores [100, 200] causavam erro "candles insuficientes"
        // porque Math.max(100, 200) = 200 > 100 disponíveis.
        // Novos lookbacks [50, 80] ficam dentro dos 100 candles do H1.
        lookbacks: [50, 80],
        thresholdATRMultiplier: 1.0,
        thresholdPercent: 0.01,
        confirmCandles: 1,
        minTouchCount: 2,
        maxSweepAgeSeconds: 3600,
        minAdxToOverride: 20,
        useTickVolume: true,
        minTickVolumeSpike: 1.5,
        psychologicalPrecision: 0.001
    }
};

/**
 * Calcula ATR a partir de candles
 */
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

/**
 * Obtém a contagem de ticks por candle
 */
function getTickVolume(candle) {
    return candle.tick_count || candle.tick_volume || 0;
}

/**
 * Média de tick volume nos últimos N candles
 */
function getAverageTickVolume(candles, lookback = 20) {
    const recent = candles.slice(-lookback);
    let sum = 0, count = 0;
    for (const c of recent) {
        const vol = getTickVolume(c);
        if (vol > 0) { sum += vol; count++; }
    }
    return count > 0 ? sum / count : 0;
}

/**
 * Encontra máximas e mínimas para múltiplos lookbacks
 */
function getMultiLevelHighLow(candles, lookbacks) {
    const resultHighs = {};
    const resultLows = {};
    for (const lb of lookbacks) {
        if (candles.length >= lb) {
            const slice = candles.slice(-lb);
            let maxHigh = -Infinity, minLow = Infinity;
            for (const c of slice) {
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

/**
 * Detecta níveis de suporte/resistência por toques múltiplos
 */
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

/**
 * Gera níveis psicológicos (preços redondos)
 */
function getPsychologicalLevels(currentPrice, precision, rangePercent = 0.02) {
    const levels = [];
    const range = currentPrice * rangePercent;
    const step = precision;
    let start = currentPrice - range;
    start = Math.floor(start / step) * step;
    let end = currentPrice + range;
    for (let p = start; p <= end; p += step) {
        if (Math.abs(p - currentPrice) > 0.0001) levels.push(p);
    }
    return levels;
}

/**
 * Verifica se o preço atual está "caçando" um nível específico
 */
function checkSweepOnLevel(currentPrice, level, threshold) {
    if (currentPrice > level + threshold) return 'above';
    if (currentPrice < level - threshold) return 'below';
    return null;
}

/**
 * Função principal de detecção de sweep de liquidez
 */
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

    // FIX: Verificação robusta de candles suficientes
    // Usa Math.max dos lookbacks mas com fallback para o máximo disponível
    const maxLookback = Math.max(...config.lookbacks);
    if (!candles || candles.length < 20) {
        return { sweepDetected: false, reason: `Candles insuficientes para ${primaryTF} (${candles?.length || 0} disponíveis, mínimo 20)` };
    }

    // Ajustar lookbacks dinamicamente se houver menos candles do que o esperado
    const effectiveLookbacks = config.lookbacks.map(lb => Math.min(lb, candles.length - 1)).filter(lb => lb >= 10);
    if (effectiveLookbacks.length === 0) {
        return { sweepDetected: false, reason: `Candles insuficientes para calcular lookbacks em ${primaryTF}` };
    }

    // 1. Calcular threshold
    let threshold = atrValue && atrValue > 0
        ? atrValue * config.thresholdATRMultiplier
        : currentPrice * config.thresholdPercent;
    const minThreshold = currentPrice * 0.0005;
    threshold = Math.max(threshold, minThreshold);

    // 2. Múltiplos níveis de liquidez (usando lookbacks efetivos)
    const { highs, lows } = getMultiLevelHighLow(candles, effectiveLookbacks);
    const allLevels = [];

    for (const lb of effectiveLookbacks) {
        if (highs[lb] !== null) {
            allLevels.push({ price: highs[lb], type: `HIGH_${lb}`, lookback: lb, direction: 'above' });
        }
        if (lows[lb] !== null) {
            allLevels.push({ price: lows[lb], type: `LOW_${lb}`, lookback: lb, direction: 'below' });
        }
    }

    // 3. Níveis de suporte/resistência
    const srLookback = Math.min(100, candles.length - 1);
    const srLevels = detectSupportResistanceLevels(candles, srLookback, threshold * 0.5, config.minTouchCount);
    for (const lvl of srLevels) {
        allLevels.push({ price: lvl.price, type: 'SR', touches: lvl.touches, direction: 'both' });
    }

    // 4. Níveis psicológicos
    const psyLevels = getPsychologicalLevels(currentPrice, config.psychologicalPrecision, 0.02);
    for (const pl of psyLevels) {
        allLevels.push({ price: pl, type: 'PSYCHOLOGICAL', direction: 'both' });
    }

    // 5. Verificar sweep em cada nível
    let bestSweep = null;
    for (const level of allLevels) {
        let direction = null;
        if (level.direction === 'above' || level.direction === 'both') {
            const check = checkSweepOnLevel(currentPrice, level.price, threshold);
            if (check === 'above') direction = 'PUT';
        }
        if (level.direction === 'below' || level.direction === 'both') {
            const check = checkSweepOnLevel(currentPrice, level.price, threshold);
            if (check === 'below') direction = 'CALL';
        }
        if (!direction) continue;

        let confidence = 65;
        let reasons = [];

        // Filtro de volume
        if (config.useTickVolume) {
            const avgVolume = getAverageTickVolume(candles, 20);
            const lastVolume = getTickVolume(candles[candles.length - 1]);
            if (avgVolume > 0 && lastVolume > avgVolume * config.minTickVolumeSpike) {
                confidence += 15;
                reasons.push(`Volume spike (${lastVolume} vs avg ${avgVolume.toFixed(0)})`);
            } else if (avgVolume > 0 && lastVolume < avgVolume * 0.5) {
                confidence -= 20;
                reasons.push(`Volume baixo (possível falso)`);
            }
        }

        // Idade do sweep
        const lastCandle = candles[candles.length - 1];
        const nowSec = Math.floor(Date.now() / 1000);
        const candleAgeSec = nowSec - (lastCandle.epoch || lastCandle.open_time);
        if (candleAgeSec > config.maxSweepAgeSeconds) continue;

        // Confirmação por distância
        const distance = direction === 'PUT' ? currentPrice - level.price : level.price - currentPrice;
        if (distance < threshold * 0.5) {
            confidence += 10;
            reasons.push(`Preço próximo ao nível`);
        } else {
            confidence -= 5;
        }

        // Contexto de timeframe superior
        const secondaryTF = config.secondaryTimeframe;
        const tertiaryTF = config.tertiaryTimeframe;
        if (analysisMap[secondaryTF] && analysisMap[secondaryTF].adx) {
            const adxSec = analysisMap[secondaryTF].adx;
            const trendSec = analysisMap[secondaryTF].sinal;
            if (adxSec > config.minAdxToOverride && trendSec !== 'HOLD') {
                if ((direction === 'CALL' && trendSec === 'PUT') || (direction === 'PUT' && trendSec === 'CALL')) {
                    confidence -= 25;
                    reasons.push(`Tendência forte contra no ${secondaryTF}`);
                } else {
                    confidence += 15;
                    reasons.push(`Sweep a favor da tendência no ${secondaryTF}`);
                }
            }
        }
        if (analysisMap[tertiaryTF] && analysisMap[tertiaryTF].adx) {
            const adxTer = analysisMap[tertiaryTF].adx;
            const trendTer = analysisMap[tertiaryTF].sinal;
            if (adxTer > 25) {
                if ((direction === 'CALL' && trendTer === 'PUT') || (direction === 'PUT' && trendTer === 'CALL')) {
                    confidence -= 15;
                } else {
                    confidence += 10;
                }
            }
        }

        // RSI extremo
        if (analysisMap[primaryTF] && analysisMap[primaryTF].rsi) {
            const rsi = analysisMap[primaryTF].rsi;
            if (direction === 'PUT' && rsi > 70) confidence += 10;
            if (direction === 'CALL' && rsi < 30) confidence += 10;
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
        return { sweepDetected: false, reason: 'Nenhum sweep relevante' };
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
