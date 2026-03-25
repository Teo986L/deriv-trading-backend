// analyzers/trader-bot-analyzer.js
const { calcularATR, calcularADXCompleto } = require('../indicators');

/**
 * TRADER BOT v3.0 - Sistema Unificado de Análise
 * Refinamento de Confiança | Modos de Trading | Filtro ATR/Volatilidade
 */
class TraderBotAnalise {
    constructor(config = {}) {
        // Configurações padrão
        this.config = {
            // Limiares de confiança
            confiancaMinimaOperar: 65,     // % mínimo para gerar sinal
            confiancaAlta: 80,              // % considerado alta confiança

            // Limiares de ADX
            adxTendenciaForte: 25,          // >25 = tendência forte
            adxSemTendencia: 20,            // <20 = sem tendência

            // Limiares de RSI
            rsiSobrevendido: 30,             // <30 = sobrevendido
            rsiSobrecomprado: 70,            // >70 = sobrecomprado

            // Limiares de volatilidade (ATR)
            volatilidadeAlta: 1.5,           // Multiplicador para considerar alta volatilidade
            maxSpreadPercent: 0.5,           // Máximo spread % permitido

            // Pesos para cálculo de confiança
            pesos: {
                alinhamentoTimeframes: 0.35,  // 35% do peso
                adx: 0.25,                   // 25% do peso
                rsi: 0.20,                   // 20% do peso
                volatilidade: 0.10,          // 10% do peso
                volume: 0.10                 // 10% do peso
            },

            ...config
        };

        // Definição dos modos de trading
        this.modos = {
            SNIPER: {
                nome: "SNIPER",
                timeframes: ["M1", "M5", "M15"],
                descricao: "Curto prazo - entradas rápidas",
                pesoTimeframes: [0.5, 0.3, 0.2],  // M1 tem mais peso
                minTimeframesAlinhados: 2,
                maxVolatilidade: 1.2               // Sniper prefere volatilidade moderada
            },
            CACADOR: {
                nome: "CACADOR",
                timeframes: ["M5", "M15", "H1"],
                descricao: "Médio prazo - tendência confirmada",
                pesoTimeframes: [0.4, 0.35, 0.25], // H1 tem peso maior
                minTimeframesAlinhados: 2,
                maxVolatilidade: 1.5
            },
            PESCADOR: {
                nome: "PESCADOR",
                timeframes: ["M15", "H1", "H4", "H24"],
                descricao: "Longo prazo - macro tendência",
                pesoTimeframes: [0.2, 0.3, 0.3, 0.2], // H1/H4 têm mais peso
                minTimeframesAlinhados: 3,
                maxVolatilidade: 2.0
            }
        };
    }

    /**
     * Calcula o ATR usando a função já existente no sistema
     * @param {Array} precos - Array de candles com high/low/close
     * @param {number} periodo - Período para cálculo (padrão 14)
     */
    calcularATR(precos, periodo = 14) {
        if (!precos || precos.length < periodo) return null;
        return calcularATR(precos, periodo);
    }

    /**
     * Calcula ADX usando a função já existente no sistema
     * @param {Array} precos - Array de candles com high/low/close
     * @param {number} periodo - Período para cálculo (padrão 14)
     */
    calcularADX(precos, periodo = 14) {
        if (!precos || precos.length < periodo) return 25; // fallback
        const adxData = calcularADXCompleto(precos, periodo);
        return adxData.adx;
    }

    /**
     * Analisa um timeframe individual
     */
    analisarTimeframe(data, modo, timeframe) {
        const adx = data.adx || this.calcularADX(data.precos, 14);
        const rsi = data.rsi;
        const preco = data.precoAtual;
        const tendencia = data.tendencia; // 'CALL' ou 'PUT'

        // Verifica força da tendência pelo ADX
        const forcaTendencia = adx >= this.config.adxTendenciaForte ? 'FORTE' :
                               adx >= this.config.adxSemTendencia ? 'MODERADA' : 'FRACA';

        // Verifica condições de RSI
        const rsiCondicao = rsi <= this.config.rsiSobrevendido ? 'SOBREVENDIDO' :
                           rsi >= this.config.rsiSobrecomprado ? 'SOBRECOMPRADO' : 'NEUTRO';

        // Score do timeframe (0-100)
        let score = 0;

        // Contribuição do ADX
        if (adx >= this.config.adxTendenciaForte) score += 40;
        else if (adx >= this.config.adxSemTendencia) score += 25;
        else score += 10;

        // Contribuição do RSI
        if (tendencia === 'CALL' && rsi <= 50) score += 35;
        else if (tendencia === 'PUT' && rsi >= 50) score += 35;
        else if (tendencia === 'CALL' && rsi > 70) score -= 20;
        else if (tendencia === 'PUT' && rsi < 30) score -= 20;
        else score += 20;

        // Contribuição de timing/volatilidade
        if (data.volatilidade && data.volatilidade < modo.maxVolatilidade) score += 25;
        else if (data.volatilidade) score += 10;

        return {
            timeframe,
            tendencia,
            adx,
            rsi,
            forcaTendencia,
            rsiCondicao,
            score: Math.min(100, Math.max(0, score)),
            timingOk: score >= 50
        };
    }

