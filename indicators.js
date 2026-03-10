// indicators.js
function calcularMediaSimples(precos, periodo) {
    if (!precos || precos.length === 0) return 0;
    if (precos.length < periodo) return precos.reduce((a, b) => a + b, 0) / precos.length;
    const slice = precos.slice(-periodo);
    return slice.reduce((a, b) => a + b, 0) / periodo;
}

function calcularMediaExponencial(precos, periodo) {
    if (!precos || precos.length === 0) return 0;
    
    // Se tiver poucos dados, usa média simples
    if (precos.length < periodo) {
        return precos.reduce((a, b) => a + b, 0) / precos.length;
    }
    
    const k = 2 / (periodo + 1);
    let ema = precos[0];
    
    for (let i = 1; i < precos.length; i++) {
        ema = precos[i] * k + ema * (1 - k);
    }
    
    return ema;
}

function calcularRSI(precos, periodo = 14) {
    if (!precos || precos.length < periodo + 1) return 50;
    
    let ganhos = 0, perdas = 0;
    
    // Primeiro cálculo
    for (let i = 1; i <= periodo; i++) {
        const diff = precos[i] - precos[i - 1];
        if (diff >= 0) ganhos += diff;
        else perdas += Math.abs(diff);
    }
    
    let avgGanho = ganhos / periodo;
    let avgPerda = perdas / periodo;
    
    // Wilder smoothing para os próximos períodos
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
    if (!precos || precos.length < slow) {
        return { 
            macd: 0, 
            sinal: 0, 
            histograma: 0, 
            valido: false,
            direcao: 'NEUTRAL',
            forca: 0
        };
    }
    
    try {
        // Calcular EMAs
        const emaRapida = calcularMediaExponencial(precos, fast);
        const emaLenta = calcularMediaExponencial(precos, slow);
        const linhaMACD = emaRapida - emaLenta;
        
        // Calcular linha de sinal (EMA do MACD)
        // Para isso, precisamos de um histórico de MACD
        const historicoMACD = [];
        const inicio = Math.max(0, precos.length - slow - signal);
        
        for (let i = inicio; i < precos.length; i++) {
            const slice = precos.slice(0, i + 1);
            const emaR = calcularMediaExponencial(slice, fast);
            const emaL = calcularMediaExponencial(slice, slow);
            historicoMACD.push(emaR - emaL);
        }
        
        let linhaSinal = 0;
        if (historicoMACD.length >= signal) {
            linhaSinal = calcularMediaExponencial(historicoMACD.slice(-signal), signal);
        } else if (historicoMACD.length > 0) {
            linhaSinal = historicoMACD.reduce((a, b) => a + b, 0) / historicoMACD.length;
        } else {
            linhaSinal = linhaMACD * 0.98;
        }
        
        const histograma = linhaMACD - linhaSinal;
        const forca = Math.abs(histograma);
        
        // Determinar direção
        let direcao = 'NEUTRAL';
        if (histograma > 0.001) direcao = 'BULLISH';
        else if (histograma < -0.001) direcao = 'BEARISH';
        
        // Determinar força
        let nivelForca = 'FRACA';
        if (forca > 0.005) nivelForca = 'FORTE';
        else if (forca > 0.002) nivelForca = 'MODERADA';
        
        return {
            macd: linhaMACD,
            sinal: linhaSinal,
            histograma,
            valido: true,
            direcao,
            forca,
            nivelForca
        };
        
    } catch (error) {
        console.error("Erro calculando MACD:", error);
        return { 
            macd: 0, 
            sinal: 0, 
            histograma: 0, 
            valido: false,
            direcao: 'NEUTRAL',
            forca: 0
        };
    }
}

