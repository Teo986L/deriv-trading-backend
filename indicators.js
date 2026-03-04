// indicators.js
function calcularMediaSimples(precos, periodo) {
    if (!precos || precos.length === 0) return 0;
    if (precos.length < periodo) return precos.reduce((a, b) => a + b, 0) / precos.length;
    const slice = precos.slice(-periodo);
    return slice.reduce((a, b) => a + b, 0) / periodo;
}

function calcularMediaExponencial(precos, periodo) {
    if (!precos || precos.length === 0) return 0;
    if (precos.length < periodo) return precos.reduce((a, b) => a + b, 0) / precos.length;
    let ema = [precos.slice(0, periodo).reduce((a, b) => a + b, 0) / periodo];
    const multiplicador = 2 / (periodo + 1);
    for (let i = periodo; i < precos.length; i++) {
        const novaEma = (precos[i] * multiplicador) + (ema[ema.length - 1] * (1 - multiplicador));
        ema.push(novaEma);
    }
    return ema[ema.length - 1];
}

function calcularRSI(precos, periodo = 14) {
    if (!precos || precos.length < periodo + 1) return 50;
    let ganhos = 0, perdas = 0;
    for (let i = 1; i <= periodo; i++) {
        const diff = precos[i] - precos[i - 1];
        if (diff >= 0) ganhos += diff;
        else perdas += Math.abs(diff);
    }
    let avgGanho = ganhos / periodo;
    let avgPerda = perdas / periodo;
    for (let i = periodo + 1; i < precos.length; i++) {
        const diff = precos[i] - precos[i - 1];
        const ganhoAtual = diff >= 0 ? diff : 0;
        const perdaAtual = diff < 0 ? Math.abs(diff) : 0;
        avgGanho = ((avgGanho * (periodo - 1)) + ganhoAtual) / periodo;
        avgPerda = ((avgPerda * (periodo - 1)) + perdaAtual) / periodo;
    }
    if (avgPerda === 0) return 100;
    const rs = avgGanho / avgPerda;
    return 100 - (100 / (1 + rs));
}

function calcularMACD(precos, fast = 12, slow = 26, signal = 9) {
    if (!precos || precos.length < slow) return { macd: 0, sinal: 0, histograma: 0, valido: false };
    try {
        const emaRapida = calcularMediaExponencial(precos, fast);
        const emaLenta = calcularMediaExponencial(precos, slow);
        const linhaMACD = emaRapida - emaLenta;
        let linhaSinal = 0;
        if (precos.length >= slow + signal) {
            const historicoMACD = [];
            for (let i = slow - 1; i < precos.length; i++) {
                const slice = precos.slice(0, i + 1);
                const emaR = calcularMediaExponencial(slice, fast);
                const emaL = calcularMediaExponencial(slice, slow);
                historicoMACD.push(emaR - emaL);
            }
            if (historicoMACD.length >= signal) {
                const ultimosMACDs = historicoMACD.slice(-signal);
                linhaSinal = calcularMediaExponencial(ultimosMACDs, signal);
            } else {
                linhaSinal = historicoMACD.reduce((a, b) => a + b, 0) / historicoMACD.length;
            }
        } else {
            const historicoRecente = [];
            const inicio = Math.max(0, precos.length - slow);
            for (let i = inicio; i < precos.length; i++) {
                const slice = precos.slice(0, i + 1);
                const emaR = calcularMediaExponencial(slice, fast);
                const emaL = calcularMediaExponencial(slice, slow);
                historicoRecente.push(emaR - emaL);
            }
            if (historicoRecente.length > 0) {
                linhaSinal = historicoRecente.reduce((a, b) => a + b, 0) / historicoRecente.length;
            } else {
                linhaSinal = linhaMACD * 0.98;
            }
        }
        const histograma = linhaMACD - linhaSinal;
        return {
            macd: linhaMACD,
            sinal: linhaSinal,
            histograma,
            valido: true,
            direcao: histograma > 0 ? 'BULLISH' : 'BEARISH',
            forca: Math.abs(histograma)
        };
    } catch (error) {
        console.error("Erro calculando MACD:", error);
        return { macd: 0, sinal: 0, histograma: 0, valido: false };
    }
}

