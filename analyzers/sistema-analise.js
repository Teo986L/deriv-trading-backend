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
const MultiTimeframeManager = require('../multi-timeframe-manager');
const { calcularRSI, calcularMACD, calcularADXCompleto, calcularVolatilidade } = require('../indicators');
const { INDICATOR_CONFIG, TRADING_MODE, MARKET_STATE, CANDLE_CLOSE_TOLERANCE } = require('../config');
const { institutionalSniper } = require('../institutional-sniper');

// ========== SISTEMA DE FASES DO MACD ==========
class MacdPhaseAnalyzer {
    constructor() {
        this.phases = {
            STRONG_BULL: { 
                name: 'ALTA FORTE', 
                confidence: 0.85, 
                action: 'CALL', 
                description: 'MACD + Sinal + Histograma positivos',
                icon: '🚀',
                color: '#00ff88',
                recomendacao: '🔥 Momento forte de alta - Operar CALL com convicção'
            },
            WEAK_BULL: { 
                name: 'ALTA PERDENDO FORÇA', 
                confidence: 0.45, 
                action: 'HOLD', 
                description: 'MACD e Sinal positivos, Histograma negativo',
                icon: '⚠️',
                color: '#ffc107',
                recomendacao: '⚠️ Alta perdendo força - Aguardar ou realizar lucro'
            },
            CROSS_BEAR: { 
                name: 'CRUZAMENTO BAIXA', 
                confidence: 0.65, 
                action: 'PUT', 
                description: 'MACD negativo, Sinal positivo, Histograma negativo',
                icon: '📉',
                color: '#ff7f7f',
                recomendacao: '🎯 Cruzamento de baixa confirmado - Iniciar operações de PUT'
            },
            STRONG_BEAR: { 
                name: 'BAIXA FORTE', 
                confidence: 0.85, 
                action: 'PUT', 
                description: 'MACD + Sinal + Histograma negativos',
                icon: '🔥',
                color: '#ff4b2b',
                recomendacao: '🔥 Momento forte de baixa - Operar PUT com convicção'
            },
            CROSS_BULL: { 
                name: 'CRUZAMENTO ALTA', 
                confidence: 0.65, 
                action: 'CALL', 
                description: 'MACD positivo, Sinal negativo, Histograma positivo',
                icon: '📈',
                color: '#90EE90',
                recomendacao: '🎯 Cruzamento de alta confirmado - Iniciar operações de CALL'
            },
            WEAK_BEAR: { 
                name: 'BAIXA PERDENDO FORÇA', 
                confidence: 0.45, 
                action: 'HOLD', 
                description: 'MACD e Sinal negativos, Histograma positivo',
                icon: '⚠️',
                color: '#ffc107',
                recomendacao: '⚠️ Baixa perdendo força - Aguardar ou realizar lucro'
            },
            NEUTRAL: { 
                name: 'NEUTRO', 
                confidence: 0.35, 
                action: 'HOLD', 
                description: 'MACD próximo de zero',
                icon: '⚪',
                color: '#cccccc',
                recomendacao: '⏳ Mercado indefinido - Aguardar melhor momento'
            }
        };
    }

