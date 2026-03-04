// analyzers/sistema-dupla-tendencia.js
class SistemaDuplaTendencia {
    constructor() {
        this.historicoTendencias = [];
    }

    analisarTendenciasDuplas(precoAtual, precoAnterior, macdData, rsi, adxData, ultimaVela) {
        const variacaoPercentual = ((precoAtual - precoAnterior) / precoAnterior) * 100;
        const tendenciaCurtoPrazo = {
            sinal: precoAtual > precoAnterior ? "CALL" : "PUT",
            direcao: precoAtual > precoAnterior ? "ALTA" : "BAIXA",
            forca: Math.abs(variacaoPercentual),
            variacao: variacaoPercentual,
            confirmacao: ultimaVela.close > ultimaVela.open ? "VELA VERDE" : "VELA VERMELHA",
            velaTamanho: Math.abs((ultimaVela.close - ultimaVela.open) / ultimaVela.open * 100)
        };
        const tendenciaMedioPrazo = {
            sinal: macdData.histograma > 0 ? "CALL" : "PUT",
            direcao: macdData.histograma > 0 ? "ALTA" : "BAIXA",
            forca: Math.abs(macdData.histograma),
            macdValor: macdData.macd,
            histograma: macdData.histograma,
            confirmacao: macdData.macd > 0 ? "MACD POSITIVO" : "MACD NEGATIVO"
        };

        const mesmaDirecao = tendenciaCurtoPrazo.direcao === tendenciaMedioPrazo.direcao;
        let tipoConvergencia = "", risco = "BAIXO";
        if (mesmaDirecao) {
            tipoConvergencia = tendenciaCurtoPrazo.direcao === "ALTA" ? "CONVERGÊNCIA BULLISH" : "CONVERGÊNCIA BEARISH";
        } else {
            tipoConvergencia = tendenciaCurtoPrazo.direcao === "ALTA" ? "DIVERGÊNCIA BEARISH" : "DIVERGÊNCIA BULLISH";
            risco = "ALTO";
        }

        let recomendacao = "", explicacao = "";
        if (tipoConvergencia.includes("CONVERGÊNCIA")) {
            recomendacao = `${tendenciaCurtoPrazo.sinal} FORTE`;
            explicacao = "Ambas as tendências concordam";
        } else {
            if (tendenciaMedioPrazo.forca > 0.002) {
                recomendacao = `${tendenciaMedioPrazo.sinal} (MACD mais forte)`;
                explicacao = "MACD tem força maior que variação recente";
            } else if (Math.abs(tendenciaCurtoPrazo.variacao) > 0.5) {
                recomendacao = `${tendenciaCurtoPrazo.sinal} (Price Action forte)`;
                explicacao = "Variação recente muito forte";
            } else {
                recomendacao = "AGUARDAR confirmação";
                explicacao = "Tendências em conflito sem força clara";
            }
        }

        const resultado = {
            tendenciaCurtoPrazo,
            tendenciaMedioPrazo,
            convergencia: {
                mesmaDirecao,
                tipo: tipoConvergencia,
                risco,
                recomendacao,
                explicacao
            },
            rsi,
            adx: adxData.adx,
            timestamp: Date.now()
        };
        this.historicoTendencias.push(resultado);
        if (this.historicoTendencias.length > 100) this.historicoTendencias = this.historicoTendencias.slice(-100);
        return resultado;
    }

    calcularSinalFinal(analiseDupla) {
        const { tendenciaCurtoPrazo, tendenciaMedioPrazo, convergencia } = analiseDupla;
        if (convergencia.risco === "ALTO") {
            return {
                sinal: "HOLD",
                probabilidade: 0.5,
                motivo: convergencia.tipo + " - " + convergencia.explicacao,
                acao: convergencia.recomendacao
            };
        }
        if (convergencia.tipo.includes("CONVERGÊNCIA")) {
            const sinal = tendenciaCurtoPrazo.sinal;
            let probabilidade = 0.75;
            if (tendenciaCurtoPrazo.forca > 0.3 && tendenciaMedioPrazo.forca > 0.01) probabilidade = 0.85;
            return {
                sinal,
                probabilidade,
                motivo: convergencia.tipo + " - " + convergencia.explicacao,
                acao: sinal + " NORMAL"
            };
        }
        return {
            sinal: tendenciaMedioPrazo.sinal,
            probabilidade: 0.65,
            motivo: "Seguindo tendência MACD (médio prazo)",
            acao: tendenciaMedioPrazo.sinal + " COM CAUTELA"
        };
    }
}

module.exports = SistemaDuplaTendencia;
