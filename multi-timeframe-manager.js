// multi-timeframe-manager.js
const { SMOOTHING } = require('./config');

class MultiTimeframeManager {
    constructor(simbolo = '') {
        this.timeframes = {
            M1: { seconds: 60, label: '1m', data: null, analysis: null },
            M5: { seconds: 300, label: '5m', data: null, analysis: null },
            M15: { seconds: 900, label: '15m', data: null, analysis: null },
            M30: { seconds: 1800, label: '30m', data: null, analysis: null },
            H1: { seconds: 3600, label: '1h', data: null, analysis: null },
            H4: { seconds: 14400, label: '4h', data: null, analysis: null },
            H24: { seconds: 86400, label: '24h', data: null, analysis: null }
        };
        this.consolidatedSignal = { signal: 'HOLD', confidence: 0, agreement: 0, details: {} };
        this.allAnalyses = {};
        this.signalHistory = {};
        
        // ========== NOVAS PROPRIEDADES PARA ANÁLISE AVANÇADA ==========
        this.simbolo = simbolo;
        this.tipoAtivo = this.detectarTipoAtivo(simbolo);
        this.priceHistory = {
            'M1': [], 'M5': [], 'M15': [], 'M30': [], 'H1': [], 'H4': [], 'H24': []
        };
        this.historicoAcertos = {
            'M1': { acertos: 0, total: 0 }, 'M5': { acertos: 0, total: 0 },
            'M15': { acertos: 0, total: 0 }, 'M30': { acertos: 0, total: 0 },
            'H1': { acertos: 0, total: 0 }, 'H4': { acertos: 0, total: 0 },
            'H24': { acertos: 0, total: 0 }
        };
        this.ultimosRSI = {};
        
        // ========== CONFIGURAÇÕES ESPECÍFICAS POR ATIVO ==========
        this.CONFIG_ATIVO = {
            'CRASH': {
                rsiCompra: 35, rsiVenda: 60, adxMinimo: 25,
                pesoH4: 3.0, pesoH1: 2.0, pesoM15: 1.2, pesoM5: 0.8, pesoM1: 0.6,
                nome: 'Crash Index',
                estrategia: 'Quedas violentas, comprar nas correções RSI<35, vender nos topos RSI>60'
            },
            'BOOM': {
                rsiCompra: 40, rsiVenda: 65, adxMinimo: 25,
                pesoH4: 3.0, pesoH1: 2.0, pesoM15: 1.2, pesoM5: 0.8, pesoM1: 0.6,
                nome: 'Boom Index',
                estrategia: 'Altas violentas, vender nas correções RSI>65, comprar nos fundos RSI<40'
            },
            'JUMP': {
                rsiCompra: 45, rsiVenda: 55, adxMinimo: 30,
                pesoH4: 2.0, pesoH1: 1.5, pesoM15: 1.5, pesoM5: 1.0, pesoM1: 0.8,
                nome: 'Jump Index',
                estrategia: 'Movimentos bruscos, operar após confirmação do salto'
            },
            'STEP': {
                rsiCompra: 40, rsiVenda: 60, adxMinimo: 20,
                pesoH4: 1.5, pesoH1: 1.3, pesoM15: 1.2, pesoM5: 1.0, pesoM1: 1.0,
                nome: 'Step Index',
                estrategia: 'Movimentos em degraus, operar quebras de suporte/resistência'
            },
            'DEFAULT': {
                rsiCompra: 30, rsiVenda: 70, adxMinimo: 20,
                pesoH4: 3.5, pesoH1: 3.0, pesoM15: 2.0, pesoM5: 1.5, pesoM1: 1.0,
                nome: 'Default',
                estrategia: 'Seguir tendência com todos os timeframes'
            }
        };
        
        this.TF_BASE_WEIGHT = {
            'M1': 1.0, 'M5': 1.5, 'M15': 2.0, 'M30': 2.5, 'H1': 3.0, 'H4': 3.5, 'H24': 4.0
        };
        
        this.ADX_THRESHOLDS = {
            'M1': { min: 12, ignore_below: 8 },
            'M5': { min: 12, ignore_below: 8 },
            'M15': { min: 14, ignore_below: 10 },
            'M30': { min: 14, ignore_below: 10 },
            'H1': { min: 12, ignore_below: 8 },
            'H4': { min: 10, ignore_below: 6 },
            'H24': { min: 8, ignore_below: 5 }
        };
    }

