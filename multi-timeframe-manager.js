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
        
        // ========== CONFIGURAÇÕES DINÂMICAS POR ATIVO ==========
        this.CONFIG_ATIVO = {
            // ===== CRASH INDEX (todos os tipos) =====
            'CRASH50': {
                rsiCompra: 30, rsiVenda: 70, adxMinimo: 20,
                pesoH4: 3.5, pesoH1: 3.0, pesoM15: 2.0, pesoM5: 1.5, pesoM1: 1.0,
                nome: 'Crash 50 Index',
                estrategia: 'Quedas suaves, RSI <30 comprar, RSI >70 vender'
            },
            'CRASH150N': {
                rsiCompra: 32, rsiVenda: 72, adxMinimo: 22,
                pesoH4: 3.3, pesoH1: 2.8, pesoM15: 1.8, pesoM5: 1.3, pesoM1: 0.9,
                nome: 'Crash 150 Index',
                estrategia: 'Quedas moderadas'
            },
            'CRASH300N': {
                rsiCompra: 35, rsiVenda: 75, adxMinimo: 24,
                pesoH4: 3.2, pesoH1: 2.5, pesoM15: 1.6, pesoM5: 1.2, pesoM1: 0.8,
                nome: 'Crash 300 Index',
                estrategia: 'Quedas médias'
            },
            'CRASH500': {
                rsiCompra: 40, rsiVenda: 92, adxMinimo: 20,
                pesoH4: 3.1, pesoH1: 2.3, pesoM15: 1.5, pesoM5: 1.1, pesoM1: 0.7,
                nome: 'Crash 500 Index',
                estrategia: 'MARATONISTA - sobe devagar por muito tempo, RSI <40 comprar, RSI >92 vender'
            },
            'CRASH600': {
                rsiCompra: 35, rsiVenda: 60, adxMinimo: 20,
                pesoH4: 3.0, pesoH1: 2.0, pesoM15: 1.2, pesoM5: 0.8, pesoM1: 0.6,
                nome: 'Crash 600 Index',
                estrategia: 'VELOCISTA - quedas violentas, RSI <35 comprar, RSI >60 vender'
            },
            'CRASH1000': {
                rsiCompra: 35, rsiVenda: 60, adxMinimo: 25,
                pesoH4: 3.0, pesoH1: 2.0, pesoM15: 1.2, pesoM5: 0.8, pesoM1: 0.6,
                nome: 'Crash 1000 Index',
                estrategia: 'EXPLOSIVO - quedas MUITO violentas, RSI <35 comprar, RSI >60 vender'
            },
            
            // ===== BOOM INDEX (todos os tipos) =====
            'BOOM300N': {
                rsiCompra: 35, rsiVenda: 75, adxMinimo: 25,
                pesoH4: 3.0, pesoH1: 2.5, pesoM15: 1.5, pesoM5: 1.0, pesoM1: 0.8,
                nome: 'Boom 300 Index',
                estrategia: 'Altas fortes, RSI <35 comprar, RSI >75 vender'
            },
            'BOOM500': {
                rsiCompra: 38, rsiVenda: 78, adxMinimo: 26,
                pesoH4: 3.1, pesoH1: 2.4, pesoM15: 1.4, pesoM5: 0.9, pesoM1: 0.7,
                nome: 'Boom 500 Index',
                estrategia: 'Altas fortes'
            },
            'BOOM600': {
                rsiCompra: 40, rsiVenda: 80, adxMinimo: 27,
                pesoH4: 3.0, pesoH1: 2.2, pesoM15: 1.3, pesoM5: 0.8, pesoM1: 0.6,
                nome: 'Boom 600 Index',
                estrategia: 'Altas violentas'
            },
            'BOOM900': {
                rsiCompra: 42, rsiVenda: 82, adxMinimo: 28,
                pesoH4: 3.0, pesoH1: 2.0, pesoM15: 1.2, pesoM5: 0.7, pesoM1: 0.5,
                nome: 'Boom 900 Index',
                estrategia: 'Altas muito violentas'
            },
            'BOOM1000': {
                rsiCompra: 45, rsiVenda: 85, adxMinimo: 30,
                pesoH4: 3.0, pesoH1: 2.0, pesoM15: 1.2, pesoM5: 0.7, pesoM1: 0.5,
                nome: 'Boom 1000 Index',
                estrategia: 'EXTREMO - altas violentíssimas, RSI <45 comprar, RSI >85 vender'
            },
            
            // ===== JUMP INDEX =====
            'JUMP10': {
                rsiCompra: 40, rsiVenda: 60, adxMinimo: 30,
                pesoH4: 2.5, pesoH1: 2.0, pesoM15: 1.8, pesoM5: 1.5, pesoM1: 1.2,
                nome: 'Jump 10 Index',
                estrategia: 'Saltos moderados'
            },
            'JUMP25': {
                rsiCompra: 38, rsiVenda: 62, adxMinimo: 32,
                pesoH4: 2.4, pesoH1: 1.9, pesoM15: 1.7, pesoM5: 1.4, pesoM1: 1.1,
                nome: 'Jump 25 Index',
                estrategia: 'Saltos médios'
            },
            'JUMP50': {
                rsiCompra: 35, rsiVenda: 65, adxMinimo: 35,
                pesoH4: 2.3, pesoH1: 1.8, pesoM15: 1.6, pesoM5: 1.3, pesoM1: 1.0,
                nome: 'Jump 50 Index',
                estrategia: 'Saltos fortes'
            },
            'JUMP75': {
                rsiCompra: 32, rsiVenda: 68, adxMinimo: 38,
                pesoH4: 2.2, pesoH1: 1.7, pesoM15: 1.5, pesoM5: 1.2, pesoM1: 0.9,
                nome: 'Jump 75 Index',
                estrategia: 'Saltos muito fortes'
            },
            'JUMP100': {
                rsiCompra: 30, rsiVenda: 70, adxMinimo: 40,
                pesoH4: 2.0, pesoH1: 1.5, pesoM15: 1.5, pesoM5: 1.0, pesoM1: 0.8,
                nome: 'Jump 100 Index',
                estrategia: 'Saltos extremos, RSI <30 comprar, RSI >70 vender'
            },
            
            // ===== STEP INDEX =====
            'STEP': {
                rsiCompra: 40, rsiVenda: 60, adxMinimo: 20,
                pesoH4: 1.5, pesoH1: 1.3, pesoM15: 1.2, pesoM5: 1.0, pesoM1: 1.0,
                nome: 'Step Index',
                estrategia: 'Movimentos em degraus, operar quebras'
            },
            
            // ===== DEFAULTS (fallback) =====
            'CRASH': {
                rsiCompra: 35, rsiVenda: 65, adxMinimo: 25,
                pesoH4: 3.0, pesoH1: 2.0, pesoM15: 1.2, pesoM5: 0.8, pesoM1: 0.6,
                nome: 'Crash Index',
                estrategia: 'Fallback para Crash não especificado'
            },
            'BOOM': {
                rsiCompra: 40, rsiVenda: 80, adxMinimo: 25,
                pesoH4: 3.0, pesoH1: 2.0, pesoM15: 1.2, pesoM5: 0.8, pesoM1: 0.6,
                nome: 'Boom Index',
                estrategia: 'Fallback para Boom não especificado'
            },
            'JUMP': {
                rsiCompra: 35, rsiVenda: 65, adxMinimo: 30,
                pesoH4: 2.0, pesoH1: 1.5, pesoM15: 1.5, pesoM5: 1.0, pesoM1: 0.8,
                nome: 'Jump Index',
                estrategia: 'Fallback para Jump não especificado'
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

    // ========== DETECTAR TIPO DE ATIVO (VERSÃO MELHORADA) ==========
    detectarTipoAtivo(simbolo) {
        if (!simbolo) return 'DEFAULT';
        
        // CRASH específicos
        if (simbolo.includes('CRASH50')) return 'CRASH50';
        if (simbolo.includes('CRASH150')) return 'CRASH150N';
        if (simbolo.includes('CRASH300')) return 'CRASH300N';
        if (simbolo.includes('CRASH500')) return 'CRASH500';
        if (simbolo.includes('CRASH600')) return 'CRASH600';
        if (simbolo.includes('CRASH1000')) return 'CRASH1000';
        
        // BOOM específicos
        if (simbolo.includes('BOOM300')) return 'BOOM300N';
        if (simbolo.includes('BOOM500')) return 'BOOM500';
        if (simbolo.includes('BOOM600')) return 'BOOM600';
        if (simbolo.includes('BOOM900')) return 'BOOM900';
        if (simbolo.includes('BOOM1000')) return 'BOOM1000';
        
        // JUMP específicos
        if (simbolo.includes('JD10')) return 'JUMP10';
        if (simbolo.includes('JD25')) return 'JUMP25';
        if (simbolo.includes('JD50')) return 'JUMP50';
        if (simbolo.includes('JD75')) return 'JUMP75';
        if (simbolo.includes('JD100')) return 'JUMP100';
        
        // STEP
        if (simbolo.includes('stpRNG')) return 'STEP';
        
        // Famílias genéricas
        if (simbolo.includes('CRASH')) return 'CRASH';
        if (simbolo.includes('BOOM')) return 'BOOM';
        if (simbolo.includes('JUMP')) return 'JUMP';
        
        return 'DEFAULT';
    }

    // ========== OBTER CONFIGURAÇÃO DO ATIVO ==========
    getConfigAtivo() {
        return this.CONFIG_ATIVO[this.tipoAtivo] || this.CONFIG_ATIVO['DEFAULT'];
    }

    // ========== NOVO MÉTODO: DETECTAR SE É TENDÊNCIA REAL OU PADRÃO DO ATIVO ==========
    detectarTipoTendencia() {
        const h4 = this.allAnalyses['H4'];
        const h1 = this.allAnalyses['H1'];
        const m15 = this.allAnalyses['M15'];
        const m5 = this.allAnalyses['M5'];
        const m1 = this.allAnalyses['M1'];
        
        if (!h4 || !h1 || !m15) return null;
        
        // Verificar se todos os timeframes estão na mesma direção
        const todosSinais = [h4?.sinal, h1?.sinal, m15?.sinal, m5?.sinal, m1?.sinal].filter(s => s);
        const todosIguais = todosSinais.every(s => s === todosSinais[0]);
        
        if (todosIguais && todosSinais.length >= 3) {
            return {
                tipo: 'TENDENCIA_REAL',
                direcao: todosSinais[0],
                forca: 'ALTA',
                estrategia: 'Seguir tendência, correções são oportunidades de entrada',
                alerta: `NÃO É PADRÃO ${this.tipoAtivo} - é tendência legítima`
            };
        }
        
        // ===== DETECÇÃO DE PADRÕES ESPECÍFICOS POR ATIVO =====
        
        // PADRÃO CRASH (timeframes maiores PUT, menores CALL)
        const maioresPUT = (h4?.sinal === 'PUT' && h1?.sinal === 'PUT');
        const menoresCALL = (m15?.sinal === 'CALL' || m5?.sinal === 'CALL' || m1?.sinal === 'CALL');
        
        if (maioresPUT && menoresCALL) {
            return {
                tipo: `PADRAO_${this.tipoAtivo.includes('CRASH') ? 'CRASH' : 'DESCARTE'}`,
                direcao: 'PUT',
                forca: 'MÉDIA',
                estrategia: this.tipoAtivo.includes('CRASH') 
                    ? 'Vender nos topos (RSI > config.rsiVenda)' 
                    : 'Possível reversão, aguardar confirmação',
                alerta: this.tipoAtivo.includes('CRASH') 
                    ? 'CRASH DETECTADO - operar correções' 
                    : 'ATENÇÃO: Padrão CRASH em ativo não-CRASH'
            };
        }
        
        // PADRÃO BOOM (timeframes maiores CALL, menores PUT)
        const maioresCALL = (h4?.sinal === 'CALL' && h1?.sinal === 'CALL');
        const menoresPUT = (m15?.sinal === 'PUT' || m5?.sinal === 'PUT' || m1?.sinal === 'PUT');
        
        if (maioresCALL && menoresPUT) {
            return {
                tipo: `PADRAO_${this.tipoAtivo.includes('BOOM') ? 'BOOM' : 'ASCENDENTE'}`,
                direcao: 'CALL',
                forca: 'MÉDIA',
                estrategia: this.tipoAtivo.includes('BOOM') 
                    ? 'Comprar nos fundos (RSI < config.rsiCompra)' 
                    : 'Possível continuação de alta, aguardar confirmação',
                alerta: this.tipoAtivo.includes('BOOM') 
                    ? 'BOOM DETECTADO - operar correções' 
                    : 'ATENÇÃO: Padrão BOOM em ativo não-BOOM'
            };
        }
        
        // PADRÃO JUMP (movimentos bruscos)
        if (this.tipoAtivo.includes('JUMP')) {
            const jumpDetected = this.detectarExplosaoJump();
            if (jumpDetected) {
                return {
                    tipo: 'PADRAO_JUMP',
                    direcao: jumpDetected.direcao,
                    forca: 'ALTA',
                    estrategia: 'Operar o salto com stops apertados',
                    alerta: 'JUMP DETECTADO - movimento brusco iminente'
                };
            }
        }
        
        // PADRÃO STEP (movimentos em degraus)
        if (this.tipoAtivo.includes('STEP')) {
            // Lógica específica para STEP pode ser adicionada aqui
            // Por enquanto, apenas retorna o padrão genérico
            if (todosIguais) {
                return {
                    tipo: 'PADRAO_STEP',
                    direcao: todosSinais[0],
                    forca: 'MÉDIA',
                    estrategia: 'Operar quebras dos degraus',
                    alerta: 'STEP DETECTADO - aguardar quebra de nível'
                };
            }
        }
        
        return null;
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
                    motivo: `SNIPER ainda CALL mas RSI ${sniperM1.rsi.toFixed(0)} próximo de ${config.rsiVenda} - quase virando`,
                    tempo_estimado: '5-10 minutos',
                    entrada_quando: 'M1 virar PUT'
                };
            }
            
            if (sniperM1.rsi > config.rsiVenda) {
                return {
                    status: 'ATENÇÃO',
                    direcaoPescador: 'PUT',
                    direcaoSniper: 'CALL',
                    motivo: `SNIPER sobrecomprado (RSI ${sniperM1.rsi.toFixed(0)}) - pode virar a qualquer momento`,
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
                    motivo: `SNIPER ainda PUT mas RSI ${sniperM1.rsi.toFixed(0)} próximo de ${config.rsiCompra} - quase virando`,
                    tempo_estimado: '5-10 minutos',
                    entrada_quando: 'M1 virar CALL'
                };
            }
            
            if (sniperM1.rsi < config.rsiCompra) {
                return {
                    status: 'ATENÇÃO',
                    direcaoPescador: 'CALL',
                    direcaoSniper: 'PUT',
                    motivo: `SNIPER sobrevendido (RSI ${sniperM1.rsi.toFixed(0)}) - pode virar a qualquer momento`,
                    tempo_estimado: '1-5 minutos',
                    entrada_quando: 'M1 virar CALL'
                };
            }
        }
        
        return null;
    }

    // ========== DETECTAR CICLO COMPLETO (VERSÃO MELHORADA) ==========
    detectarCicloCompleto() {
        const h4 = this.allAnalyses['H4'];
        const m1 = this.allAnalyses['M1'];
        const config = this.getConfigAtivo();
        
        if (!h4 || !m1) return null;
        
        // Verificar primeiro se é TENDÊNCIA REAL (todos alinhados)
        const tipoTendencia = this.detectarTipoTendencia();
        
        // ===== PARA CRASH (todos os tipos) =====
        if (this.tipoAtivo.includes('CRASH')) {
            
            if (tipoTendencia?.tipo === 'TENDENCIA_REAL') {
                // Em tendência real, usar limites mais extremos
                if (m1.rsi < config.rsiCompra && m1.adx > config.adxMinimo) {
                    return {
                        fase: 'FUNDO_DA_TENDENCIA',
                        acao: 'COMPRAR',
                        direcao: tipoTendencia.direcao,
                        duracao: '20-40 minutos',
                        confianca: 0.7,
                        motivo: `📈 TENDÊNCIA REAL: RSI ${m1.rsi.toFixed(0)} no fundo - comprar para nova perna`
                    };
                }
                
                if (m1.rsi > config.rsiVenda && m1.adx > 30) {
                    return {
                        fase: 'TOPO_DA_TENDENCIA',
                        acao: 'VENDER',
                        direcao: tipoTendencia.direcao === 'CALL' ? 'PUT' : 'CALL',
                        duracao: '15-30 minutos',
                        confianca: 0.8,
                        motivo: `🔥 TOPO DE TENDÊNCIA: RSI ${m1.rsi.toFixed(0)} extremo - realizar lucro`
                    };
                }
            }
            
            // FASE 1: FUNDO (comprar para correção) - padrão CRASH
            if (m1.rsi < config.rsiCompra && m1.adx > config.adxMinimo && m1.sinal === 'PUT') {
                return {
                    fase: 'FUNDO_DO_CICLO',
                    acao: 'COMPRAR_CORRECAO',
                    direcao: 'CALL',
                    duracao: '10-15 minutos',
                    confianca: 0.6,
                    motivo: `🔥 FUNDO DE CICLO ${this.tipoAtivo} - RSI ${m1.rsi.toFixed(0)} extremo`
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
                    motivo: `🔥 TOPO DE CICLO ${this.tipoAtivo} - RSI ${m1.rsi.toFixed(0)} alto`
                };
            }
        }
        
        // ===== PARA BOOM (todos os tipos) =====
        if (this.tipoAtivo.includes('BOOM')) {
            
            if (tipoTendencia?.tipo === 'TENDENCIA_REAL') {
                // Em tendência real, usar limites mais extremos
                if (m1.rsi < config.rsiCompra && m1.adx > config.adxMinimo) {
                    return {
                        fase: 'FUNDO_DA_TENDENCIA',
                        acao: 'COMPRAR',
                        direcao: tipoTendencia.direcao,
                        duracao: '20-40 minutos',
                        confianca: 0.7,
                        motivo: `📈 TENDÊNCIA REAL: RSI ${m1.rsi.toFixed(0)} no fundo - comprar`
                    };
                }
                
                if (m1.rsi > config.rsiVenda && m1.adx > 30) {
                    return {
                        fase: 'TOPO_DA_TENDENCIA',
                        acao: 'VENDER',
                        direcao: tipoTendencia.direcao === 'CALL' ? 'PUT' : 'CALL',
                        duracao: '15-30 minutos',
                        confianca: 0.8,
                        motivo: `🔥 TOPO DE TENDÊNCIA: RSI ${m1.rsi.toFixed(0)} extremo - realizar lucro`
                    };
                }
            }
            
            // FASE 1: TOPO (vender para correção)
            if (m1.rsi > config.rsiVenda && m1.adx > config.adxMinimo && m1.sinal === 'CALL') {
                return {
                    fase: 'TOPO_DO_CICLO',
                    acao: 'VENDER_CORRECAO',
                    direcao: 'PUT',
                    duracao: '10-15 minutos',
                    confianca: 0.6,
                    motivo: `🔥 TOPO DE CICLO ${this.tipoAtivo} - RSI ${m1.rsi.toFixed(0)} extremo`
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
                    motivo: `🔥 FUNDO DE CICLO ${this.tipoAtivo} - RSI ${m1.rsi.toFixed(0)} baixo`
                };
            }
        }
        
        // ===== PARA JUMP =====
        if (this.tipoAtivo.includes('JUMP')) {
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
                motivo: `🔥 PONTO FRANCO: H4 PUT forte + M1 PUT com RSI ${m1.rsi.toFixed(0)}`
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
                motivo: `🔥 PONTO FRANCO: H4 CALL forte + M1 CALL com RSI ${m1.rsi.toFixed(0)}`
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
        
        // Primeiro, verificar tipo de tendência
        const tipoTendencia = this.detectarTipoTendencia();
        
        // Para CRASH: pontos de virada
        if (this.tipoAtivo.includes('CRASH')) {
            
            // Se for tendência real, ajustar limites
            if (tipoTendencia?.tipo === 'TENDENCIA_REAL') {
                // Em tendência real, comprar nos fundos e vender nos topos
                if (rsi < config.rsiCompra && adx > config.adxMinimo) {
                    return {
                        permitido: true,
                        acao: 'COMPRAR',
                        timing: '✅ FUNDO DA TENDÊNCIA',
                        confianca: 0.8,
                        motivo: `RSI ${rsi.toFixed(0)} no fundo - tendência real de ${tipoTendencia.direcao}`
                    };
                }
                
                if (rsi > config.rsiVenda && adx > 30) {
                    return {
                        permitido: true,
                        acao: 'VENDER',
                        timing: '✅ TOPO DA TENDÊNCIA',
                        confianca: 0.8,
                        motivo: `RSI ${rsi.toFixed(0)} extremo - realizar lucro na tendência`
                    };
                }
            }
            
            // PONTO DE COMPRA (fundo do ciclo) - padrão CRASH
            if (rsi < config.rsiCompra && adx > config.adxMinimo && sinal === 'PUT') {
                return {
                    permitido: true,
                    acao: 'COMPRAR',
                    timing: '✅ FUNDO DO CICLO',
                    confianca: 0.7,
                    motivo: `RSI ${rsi.toFixed(0)} extremo - fundo de ciclo ${this.tipoAtivo}`
                };
            }
            
            // PONTO DE VENDA (topo do ciclo)
            if (rsi > config.rsiVenda && adx < config.adxMinimo && sinal === 'PUT') {
                return {
                    permitido: true,
                    acao: 'VENDER',
                    timing: '✅ TOPO DO CICLO',
                    confianca: 0.7,
                    motivo: `RSI ${rsi.toFixed(0)} alto - topo de ciclo ${this.tipoAtivo}`
                };
            }
        }
        
        // Para BOOM: pontos de virada
        if (this.tipoAtivo.includes('BOOM')) {
            
            // Se for tendência real, ajustar limites
            if (tipoTendencia?.tipo === 'TENDENCIA_REAL') {
                if (rsi < config.rsiCompra && adx > config.adxMinimo) {
                    return {
                        permitido: true,
                        acao: 'COMPRAR',
                        timing: '✅ FUNDO DA TENDÊNCIA',
                        confianca: 0.8,
                        motivo: `RSI ${rsi.toFixed(0)} no fundo - tendência real de ${tipoTendencia.direcao}`
                    };
                }
                
                if (rsi > config.rsiVenda && adx > 30) {
                    return {
                        permitido: true,
                        acao: 'VENDER',
                        timing: '✅ TOPO DA TENDÊNCIA',
                        confianca: 0.8,
                        motivo: `RSI ${rsi.toFixed(0)} extremo - realizar lucro na tendência`
                    };
                }
            }
            
            // PONTO DE VENDA (topo do ciclo)
            if (rsi > config.rsiVenda && adx > config.adxMinimo && sinal === 'CALL') {
                return {
                    permitido: true,
                    acao: 'VENDER',
                    timing: '✅ TOPO DO CICLO',
                    confianca: 0.7,
                    motivo: `RSI ${rsi.toFixed(0)} extremo - topo de ciclo ${this.tipoAtivo}`
                };
            }
            
            // PONTO DE COMPRA (fundo do ciclo)
            if (rsi < config.rsiCompra && adx < config.adxMinimo && sinal === 'CALL') {
                return {
                    permitido: true,
                    acao: 'COMPRAR',
                    timing: '✅ FUNDO DO CICLO',
                    confianca: 0.7,
                    motivo: `RSI ${rsi.toFixed(0)} baixo - fundo de ciclo ${this.tipoAtivo}`
                };
            }
        }
        
        return null;
    }

    // ========== DETECTAR EXPLOSÃO JUMP ==========
    detectarExplosaoJump() {
        if (!this.tipoAtivo.includes('JUMP')) return null;
        
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
                motivo: `💥 JUMP DETECTADO: Movimento brusco com ADX ${m1.adx.toFixed(0)}`
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

    // ========== CALCULAR PESO DINÂMICO (MODIFICADO PARA VOLATILITY) ==========
    calcularPesoDinamico(timeframeKey, analysis) {
        const pesoBase = this.TF_BASE_WEIGHT[timeframeKey] || 1.0;
        const pesoEspecial = this.calcularPesoEspecial(timeframeKey);
        
        // Histórico de acertos
        const historico = this.historicoAcertos[timeframeKey] || { acertos: 0, total: 1 };
        const taxaAcerto = historico.total > 0 ? historico.acertos / historico.total : 0.5;
        const pesoPorAcerto = 0.5 + (taxaAcerto * 0.5);
        
        // 🔥 AJUSTADO: pesoADX mais suave para Volatility Index
        let pesoADX;
        const isVolatility = this.simbolo && this.simbolo.startsWith('R_');
        
        if (isVolatility) {
            // Volatility Index: limiares mais baixos (ADX 19.2 → peso 1.0)
            pesoADX = analysis.adx > 22 ? 1.2 : analysis.adx > 14 ? 1.0 : 0.7;
        } else {
            // Outros ativos: padrão original
            pesoADX = analysis.adx > 30 ? 1.2 : analysis.adx > 20 ? 1.0 : 0.6;
        }
        
        return pesoBase * pesoEspecial * pesoPorAcerto * pesoADX;
    }

    // ========== CALCULAR VOLATILITY BOOST (NOVO MÉTODO) ==========
    calcularVolatilityBoost() {
        // Só aplica para Volatility Index
        if (!this.simbolo?.startsWith('R_')) return 1.0;
        
        // Calcular ADX médio de todos os timeframes
        const adxValues = Object.values(this.allAnalyses)
            .filter(a => a && a.adx && typeof a.adx === 'number')
            .map(a => a.adx);
        
        if (adxValues.length === 0) return 1.0;
        
        const adxMedio = adxValues.reduce((sum, a) => sum + a, 0) / adxValues.length;
        
        // Boost quando ADX médio está em zona de tendência moderada
        if (adxMedio > 20 && adxMedio < 30) {
            console.log(`📈 Volatility Boost: ADX médio ${adxMedio.toFixed(1)} → +15% confiança`);
            return 1.15;
        }
        
        if (adxMedio >= 30) {
            console.log(`📈 Volatility Boost: ADX médio ${adxMedio.toFixed(1)} → +10% confiança`);
            return 1.10;
        }
        
        return 1.0;
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
        const tipoTendencia = this.detectarTipoTendencia();
        const cicloCompleto = this.detectarCicloCompleto();
        const pontoFranco = this.detectarPontoFranco();
        const alinhamentoPescador = this.detectarAlinhamentoPescador();

        // Se for tendência real, logar
        if (tipoTendencia?.tipo === 'TENDENCIA_REAL') {
            console.log(`📊 TENDÊNCIA REAL DETECTADA: ${tipoTendencia.direcao} - ${tipoTendencia.alerta}`);
        }

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

        // Se for tendência real, aumentar confiança
        if (tipoTendencia?.tipo === 'TENDENCIA_REAL') {
            confidence = Math.min(0.9, confidence * 1.2);
        }

        const divergencias = this.detectarDivergencias();
        const timeframeDominante = this.getTimeframeDominante();

        if (divergencias.length > 0) {
            const severidadeMedia = divergencias.reduce((acc, d) => acc + d.severidade, 0) / divergencias.length;
            confidence *= (1 - (severidadeMedia / 200));
        }

        const majorityRatio = Math.max(callCount, putCount) / (callCount + putCount + holdCount);
        confidence = confidence * (0.8 + 0.2 * majorityRatio);
        
        // 🔥 APLICAR VOLATILITY BOOST
        const volatilityBoost = this.calcularVolatilityBoost();
        confidence = confidence * volatilityBoost;
        
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
            tipo_tendencia: tipoTendencia,
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
            tipo_tendencia: this.detectarTipoTendencia(),
            ciclo_completo: this.detectarCicloCompleto(),
            ponto_franco: this.detectarPontoFranco(),
            alinhamento_pescador: this.detectarAlinhamentoPescador()
        };
    }
}

module.exports = MultiTimeframeManager;