    /**
     * Calcula volatilidade normalizada
     */
    calcularVolatilidade(precos, atr, precoAtual) {
        if (!atr || !precoAtual) return 1.0;

        const volatilidadePercentual = (atr / precoAtual) * 100;
        const volatilidadeNormalizada = Math.min(3.0, volatilidadePercentual / 0.5);

        return {
            percentual: volatilidadePercentual,
            normalizada: volatilidadeNormalizada,
            nivel: volatilidadeNormalizada <= 0.8 ? 'BAIXA' :
                   volatilidadeNormalizada <= 1.5 ? 'MODERADA' : 'ALTA'
        };
    }

    /**
     * Calcula confiança total baseada em múltiplos fatores
     */
    calcularConfianca(timeframesAnalisados, modo, volatilidade, volume) {
        let totalPeso = 0;

        // 1. Alinhamento de timeframes
        const tendencias = timeframesAnalisados.map(tf => tf.tendencia);
        const alinhamento = tendencias.every(t => t === tendencias[0]);
        const percentualAlinhamento = alinhamento ? 100 :
                                     (tendencias.filter(t => t === 'CALL').length / tendencias.length) * 100;

        // Aplica pesos por timeframe baseado no modo
        let scorePonderadoTimeframes = 0;
        timeframesAnalisados.forEach((tf, idx) => {
            const peso = modo.pesoTimeframes[idx] || 0;
            scorePonderadoTimeframes += tf.score * peso;
            totalPeso += peso;
        });

        if (totalPeso > 0) scorePonderadoTimeframes /= totalPeso;

        // 2. Fator ADX (média dos ADXs)
        const mediaAdx = timeframesAnalisados.reduce((sum, tf) => sum + tf.adx, 0) / timeframesAnalisados.length;
        let scoreAdx = 0;
        if (mediaAdx >= this.config.adxTendenciaForte) scoreAdx = 100;
        else if (mediaAdx >= this.config.adxSemTendencia) scoreAdx = 60;
        else scoreAdx = 30;

        // 3. Fator RSI (evitar extremos)
        const mediaRsi = timeframesAnalisados.reduce((sum, tf) => sum + tf.rsi, 0) / timeframesAnalisados.length;
        let scoreRsi = 0;
        if (mediaRsi >= 30 && mediaRsi <= 70) scoreRsi = 100;
        else if (mediaRsi < 30) scoreRsi = 70; // Sobrevencido pode ser bom para CALL
        else if (mediaRsi > 70) scoreRsi = 70; // Sobrecomprado pode ser bom para PUT
        else scoreRsi = 50;

        // Ajuste baseado na tendência
        const tendenciaPrincipal = this.getTendenciaPrincipal(timeframesAnalisados);
        if (tendenciaPrincipal === 'CALL' && mediaRsi < 40) scoreRsi += 10;
        if (tendenciaPrincipal === 'PUT' && mediaRsi > 60) scoreRsi += 10;

        // 4. Fator volatilidade
        let scoreVolatilidade = 100;
        if (volatilidade.nivel === 'ALTA') scoreVolatilidade = 50;
        else if (volatilidade.nivel === 'BAIXA') scoreVolatilidade = 70;

        // 5. Fator volume (se disponível)
        let scoreVolume = volume ? Math.min(100, (volume / 1000) * 100) : 70;

        // Confiança final ponderada
        const pesos = this.config.pesos;
        const confianca = (
            scorePonderadoTimeframes * pesos.alinhamentoTimeframes +
            scoreAdx * pesos.adx +
            scoreRsi * pesos.rsi +
            scoreVolatilidade * pesos.volatilidade +
            scoreVolume * pesos.volume
        );

        // Ajustes finos
        let confiancaFinal = confianca;

        // Penalidade por timeframes divergentes
        if (!alinhamento) confiancaFinal *= 0.7;

        // Bônus por forte alinhamento
        if (alinhamento && mediaAdx >= this.config.adxTendenciaForte) confiancaFinal *= 1.15;

        // Penalidade por volatilidade extrema
        if (volatilidade.nivel === 'ALTA') confiancaFinal *= 0.85;

        return Math.min(100, Math.max(0, Math.round(confiancaFinal)));
    }

    /**
     * Determina tendência principal baseada nos timeframes
     */
    getTendenciaPrincipal(timeframesAnalisados) {
        const calls = timeframesAnalisados.filter(tf => tf.tendencia === 'CALL').length;
        const puts = timeframesAnalisados.filter(tf => tf.tendencia === 'PUT').length;

        if (calls > puts) return 'CALL';
        if (puts > calls) return 'PUT';
        return 'NEUTRO';
    }

