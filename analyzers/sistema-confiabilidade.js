// analyzers/sistema-confiabilidade.js
class SistemaConfiabilidade {
    constructor() {
        this.historicoConfianca = [];
    }

    analisarConfiabilidadeSinal(sinal, dados) {
        if (!dados.candles || dados.candles.length < 2) return {
            confiavel: false,
            categoria: "DADOS INSUFICIENTES",
            acaoRecomendada: "AGUARDAR",
            motivo: "Dados de candles insuficientes"
        };
        const ultimaVela = dados.candles[dados.candles.length - 2];
        const velaVermelha = ultimaVela.close < ultimaVela.open;

        if (sinal === "CALL" && velaVermelha) return {
            confiavel: false,
            categoria: "INCONSISTÊNCIA BULLISH",
            acaoRecomendada: "AGUARDAR confirmação",
            motivo: "Sinal CALL com vela vermelha - possível correção"
        };
        if (sinal === "PUT" && !velaVermelha) return {
            confiavel: false,
            categoria: "INCONSISTÊNCIA BEARISH",
            acaoRecomendada: "AGUARDAR confirmação",
            motivo: "Sinal PUT com vela verde - possível reversão"
        };

        const tamanhoVela = Math.abs((ultimaVela.close - ultimaVela.open) / ultimaVela.open * 100);
        const macd = dados.macdHistograma;
        const rsi = dados.rsi;

        let confiavel = true;
        let acao = `${sinal} normal`;
        let motivo = velaVermelha ? "Vela vermelha confirma baixa" : "Vela verde confirma alta";

        if (sinal === "CALL") {
            if (macd < 0.1 && rsi > 70) {
                confiavel = false;
                acao = "AGUARDAR (RSI sobrecomprado)";
                motivo = "MACD fraco + RSI elevado";
            } else if (macd < 0) {
                confiavel = false;
                acao = "PUT ou SAIR";
                motivo = "MACD negativo indica momentum baixista";
            }
        } else if (sinal === "PUT") {
            if (macd > -0.1 && rsi < 30) {
                confiavel = false;
                acao = "AGUARDAR (RSI sobrevendido)";
                motivo = "MACD fraco + RSI baixo";
            } else if (macd > 0) {
                confiavel = false;
                acao = "CALL ou SAIR";
                motivo = "MACD positivo indica momentum altista";
            }
        }

        const resultado = {
            confiavel,
            categoria: confiavel ? "CONSISTENTE" : "ALERTA",
            acaoRecomendada: acao,
            motivo,
            detalhes: {
                velaVermelha,
                tamanhoVelaPercent: tamanhoVela.toFixed(2) + "%",
                macd,
                rsi
            }
        };
        this.atualizarHistorico({ timestamp: Date.now(), sinal, confiavel, categoria: resultado.categoria, dados: resultado });
        return resultado;
    }

    tabelaDecisaoRapida(macd, rsi) {
        if (macd > 1.0 && rsi < 60) return "🚀 CALL CONFIÁVEL";
        if (macd > 0.5 && rsi < 65) return "✅ CALL MODERADA";
        if (macd > 0.1 && rsi < 70) return "⚠️ CALL COM CAUTELA";
        if (macd < 0.1 && rsi > 70) return "❌ NÃO ENTRAR (revisão)";
        if (macd < 0) return "📉 CONSIDERAR PUT";
        return "🔍 ANÁLISE ADICIONAL";
    }

    atualizarHistorico(dados) {
        this.historicoConfianca.push(dados);
        if (this.historicoConfianca.length > 50) this.historicoConfianca = this.historicoConfianca.slice(-50);
    }

    getEstatisticas() {
        if (this.historicoConfianca.length === 0) return { total: 0, confiaveis: 0, taxaConfianca: 0 };
        const confiaveis = this.historicoConfianca.filter(item => item.confiavel).length;
        const taxaConfianca = (confiaveis / this.historicoConfianca.length) * 100;
        return {
            total: this.historicoConfianca.length,
            confiaveis,
            taxaConfianca: taxaConfianca.toFixed(1) + "%",
            ultimaCategoria: this.historicoConfianca.length > 0 ? this.historicoConfianca[this.historicoConfianca.length - 1].categoria : "N/A"
        };
    }
}

module.exports = SistemaConfiabilidade;
