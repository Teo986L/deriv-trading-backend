// trade-analyzer.js
class CandleTradeAnalyzer {
    /**
     * @param {number} margemPercentual - ex: 0.002 = 0.2% de distância para o SL
     * @param {number} rewardRiskRatio  - múltiplos de risco para o TP
     */
    constructor(margemPercentual = 0.002, rewardRiskRatio = 3) {
        this.margemPercentual = margemPercentual;
        this.rewardRiskRatio = rewardRiskRatio;
    }

    /** Níveis para CALL (long) */
    calcularNiveisLong(candle) {
        const entrada = parseFloat(candle.close);
        // Stop loss: um pouco abaixo da mínima do candle
        const stopLossCandle = Math.min(parseFloat(candle.low), entrada * (1 - this.margemPercentual));
        const stopLoss = stopLossCandle;
        const risco = entrada - stopLoss;
        const takeProfit = entrada + risco * this.rewardRiskRatio;
        return { precoEntrada: entrada, stopLoss, takeProfit };
    }

    /** Níveis para PUT (short) */
    calcularNiveisShort(candle) {
        const entrada = parseFloat(candle.close);
        // Stop loss: um pouco acima da máxima do candle
        const stopLossCandle = Math.max(parseFloat(candle.high), entrada * (1 + this.margemPercentual));
        const stopLoss = stopLossCandle;
        const risco = stopLoss - entrada;
        const takeProfit = entrada - risco * this.rewardRiskRatio;
        return { precoEntrada: entrada, stopLoss, takeProfit };
    }
}

module.exports = CandleTradeAnalyzer;