    // ========== DETECTAR TIPO DE ATIVO ==========
    detectarTipoAtivo(simbolo) {
        if (!simbolo) return 'DEFAULT';
        if (simbolo.includes('CRASH')) return 'CRASH';
        if (simbolo.includes('BOOM')) return 'BOOM';
        if (simbolo.includes('JUMP')) return 'JUMP';
        if (simbolo.includes('STEP')) return 'STEP';
        return 'DEFAULT';
    }

    // ========== OBTER CONFIGURAÇÃO DO ATIVO ==========
    getConfigAtivo() {
        return this.CONFIG_ATIVO[this.tipoAtivo] || this.CONFIG_ATIVO['DEFAULT'];
    }

    // ========== DETECTAR ALINHAMENTO PARA ENTRADA NO PESCADOR ==========
    detectarAlinhamentoPescador() {
        const pescador = this.consolidatedSignal;
        const sniperM1 = this.allAnalyses['M1'];
        
        if (!pescador || !sniperM1) return null;
        
        const config = this.getConfigAtivo();
        
        // Se PESCADOR quer PUT mas SNIPER ainda está CALL
        if (pescador.signal === 'PUT' && sniperM1.sinal === 'CALL') {
            
            // Detectar se SNIPER está perto de virar (RSI alto)
            if (sniperM1.rsi > config.rsiVenda - 5 && sniperM1.adx > config.adxMinimo) {
                return {
                    status: 'AGUARDAR',
                    direcaoPescador: 'PUT',
                    direcaoSniper: 'CALL',
                    motivo: `SNIPER ainda CALL mas RSI ${sniperM1.rsi} próximo de ${config.rsiVenda} - quase virando`,
                    tempo_estimado: '5-10 minutos',
                    entrada_quando: 'M1 virar PUT'
                };
            }
            
            if (sniperM1.rsi > config.rsiVenda) {
                return {
                    status: 'ATENÇÃO',
                    direcaoPescador: 'PUT',
                    direcaoSniper: 'CALL',
                    motivo: `SNIPER sobrecomprado (RSI ${sniperM1.rsi}) - pode virar a qualquer momento`,
                    tempo_estimado: '1-5 minutos',
                    entrada_quando: 'M1 virar PUT'
                };
            }
        }
        
        // Se PESCADOR quer CALL mas SNIPER ainda está PUT
        if (pescador.signal === 'CALL' && sniperM1.sinal === 'PUT') {
            
            if (sniperM1.rsi < config.rsiCompra + 5 && sniperM1.adx > config.adxMinimo) {
                return {
                    status: 'AGUARDAR',
                    direcaoPescador: 'CALL',
                    direcaoSniper: 'PUT',
                    motivo: `SNIPER ainda PUT mas RSI ${sniperM1.rsi} próximo de ${config.rsiCompra} - quase virando`,
                    tempo_estimado: '5-10 minutos',
                    entrada_quando: 'M1 virar CALL'
                };
            }
            
            if (sniperM1.rsi < config.rsiCompra) {
                return {
                    status: 'ATENÇÃO',
                    direcaoPescador: 'CALL',
                    direcaoSniper: 'PUT',
                    motivo: `SNIPER sobrevendido (RSI ${sniperM1.rsi}) - pode virar a qualquer momento`,
                    tempo_estimado: '1-5 minutos',
                    entrada_quando: 'M1 virar CALL'
                };
            }
        }
        
        return null;
    }

