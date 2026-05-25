// analyzers/trader-bot-analyzer.js
const { calcularATR, calcularADXCompleto } = require('../indicators');

/**
 * TRADER BOT v3.1 - Sistema Unificado de Análise
 * [RETIFICADO] Modo CAÇADOR com cedilha | Filtro de pullback | Contexto de modo
 */
class TraderBotAnalise {
    constructor(config = {}) {
        this.config = {
            confiancaMinimaOperar: 65,
            confiancaAlta: 80,
            adxTendenciaForte: 25,
            adxSemTendencia: 20,
            rsiSobrevendido: 30,
            rsiSobrecomprado: 70,
            volatilidadeAlta: 1.5,
            maxSpreadPercent: 0.5,
            pesos: {
                alinhamentoTimeframes: 0.35,
                adx: 0.25,
                rsi: 0.20,
                volatilidade: 0.10,
                volume: 0.10
            },
            ...config
        };

        this.modos = {
            SNIPER: {
                nome: "SNIPER",
                timeframes: ["M1", "M5", "M15"],
                descricao: "Curto prazo - entradas rápidas",
                pesoTimeframes: [0.5, 0.3, 0.2],
                minTimeframesAlinhados: 2,
                maxVolatilidade: 1.2,
                tfPrimario: 'M1',
                tfTendencia: 'M15'
            },
            CAÇADOR: {
                nome: "CAÇADOR",
                timeframes: ["M5", "M15", "H1"],
                descricao: "Médio prazo - tendência confirmada",
                pesoTimeframes: [0.4, 0.35, 0.25],
                minTimeframesAlinhados: 2,
                maxVolatilidade: 1.5,
                tfPrimario: 'M5',
                tfTendencia: 'H1'
            },
            PESCADOR: {
                nome: "PESCADOR",
                timeframes: ["M15", "H1", "H4", "H24"],
                descricao: "Longo prazo - macro tendência",
                pesoTimeframes: [0.2, 0.3, 0.3, 0.2],
                minTimeframesAlinhados: 3,
                maxVolatilidade: 2.0,
                tfPrimario: 'M15',
                tfTendencia: 'H4'
            }
        };
    }

    calcularATR(precos, periodo = 14) {
        if (!precos || precos.length < periodo) return null;
        return calcularATR(precos, periodo);
    }

    calcularADX(precos, periodo = 14) {
        if (!precos || precos.length < periodo) return 25;
        const adxData = calcularADXCompleto(precos, periodo);
        return adxData.adx;
    }

    analisarTimeframe(data, modo, timeframe) {
        const adx = data.adx || this.calcularADX(data.precos, 14);
        const rsi = data.rsi;
        const preco = data.precoAtual;
        const tendencia = data.tendencia;
        const faseMACD = data.faseMACD;

        const forcaTendencia = adx >= this.config.adxTendenciaForte ? 'FORTE' :
                               adx >= this.config.adxSemTendencia ? 'MODERADA' : 'FRACA';

        const rsiCondicao = rsi <= this.config.rsiSobrevendido ? 'SOBREVENDIDO' :
                           rsi >= this.config.rsiSobrecomprado ? 'SOBRECOMPRADO' : 'NEUTRO';

        let score = 0;

        if (adx >= this.config.adxTendenciaForte) score += 40;
        else if (adx >= this.config.adxSemTendencia) score += 25;
        else score += 10;

        if (tendencia === 'CALL' && rsi <= 50) score += 35;
        else if (tendencia === 'PUT' && rsi >= 50) score += 35;
        else if (faseMACD === 'WEAK_BULL' && tendencia === 'CALL') score += 25;
        else if (faseMACD === 'WEAK_BEAR' && tendencia === 'PUT') score += 25;
        else if (tendencia === 'CALL' && rsi > 70) score -= 15;
        else if (tendencia === 'PUT' && rsi < 30) score -= 15;
        else score += 20;

        if (data.volatilidade && data.volatilidade < modo.maxVolatilidade) score += 25;
        else if (data.volatilidade) score += 10;

        const isTfTendencia = timeframe === modo.tfTendencia;
        if (isTfTendencia && adx >= this.config.adxTendenciaForte) {
            score += 10;
        }

        return {
            timeframe,
            tendencia,
            adx,
            rsi,
            forcaTendencia,
            rsiCondicao,
            score: Math.min(100, Math.max(0, score)),
            timingOk: score >= 50,
            faseMACD,
            isTfTendencia
        };
    }

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