    analyzePhase(macdData) {
        if (!macdData || !macdData.valido) {
            return { 
                phase: 'NEUTRAL', 
                ...this.phases.NEUTRAL,
                status: {
                    macd: '⚪ NEUTRO',
                    sinal: '⚪ NEUTRO',
                    histograma: '⚪ NEUTRO'
                },
                multiplier: 1.0
            };
        }

        const { macd, sinal, histograma } = macdData;
        
        // Tolerância para considerar zero
        const tolerance = 0.001;
        const macdPos = macd > tolerance;
        const macdNeg = macd < -tolerance;
        const sinalPos = sinal > tolerance;
        const sinalNeg = sinal < -tolerance;
        const histPos = histograma > tolerance;
        const histNeg = histograma < -tolerance;

        let phase = 'NEUTRAL';
        let status = {};

        // FASE 1: ALTA FORTE 📈
        if (macdPos && sinalPos && histPos) {
            phase = 'STRONG_BULL';
            status = {
                macd: '✅ POSITIVO',
                sinal: '✅ POSITIVO',
                histograma: '✅ POSITIVO'
            };
        }
        // FASE 2: ALTA PERDENDO FORÇA ⚠️
        else if (macdPos && sinalPos && histNeg) {
            phase = 'WEAK_BULL';
            status = {
                macd: '✅ POSITIVO',
                sinal: '✅ POSITIVO',
                histograma: '❌ NEGATIVO'
            };
        }
        // FASE 3: CRUZAMENTO DE BAIXA 🔻
        else if (macdNeg && sinalPos && histNeg) {
            phase = 'CROSS_BEAR';
            status = {
                macd: '❌ NEGATIVO',
                sinal: '✅ POSITIVO',
                histograma: '❌ NEGATIVO'
            };
        }
        // FASE 4: BAIXA FORTE 📉
        else if (macdNeg && sinalNeg && histNeg) {
            phase = 'STRONG_BEAR';
            status = {
                macd: '❌ NEGATIVO',
                sinal: '❌ NEGATIVO',
                histograma: '❌ NEGATIVO'
            };
        }
        // FASE 5: CRUZAMENTO DE ALTA 🔺
        else if (macdPos && sinalNeg && histPos) {
            phase = 'CROSS_BULL';
            status = {
                macd: '✅ POSITIVO',
                sinal: '❌ NEGATIVO',
                histograma: '✅ POSITIVO'
            };
        }
        // FASE 6: BAIXA PERDENDO FORÇA ⚠️
        else if (macdNeg && sinalNeg && histPos) {
            phase = 'WEAK_BEAR';
            status = {
                macd: '❌ NEGATIVO',
                sinal: '❌ NEGATIVO',
                histograma: '✅ POSITIVO'
            };
        }
        // FASE 7: NEUTRO
        else {
            phase = 'NEUTRAL';
            status = {
                macd: '⚪ NEUTRO',
                sinal: '⚪ NEUTRO',
                histograma: '⚪ NEUTRO'
            };
        }

        const multiplier = this.getPhaseMultiplier(phase);
        const phaseData = this.phases[phase];

        return {
            phase,
            ...phaseData,
            status,
            multiplier,
            raw: {
                macd: macd.toFixed(4),
                sinal: sinal.toFixed(4),
                histograma: histograma.toFixed(4)
            }
        };
    }

    getPhaseMultiplier(phase) {
        const multipliers = {
            'STRONG_BULL': 1.3,
            'STRONG_BEAR': 1.3,
            'CROSS_BULL': 1.2,
            'CROSS_BEAR': 1.2,
            'WEAK_BULL': 0.7,
            'WEAK_BEAR': 0.7,
            'NEUTRAL': 0.5
        };
        return multipliers[phase] || 1.0;
    }

    shouldTrade(phase) {
        const tradeAllowed = ['STRONG_BULL', 'STRONG_BEAR', 'CROSS_BULL', 'CROSS_BEAR'];
        return tradeAllowed.includes(phase);
    }

    getDescription(phase) {
        return this.phases[phase]?.description || 'Fase não identificada';
    }
}

class AutomatedElliottTradingSystem {
    constructor() {
        this.analyzer = new ElliottWaveMaster();
        this.dataHistory = [];
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
        this.macdPhaseAnalyzer = new MacdPhaseAnalyzer(); // NOVO: Analisador de fases MACD
        
        this.multiTimeframeManager = new MultiTimeframeManager();
        this.timeframesData = {};
        
        // 🔥 NOVO: Armazenar ADX atual para uso na detecção de divergências
        this._adxAtual = 0;
    }

    getTimeframeSeconds(tf) {
        const map = { M1: 60, M5: 300, M15: 900, M30: 1800, H1: 3600, H4: 14400, H24: 86400 };
        return map[tf] || 300;
    }

    isCandleClosed(candle, tfSeconds) {
        if (!candle || !candle.epoch) return true;
        const now = Math.floor(Date.now() / 1000);
        const candleEnd = candle.epoch + tfSeconds;
        return now >= candleEnd - CANDLE_CLOSE_TOLERANCE;
    }