    // ========== DETECTAR CICLO COMPLETO ==========
    detectarCicloCompleto() {
        const h4 = this.allAnalyses['H4'];
        const m1 = this.allAnalyses['M1'];
        const config = this.getConfigAtivo();
        
        if (!h4 || !m1) return null;
        
        // ===== PARA CRASH (tendência de QUEDA) =====
        if (this.tipoAtivo === 'CRASH') {
            
            // FASE 1: FUNDO (comprar para correção)
            if (m1.rsi < config.rsiCompra && m1.adx > config.adxMinimo && m1.sinal === 'PUT') {
                return {
                    fase: 'FUNDO_DO_CICLO',
                    acao: 'COMPRAR_CORRECAO',
                    direcao: 'CALL',
                    duracao: '10-15 minutos',
                    confianca: 0.6,
                    motivo: `🔥 FUNDO DE CICLO CRASH - RSI ${m1.rsi} extremo`
                };
            }
            
            // FASE 2: TOPO (vender para queda)
            if (m1.rsi > config.rsiVenda && m1.adx < config.adxMinimo && m1.sinal === 'PUT') {
                return {
                    fase: 'TOPO_DO_CICLO',
                    acao: 'VENDER_QUEDA',
                    direcao: 'PUT',
                    duracao: '10-15 minutos',
                    confianca: 0.7,
                    motivo: `🔥 TOPO DE CICLO CRASH - RSI ${m1.rsi} alto`
                };
            }
        }
        
        // ===== PARA BOOM (tendência de ALTA) =====
        if (this.tipoAtivo === 'BOOM') {
            
            // FASE 1: TOPO (vender para correção)
            if (m1.rsi > config.rsiVenda && m1.adx > config.adxMinimo && m1.sinal === 'CALL') {
                return {
                    fase: 'TOPO_DO_CICLO',
                    acao: 'VENDER_CORRECAO',
                    direcao: 'PUT',
                    duracao: '10-15 minutos',
                    confianca: 0.6,
                    motivo: `🔥 TOPO DE CICLO BOOM - RSI ${m1.rsi} extremo`
                };
            }
            
            // FASE 2: FUNDO (comprar para alta)
            if (m1.rsi < config.rsiCompra && m1.adx < config.adxMinimo && m1.sinal === 'CALL') {
                return {
                    fase: 'FUNDO_DO_CICLO',
                    acao: 'COMPRAR_ALTA',
                    direcao: 'CALL',
                    duracao: '10-15 minutos',
                    confianca: 0.7,
                    motivo: `🔥 FUNDO DE CICLO BOOM - RSI ${m1.rsi} baixo`
                };
            }
        }
        
        // ===== PARA JUMP =====
        if (this.tipoAtivo === 'JUMP') {
            return this.detectarExplosaoJump();
        }
        
        return null;
    }

    // ========== DETECTAR PONTO FRANCO ==========
    detectarPontoFranco() {
        const h4 = this.allAnalyses['H4'];
        const m1 = this.allAnalyses['M1'];
        
        if (!h4 || !m1) return null;
        
        const isEspecial = this.tipoAtivo !== 'DEFAULT';
        if (!isEspecial) return null;
        
        const config = this.getConfigAtivo();
        
        // Caso 1: Ponto franco de QUEDA (PUT) - H4 PUT + M1 PUT com RSI baixo
        if (h4.sinal === 'PUT' && h4.adx > 30 &&
            m1.sinal === 'PUT' && m1.adx > 35 && 
            m1.rsi < config.rsiCompra + 5) {
            
            const forca = (h4.adx / 40) * (m1.adx / 40) * ((config.rsiCompra + 10 - m1.rsi) / 20);
            
            return {
                tipo: 'PONTO_FRANCO_QUEDA',
                forca: Math.min(1, forca),
                entrada: 'PUT',
                confianca: 0.6 + (forca * 0.3),
                motivo: `🔥 PONTO FRANCO: H4 PUT forte + M1 PUT com RSI ${m1.rsi}`
            };
        }
        
        // Caso 2: Ponto franco de ALTA (CALL) - H4 CALL + M1 CALL com RSI alto
        if (h4.sinal === 'CALL' && h4.adx > 30 &&
            m1.sinal === 'CALL' && m1.adx > 35 && 
            m1.rsi > config.rsiVenda - 5) {
            
            const forca = (h4.adx / 40) * (m1.adx / 40) * ((m1.rsi - (config.rsiVenda - 10)) / 20);
            
            return {
                tipo: 'PONTO_FRANCO_ALTA',
                forca: Math.min(1, forca),
                entrada: 'CALL',
                confianca: 0.6 + (forca * 0.3),
                motivo: `🔥 PONTO FRANCO: H4 CALL forte + M1 CALL com RSI ${m1.rsi}`
            };
        }
        
        return null;
    }

