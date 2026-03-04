// institutional-sniper.js
const CONFIG = {
    ADX_TREND_MIN: 20,
    RSI_PULLBACK_MIN: 40,
    RSI_PULLBACK_MAX: 60,
    STRONG_CLOSE_RATIO: 0.6,
    REJECTION_MULTIPLIER: 1.5,
    H1_OPENING_WINDOW_MINUTES: 30,
    LIQUIDITY_LOOKBACK: 10,
    FAKE_LOOKBACK: 10,
    MIN_BODY_RATIO_FOR_REJECTION: 0.1
};

// Funções auxiliares
const bullish = c => c.close > c.open;
const bearish = c => c.close < c.open;
const body = c => Math.abs(c.close - c.open);
const upperWick = c => c.high - Math.max(c.open, c.close);
const lowerWick = c => Math.min(c.open, c.close) - c.low;

function isValidNumber(value) {
    return typeof value === 'number' && !isNaN(value) && isFinite(value);
}

function isCandleComplete(candle) {
    return candle && typeof candle.open === 'number' && typeof candle.high === 'number' &&
        typeof candle.low === 'number' && typeof candle.close === 'number' &&
        candle.high >= candle.low && candle.high >= candle.open && candle.high >= candle.close &&
        candle.low <= candle.open && candle.low <= candle.close;
}

function strongClose(candle) {
    const b = body(candle);
    const range = candle.high - candle.low;
    if (range === 0) return false;
    return (b / range) >= CONFIG.STRONG_CLOSE_RATIO;
}

function isH1OpeningWindow(serverTime = Date.now()) {
    const date = new Date(serverTime);
    const minutes = date.getUTCMinutes();
    return minutes >= 0 && minutes < CONFIG.H1_OPENING_WINDOW_MINUTES;
}

function marketTrending(adx) {
    return isValidNumber(adx) && adx >= CONFIG.ADX_TREND_MIN;
}

function rsiPullbackZone(rsi) {
    return isValidNumber(rsi) && rsi >= CONFIG.RSI_PULLBACK_MIN && rsi <= CONFIG.RSI_PULLBACK_MAX;
}

function wickRejection(candle) {
    const b = body(candle);
    const range = candle.high - candle.low;
    if (range === 0 || b / range < CONFIG.MIN_BODY_RATIO_FOR_REJECTION) {
        return { bullishReject: false, bearishReject: false };
    }

    const up = upperWick(candle);
    const low = lowerWick(candle);

    const bearishReject = bearish(candle) && up > b * CONFIG.REJECTION_MULTIPLIER;
    const bullishReject = bullish(candle) && low > b * CONFIG.REJECTION_MULTIPLIER;

    return { bullishReject, bearishReject };
}

function detectLiquidityGrab(candles, lookback = CONFIG.LIQUIDITY_LOOKBACK) {
    if (!candles || candles.length < lookback + 1) return { grabUp: false, grabDown: false };

    const last = candles.at(-1);
    const previousCandles = candles.slice(-lookback - 1, -1);
    const maxHigh = Math.max(...previousCandles.map(c => c.high));
    const minLow = Math.min(...previousCandles.map(c => c.low));

    const grabUp = last.high > maxHigh && last.close < maxHigh;
    const grabDown = last.low < minLow && last.close > minLow;

    return { grabUp, grabDown };
}

function detectFakeBreakout(candles, lookback = CONFIG.FAKE_LOOKBACK) {
    if (!candles || candles.length < lookback + 1) return { fakeUp: false, fakeDown: false };

    const last = candles.at(-1);
    const previousCandles = candles.slice(-lookback - 1, -1);
    const maxHigh = Math.max(...previousCandles.map(c => c.high));
    const minLow = Math.min(...previousCandles.map(c => c.low));

    const fakeUp = last.high > maxHigh && bearish(last);
    const fakeDown = last.low < minLow && bullish(last);

    return { fakeUp, fakeDown };
}