function calcularADXCompleto(candles, periodo = 14) {
    if (!candles || candles.length < periodo * 2) {
        return { 
            adx: 25.0, 
            plusDI: 50, 
            minusDI: 50, 
            tendenciaForca: "FRACA", 
            tendenciaDirecao: "NEUTRAL", 
            cruzamentoDI: "NENHUM",
            adxNormalizado: 0.5
        };
    }
    
    try {
        const highs = candles.map(c => parseFloat(c.high));
        const lows = candles.map(c => parseFloat(c.low));
        const closes = candles.map(c => parseFloat(c.close));
        
        const trValues = [];
        const plusDMValues = [];
        const minusDMValues = [];
        
        for (let i = 1; i < highs.length; i++) {
            // True Range
            const highLow = highs[i] - lows[i];
            const highPrevClose = Math.abs(highs[i] - closes[i - 1]);
            const lowPrevClose = Math.abs(lows[i] - closes[i - 1]);
            trValues.push(Math.max(highLow, highPrevClose, lowPrevClose));

            // Directional Movement
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

        // Wilder smoothing
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

        const plusDI = [];
        const minusDI = [];
        
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

        // Classificar força da tendência
        let tendenciaForca = "FRACA";
        if (lastADX >= 50) tendenciaForca = "MUITO FORTE";
        else if (lastADX >= 40) tendenciaForca = "FORTE";
        else if (lastADX >= 25) tendenciaForca = "MODERADA";
        else if (lastADX >= 20) tendenciaForca = "FRACA";
        else tendenciaForca = "LATERAL";

        // Direção da tendência
        let tendenciaDirecao = "NEUTRAL";
        const diDiff = lastPlusDI - lastMinusDI;
        if (diDiff > 10) tendenciaDirecao = "BULLISH";
        else if (diDiff < -10) tendenciaDirecao = "BEARISH";

        // Detectar cruzamento
        let cruzamentoDI = "NENHUM";
        const penultimoPlusDI = plusDI.length > 1 ? plusDI[plusDI.length - 2] : lastPlusDI;
        const penultimoMinusDI = minusDI.length > 1 ? minusDI[minusDI.length - 2] : lastMinusDI;
        
        if (penultimoPlusDI <= penultimoMinusDI && lastPlusDI > lastMinusDI) cruzamentoDI = "BULLISH";
        else if (penultimoMinusDI <= penultimoPlusDI && lastMinusDI > lastPlusDI) cruzamentoDI = "BEARISH";

        // ADX normalizado (0-1) para cálculos de peso
        const adxNormalizado = Math.min(1, lastADX / 50);

        return {
            adx: lastADX,
            plusDI: lastPlusDI,
            minusDI: lastMinusDI,
            tendenciaForca,
            tendenciaDirecao,
            cruzamentoDI,
            adxNormalizado
        };
        
    } catch (e) {
        return { 
            adx: 25.0, 
            plusDI: 50, 
            minusDI: 50, 
            tendenciaForca: "FRACA", 
            tendenciaDirecao: "NEUTRAL", 
            cruzamentoDI: "NENHUM",
            adxNormalizado: 0.5
        };
    }
}

function calcularVolatilidade(candles, precoAtual) {
    if (!candles || candles.length < 10 || !precoAtual || precoAtual <= 0) return 0;
    
    const recentes = candles.slice(-10);
    const ranges = recentes.map(c => (parseFloat(c.high) - parseFloat(c.low)) / precoAtual * 100);
    
    return ranges.reduce((a, b) => a + b, 0) / ranges.length;
}

function calcularATR(candles, periodo = 14) {
    if (!candles || candles.length < periodo) return 0;
    
    const trs = [];
    for (let i = 1; i < candles.length; i++) {
        const high = parseFloat(candles[i].high);
        const low = parseFloat(candles[i].low);
        const prevClose = parseFloat(candles[i - 1].close);
        
        const tr = Math.max(
            high - low,
            Math.abs(high - prevClose),
            Math.abs(low - prevClose)
        );
        trs.push(tr);
    }
    
    // Média simples dos últimos 'periodo' TRs
    const ultimosTRs = trs.slice(-periodo);
    return ultimosTRs.reduce((a, b) => a + b, 0) / ultimosTRs.length;
}

function calcularSuporteResistencia(candles, periodo = 20) {
    if (!candles || candles.length < periodo) {
        return { suporte: 0, resistencia: 0 };
    }
    
    const recentes = candles.slice(-periodo);
    const highs = recentes.map(c => parseFloat(c.high));
    const lows = recentes.map(c => parseFloat(c.low));
    
    const resistencia = Math.max(...highs);
    const suporte = Math.min(...lows);
    
    return { suporte, resistencia };
}

module.exports = {
    calcularMediaSimples,
    calcularMediaExponencial,
    calcularRSI,
    calcularMACD,
    calcularADXCompleto,
    calcularVolatilidade,
    calcularATR,
    calcularSuporteResistencia
};