    // ========== CALCULAR TIMING ESPECIAL ==========
    calcularTimingEspecial(timeframeKey, analysis) {
        if (!analysis || !this.simbolo) return null;
        if (timeframeKey !== 'M1') return null;
        
        const config = this.getConfigAtivo();
        const rsi = analysis.rsi;
        const adx = analysis.adx;
        const sinal = analysis.sinal;
        
        // Para CRASH: pontos de virada
        if (this.tipoAtivo === 'CRASH') {
            
            // PONTO DE COMPRA (fundo do ciclo)
            if (rsi < config.rsiCompra && adx > config.adxMinimo && sinal === 'PUT') {
                return {
                    permitido: true,
                    acao: 'COMPRAR',
                    timing: '✅ FUNDO DO CICLO',
                    confianca: 0.7,
                    motivo: `RSI ${rsi} extremo - fundo de ciclo CRASH`
                };
            }
            
            // PONTO DE VENDA (topo do ciclo)
            if (rsi > config.rsiVenda && adx < config.adxMinimo && sinal === 'PUT') {
                return {
                    permitido: true,
                    acao: 'VENDER',
                    timing: '✅ TOPO DO CICLO',
                    confianca: 0.7,
                    motivo: `RSI ${rsi} alto - topo de ciclo CRASH`
                };
            }
        }
        
        // Para BOOM: pontos de virada
        if (this.tipoAtivo === 'BOOM') {
            
            // PONTO DE VENDA (topo do ciclo)
            if (rsi > config.rsiVenda && adx > config.adxMinimo && sinal === 'CALL') {
                return {
                    permitido: true,
                    acao: 'VENDER',
                    timing: '✅ TOPO DO CICLO',
                    confianca: 0.7,
                    motivo: `RSI ${rsi} extremo - topo de ciclo BOOM`
                };
            }
            
            // PONTO DE COMPRA (fundo do ciclo)
            if (rsi < config.rsiCompra && adx < config.adxMinimo && sinal === 'CALL') {
                return {
                    permitido: true,
                    acao: 'COMPRAR',
                    timing: '✅ FUNDO DO CICLO',
                    confianca: 0.7,
                    motivo: `RSI ${rsi} baixo - fundo de ciclo BOOM`
                };
            }
        }
        
        return null;
    }

    // ========== DETECTAR EXPLOSÃO JUMP ==========
    detectarExplosaoJump() {
        if (this.tipoAtivo !== 'JUMP') return null;
        
        const m1 = this.allAnalyses['M1'];
        const m5 = this.allAnalyses['M5'];
        
        if (!m1 || !m5) return null;
        
        // Detectar movimento brusco no M1
        if (m1.adx > 40 && Math.abs(m1.rsi - 50) > 20) {
            return {
                fase: 'EXPLOSAO_JUMP',
                acao: m1.rsi > 60 ? 'COMPRAR' : 'VENDER',
                direcao: m1.rsi > 60 ? 'CALL' : 'PUT',
                duracao: '5-10 minutos',
                confianca: 0.6,
                motivo: `💥 JUMP DETECTADO: Movimento brusco com ADX ${m1.adx}`
            };
        }
        
        return null;
    }

    // ========== CALCULAR PESO ESPECÍFICO POR ATIVO ==========
    calcularPesoEspecial(timeframeKey) {
        const config = this.getConfigAtivo();
        
        switch(timeframeKey) {
            case 'H4': return config.pesoH4;
            case 'H1': return config.pesoH1;
            case 'M15': return config.pesoM15;
            case 'M5': return config.pesoM5;
            case 'M1': return config.pesoM1;
            default: return 1.0;
        }
    }

