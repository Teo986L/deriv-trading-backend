// analyzers/zona-ouro.js
const { MARKET_STATE } = require('../config');

class ZonaDeOuroPremium {
    constructor() {
        this.nome = "Zona de Ouro Premium";
        this.zonaOuroMin = 45;
        this.zonaOuroMax = 70;
        this.zonaOuroBaixaMin = 35;
        this.zonaOuroBaixaMax = 50;
        this.confiancaMinima = 75;
    }

    verificarZonaDeOuro(analise) {
        if (!analise || !analise.rsi) return false;
        const rsi = analise.rsi;
        return rsi >= this.zonaOuroMin && rsi <= this.zonaOuroMax;
    }

    verificarZonaDeOuroBaixa(analise) {
        if (!analise || !analise.rsi) return false;
        const rsi = analise.rsi;
        return rsi >= this.zonaOuroBaixaMin && rsi <= this.zonaOuroBaixaMax;
    }

    tendenciaForte(analise) {
        if (!analise) return false;
        const adxForte = analise.adx && analise.adx >= 25;
        const estadoForte = analise.advanced_analysis &&
            (analise.advanced_analysis.summary.state === MARKET_STATE.STRONG_BULL_TREND ||
             analise.advanced_analysis.summary.state === MARKET_STATE.STRONG_BEAR_TREND);
        return adxForte || estadoForte;
    }

    precoNaZonaDePullback(analise, precoAtual) {
        if (!analise || !analise.advanced_analysis || !analise.advanced_analysis.pullbackZone) {
            return false;
        }
        const zona = analise.advanced_analysis.pullbackZone;
        return precoAtual >= zona.low && precoAtual <= zona.high;
    }

    obterZonaPullback(analise) {
        if (!analise || !analise.advanced_analysis) return null;
        return analise.advanced_analysis.pullbackZone || null;
    }

    gerarSinalPremium(mtfManager) {
        const m5 = mtfManager.timeframes['M5']?.analysis;
        const m15 = mtfManager.timeframes['M15']?.analysis;
        const m30 = mtfManager.timeframes['M30']?.analysis;
        const h1 = mtfManager.timeframes['H1']?.analysis;
        const h4 = mtfManager.timeframes['H4']?.analysis;

        if (!h4 || !h1 || !m30 || !m15) {
            return null;
        }

        const precoAtual = m15?.preco_atual || m5?.preco_atual || 0;
        if (precoAtual === 0) return null;

        const tendenciaAlta = h4.sinal === 'CALL' && this.tendenciaForte(h4);
        const zonaOuroH1 = this.verificarZonaDeOuro(h1);
        const zonaOuroM30 = this.verificarZonaDeOuro(m30);
        const naZonaPullback = this.precoNaZonaDePullback(m15, precoAtual);

        if (tendenciaAlta && zonaOuroH1 && zonaOuroM30 && naZonaPullback) {
            const zona = this.obterZonaPullback(m15);
            return {
                signal: 'CALL',
                tipo: 'ZONA_DE_OURO_PREMIUM',
                confianca: 85,
                entrada: precoAtual,
                stopLoss: zona?.stopLoss || precoAtual * 0.995,
                takeProfit: zona?.takeProfit || [precoAtual * 1.005, precoAtual * 1.01],
                razao: '🎯 ZONA DE OURO! RSI H1/M30 em 45-70 + Preço na zona de pullback',
                timeframes: {
                    h4: { sinal: h4.sinal, rsi: h4.rsi, adx: h4.adx },
                    h1: { rsi: h1.rsi },
                    m30: { rsi: m30.rsi },
                    m15: { zona: zona ? `${zona.low.toFixed(2)}-${zona.high.toFixed(2)}` : null }
                },
                zona: zona
            };
        }

        const tendenciaBaixa = h4.sinal === 'PUT' && this.tendenciaForte(h4);
        const zonaOuroBaixaH1 = this.verificarZonaDeOuroBaixa(h1);
        const zonaOuroBaixaM30 = this.verificarZonaDeOuroBaixa(m30);

        if (tendenciaBaixa && zonaOuroBaixaH1 && zonaOuroBaixaM30 && naZonaPullback) {
            const zona = this.obterZonaPullback(m15);
            return {
                signal: 'PUT',
                tipo: 'ZONA_DE_OURO_PREMIUM',
                confianca: 85,
                entrada: precoAtual,
                stopLoss: zona?.stopLoss || precoAtual * 1.005,
                takeProfit: zona?.takeProfit || [precoAtual * 0.995, precoAtual * 0.99],
                razao: '🎯 ZONA DE OURO! RSI H1/M30 corrigido + Preço na zona de pullback',
                timeframes: {
                    h4: { sinal: h4.sinal, rsi: h4.rsi, adx: h4.adx },
                    h1: { rsi: h1.rsi },
                    m30: { rsi: m30.rsi },
                    m15: { zona: zona ? `${zona.low.toFixed(2)}-${zona.high.toFixed(2)}` : null }
                },
                zona: zona
            };
        }

        if (tendenciaAlta && zonaOuroH1 && zonaOuroM30) {
            const zona = this.obterZonaPullback(m15);
            if (zona) {
                return {
                    signal: 'OBSERVAR',
                    tipo: 'AGUARDANDO_ZONA',
                    confianca: 70,
                    razao: `⏳ RSI na zona de ouro! Aguardar preço entrar na zona: ${zona.low.toFixed(2)} - ${zona.high.toFixed(2)}`,
                    entrada: null,
                    stopLoss: null,
                    takeProfit: null,
                    zona: zona,
                    timeframes: {
                        h4: { sinal: h4.sinal, rsi: h4.rsi },
                        h1: { rsi: h1.rsi },
                        m30: { rsi: m30.rsi }
                    }
                };
            }
        }

        return null;
    }

    getDescricao(sinal) {
        if (!sinal) return 'Sem sinal premium no momento';
        if (sinal.signal === 'CALL') {
            return `✅ ${sinal.razao} | Confiança: ${sinal.confianca}%`;
        } else if (sinal.signal === 'PUT') {
            return `✅ ${sinal.razao} | Confiança: ${sinal.confianca}%`;
        } else if (sinal.signal === 'OBSERVAR') {
            return sinal.razao;
        }
        return 'Analisando condições...';
    }
}

module.exports = ZonaDeOuroPremium;