    calcularConfianca(timeframesAnalisados, modo, volatilidade, volume) {
        let totalPeso = 0;

        const tfsTendencia = timeframesAnalisados.filter(tf => tf.isTfTendencia);
        const tfsTiming = timeframesAnalisados.filter(tf => !tf.isTfTendencia);

        const tendencias = timeframesAnalisados.map(tf => tf.tendencia);
        const tendenciaPrincipal = this.getTendenciaPrincipal(timeframesAnalisados);
        
        const tendenciaTfsAlinhados = tfsTendencia.filter(tf => tf.tendencia === tendenciaPrincipal).length;
        const timingTfsAlinhados = tfsTiming.filter(tf => tf.tendencia === tendenciaPrincipal).length;
        
        let alinhamentoValido = false;
        if (tfsTendencia.length === 0) {
            alinhamentoValido = timingTfsAlinhados >= 2;
        } else {
            if (tendenciaTfsAlinhados === tfsTendencia.length) {
                alinhamentoValido = timingTfsAlinhados >= tfsTiming.length - 1;
            } else {
                alinhamentoValido = false;
            }
        }

        let scorePonderadoTimeframes = 0;
        timeframesAnalisados.forEach((tf, idx) => {
            const peso = modo.pesoTimeframes[idx] || 0;
            const scoreEfetivo = tf.faseMACD?.startsWith('WEAK') ? tf.score * 0.85 : tf.score;
            scorePonderadoTimeframes += scoreEfetivo * peso;
            totalPeso += peso;
        });

        if (totalPeso > 0) scorePonderadoTimeframes /= totalPeso;

        let mediaAdx = 0;
        let pesoAdxTotal = 0;
        timeframesAnalisados.forEach(tf => {
            const peso = tf.isTfTendencia ? 2.0 : 1.0;
            mediaAdx += tf.adx * peso;
            pesoAdxTotal += peso;
        });
        mediaAdx /= pesoAdxTotal;

        let scoreAdx = 0;
        if (mediaAdx >= this.config.adxTendenciaForte) scoreAdx = 100;
        else if (mediaAdx >= this.config.adxSemTendencia) scoreAdx = 60;
        else scoreAdx = 30;

        const mediaRsi = timeframesAnalisados.reduce((sum, tf) => sum + tf.rsi, 0) / timeframesAnalisados.length;
        let scoreRsi = 0;
        if (mediaRsi >= 30 && mediaRsi <= 70) scoreRsi = 100;
        else if (mediaRsi < 30) scoreRsi = 70;
        else if (mediaRsi > 70) scoreRsi = 70;
        else scoreRsi = 50;

        if (tendenciaPrincipal === 'CALL' && mediaRsi < 40) scoreRsi += 10;
        if (tendenciaPrincipal === 'PUT' && mediaRsi > 60) scoreRsi += 10;

        let scoreVolatilidade = 100;
        if (volatilidade.nivel === 'ALTA') scoreVolatilidade = 50;
        else if (volatilidade.nivel === 'BAIXA') scoreVolatilidade = 70;

        let scoreVolume = volume ? Math.min(100, (volume / 1000) * 100) : 70;

        const pesos = this.config.pesos;
        const confianca = (
            scorePonderadoTimeframes * pesos.alinhamentoTimeframes +
            scoreAdx * pesos.adx +
            scoreRsi * pesos.rsi +
            scoreVolatilidade * pesos.volatilidade +
            scoreVolume * pesos.volume
        );

        let confiancaFinal = confianca;

        if (!alinhamentoValido) {
            const temDivergenciaTendencia = tfsTendencia.some(tf => tf.tendencia !== tendenciaPrincipal);
            confiancaFinal *= temDivergenciaTendencia ? 0.5 : 0.8;
        }

        if (alinhamentoValido && mediaAdx >= this.config.adxTendenciaForte) confiancaFinal *= 1.15;
        if (volatilidade.nivel === 'ALTA') confiancaFinal *= 0.85;

        return Math.min(100, Math.max(0, Math.round(confiancaFinal)));
    }

    getTendenciaPrincipal(timeframesAnalisados) {
        const calls = timeframesAnalisados.filter(tf => tf.tendencia === 'CALL').length;
        const puts = timeframesAnalisados.filter(tf => tf.tendencia === 'PUT').length;

        if (calls > puts) return 'CALL';
        if (puts > calls) return 'PUT';
        return 'NEUTRO';
    }