    // ========== CALCULAR PESO DINÂMICO ==========
    calcularPesoDinamico(timeframeKey, analysis) {
        const pesoBase = this.TF_BASE_WEIGHT[timeframeKey] || 1.0;
        const pesoEspecial = this.calcularPesoEspecial(timeframeKey);
        
        // Histórico de acertos
        const historico = this.historicoAcertos[timeframeKey] || { acertos: 0, total: 1 };
        const taxaAcerto = historico.total > 0 ? historico.acertos / historico.total : 0.5;
        const pesoPorAcerto = 0.5 + (taxaAcerto * 0.5);
        
        // Ajustar baseado no ADX
        const pesoADX = analysis.adx > 30 ? 1.2 : analysis.adx > 20 ? 1.0 : 0.6;
        
        return pesoBase * pesoEspecial * pesoPorAcerto * pesoADX;
    }

    addAnalysis(timeframeKey, analysis) {
        if (this.timeframes[timeframeKey]) {
            this.timeframes[timeframeKey].analysis = analysis;
            this.allAnalyses[timeframeKey] = analysis;
            
            // ========== ARMAZENAR HISTÓRICO DE PREÇOS ==========
            if (analysis && analysis.preco_atual) {
                if (!this.priceHistory[timeframeKey]) {
                    this.priceHistory[timeframeKey] = [];
                }
                this.priceHistory[timeframeKey].push({
                    close: analysis.preco_atual,
                    timestamp: Date.now()
                });
                if (this.priceHistory[timeframeKey].length > 50) {
                    this.priceHistory[timeframeKey] = this.priceHistory[timeframeKey].slice(-50);
                }
            }
            
            // ========== ARMAZENAR HISTÓRICO DE RSI ==========
            if (analysis && analysis.rsi) {
                if (!this.ultimosRSI[timeframeKey]) {
                    this.ultimosRSI[timeframeKey] = [];
                }
                this.ultimosRSI[timeframeKey].push(analysis.rsi);
                if (this.ultimosRSI[timeframeKey].length > 20) {
                    this.ultimosRSI[timeframeKey] = this.ultimosRSI[timeframeKey].slice(-20);
                }
            }
            
            if (!this.signalHistory[timeframeKey]) {
                this.signalHistory[timeframeKey] = [];
            }
            if (analysis && analysis.sinal) {
                this.signalHistory[timeframeKey].push(analysis.sinal);
                const smoothing = SMOOTHING[timeframeKey] || SMOOTHING.DEFAULT;
                const maxSize = smoothing.historySize;
                if (this.signalHistory[timeframeKey].length > maxSize) {
                    this.signalHistory[timeframeKey] = this.signalHistory[timeframeKey].slice(-maxSize);
                }
            }
        }
    }

    getSmoothedSignal(timeframeKey) {
        const history = this.signalHistory[timeframeKey];
        if (!history || history.length === 0) return null;
        const smoothing = SMOOTHING[timeframeKey] || SMOOTHING.DEFAULT;
        if (history.length < smoothing.minAgreement) {
            return history[history.length - 1];
        }
        const calls = history.filter(s => s === 'CALL').length;
        const puts = history.filter(s => s === 'PUT').length;
        if (calls >= smoothing.minAgreement) return 'CALL';
        if (puts >= smoothing.minAgreement) return 'PUT';
        return history[history.length - 1];
    }

    calcularPesoPorTF(timeframeKey, analysis) {
        if (!analysis || !analysis.adx) return 0;
        
        const adx = analysis.adx;
        const baseWeight = this.TF_BASE_WEIGHT[timeframeKey] || 1.0;
        const thresholds = this.ADX_THRESHOLDS[timeframeKey] || { min: 15, ignore_below: 12 };
        
        if (adx < thresholds.ignore_below) {
            return 0;
        }
        
        if (adx < thresholds.min) {
            const factor = (adx - thresholds.ignore_below) / (thresholds.min - thresholds.ignore_below);
            return baseWeight * Math.max(0.3, factor);
        }
        
        if (adx < 30) {
            return baseWeight;
        }
        
        const adxMultiplier = 1.0 + (Math.min(adx, 50) - 30) / 20;
        return baseWeight * Math.min(2.0, adxMultiplier);
    }

