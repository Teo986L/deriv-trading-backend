// analyzers/sistema-pesos.js
class SistemaPesosAutomaticos {
    constructor() {
        this.historicoMercado = [];
        this.pesosAtuais = {};
        this.estadoMercado = "NEUTRO";
        this.tendenciaForca = "MEDIA";
        this.volatilidade = "MEDIA";
        this.tipoAtivo = null;
    }

    setTipoAtivo(tipo) {
        this.tipoAtivo = tipo;
    }

    gerarPesosPorAtivo() {
        const base = {
            peso_macd: 15,
            peso_macd_histograma: 25,
            peso_macd_tendencia: 20,
            adx_lateral: 10,
            adx_fraca: 15,
            adx_moderada: 25,
            adx_forte: 35,
            peso_adx_fraco: -5,
            peso_adx_moderado: 5,
            peso_adx_forte: 10,
            rsi_oversold: 20,
            rsi_overbought: 80,
            peso_m1: 3,
            peso_m5: 8,
            peso_m15: 12,
            peso_m30: 15,
            peso_h1: 18,
            peso_h4: 22,
            peso_h24: 25,
            sensibilidade_geral: 1.3,
            agressividade_ajustada: 1.2,
            ignorar_adx_abaixo: 25,
            forcar_macd_acima: 0.002
        };

        if (this.tipoAtivo === 'volatility_index') {
            return {
                ...base,
                peso_m1: 8,
                peso_m5: 12,
                peso_m15: 15,
                peso_m30: 15,
                peso_h1: 18,
                peso_h4: 20,
                peso_h24: 22,
                ignorar_adx_abaixo: 18,
                sensibilidade_geral: 1.5,
                agressividade_ajustada: 1.4,
                rsi_oversold: 25,
                rsi_overbought: 75
            };
        }
        
        if (this.tipoAtivo === 'forex') {
            return {
                ...base,
                peso_m1: 2,
                peso_m5: 5,
                peso_m15: 10,
                peso_m30: 15,
                peso_h1: 20,
                peso_h4: 25,
                peso_h24: 30,
                ignorar_adx_abaixo: 20,
                sensibilidade_geral: 1.1
            };
        }

        return base;
    }

    gerarPesosPadrao() {
        if (this.tipoAtivo) {
            return this.gerarPesosPorAtivo();
        }
        
        return {
            peso_macd: 15,
            peso_macd_histograma: 25,
            peso_macd_tendencia: 20,
            adx_lateral: 10,
            adx_fraca: 15,
            adx_moderada: 25,
            adx_forte: 35,
            peso_adx_fraco: -5,
            peso_adx_moderado: 5,
            peso_adx_forte: 10,
            rsi_oversold: 20,
            rsi_overbought: 80,
            peso_m1: 3,
            peso_m5: 8,
            peso_m15: 12,
            peso_m30: 15,
            peso_h1: 18,
            peso_h4: 22,
            peso_h24: 25,
            sensibilidade_geral: 1.3,
            agressividade_ajustada: 1.2,
            ignorar_adx_abaixo: 25,
            forcar_macd_acima: 0.002
        };
    }

    analisarMercado(candles, precoAtual) {
        if (!candles || candles.length < 50) return this.gerarPesosPadrao();
        
        const fechamentos = candles.map(c => parseFloat(c.close));
        const tendencia = this.calcularTendencia(fechamentos);
        const volatilidade = this.calcularVolatilidade(candles, precoAtual);
        const momentum = this.calcularMomentum(fechamentos);
        const consolidacao = this.verificarConsolidacao(candles);
        
        this.estadoMercado = this.determinarEstadoMercado(tendencia, volatilidade, momentum, consolidacao);
        this.tendenciaForca = Math.abs(tendencia) > 0.3 ? "FORTE" : Math.abs(tendencia) > 0.15 ? "MODERADA" : "FRACA";
        this.volatilidade = volatilidade > 1.5 ? "ALTA" : volatilidade > 0.5 ? "MEDIA" : "BAIXA";
        
        const pesos = this.gerarPesosAutomaticos(tendencia, volatilidade, momentum, consolidacao);
        
        this.atualizarHistorico({ 
            timestamp: Date.now(), 
            tendencia, 
            volatilidade, 
            momentum, 
            consolidacao, 
            estado: this.estadoMercado, 
            pesos 
        });
        
        this.pesosAtuais = pesos;
        return pesos;
    }

    calcularTendencia(fechamentos) {
        if (!fechamentos || fechamentos.length < 20) return 0;
        
        const periodoCurto = Math.min(10, Math.floor(fechamentos.length / 5));
        const periodoLongo = Math.min(20, Math.floor(fechamentos.length / 2));
        const precoAtual = fechamentos[fechamentos.length - 1];
        
        const mediaCurta = this.calcularMedia(fechamentos.slice(-periodoCurto));
        const mediaLonga = this.calcularMedia(fechamentos.slice(-periodoLongo));
        
        const acimaMediaCurta = precoAtual > mediaCurta ? 0.5 : 0;
        const acimaMediaLonga = precoAtual > mediaLonga ? 0.5 : 0;
        
        return (acimaMediaCurta + acimaMediaLonga) * 2 - 1;
    }