function analyzeTimeframes(timeframesData) {
    if (!timeframesData) return { agreementScore: 0, consensusTrend: null };

    let totalScore = 0;
    let count = 0;
    let callVotes = 0;
    let putVotes = 0;

    for (const [tf, data] of Object.entries(timeframesData)) {
        if (data && data.trend) {
            if (data.trend === 'CALL') callVotes++;
            else if (data.trend === 'PUT') putVotes++;
            if (isValidNumber(data.adx) && data.adx >= CONFIG.ADX_TREND_MIN) totalScore += 10;
            if (isValidNumber(data.rsi) && data.rsi >= CONFIG.RSI_PULLBACK_MIN && data.rsi <= CONFIG.RSI_PULLBACK_MAX) totalScore += 10;
            count++;
        }
    }

    const agreementScore = count > 0 ? totalScore / count : 0;
    const consensusTrend = callVotes > putVotes ? 'CALL' : (putVotes > callVotes ? 'PUT' : null);

    return { agreementScore, consensusTrend };
}

function getRating(score) {
    if (score >= 90) return "A+";
    if (score >= 80) return "A";
    if (score >= 60) return "B";
    return "C";
}

function institutionalSniper({
    trendH1,
    candlesM15,
    rsiM15,
    adxM15,
    agreementScore,
    serverTime,
    timeframes = {}
}) {
    if (!candlesM15 || candlesM15.length < 5) return null;

    const lastCandle = candlesM15.at(-1);
    if (!isCandleComplete(lastCandle)) {
        console.warn("institutionalSniper: último candle incompleto, aguardando fechamento.");
        return null;
    }

    if (!isValidNumber(rsiM15) || !isValidNumber(adxM15)) {
        console.warn("institutionalSniper: indicadores M15 inválidos");
        return null;
    }

    let finalAgreementScore = isValidNumber(agreementScore) ? agreementScore : 0;
    let consensusTrend = trendH1;

    if (timeframes && Object.keys(timeframes).length > 0) {
        const mtfAnalysis = analyzeTimeframes(timeframes);
        if (mtfAnalysis.agreementScore > 0) {
            finalAgreementScore = mtfAnalysis.agreementScore;
        }
        if (mtfAnalysis.consensusTrend) {
            consensusTrend = mtfAnalysis.consensusTrend;
        }
    }

    // if (!isH1OpeningWindow(serverTime)) return null;

    const prev = candlesM15.at(-2);
    const prev2 = candlesM15.at(-3);

    let score = 0;

    if (!marketTrending(adxM15)) return null;
    score += 15;

    if (!rsiPullbackZone(rsiM15)) return null;
    score += 15;

    const correctionBuy = bearish(prev) && bearish(prev2);
    const correctionSell = bullish(prev) && bullish(prev2);
    if (correctionBuy || correctionSell) score += 10;

    const liquidity = detectLiquidityGrab(candlesM15);
    if (liquidity.grabDown || liquidity.grabUp) score += 20;

    const fake = detectFakeBreakout(candlesM15);
    if (fake.fakeDown || fake.fakeUp) score += 20;

    const rejection = wickRejection(lastCandle);
    if (rejection.bullishReject || rejection.bearishReject) score += 15;

    if (finalAgreementScore >= 60) score += 20;

    if (consensusTrend === "CALL" &&
        correctionBuy &&
        bullish(lastCandle) &&
        strongClose(lastCandle) &&
        (rejection.bullishReject || liquidity.grabDown || fake.fakeDown)) {
        score += 30;
        return {
            signal: "CALL",
            type: "INSTITUTIONAL_SNIPER",
            confidence: score,
            rating: getRating(score),
            timeframeAnalysis: { consensusTrend, agreementScore: finalAgreementScore }
        };
    }

    if (consensusTrend === "PUT" &&
        correctionSell &&
        bearish(lastCandle) &&
        strongClose(lastCandle) &&
        (rejection.bearishReject || liquidity.grabUp || fake.fakeUp)) {
        score += 30;
        return {
            signal: "PUT",
            type: "INSTITUTIONAL_SNIPER",
            confidence: score,
            rating: getRating(score),
            timeframeAnalysis: { consensusTrend, agreementScore: finalAgreementScore }
        };
    }

    return null;
}

module.exports = {
    institutionalSniper,
    bullish,
    bearish,
    strongClose,
    wickRejection,
    detectLiquidityGrab,
    detectFakeBreakout,
    CONFIG
};