    detectarDivergencias() {
        const divergencias = [];
        
        const h4 = this.allAnalyses['H4'];
        const h1 = this.allAnalyses['H1'];
        const m30 = this.allAnalyses['M30'];
        const m15 = this.allAnalyses['M15'];
        const m5 = this.allAnalyses['M5'];
        
        if (h4 && h1 && h4.sinal !== h1.sinal) {
            if (h4.adx >= 20 && h1.adx >= 20) {
                divergencias.push({
                    tipo: 'DIVERGENCIA_MAIOR',
                    entre: ['H4', 'H1'],
                    descricao: `H4 quer ${h4.sinal} mas H1 quer ${h1.sinal}`,
                    severidade: 80
                });
            }
        }
        
        if (h1 && m15 && h1.sinal !== m15.sinal) {
            if (h1.adx >= 18 && m15.adx >= 15) {
                divergencias.push({
                    tipo: 'DIVERGENCIA_MEDIA',
                    entre: ['H1', 'M15'],
                    descricao: `H1 quer ${h1.sinal} mas M15 quer ${m15.sinal}`,
                    severidade: 60
                });
            }
        }
        
        const sinais = [];
        if (h4) sinais.push({ tf: 'H4', sinal: h4.sinal, adx: h4.adx });
        if (h1) sinais.push({ tf: 'H1', sinal: h1.sinal, adx: h1.adx });
        if (m30) sinais.push({ tf: 'M30', sinal: m30.sinal, adx: m30.adx });
        if (m15) sinais.push({ tf: 'M15', sinal: m15.sinal, adx: m15.adx });
        
        const calls = sinais.filter(s => s.sinal === 'CALL').length;
        const puts = sinais.filter(s => s.sinal === 'PUT').length;
        
        if (calls > 0 && puts > 0 && (calls + puts) >= 3) {
            divergencias.push({
                tipo: 'MULTIPLA_DIVERGENCIA',
                descricao: `${calls} CALL vs ${puts} PUT - mercado indefinido`,
                severidade: 70
            });
        }
        
        return divergencias;
    }

    getTimeframeDominante() {
        let maxPeso = 0;
        let dominante = null;
        
        for (const [tf, analysis] of Object.entries(this.allAnalyses)) {
            const peso = this.calcularPesoPorTF(tf, analysis);
            if (peso > maxPeso) {
                maxPeso = peso;
                dominante = { tf, peso, sinal: analysis.sinal, adx: analysis.adx };
            }
        }
        
        return dominante;
    }

    calculateAgreement() {
        const signals = [];
        const timeframesWithData = [];

        for (const [key, analysis] of Object.entries(this.allAnalyses)) {
            if (analysis && analysis.sinal) {
                signals.push(analysis.sinal);
                timeframesWithData.push(key);
            }
        }

        if (signals.length === 0) return { agreement: 0, primarySignal: 'HOLD', callCount: 0, putCount: 0, totalTimeframes: 0, timeframes: [] };

        const callCount = signals.filter(s => s === 'CALL').length;
        const putCount = signals.filter(s => s === 'PUT').length;
        const total = signals.length;
        const primarySignal = callCount > putCount ? 'CALL' : (putCount > callCount ? 'PUT' : 'HOLD');
        const consensus = total > 0 ? Math.max(callCount, putCount) / total * 100 : 0;

        return {
            agreement: consensus,
            primarySignal,
            callCount,
            putCount,
            totalTimeframes: total,
            timeframes: timeframesWithData
        };
    }

    registrarResultado(timeframeKey, acertou) {
        if (!this.historicoAcertos[timeframeKey]) {
            this.historicoAcertos[timeframeKey] = { acertos: 0, total: 0 };
        }
        this.historicoAcertos[timeframeKey].total++;
        if (acertou) {
            this.historicoAcertos[timeframeKey].acertos++;
        }
        const taxa = (this.historicoAcertos[timeframeKey].acertos / 
                      this.historicoAcertos[timeframeKey].total * 100).toFixed(1);
        console.log(`📊 Histórico ${timeframeKey}: ${taxa}% acertos`);
    }

