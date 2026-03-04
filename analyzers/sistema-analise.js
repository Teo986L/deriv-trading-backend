// analyzers/sistema-analise.js
const ConfigAtivo = require('../config').ConfigAtivo;
const SistemaPesosAutomaticos = require('./sistema-pesos');
const SistemaConfiabilidade = require('./sistema-confiabilidade');
const SistemaDuplaTendencia = require('./sistema-dupla-tendencia');
const QuasimodoPattern = require('./quasimodo');
const ElliottWaveMaster = require('./elliott-wave');
const AdvancedMarketAnalyzer = require('./advanced-market');
const AnaliseVelocidadeIndicadores = require('./velocidade');
const ZonaDeOuroPremium = require('./zona-ouro');
const { calcularRSI, calcularMACD, calcularADXCompleto, calcularVolatilidade } = require('../indicators');
const { INDICATOR_CONFIG, TRADING_MODE, MARKET_STATE } = require('../config');
const { institutionalSniper, bullish, bearish, strongClose, wickRejection, detectLiquidityGrab, detectFakeBreakout } = require('../institutional-sniper');

class AutomatedElliottTradingSystem {
    constructor() {
        this.analyzer = new ElliottWaveMaster();
        this.dataHistory = [];
        this.riskManager = null; // Não usado aqui
        this.positions = [];
        this.accountBalance = 10;
    }
    async onNewCandle(candle) {
        this.dataHistory.push(candle);
        if (this.dataHistory.length > 200) this.dataHistory = this.dataHistory.slice(-200);
        const analysis = this.analyzer.analyzeFull(this.dataHistory);
        const signals = analysis.tradingSignals;
        return { analysis, signals, positions: this.positions, accountBalance: this.accountBalance };
    }
}

class SistemaAnaliseInteligente {
    constructor(simbolo) {
        this.simbolo = simbolo;
        this.config = ConfigAtivo.getConfig(simbolo);
        this.tipoAtivo = ConfigAtivo._detectarTipoAtivo(simbolo);
        this.sistemaPesos = new SistemaPesosAutomaticos();
        this.sistemaConfiabilidade = new SistemaConfiabilidade();
        this.sistemaDuplaTendencia = new SistemaDuplaTendencia();
        this.quasimodoAnalyzer = new QuasimodoPattern([]);
        this.elliottWaveSystem = new AutomatedElliottTradingSystem();
        this.advancedAnalyzer = new AdvancedMarketAnalyzer();
        this.velocidadeAnalyzer = new AnaliseVelocidadeIndicadores();
        this.zonaDeOuroPremium = new ZonaDeOuroPremium();

        this.timeframesData = {};
    }

    calcularMediaSimples(precos, periodo) {
        if (!precos || precos.length === 0) return 0;
        if (precos.length < periodo) return precos.reduce((a, b) => a + b, 0) / precos.length;
        const slice = precos.slice(-periodo);
        return slice.reduce((a, b) => a + b, 0) / periodo;
    }