    gerarAnalise(dadosMercado, modoSelecionado = 'CAÇADOR') {
        const modo = this.modos[modoSelecionado];
        if (!modo) throw new Error(`Modo ${modoSelecionado} não encontrado`);

        const timeframesAnalisados = [];

        for (const tf of modo.timeframes) {
            const dadosTF = dadosMercado.timeframes[tf];
            if (!dadosTF) continue;

            const analise = this.analisarTimeframe({
                ...dadosTF,
                faseMACD: dadosTF.faseMACD
            }, modo, tf);
            timeframesAnalisados.push(analise);
        }

        if (timeframesAnalisados.length === 0) {
            return { erro: "Dados insuficientes para análise" };
        }

        const atr = this.calcularATR(dadosMercado.precosHistoricos, 14);
        const volatilidade = this.calcularVolatilidade(
            dadosMercado.precosHistoricos,
            atr,
            dadosMercado.precoAtual
        );

        const confianca = this.calcularConfianca(
            timeframesAnalisados,
            modo,
            volatilidade,
            dadosMercado.volume
        );

        const tendenciaPrincipal = this.getTendenciaPrincipal(timeframesAnalisados);
        const timeframesAlinhados = timeframesAnalisados.filter(tf => tf.tendencia === tendenciaPrincipal).length;
        const totalTimeframes = timeframesAnalisados.length;
        const alinhamentoPercentual = (timeframesAlinhados / totalTimeframes) * 100;

        const tfTendencia = timeframesAnalisados.find(tf => tf.isTfTendencia);
        const tendenciaForte = tfTendencia && tfTendencia.adx >= this.config.adxTendenciaForte;

        let sinal = 'HOLD';
        let acao = 'AGUARDAR';
        let motivo = '';

        if (confianca >= this.config.confiancaMinimaOperar) {
            if (tendenciaPrincipal === 'CALL') {
                if (tendenciaForte || timeframesAlinhados >= modo.minTimeframesAlinhados) {
                    sinal = 'CALL';
                    acao = '🟢 COMPRAR';
                    motivo = `${timeframesAlinhados}/${totalTimeframes} TFs em CALL com ${confianca}% de confiança`;
                    if (tendenciaForte) motivo += ` | ${modo.tfTendencia} tendência forte (ADX ${tfTendencia.adx.toFixed(0)})`;
                } else {
                    motivo = `TF de tendência (${modo.tfTendencia}) não confirma CALL`;
                }
            } else if (tendenciaPrincipal === 'PUT') {
                if (tendenciaForte || timeframesAlinhados >= modo.minTimeframesAlinhados) {
                    sinal = 'PUT';
                    acao = '🔴 VENDER';
                    motivo = `${timeframesAlinhados}/${totalTimeframes} TFs em PUT com ${confianca}% de confiança`;
                    if (tendenciaForte) motivo += ` | ${modo.tfTendencia} tendência forte (ADX ${tfTendencia.adx.toFixed(0)})`;
                } else {
                    motivo = `TF de tendência (${modo.tfTendencia}) não confirma PUT`;
                }
            }
        } else {
            motivo = `Confiança ${confianca}% abaixo do mínimo (${this.config.confiancaMinimaOperar}%)`;
            if (alinhamentoPercentual < 60) motivo += ' | TFs divergentes';
            if (volatilidade.nivel === 'ALTA') motivo += ' | Alta volatilidade';
        }

        const alertas = [];
        if (volatilidade.nivel === 'ALTA') {
            alertas.push(`⚠️ Volatilidade ALTA (${volatilidade.percentual.toFixed(2)}%) - risco elevado`);
        }
        if (confianca < this.config.confiancaAlta && confianca >= this.config.confiancaMinimaOperar) {
            alertas.push(`⚠️ Confiança ${confianca}% - considerar redução de stake`);
        }
        
        const weakTfs = timeframesAnalisados.filter(tf => tf.faseMACD?.startsWith('WEAK'));
        if (weakTfs.length > 0) {
            const tfNomes = weakTfs.map(tf => tf.timeframe).join(', ');
            alertas.push(`⚠️ ${tfNomes} perdendo força - monitorar para saída antecipada`);
        }
        
        if (timeframesAlinhados < totalTimeframes) {
            const divergentes = totalTimeframes - timeframesAlinhados;
            alertas.push(`⚠️ ${divergentes} TF(s) divergente(s)`);
        }

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
                tendenciaPrincipal: tendenciaPrincipal,
                tfTendencia: modo.tfTendencia,
                tfPrimario: modo.tfPrimario
            }
        };
    }

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