    consolidateSignals() {
        let totalWeight = 0;
        let callWeight = 0;
        let putWeight = 0;
        let totalConfidence = 0;
        let timeframesCount = 0;
        const details = {};

        let callCount = 0, putCount = 0, holdCount = 0;

        // ========== DETECTAR INFORMAÇÕES ESPECIAIS ==========
        const cicloCompleto = this.detectarCicloCompleto();
        const pontoFranco = this.detectarPontoFranco();
        const alinhamentoPescador = this.detectarAlinhamentoPescador();

        for (const [key, analysis] of Object.entries(this.allAnalyses)) {
            if (!analysis) continue;
            
            const smoothedSignal = this.getSmoothedSignal(key);
            const signalForWeight = smoothedSignal || analysis.sinal;
            
            // ========== USAR PESO DINÂMICO ==========
            let weight = this.calcularPesoDinamico(key, analysis);
            
            // ========== AJUSTAR POR PONTO FRANCO ==========
            if (pontoFranco && key === 'M1') {
                if (pontoFranco.entrada === analysis.sinal) {
                    weight *= 1.5;
                    console.log(`⚖️ Ponto franco: peso M1 aumentado para ${weight.toFixed(2)}`);
                }
            }
            
            if (weight === 0) {
                details[key] = {
                    signal: analysis.sinal,
                    smoothed: smoothedSignal,
                    confidence: (analysis.probabilidade * 100).toFixed(1) + '%',
                    price: analysis.preco_atual,
                    adx: analysis.adx,
                    status: 'IGNORADO (ADX baixo)'
                };
                continue;
            }

            totalWeight += weight;

            if (signalForWeight === 'CALL') {
                callCount++;
                callWeight += weight * (analysis.probabilidade || 0.5);
            } else if (signalForWeight === 'PUT') {
                putCount++;
                putWeight += weight * (analysis.probabilidade || 0.5);
            } else {
                holdCount++;
                const holdConfidence = (analysis.probabilidade || 0.5) * 0.3;
                callWeight += weight * holdConfidence * 0.5;
                putWeight += weight * holdConfidence * 0.5;
            }

            totalConfidence += (analysis.probabilidade || 0.5) * 100;
            timeframesCount++;

            details[key] = {
                signal: analysis.sinal,
                smoothed: smoothedSignal,
                confidence: (analysis.probabilidade * 100).toFixed(1) + '%',
                price: analysis.preco_atual,
                adx: analysis.adx,
                weight: weight.toFixed(2),
                trend: analysis.tendencia,
                status: 'ATIVO'
            };
        }

        if (totalWeight === 0 && timeframesCount > 0) {
            console.warn("⚠️ Nenhum timeframe com ADX suficiente - usando o melhor disponível");
            return this.consolidateSignalsFallback();
        }

        let primarySignal = 'HOLD';
        
        if (callCount === 0 && putCount === 0) {
            primarySignal = 'HOLD';
        }
        else {
            primarySignal = callWeight > putWeight ? 'CALL' : 'PUT';
            
            if (callWeight === putWeight) {
                const dominante = this.getTimeframeDominante();
                if (dominante && dominante.sinal !== 'HOLD') {
                    primarySignal = dominante.sinal;
                    console.log(`⚖️ Empate por peso → usando timeframe dominante: ${dominante.tf} (${dominante.sinal})`);
                }
            }
            
            console.log(`⚖️ Decisão: ${callCount}CALL/${putCount}PUT | Pesos: ${callWeight.toFixed(2)}/${putWeight.toFixed(2)} → ${primarySignal}`);
        }

        let agreement = 0;
        if (primarySignal === 'CALL') {
            agreement = callCount / (callCount + putCount + holdCount) * 100;
        } else if (primarySignal === 'PUT') {
            agreement = putCount / (callCount + putCount + holdCount) * 100;
        } else {
            agreement = holdCount / (callCount + putCount + holdCount) * 100;
        }

        let confidence = 0;
        if (primarySignal === 'CALL') {
            confidence = totalWeight > 0 ? callWeight / totalWeight : 0;
        } else if (primarySignal === 'PUT') {
            confidence = totalWeight > 0 ? putWeight / totalWeight : 0;
        } else {
            confidence = totalConfidence / (timeframesCount * 100) * 0.5;
        }

        const divergencias = this.detectarDivergencias();
        const timeframeDominante = this.getTimeframeDominante();

        if (divergencias.length > 0) {
            const severidadeMedia = divergencias.reduce((acc, d) => acc + d.severidade, 0) / divergencias.length;
            confidence *= (1 - (severidadeMedia / 200));
        }

        const majorityRatio = Math.max(callCount, putCount) / (callCount + putCount + holdCount);
        confidence = confidence * (0.8 + 0.2 * majorityRatio);
        confidence = Math.min(0.95, Math.max(0.05, confidence));

        // ========== ADICIONAR INFORMAÇÕES ESPECIAIS AO RESULTADO ==========
        this.consolidatedSignal = {
            signal: primarySignal,
            confidence: confidence,
            agreement: agreement,
            details,
            timeframesAnalyzed: timeframesCount,
            simpleMajority: {
                signal: callCount > putCount ? 'CALL' : (putCount > callCount ? 'PUT' : 'HOLD'),
                callCount,
                putCount,
                holdCount
            },
            allAnalyses: this.allAnalyses,
            divergencias: divergencias,
            timeframeDominante: timeframeDominante,
            recomendacao: divergencias.length > 1 ? 'AGUARDAR' : 
                          (confidence > 0.7 ? primarySignal : 'CAUTELA'),
            // ========== NOVAS INFORMAÇÕES ==========
            ciclo_completo: cicloCompleto,
            ponto_franco: pontoFranco,
            alinhamento_pescador: alinhamentoPescador,
            tipo_ativo: this.tipoAtivo,
            config_ativo: this.getConfigAtivo()
        };

        return this.consolidatedSignal;
    }