    calcularMediaExponencial(precos, periodo) {
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

    calcularRSI(precos, periodo = INDICATOR_CONFIG.RSI_PERIOD) {
        return calcularRSI(precos, periodo);
    }

    calcularMACD(precos, periodoRapido = INDICATOR_CONFIG.MACD_FAST, periodoLento = INDICATOR_CONFIG.MACD_SLOW, periodoSinal = INDICATOR_CONFIG.MACD_SIGNAL) {
        return calcularMACD(precos, periodoRapido, periodoLento, periodoSinal);
    }

    verificarTendenciaMACD(macdData) {
        if (!macdData || !macdData.valido) return "NEUTRO";
        const histograma = macdData.histograma, linhaMACD = macdData.macd, linhaSinal = macdData.sinal;
        if (histograma > 0.001 && linhaMACD > linhaSinal) return "FORTE_ALTA";
        if (histograma < -0.001 && linhaMACD < linhaSinal) return "FORTE_BAIXA";
        if (histograma > 0) return "MODERADA_ALTA";
        if (histograma < 0) return "MODERADA_BAIXA";
        return "NEUTRO";
    }

    calcularADXCompleto(candles, periodo = INDICATOR_CONFIG.ADX_PERIOD) {
        return calcularADXCompleto(candles, periodo);
    }

    calcularVolatilidade(candles, precoAtual) {
        return calcularVolatilidade(candles, precoAtual);
    }

    gerarSinalRapidoMACD(candles) {
        if (!candles || candles.length < 30) return null;
        const fechamentos = candles.map(c => parseFloat(c.close));
        const macdResult = this.calcularMACD(fechamentos);
        if (!macdResult.valido) return null;

        if (macdResult.histograma > 0.002) return { sinal: "CALL", forca: "FORTE", motivo: `MACD positivo forte (${macdResult.histograma.toFixed(4)})`, probabilidade: 0.68 };
        else if (macdResult.histograma > 0.001) return { sinal: "CALL", forca: "MODERADA", motivo: `MACD positivo moderado (${macdResult.histograma.toFixed(4)})`, probabilidade: 0.62 };
        else if (macdResult.histograma < -0.002) return { sinal: "PUT", forca: "FORTE", motivo: `MACD negativo forte (${macdResult.histograma.toFixed(4)})`, probabilidade: 0.68 };
        else if (macdResult.histograma < -0.001) return { sinal: "PUT", forca: "MODERADA", motivo: `MACD negativo moderado (${macdResult.histograma.toFixed(4)})`, probabilidade: 0.62 };
        return null;
    }

    updateTimeframeData(timeframeKey, analysis) {
        if (analysis && analysis.sinal) {
            this.timeframesData[timeframeKey] = {
                trend: analysis.sinal,
                adx: analysis.adx,
                rsi: analysis.rsi,
                preco: analysis.preco_atual,
                probabilidade: analysis.probabilidade
            };
        }
    }

    analyzeInstitutionalSniper(m15Data, agreementScore) {
        if (!m15Data || !m15Data.candles || m15Data.candles.length < 5) return null;

        const sniperResult = institutionalSniper({
            trendH1: this.timeframesData['H1']?.trend || 'NEUTRAL',
            candlesM15: m15Data.candles,
            rsiM15: m15Data.rsi,
            adxM15: m15Data.adx,
            agreementScore: agreementScore,
            serverTime: Date.now(),
            timeframes: this.timeframesData
        });

        return sniperResult;
    }

    async analisar(candles, timeframeKey = 'M5') {
        if (!candles || candles.length < 20) return { erro: "Dados insuficientes (mínimo 20 candles)" };

        const fechamentos = candles.map(c => parseFloat(c.close));
        const precoAtual = fechamentos[fechamentos.length - 1];
        const precoAnterior = fechamentos[fechamentos.length - 2];
        const ultimaVela = candles[candles.length - 2];

        const pesosAutomaticos = this.sistemaPesos.analisarMercado(candles, precoAtual);
        const estadoMercado = this.sistemaPesos.getEstadoMercado();
        const tendenciaForca = this.sistemaPesos.getTendenciaForca();
        const volatilidade = this.sistemaPesos.getVolatilidade();
        const rsi = this.calcularRSI(fechamentos);
        const adxData = this.calcularADXCompleto(candles);
        const macdResult = this.calcularMACD(fechamentos);
        const volatilidadeAtual = this.calcularVolatilidade(candles, precoAtual);
        const tendenciaMACD = this.verificarTendenciaMACD(macdResult);

        const analiseDupla = this.sistemaDuplaTendencia.analisarTendenciasDuplas(precoAtual, precoAnterior, macdResult, rsi, adxData, ultimaVela);
        const sinalFinal = this.sistemaDuplaTendencia.calcularSinalFinal(analiseDupla);

        let sinal = sinalFinal.sinal;
        let probabilidade = sinalFinal.probabilidade;
        let regra = sinalFinal.motivo;

        const sinalCombinado = this.quasimodoAnalyzer.generateCombinedSignal(candles, macdResult.histograma, rsi);
        const confirmacaoQM = this.quasimodoAnalyzer.confirmSignalWithQM(sinal, precoAtual, candles.slice(-50));

        const elliottAnalyzer = new ElliottWaveMaster();
        const elliottAnalysis = elliottAnalyzer.analyzeFull(candles.slice(-100));
        let elliottConfirma = false, elliottSinal = "NEUTRAL", elliottConfidence = 0, elliottReason = "";

        if (elliottAnalysis.tradingSignals.length > 0) {
            const primarySignal = elliottAnalysis.tradingSignals[0];
            elliottSinal = primarySignal.type === 'BUY' ? 'CALL' : 'SELL';
            elliottConfidence = primarySignal.confidence;
            elliottReason = primarySignal.reason;
            if (elliottSinal === sinal) elliottConfirma = true;
        }

        const advancedIndicators = {
            macdLine: macdResult.macd,
            macdSignal: macdResult.sinal,
            macdHist: macdResult.histograma,
            adx: adxData.adx,
            rsi: rsi,
            h4ADX: adxData.adx,
            h4RSI: rsi,
            totalScore: probabilidade * 100
        };
        const advancedAnalysis = this.advancedAnalyzer.analyze(candles, advancedIndicators);

        const velocidadeAnalysis = this.velocidadeAnalyzer.analisarVelocidade(
            rsi, adxData.adx, precoAtual,
            timeframeKey,
            candles.slice(-10)
        );

        let sinalAjustado = sinal, probabilidadeAjustada = probabilidade, regraAjustada = regra;

        if (confirmacaoQM.confirmed) {
            probabilidadeAjustada += 0.07;
            regraAjustada += " | ✅ Confirmado por Quasimodo";
        } else if (sinal !== "HOLD") {
            probabilidadeAjustada -= 0.05;
            regraAjustada += " | ⚠️ Quasimodo não confirma";
        }

        if (elliottConfirma) {
            probabilidadeAjustada += 0.08;
            regraAjustada += " | 🌊 Confirmado por Elliott Wave";
            if (elliottAnalysis.structure.pattern !== 'UNKNOWN') regraAjustada += ` (${elliottAnalysis.structure.pattern})`;
        } else if (sinal !== "HOLD" && elliottSinal !== "NEUTRAL") {
            if (elliottConfidence > probabilidadeAjustada + 0.1) {
                sinalAjustado = elliottSinal;
                probabilidadeAjustada = elliottConfidence;
                regraAjustada = elliottReason + " | Prioridade Elliott Wave";
            } else {
                probabilidadeAjustada -= 0.04;
                regraAjustada += " | ⚠️ Elliott Wave sugere direção diferente";
            }
        }

        if (advancedAnalysis && advancedAnalysis.summary) {
            const adv = advancedAnalysis.summary;
            if (!adv.tradeAllowed) {
                probabilidadeAjustada *= 0.5;
                regraAjustada += ` | 🚫 Análise avançada bloqueia: ${adv.reason}`;
            } else {
                if (adv.state === MARKET_STATE.STRONG_BULL_TREND || adv.state === MARKET_STATE.STRONG_BEAR_TREND) {
                    probabilidadeAjustada += 0.1;
                    regraAjustada += ` | 📈 Estado de tendência forte (${adv.state})`;
                }
            }
        }

        if (velocidadeAnalysis && velocidadeAnalysis.fatorConfianca < 0.7) {
            probabilidadeAjustada *= velocidadeAnalysis.fatorConfianca;
            regraAjustada += ` | ⏱️ Velocidade anormal (fator ${velocidadeAnalysis.fatorConfianca.toFixed(2)})`;
        }

        const metodosConvergentes = [sinal === sinalCombinado.signal, elliottConfirma || elliottSinal === sinalAjustado];
        const convergenciaCount = metodosConvergentes.filter(Boolean).length;
        if (convergenciaCount >= 2) {
            probabilidadeAjustada += 0.1;
            regraAjustada += " | 🎯 ALTA CONVERGÊNCIA ENTRE MÉTODOS";
        }

        sinal = sinalAjustado;
        probabilidade = probabilidadeAjustada;
        regra = regraAjustada;

        const analiseConfiabilidade = this.sistemaConfiabilidade.analisarConfiabilidadeSinal(sinal, {
            precoAtual,
            macdHistograma: macdResult.histograma,
            rsi,
            candles,
            timeframe: "5min"
        });

        const decisaoRapida = this.sistemaConfiabilidade.tabelaDecisaoRapida(macdResult.histograma, rsi);

        if (!analiseConfiabilidade.confiavel && sinal !== "HOLD") {
            probabilidade *= 0.7;
            regra += " | Confiabilidade baixa";
        }

        if (sinal !== "HOLD") {
            const sensibilidade = Math.max(0.8, Math.min(1.5, pesosAutomaticos.sensibilidade_geral || 1.0));
            const agressividade = Math.max(0.8, Math.min(1.5, pesosAutomaticos.agressividade_ajustada || 1.0));
            probabilidade *= sensibilidade;
            probabilidade *= agressividade;

            if (volatilidadeAtual > 2.0) {
                probabilidade *= 0.92;
                regra += " | Alta volatilidade";
            } else if (volatilidadeAtual < 0.3) {
                probabilidade *= 1.1;
                regra += " | Baixa volatilidade";
            }

            probabilidade = Math.max(0.3, Math.min(0.88, probabilidade));
        }

        probabilidade = this.aplicarFiltroTradingMode(sinal, probabilidade);
        probabilidade = Math.max(0.35, Math.min(0.88, probabilidade));

        const direcao = sinal === "CALL" ? "ALTA" : sinal === "PUT" ? "BAIXA" : "NEUTRA";

        this.updateTimeframeData(timeframeKey, {
            sinal,
            probabilidade,
            adx: adxData.adx,
            rsi,
            preco_atual: precoAtual
        });

        const resultado = {
            sinal,
            direcao,
            probabilidade,
            tendencia: tendenciaMACD,
            rsi,
            adx: adxData.adx,
            preco_atual: precoAtual,
            variacao_recente: ((precoAtual - precoAnterior) / precoAnterior * 100),
            regra_aplicada: regra,
            volatilidade: volatilidadeAtual,
            tipo_ativo: this.tipoAtivo,
            simbolo: this.simbolo,
            decisao_rapida: decisaoRapida,
            tendencias_duplas: analiseDupla,
            confiabilidade: {
                confiavel: analiseConfiabilidade.confiavel,
                categoria: analiseConfiabilidade.categoria,
                acao_recomendada: analiseConfiabilidade.acaoRecomendada,
                motivo: analiseConfiabilidade.motivo
            },
            quasimodo_confirmation: {
                confirmed: confirmacaoQM.confirmed,
                confirmation_type: confirmacaoQM.confirmationType,
                distance_percent: confirmacaoQM.distancePercent,
                pattern_type: confirmacaoQM.pattern ? confirmacaoQM.pattern.type : null,
                pattern_price: confirmacaoQM.pattern ? confirmacaoQM.pattern.price : null
            },
            elliott_wave: {
                pattern: elliottAnalysis.structure.pattern,
                phase: elliottAnalysis.structure.phase,
                trend: elliottAnalysis.trend,
                confidence: elliottAnalysis.confidence,
                confirms_signal: elliottConfirma,
                suggested_signal: elliottSinal,
                reason: elliottReason,
                fibonacci_levels: elliottAnalysis.fibonacci,
                wave_count: elliottAnalysis.waveCount
            },
            sinal_combinado: {
                signal: sinalCombinado.signal,
                confidence: sinalCombinado.confidence,
                reason: sinalCombinado.reason
            },
            pesos_automaticos: {
                estado_mercado: estadoMercado,
                tendencia_forca: tendenciaForca,
                volatilidade_nivel: volatilidade
            },
            advanced_analysis: advancedAnalysis,
            velocidade_analysis: velocidadeAnalysis,
            indicator_config: {
                rsi_period: INDICATOR_CONFIG.RSI_PERIOD,
                adx_period: INDICATOR_CONFIG.ADX_PERIOD,
                macd_fast: INDICATOR_CONFIG.MACD_FAST,
                macd_slow: INDICATOR_CONFIG.MACD_SLOW,
                macd_signal: INDICATOR_CONFIG.MACD_SIGNAL
            },
            macd_data: {
                macd: macdResult.macd,
                sinal: macdResult.sinal,
                histograma: macdResult.histograma,
                direcao: macdResult.direcao
            },
            timeframe_key: timeframeKey
        };

        if (timeframeKey === 'M15') {
            const sniperResult = this.analyzeInstitutionalSniper({
                candles: candles,
                rsi: rsi,
                adx: adxData.adx
            }, probabilidade * 100);

            if (sniperResult) {
                resultado.institutional_sniper = sniperResult;
                if (sniperResult.confidence >= 70 && sniperResult.rating === 'A+') {
                    resultado.sinal = sniperResult.signal;
                    resultado.probabilidade = sniperResult.confidence / 100;
                    resultado.regra_aplicada += ` | 🎯 INSTITUTIONAL SNIPER (${sniperResult.rating})`;
                }
            }
        }

        return resultado;
    }

    obterTimeframeKey(candles) {
        if (candles.length < 2) return "M5";
        const diff = (candles[1].epoch || candles[1].time) - (candles[0].epoch || candles[0].time);
        if (diff <= 300) return "M5";
        if (diff <= 900) return "M15";
        if (diff <= 1800) return "M30";
        if (diff <= 3600) return "H1";
        if (diff <= 14400) return "H4";
        return "H24";
    }

    aplicarFiltroTradingMode(sinal, probabilidade) {
        if (sinal === "HOLD") return probabilidade;
        if (TRADING_MODE === "CONSERVADOR") return probabilidade >= 0.55 ? probabilidade : 0.35;
        else if (TRADING_MODE === "PADRÃO") return probabilidade;
        else if (TRADING_MODE === "AGGRESSIVO") return Math.min(0.85, probabilidade * 1.12);
        return probabilidade;
    }

    clearTimeframeCache() {
        this.timeframesData = {};
    }
}

module.exports = { SistemaAnaliseInteligente };