    // ========== FUNÇÃO CORRIGIDA: DETECTAR DIVERGÊNCIAS MACD ==========
    detectarDivergenciaMACD(macdData) {
        if (!macdData || !macdData.valido) return { divergencia: false, motivo: '' };
        
        const { macd, sinal, histograma } = macdData;
        
        // 🔥 CORREÇÃO 1: Se ADX for forte (> 30), IGNORAR divergências MACD
        if (this._adxAtual && this._adxAtual > 30) {
            return { 
                divergencia: false, 
                motivo: `ADX forte (${this._adxAtual.toFixed(1)}) ignorando divergências` 
            };
        }
        
        // Caso 1: MACD positivo e sinal positivo, mas histograma negativo
        if (macd > 0 && sinal > 0 && histograma < 0) {
            return {
                divergencia: true,
                tipo: 'DIVERGÊNCIA BEARISH',
                motivo: 'MACD e sinal positivos mas histograma negativo - MOMENTO CONTRÁRIO À TENDÊNCIA',
                acao: 'HOLD',
                probabilidadeReducao: 0.7
            };
        }
        
        // Caso 2: MACD negativo e sinal negativo, mas histograma positivo
        if (macd < 0 && sinal < 0 && histograma > 0) {
            return {
                divergencia: true,
                tipo: 'DIVERGÊNCIA BULLISH',
                motivo: 'MACD e sinal negativos mas histograma positivo - MOMENTO CONTRÁRIO À TENDÊNCIA',
                acao: 'HOLD',
                probabilidadeReducao: 0.7
            };
        }
        
        // Caso 3: MACD positivo mas sinal negativo (cruzamento de alta recente)
        if (macd > 0 && sinal < 0) {
            return {
                divergencia: true,
                tipo: 'CRUZAMENTO DE ALTA RECENTE',
                motivo: 'MACD acabou de cruzar para cima - AGUARDAR CONFIRMAÇÃO',
                acao: 'HOLD',
                probabilidadeReducao: 0.8
            };
        }
        
        // Caso 4: MACD negativo mas sinal positivo (cruzamento de baixa recente)
        if (macd < 0 && sinal > 0) {
            return {
                divergencia: true,
                tipo: 'CRUZAMENTO DE BAIXA RECENTE',
                motivo: 'MACD acabou de cruzar para baixo - AGUARDAR CONFIRMAÇÃO',
                acao: 'HOLD',
                probabilidadeReducao: 0.8
            };
        }
        
        // Caso 5: MACD próximo de zero (neutro)
        if (Math.abs(macd) < 0.001 && Math.abs(histograma) < 0.001) {
            return {
                divergencia: true,
                tipo: 'MACD NEUTRO',
                motivo: 'MACD próximo de zero - TENDÊNCIA INDEFINIDA',
                acao: 'HOLD',
                probabilidadeReducao: 0.7
            };
        }
        
        return { divergencia: false, motivo: '' };
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
        
        const k = 2 / (periodo + 1);
        let ema = precos[0];
        
        for (let i = 1; i < precos.length; i++) {
            ema = precos[i] * k + ema * (1 - k);
        }
        
        return ema;
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

    coletarAnalisesVelocidade(analisesPorTF) {
        const velocidades = {};
        
        for (const [tf, analise] of Object.entries(analisesPorTF)) {
            if (analise && analise.velocidade_analysis) {
                velocidades[tf] = analise.velocidade_analysis;
            }
        }
        
        return velocidades;
    }

    async analisar(candles, timeframeKey = 'M5') {
        if (!candles || candles.length < 20) {
            return { erro: "Dados insuficientes (mínimo 20 candles)" };
        }

        const tfSeconds = this.getTimeframeSeconds(timeframeKey);
        if (candles.length > 0 && !this.isCandleClosed(candles[candles.length - 1], tfSeconds)) {
            console.log(`⚠️ Último candle de ${timeframeKey} descartado por estar aberto`);
            candles = candles.slice(0, -1);
            if (candles.length < 20) {
                return { erro: "Dados insuficientes após descartar candle aberto" };
            }
        }

        const fechamentos = candles.map(c => parseFloat(c.close));
        const precoAtual = fechamentos[fechamentos.length - 1];
        const precoAnterior = fechamentos[fechamentos.length - 2];
        
        const pesosAutomaticos = this.sistemaPesos.analisarMercado(candles, precoAtual);
        const estadoMercado = this.sistemaPesos.getEstadoMercado();
        const tendenciaForca = this.sistemaPesos.getTendenciaForca();
        const volatilidade = this.sistemaPesos.getVolatilidade();
        const rsi = this.calcularRSI(fechamentos);
        const adxData = this.calcularADXCompleto(candles);
        
        // 🔥 CORREÇÃO 2: Guardar ADX atual para uso na detecção de divergências
        this._adxAtual = adxData.adx;
        
        const macdResult = this.calcularMACD(fechamentos);
        const volatilidadeAtual = this.calcularVolatilidade(candles, precoAtual);
        const tendenciaMACD = this.verificarTendenciaMACD(macdResult);

        // ========== NOVA ANÁLISE DE FASE MACD ==========
        const macdPhase = this.macdPhaseAnalyzer.analyzePhase(macdResult);
        
        console.log(`\n📊 ANÁLISE DE FASE MACD:`);
        console.log(`   Fase: ${macdPhase.phase} - ${macdPhase.name}`);
        console.log(`   MACD: ${macdPhase.status.macd} | Sinal: ${macdPhase.status.sinal} | Hist: ${macdPhase.status.histograma}`);
        console.log(`   Recomendação: ${macdPhase.recomendacao}`);
        console.log(`   Multiplicador: ${macdPhase.multiplier.toFixed(2)}x`);

        // ========== DETECTAR DIVERGÊNCIAS MACD ==========
        const divergenciaMACD = this.detectarDivergenciaMACD(macdResult);

        const analiseDupla = this.sistemaDuplaTendencia.analisarTendenciasDuplas(
            candles, macdResult, rsi, adxData
        );
        const sinalDupla = this.sistemaDuplaTendencia.calcularSinalFinal(analiseDupla);
        
        const sinalCombinado = this.quasimodoAnalyzer.generateCombinedSignal(
            candles, macdResult.histograma, rsi
        );
        
        const confirmacaoQM = this.quasimodoAnalyzer.confirmSignalWithQM(
            sinalDupla.sinal, precoAtual, candles.slice(-50)
        );

        const elliottAnalyzer = new ElliottWaveMaster();
        const elliottAnalysis = elliottAnalyzer.analyzeFull(candles.slice(-100));
        
        const advancedIndicators = {
            macdLine: macdResult.macd,
            macdSignal: macdResult.sinal,
            macdHist: macdResult.histograma,
            adx: adxData.adx,
            rsi: rsi,
            h4ADX: adxData.adx,
            h4RSI: rsi,
            totalScore: sinalDupla.probabilidade * 100
        };
        
        const advancedAnalysis = this.advancedAnalyzer.analyze(candles, advancedIndicators);
        
        const velocidadeAnalysis = this.velocidadeAnalyzer.analisarVelocidade(
            rsi, adxData.adx, precoAtual, timeframeKey, candles.slice(-10)
        );

        const analiseAtual = {
            sinal: sinalDupla.sinal,
            probabilidade: sinalDupla.probabilidade,
            adx: adxData.adx,
            rsi,
            preco_atual: precoAtual,
            tendencia: tendenciaMACD,
            velocidade_analysis: velocidadeAnalysis,
            macd: macdResult,
            macd_phase: macdPhase, // NOVO: adicionar fase MACD
            elliott: elliottAnalysis.structure,
            quasimodo: confirmacaoQM,
            dupla_tendencia: {
                sinal: sinalDupla.sinal,
                probabilidade: sinalDupla.probabilidade,
                convergencia: analiseDupla.convergencia
            },
            divergencia_macd: divergenciaMACD
        };
        
        this.multiTimeframeManager.addAnalysis(timeframeKey, analiseAtual);

        const consolidated = this.multiTimeframeManager.consolidateSignals();
        
        const velocidades = this.coletarAnalisesVelocidade(this.multiTimeframeManager.allAnalyses);
        const comparacaoVelocidade = this.velocidadeAnalyzer.compararVelocidadeEntreTimeframes(velocidades);

        let sinal = consolidated.signal;
        let probabilidade = consolidated.confidence;
        let regra = `Sinal consolidado por ADX (timeframe dominante: ${consolidated.timeframeDominante?.tf || 'N/A'})`;
        let explicacoes = [regra];

        // ========== APLICAR FILTRO DE DIVERGÊNCIA MACD ==========
        if (divergenciaMACD.divergencia) {
            probabilidade *= divergenciaMACD.probabilidadeReducao;
            explicacoes.push(`🚨 ${divergenciaMACD.tipo}: ${divergenciaMACD.motivo} (fator ${divergenciaMACD.probabilidadeReducao})`);
        }

        // ========== APLICAR MULTIPLICADOR DA FASE MACD ==========
        const phaseMultiplier = macdPhase.multiplier;
        probabilidade *= phaseMultiplier;
        explicacoes.push(`📊 Fase MACD: ${macdPhase.name} (x${phaseMultiplier.toFixed(2)})`);

        // ========== VERIFICAR SE A FASE PERMITE TRADING ==========
        if (!this.macdPhaseAnalyzer.shouldTrade(macdPhase.phase)) {
            probabilidade *= 0.5;
            explicacoes.push('⚠️ Fase MACD não recomendada para trading');
        }

        if (advancedAnalysis && advancedAnalysis.summary) {
            const adv = advancedAnalysis.summary;
            if (!adv.tradeAllowed) {
                probabilidade *= 0.3;
                explicacoes.push(`🚫 Análise avançada bloqueia: ${adv.reason}`);
            } else if (adv.state === MARKET_STATE.STRONG_BULL_TREND || 
                       adv.state === MARKET_STATE.STRONG_BEAR_TREND) {
                probabilidade += 0.1;
                explicacoes.push(`📈 Estado de tendência forte (${adv.state})`);
            }
        }

        if (confirmacaoQM.confirmed && confirmacaoQM.pattern) {
            probabilidade += 0.07;
            explicacoes.push("✅ Confirmado por Quasimodo");
        }

        const elliottConfirma = elliottAnalysis.tradingSignals.some(
            s => (s.type === 'BUY' && sinal === 'CALL') || 
                 (s.type === 'SELL' && sinal === 'PUT')
        );
        
        if (elliottConfirma) {
            probabilidade += 0.08;
            explicacoes.push("🌊 Confirmado por Elliott Wave");
        }

        if (velocidadeAnalysis && velocidadeAnalysis.fatorConfianca < 0.6) {
            probabilidade *= velocidadeAnalysis.fatorConfianca;
            explicacoes.push(`⏱️ Velocidade anormal (fator ${velocidadeAnalysis.fatorConfianca.toFixed(2)})`);
        }

        if (comparacaoVelocidade.score < 50) {
            probabilidade *= 0.7;
            explicacoes.push(`⚠️ Divergência de velocidade entre TFs (score: ${comparacaoVelocidade.score}%)`);
        }

        if (volatilidadeAtual > 2.0) {
            probabilidade *= 0.9;
            explicacoes.push("📊 Alta volatilidade");
        } else if (volatilidadeAtual < 0.3) {
            probabilidade *= 1.1;
            explicacoes.push("📊 Baixa volatilidade");
        }

        const analiseConfiabilidade = this.sistemaConfiabilidade.analisarConfiabilidadeSinal(sinal, {
            precoAtual,
            macdHistograma: macdResult.histograma,
            rsi,
            candles,
            timeframe: timeframeKey
        });

        if (!analiseConfiabilidade.confiavel && sinal !== "HOLD") {
            probabilidade *= 0.7;
            explicacoes.push("⚠️ Confiabilidade baixa");
        }

        probabilidade = Math.max(0.3, Math.min(0.92, probabilidade));
        probabilidade = this.aplicarFiltroTradingMode(sinal, probabilidade);
        probabilidade = Math.max(0.35, Math.min(0.92, probabilidade));

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
            regra_aplicada: explicacoes.join(' | '),
            volatilidade: volatilidadeAtual,
            tipo_ativo: this.tipoAtivo,
            simbolo: this.simbolo,
            decisao_rapida: this.sistemaConfiabilidade.tabelaDecisaoRapida(macdResult.histograma, rsi),
            
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
                suggests_signal: elliottAnalysis.tradingSignals.length > 0 ? 
                    (elliottAnalysis.tradingSignals[0].type === 'BUY' ? 'CALL' : 'PUT') : null
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
            divergencia_macd: divergenciaMACD,
            
            // ========== NOVA INFORMAÇÃO DE FASE MACD ==========
            macd_phase: {
                phase: macdPhase.phase,
                name: macdPhase.name,
                icon: macdPhase.icon,
                color: macdPhase.color,
                confidence: macdPhase.confidence,
                recomendacao: macdPhase.recomendacao,
                multiplier: macdPhase.multiplier,
                status: macdPhase.status,
                raw: macdPhase.raw
            },
            
            multi_timeframe: this.multiTimeframeManager.getDiagnostico ? 
                this.multiTimeframeManager.getDiagnostico() : {
                    consolidado: consolidated,
                    comparacao_velocidade: comparacaoVelocidade,
                    timeframe_dominante: consolidated.timeframeDominante,
                    divergencias: consolidated.divergencias || []
                },
            
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
                if (sniperResult.confidence >= 80 && sniperResult.signal === sinal) {
                    resultado.regra_aplicada += ` | 🎯 INSTITUTIONAL SNIPER CONFIRMA (${sniperResult.rating})`;
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
        
        switch(TRADING_MODE) {
            case "CONSERVADOR":
                return probabilidade >= 0.6 ? probabilidade : 0.3;
            case "PADRÃO":
                return probabilidade;
            case "AGGRESSIVO":
                return Math.min(0.9, probabilidade * 1.15);
            default:
                return probabilidade;
        }
    }

    clearTimeframeCache() {
        this.timeframesData = {};
        this.multiTimeframeManager = new MultiTimeframeManager();
    }
}

module.exports = { SistemaAnaliseInteligente };