    /**
     * Gera análise completa baseada nos dados de mercado
     */
    gerarAnalise(dadosMercado, modoSelecionado = 'CACADOR') {
        const modo = this.modos[modoSelecionado];
        if (!modo) throw new Error(`Modo ${modoSelecionado} não encontrado`);

        // 1. Coletar dados de cada timeframe
        const timeframesAnalisados = [];

        for (const tf of modo.timeframes) {
            const dadosTF = dadosMercado.timeframes[tf];
            if (!dadosTF) continue;

            const analise = this.analisarTimeframe(dadosTF, modo, tf);
            timeframesAnalisados.push(analise);
        }

        if (timeframesAnalisados.length === 0) {
            return { erro: "Dados insuficientes para análise" };
        }

        // 2. Calcular volatilidade
        const atr = this.calcularATR(dadosMercado.precosHistoricos, 14);
        const volatilidade = this.calcularVolatilidade(
            dadosMercado.precosHistoricos,
            atr,
            dadosMercado.precoAtual
        );

        // 3. Calcular confiança
        const confianca = this.calcularConfianca(
            timeframesAnalisados,
            modo,
            volatilidade,
            dadosMercado.volume
        );

        // 4. Determinar sinal final
        const tendenciaPrincipal = this.getTendenciaPrincipal(timeframesAnalisados);
        const timeframesAlinhados = timeframesAnalisados.filter(tf => tf.tendencia === tendenciaPrincipal).length;
        const totalTimeframes = timeframesAnalisados.length;
        const alinhamentoPercentual = (timeframesAlinhados / totalTimeframes) * 100;

        let sinal = 'HOLD';
        let acao = 'AGUARDAR';
        let motivo = '';

        if (confianca >= this.config.confiancaMinimaOperar) {
            if (tendenciaPrincipal === 'CALL') {
                sinal = 'CALL';
                acao = '🟢 COMPRAR';
                motivo = `${timeframesAlinhados}/${totalTimeframes} TFs em CALL com ${confianca}% de confiança`;
            } else if (tendenciaPrincipal === 'PUT') {
                sinal = 'PUT';
                acao = '🔴 VENDER';
                motivo = `${timeframesAlinhados}/${totalTimeframes} TFs em PUT com ${confianca}% de confiança`;
            }
        } else {
            motivo = `Confiança ${confianca}% abaixo do mínimo (${this.config.confiancaMinimaOperar}%)`;
            if (alinhamentoPercentual < 60) motivo += ' | TFs divergentes';
            if (volatilidade.nivel === 'ALTA') motivo += ' | Alta volatilidade';
        }

        // 5. Gerar alertas
        const alertas = [];
        if (volatilidade.nivel === 'ALTA') {
            alertas.push(`⚠️ Volatilidade ALTA (${volatilidade.percentual.toFixed(2)}%) - risco elevado`);
        }
        if (confianca < this.config.confiancaAlta && confianca >= this.config.confiancaMinimaOperar) {
            alertas.push(`⚠️ Confiança ${confianca}% - considerar redução de stake`);
        }
        if (timeframesAlinhados < totalTimeframes) {
            alertas.push(`⚠️ ${totalTimeframes - timeframesAlinhados} TF(s) divergente(s)`);
        }

        // 6. Retornar análise completa
        return {
            timestamp: new Date().toISOString(),
            modo: modo.nome,
            ativo: dadosMercado.ativo,
            preco: dadosMercado.precoAtual,

            sinal: {
                direcao: sinal,
                confianca: confianca,
                acao: acao,
                motivo: motivo
            },

            timeframes: timeframesAnalisados,

            volatilidade: {
                atr: atr,
                percentual: volatilidade.percentual,
                nivel: volatilidade.nivel
            },

            alertas: alertas.length > 0 ? alertas : ['✅ Nenhum alerta crítico'],

            metadados: {
                timeframesAnalisados: timeframesAlinhados,
                totalTimeframes: totalTimeframes,
                alinhamento: alinhamentoPercentual.toFixed(1) + '%',
                tendenciaPrincipal: tendenciaPrincipal
            }
        };
    }

    /**
     * Valida se um sinal é operável com base em risco
     */
    validarOperacao(analise, saldo, riscoPercentual = 2) {
        if (!analise || analise.sinal.direcao === 'HOLD') {
            return { operavel: false, motivo: "Sinal HOLD ou inválido" };
        }

        if (analise.sinal.confianca < this.config.confiancaMinimaOperar) {
            return { operavel: false, motivo: `Confiança ${analise.sinal.confianca}% abaixo do mínimo` };
        }

        if (analise.volatilidade.nivel === 'ALTA') {
            return {
                operavel: true,
                alerta: "Volatilidade alta - reduzir stake em 50%",
                stakeSugerido: (saldo * (riscoPercentual / 100)) * 0.5
            };
        }

        // Cálculo de stake baseado na confiança
        const stakeBase = saldo * (riscoPercentual / 100);
        const stakeAjustado = stakeBase * (analise.sinal.confianca / 100);

        return {
            operavel: true,
            stakeSugerido: Math.min(stakeBase, stakeAjustado),
            motivo: `Sinal ${analise.sinal.direcao} com ${analise.sinal.confianca}% de confiança`
        };
    }
}

module.exports = TraderBotAnalise;