    calcularVolatilidade(candles, precoAtual) {
        if (!candles || candles.length < 10) return 0;
        
        const recentes = candles.slice(-10);
        const ranges = recentes.map(c => {
            const mid = (parseFloat(c.high) + parseFloat(c.low)) / 2;
            return (parseFloat(c.high) - parseFloat(c.low)) / mid * 100;
        });
        
        return ranges.reduce((a, b) => a + b, 0) / ranges.length;
    }

    calcularMomentum(fechamentos) {
        if (!fechamentos || fechamentos.length < 5) return 0;
        
        const atual = fechamentos[fechamentos.length - 1];
        const anterior = fechamentos[fechamentos.length - 5];
        
        return ((atual - anterior) / anterior) * 100 / 10;
    }

    verificarConsolidacao(candles) {
        if (!candles || candles.length < 20) return 0;
        
        const recentes = candles.slice(-20);
        const ranges = recentes.map(c => parseFloat(c.high) - parseFloat(c.low));
        const avgRange = ranges.reduce((a, b) => a + b, 0) / ranges.length;
        const precoMedio = recentes.reduce((sum, c) => sum + parseFloat(c.close), 0) / recentes.length;
        const rangeRelativo = avgRange / precoMedio;
        
        return rangeRelativo < 0.005 ? 1 : rangeRelativo < 0.01 ? 0.5 : 0;
    }

    determinarEstadoMercado(tendencia, volatilidade, momentum, consolidacao) {
        if (consolidacao > 0.7) return "CONSOLIDACAO";
        if (volatilidade > 2.0) return "VOLATIL_ALTO";
        if (Math.abs(momentum) > 2) return momentum > 0 ? "MOMENTUM_ALTA_FORTE" : "MOMENTUM_BAIXA_FORTE";
        if (tendencia > 0.3) return "TENDENCIA_ALTA";
        if (tendencia < -0.3) return "TENDENCIA_BAIXA";
        if (volatilidade > 1.0) return "VOLATIL";
        return "NEUTRO";
    }

    gerarPesosAutomaticos(tendencia, volatilidade, momentum, consolidacao) {
        const basePesos = this.gerarPesosPadrao();
        const ajustes = this.calcularAjustesPorEstado(this.estadoMercado);
        
        const pesosAjustados = {};
        
        for (const [key, value] of Object.entries(basePesos)) {
            let ajuste = 1.0;
            
            if (key.includes('adx_')) ajuste = ajustes.adx || 1.0;
            else if (key.includes('peso_m') || key.includes('peso_h')) ajuste = ajustes.timeframes || 1.0;
            else if (key.includes('peso_')) ajuste = ajustes.indicadores || 1.0;
            else if (key.includes('rsi_')) ajuste = ajustes.rsi || 1.0;
            
            if (typeof value === 'number') {
                pesosAjustados[key] = value * ajuste;
            } else {
                pesosAjustados[key] = value;
            }
        }
        
        pesosAjustados.sensibilidade_geral = ajustes.sensibilidade || 1.0;
        pesosAjustados.agressividade_ajustada = ajustes.agressividade || 1.0;
        
        return pesosAjustados;
    }

    calcularAjustesPorEstado(estado) {
        const ajustes = { 
            adx: 1.0, 
            timeframes: 1.0, 
            indicadores: 1.0, 
            rsi: 1.0, 
            sensibilidade: 1.0, 
            agressividade: 1.0 
        };
        
        switch (estado) {
            case "CONSOLIDACAO":
                ajustes.adx = 0.6;
                ajustes.indicadores = 0.8;
                ajustes.sensibilidade = 1.1;
                ajustes.agressividade = 0.8;
                break;
            case "VOLATIL_ALTO":
                ajustes.adx = 1.0;
                ajustes.timeframes = 0.9;
                ajustes.sensibilidade = 1.0;
                ajustes.agressividade = 0.9;
                break;
            case "TENDENCIA_ALTA":
            case "TENDENCIA_BAIXA":
                ajustes.adx = 1.2;
                ajustes.indicadores = 1.3;
                ajustes.timeframes = 1.2;
                ajustes.sensibilidade = 1.3;
                ajustes.agressividade = 1.3;
                break;
            case "MOMENTUM_ALTA_FORTE":
            case "MOMENTUM_BAIXA_FORTE":
                ajustes.adx = 1.0;
                ajustes.indicadores = 1.5;
                ajustes.timeframes = 1.1;
                ajustes.sensibilidade = 1.5;
                ajustes.agressividade = 1.7;
                break;
            case "VOLATIL":
                ajustes.adx = 0.9;
                ajustes.indicadores = 1.1;
                ajustes.sensibilidade = 1.1;
                ajustes.agressividade = 1.0;
                break;
            default:
                ajustes.adx = 0.8;
                ajustes.indicadores = 1.1;
                ajustes.timeframes = 1.1;
                ajustes.sensibilidade = 1.1;
                ajustes.agressividade = 1.1;
        }
        
        return ajustes;
    }

    calcularMedia(valores) {
        return valores && valores.length ? valores.reduce((a, b) => a + b, 0) / valores.length : 0;
    }

    atualizarHistorico(dados) {
        this.historicoMercado.push(dados);
        if (this.historicoMercado.length > 100) this.historicoMercado = this.historicoMercado.slice(-100);
    }

    getEstadoMercado() { return this.estadoMercado; }
    getTendenciaForca() { return this.tendenciaForca; }
    getVolatilidade() { return this.volatilidade; }
}

module.exports = SistemaPesosAutomaticos;