function calcularADXCompleto(candles, periodo = 14) {
    if (!candles || candles.length < periodo * 2) {
        return { adx: 25.0, plusDI: 50, minusDI: 50, tendenciaForca: "FRACA", tendenciaDirecao: "NEUTRAL", cruzamentoDI: "NENHUM" };
    }
    try {
        const highs = candles.map(c => parseFloat(c.high));
        const lows = candles.map(c => parseFloat(c.low));
        const closes = candles.map(c => parseFloat(c.close));
        const trValues = [], plusDMValues = [], minusDMValues = [];
        for (let i = 1; i < highs.length; i++) {
            const highLow = highs[i] - lows[i];
            const highPrevClose = Math.abs(highs[i] - closes[i - 1]);
            const lowPrevClose = Math.abs(lows[i] - closes[i - 1]);
            trValues.push(Math.max(highLow, highPrevClose, lowPrevClose));

            const upMove = highs[i] - highs[i - 1];
            const downMove = lows[i - 1] - lows[i];
            if (upMove > downMove && upMove > 0) {
                plusDMValues.push(upMove);
                minusDMValues.push(0);
            } else if (downMove > upMove && downMove > 0) {
                plusDMValues.push(0);
                minusDMValues.push(downMove);
            } else {
                plusDMValues.push(0);
                minusDMValues.push(0);
            }
        }

        const wilderSmooth = (values, period) => {
            if (!values || values.length === 0) return [0];
            if (values.length < period) {
                const avg = values.reduce((a, b) => a + b, 0) / values.length;
                return Array(values.length).fill(avg);
            }
            let smoothed = [values.slice(0, period).reduce((a, b) => a + b, 0) / period];
            const alpha = 1.0 / period;
            for (let i = period; i < values.length; i++) {
                smoothed.push(smoothed[smoothed.length - 1] * (1 - alpha) + values[i] * alpha);
            }
            return smoothed;
        };

        const smoothedTR = wilderSmooth(trValues, periodo);
        const smoothedPlusDM = wilderSmooth(plusDMValues, periodo);
        const smoothedMinusDM = wilderSmooth(minusDMValues, periodo);

        const plusDI = [], minusDI = [];
        for (let i = 0; i < smoothedTR.length; i++) {
            if (smoothedTR[i] !== 0) {
                plusDI.push((smoothedPlusDM[i] / smoothedTR[i]) * 100);
                minusDI.push((smoothedMinusDM[i] / smoothedTR[i]) * 100);
            } else {
                plusDI.push(0);
                minusDI.push(0);
            }
        }

        const dxValues = [];
        for (let i = 0; i < plusDI.length; i++) {
            const sum = plusDI[i] + minusDI[i];
            if (sum !== 0) {
                dxValues.push((Math.abs(plusDI[i] - minusDI[i]) / sum) * 100);
            } else {
                dxValues.push(0);
            }
        }

        const adxValues = wilderSmooth(dxValues, periodo);
        const lastADX = adxValues[adxValues.length - 1] || 25.0;
        const lastPlusDI = plusDI[plusDI.length - 1] || 50;
        const lastMinusDI = minusDI[minusDI.length - 1] || 50;

        let tendenciaForca = "FRACA";
        if (lastADX >= 50) tendenciaForca = "MUITO FORTE";
        else if (lastADX >= 40) tendenciaForca = "FORTE";
        else if (lastADX >= 25) tendenciaForca = "MODERADA";
        else if (lastADX >= 20) tendenciaForca = "FRACA";
        else tendenciaForca = "LATERAL";

        let tendenciaDirecao = "NEUTRAL";
        const diDiff = lastPlusDI - lastMinusDI;
        if (diDiff > 10) tendenciaDirecao = "BULLISH";
        else if (diDiff < -10) tendenciaDirecao = "BEARISH";

        let cruzamentoDI = "NENHUM";
        const penultimoPlusDI = plusDI.length > 1 ? plusDI[plusDI.length - 2] : lastPlusDI;
        const penultimoMinusDI = minusDI.length > 1 ? minusDI[minusDI.length - 2] : lastMinusDI;
        if (penultimoPlusDI <= penultimoMinusDI && lastPlusDI > lastMinusDI) cruzamentoDI = "BULLISH";
        else if (penultimoMinusDI <= penultimoPlusDI && lastMinusDI > lastPlusDI) cruzamentoDI = "BEARISH";

        return {
            adx: lastADX,
            plusDI: lastPlusDI,
            minusDI: lastMinusDI,
            tendenciaForca,
            tendenciaDirecao,
            cruzamentoDI
        };
    } catch (e) {
        return { adx: 25.0, plusDI: 50, minusDI: 50, tendenciaForca: "FRACA", tendenciaDirecao: "NEUTRAL", cruzamentoDI: "NENHUM" };
    }
}

function calcularVolatilidade(candles, precoAtual) {
    if (!candles || candles.length < 10 || !precoAtual || precoAtual <= 0) return 0;
    const recentes = candles.slice(-10);
    const ranges = recentes.map(c => (parseFloat(c.high) - parseFloat(c.low)) / precoAtual * 100);
    return ranges.reduce((a, b) => a + b, 0) / ranges.length;
}

module.exports = {
    calcularMediaSimples,
    calcularMediaExponencial,
    calcularRSI,
    calcularMACD,
    calcularADXCompleto,
    calcularVolatilidade
};