    consolidateSignalsFallback() {
        let bestTF = null;
        let bestADX = 0;
        
        for (const [key, analysis] of Object.entries(this.allAnalyses)) {
            if (analysis && analysis.adx > bestADX) {
                bestADX = analysis.adx;
                bestTF = { tf: key, analysis };
            }
        }
        
        if (bestTF) {
            return {
                signal: bestTF.analysis.sinal,
                confidence: 0.4,
                agreement: 33,
                details: { [bestTF.tf]: bestTF.analysis },
                timeframesAnalyzed: 1,
                simpleMajority: {
                    signal: bestTF.analysis.sinal,
                    callCount: bestTF.analysis.sinal === 'CALL' ? 1 : 0,
                    putCount: bestTF.analysis.sinal === 'PUT' ? 1 : 0,
                    holdCount: 0
                },
                divergencias: [],
                timeframeDominante: { tf: bestTF.tf, sinal: bestTF.analysis.sinal, adx: bestADX },
                recomendacao: 'USAR_COM_CAUTELA',
                tipo_ativo: this.tipoAtivo
            };
        }
        
        return {
            signal: 'HOLD',
            confidence: 0,
            agreement: 0,
            details: {},
            timeframesAnalyzed: 0,
            simpleMajority: { signal: 'HOLD', callCount: 0, putCount: 0, holdCount: 0 },
            divergencias: [],
            timeframeDominante: null,
            recomendacao: 'AGUARDAR',
            tipo_ativo: this.tipoAtivo
        };
    }

    getDiagnostico() {
        const timeframesAtivos = [];
        const timeframesIgnorados = [];
        
        for (const [key, analysis] of Object.entries(this.allAnalyses)) {
            const peso = this.calcularPesoPorTF(key, analysis);
            if (peso > 0) {
                timeframesAtivos.push({ tf: key, adx: analysis.adx, peso });
            } else {
                timeframesIgnorados.push({ tf: key, adx: analysis.adx, motivo: 'ADX baixo' });
            }
        }
        
        return {
            timeframesAtivos,
            timeframesIgnorados,
            timeframeDominante: this.getTimeframeDominante(),
            divergencias: this.detectarDivergencias(),
            tipo_ativo: this.tipoAtivo,
            config_ativo: this.getConfigAtivo(),
            ciclo_completo: this.detectarCicloCompleto(),
            ponto_franco: this.detectarPontoFranco(),
            alinhamento_pescador: this.detectarAlinhamentoPescador()
        };
    }
}

module.exports = MultiTimeframeManager;
