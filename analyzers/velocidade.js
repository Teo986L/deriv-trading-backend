// analyzers/velocidade.js
class AnaliseVelocidadeIndicadores {
    constructor() {
        this.historicoRSI = {};
        this.historicoADX = {};
        this.historicoPrecos = {};
        this.maxHistorico = 50;
        this.limiares = {
            M1: { rsiMaxVariacao: 22, adxMaxVariacao: 18, tempoAnalise: 3 },
            M5: { rsiMaxVariacao: 18, adxMaxVariacao: 15, tempoAnalise: 4 },
            M15: { rsiMaxVariacao: 14, adxMaxVariacao: 12, tempoAnalise: 5 },
            M30: { rsiMaxVariacao: 12, adxMaxVariacao: 10, tempoAnalise: 6 },
            H1: { rsiMaxVariacao: 10, adxMaxVariacao: 8, tempoAnalise: 8 },
            H4: { rsiMaxVariacao: 8, adxMaxVariacao: 6, tempoAnalise: 10 },
            H24: { rsiMaxVariacao: 6, adxMaxVariacao: 4, tempoAnalise: 15 }
        };
        this.padroesPerigosos = {
            rsiExtremoSaltos: 0,
            adxFalsoRompimento: 0,
            divergenciasVelocidade: 0
        };
        
        // 🔥 NOVO: Inicializa históricos por timeframe
        this.inicializarHistoricos();
    }

    inicializarHistoricos() {
        const tfs = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'H24'];
        tfs.forEach(tf => {
            this.historicoRSI[tf] = [];
            this.historicoADX[tf] = [];
            this.historicoPrecos[tf] = [];
        });
    }

    // 🔥 NOVO: Compara velocidades entre diferentes timeframes
    compararVelocidadeEntreTimeframes(analisesPorTF) {
        const divergencias = [];
        const alertas = [];
        
        if (!analisesPorTF || Object.keys(analisesPorTF).length < 2) {
            return { divergencias: [], alertas: [], score: 0 };
        }

        // Pega as análises dos principais timeframes
        const h4 = analisesPorTF['H4'];
        const h1 = analisesPorTF['H1'];
        const m30 = analisesPorTF['M30'];
        const m15 = analisesPorTF['M15'];
        const m5 = analisesPorTF['M5'];

        // 🔥 REGRA 1: M5/M15 rápidos mas H1 lento = RUÍDO
        if (m5 && h1) {
            if (m5.severidade > 40 && h1.severidade < 20) {
                divergencias.push({
                    tipo: 'RUÍDO_ALTA_FREQUENCIA',
                    descricao: 'M5 acelerado sem confirmação H1 - MOVIMENTO FALSO',
                    severidade: 70,
                    acao: 'IGNORAR_M5'
                });
            }
        }

        // 🔥 REGRA 2: M15 rápido mas H4 lento = CORREÇÃO
        if (m15 && h4) {
            if (m15.severidade > 50 && h4.severidade < 15) {
                const direcao = this.inferirDirecao(analisesPorTF);
                divergencias.push({
                    tipo: 'CORRECAO_RAPIDA',
                    descricao: `M15 acelerado (${m15.severidade.toFixed(0)}%) em H4 lento - PROVÁVEL CORREÇÃO ${direcao}`,
                    severidade: 65,
                    acao: 'AGUARDAR_FIM_CORRECAO'
                });
            }
        }

        // 🔥 REGRA 3: Aceleração em cascata (todos rápidos)
        const tfsRapidos = [];
        if (m5 && m5.severidade > 45) tfsRapidos.push('M5');
        if (m15 && m15.severidade > 45) tfsRapidos.push('M15');
        if (h1 && h1.severidade > 45) tfsRapidos.push('H1');
        
        if (tfsRapidos.length >= 3) {
            divergencias.push({
                tipo: 'CASCATA_ACELERACAO',
                descricao: `Aceleração em cascata: ${tfsRapidos.join(', ')} - MOMENTUM FORTE`,
                severidade: 30, // Baixa severidade, é bom sinal
                acao: 'MOMENTUM_CONFIRMADO'
            });
        }

        // 🔥 REGRA 4: Divergência de velocidade entre timeframes
        if (m15 && h1 && m30) {
            const m15Veloz = m15.severidade > 40;
            const h1Lento = h1.severidade < 20;
            const m30Moderado = m30.severidade > 25 && m30.severidade < 45;
            
            if (m15Veloz && h1Lento && m30Moderado) {
                divergencias.push({
                    tipo: 'DIVERGENCIA_VELOCIDADE_ESTRUTURAL',
                    descricao: 'M15 veloz, H1 lento - CONSOLIDAÇÃO IMINENTE',
                    severidade: 55,
                    acao: 'REDUZIR_POSICAO'
                });
            }
        }

        // 🔥 Calcular score de confiança baseado nas divergências
        let score = 100;
        divergencias.forEach(d => {
            score -= d.severidade / 2;
        });
        score = Math.max(30, Math.min(100, score));

        // Gerar alertas
        if (divergencias.length > 0) {
            alertas.push({
                tipo: 'DIVERGENCIA_VELOCIDADE',
                mensagem: `${divergencias.length} divergência(s) de velocidade detectada(s)`,
                severidade: 50,
                detalhes: divergencias
            });
        }

        return {
            divergencias,
            alertas,
            score,
            confiabilidade: score > 80 ? 'ALTA' : score > 60 ? 'MEDIA' : 'BAIXA',
            recomendacao: score > 70 ? 'PERMITIR' : 
                          score > 50 ? 'CAUTELA' : 'BLOQUEAR'
        };
    }

    // 🔥 NOVO: Infere direção baseado nos sinais
    inferirDirecao(analisesPorTF) {
        let calls = 0, puts = 0;
        
        if (analisesPorTF['M5']) calls += analisesPorTF['M5'].direcao === 'CALL' ? 1 : 0;
        if (analisesPorTF['M15']) calls += analisesPorTF['M15'].direcao === 'CALL' ? 1 : 0;
        if (analisesPorTF['H1']) calls += analisesPorTF['H1'].direcao === 'CALL' ? 1 : 0;
        
        return calls >= 2 ? 'ALTA' : 'BAIXA';
    }

    // 🔥 VERSÃO MODIFICADA: Agora recebe timeframeKey e armazena por TF
    analisarVelocidade(rsiAtual, adxAtual, precoAtual, timeframeKey, candlesRecentes = []) {
        const limiar = this.limiares[timeframeKey] || this.limiares.M5;

        // Garantir que os históricos para este timeframe existem
        if (!this.historicoRSI[timeframeKey]) this.historicoRSI[timeframeKey] = [];
        if (!this.historicoADX[timeframeKey]) this.historicoADX[timeframeKey] = [];
        if (!this.historicoPrecos[timeframeKey]) this.historicoPrecos[timeframeKey] = [];

        const analiseRSI = this.analisarVelocidadeRSI(rsiAtual, limiar, timeframeKey);
        const analiseADX = this.analisarVelocidadeADX(adxAtual, limiar, timeframeKey);
        const analisePreco = this.analisarVelocidadePreco(precoAtual, candlesRecentes, limiar, timeframeKey);
        const analiseConjunta = this.analisarConjunto(analiseRSI, analiseADX, analisePreco, timeframeKey);

        this.atualizarHistoricos(rsiAtual, adxAtual, precoAtual, timeframeKey);

        const padroesPerigosos = this.detectarPadroesPerigosos(rsiAtual, adxAtual, analiseRSI, analiseADX, timeframeKey);

        const fatorConfianca = this.calcularFatorConfianca(analiseConjunta, padroesPerigosos);

        const alertas = this.gerarAlertas(analiseRSI, analiseADX, analisePreco, analiseConjunta, padroesPerigosos, timeframeKey);

        const recomendacao = this.gerarRecomendacao(fatorConfianca, analiseConjunta, padroesPerigosos);

        return {
            fatorConfianca: fatorConfianca,
            recomendacao: recomendacao.acao,
            motivo: recomendacao.motivo,
            direcao: this.inferirDirecaoLocal(analiseRSI, analiseADX, analisePreco),
            analises: {
                rsi: analiseRSI,
                adx: analiseADX,
                preco: analisePreco,
                conjunta: analiseConjunta
            },
            alertas: alertas,
            padroesPerigosos: padroesPerigosos,
            severidade: analiseConjunta.severidadeTotal,
            estatisticas: {
                rsi_historico: this.historicoRSI[timeframeKey].slice(-5),
                adx_historico: this.historicoADX[timeframeKey].slice(-5),
                variacao_rsi_3velas: this.calcularVariacaoPeriodo(this.historicoRSI[timeframeKey], 3),
                variacao_adx_3velas: this.calcularVariacaoPeriodo(this.historicoADX[timeframeKey], 3),
                aceleracao_rsi: this.calcularAceleracao(this.historicoRSI[timeframeKey]),
                aceleracao_adx: this.calcularAceleracao(this.historicoADX[timeframeKey])
            },
            timestamp: new Date().toISOString(),
            timeframe: timeframeKey
        };
    }

    inferirDirecaoLocal(analiseRSI, analiseADX, analisePreco) {
        // Lógica simples para inferir direção baseada nos indicadores
        return 'NEUTRA';
    }

    analisarVelocidadeRSI(rsiAtual, limiar, timeframeKey) {
        const historico = this.historicoRSI[timeframeKey] || [];
        
        if (historico.length < 3) {
            return {
                velocidadeNormal: true,
                variacao: 0,
                variacaoMaxima: limiar.rsiMaxVariacao,
                alerta: null,
                severidade: 0
            };
        }

        const rsiAnterior = historico[historico.length - 1] || rsiAtual;
        const rsiAntePenultimo = historico[historico.length - 2] || rsiAnterior;

        const variacaoAtual = Math.abs(rsiAtual - rsiAnterior);
        const variacao3Velas = Math.abs(rsiAtual - (historico[historico.length - 3] || rsiAtual));
        const variacaoAnterior = Math.abs(rsiAnterior - rsiAntePenultimo);
        const aceleracao = variacaoAtual - variacaoAnterior;

        const ultrapassouLimite = variacaoAtual > limiar.rsiMaxVariacao;
        const ultrapassouLimitePeriodo = variacao3Velas > limiar.rsiMaxVariacao * 2;

        let severidade = 0;
        if (ultrapassouLimite) {
            severidade = Math.min(100, (variacaoAtual / limiar.rsiMaxVariacao) * 70);
        }
        if (ultrapassouLimitePeriodo) {
            severidade = Math.min(100, severidade + 20);
        }
        if (aceleracao > 5) {
            severidade += 10;
        }

        const padrao = this.detectarPadraoRSI(rsiAtual, variacaoAtual, aceleracao, limiar);

        let alerta = null;
        if (ultrapassouLimite) {
            alerta = {
                tipo: 'RSI_RAPIDO',
                mensagem: `RSI variou ${variacaoAtual.toFixed(1)} pontos em 1 vela (limite: ${limiar.rsiMaxVariacao})`,
                severidade: severidade
            };
        } else if (ultrapassouLimitePeriodo) {
            alerta = {
                tipo: 'RSI_ACELERADO',
                mensagem: `RSI variou ${variacao3Velas.toFixed(1)} pontos em 3 velas - ACELERAÇÃO PERIGOSA`,
                severidade: severidade
            };
        } else if (aceleracao > 8) {
            alerta = {
                tipo: 'RSI_ACELERANDO',
                mensagem: `RSI acelerando (${aceleracao.toFixed(1)} pts/vela) - momentum excessivo`,
                severidade: 40
            };
        }

        return {
            valor: rsiAtual,
            variacao: variacaoAtual,
            variacao3Velas: variacao3Velas,
            aceleracao: aceleracao,
            velocidadeNormal: !ultrapassouLimite && !ultrapassouLimitePeriodo && aceleracao < 8,
            ultrapassouLimite: ultrapassouLimite,
            ultrapassouLimitePeriodo: ultrapassouLimitePeriodo,
            padrao: padrao,
            alerta: alerta,
            severidade: severidade,
            limite: limiar.rsiMaxVariacao
        };
    }

    analisarVelocidadeADX(adxAtual, limiar, timeframeKey) {
        const historico = this.historicoADX[timeframeKey] || [];
        
        if (historico.length < 3) {
            return {
                velocidadeNormal: true,
                variacao: 0,
                variacaoMaxima: limiar.adxMaxVariacao,
                alerta: null,
                severidade: 0
            };
        }

        const adxAnterior = historico[historico.length - 1] || adxAtual;
        const adxAntePenultimo = historico[historico.length - 2] || adxAnterior;

        const variacaoAtual = Math.abs(adxAtual - adxAnterior);
        const variacao3Velas = Math.abs(adxAtual - (historico[historico.length - 3] || adxAtual));
        const variacaoAnterior = Math.abs(adxAnterior - adxAntePenultimo);
        const aceleracao = variacaoAtual - variacaoAnterior;

        const ultrapassouLimite = variacaoAtual > limiar.adxMaxVariacao;
        const ultrapassouLimitePeriodo = variacao3Velas > limiar.adxMaxVariacao * 2;

        const adxContexto = {
            fraco: adxAtual < 20,
            moderado: adxAtual >= 20 && adxAtual < 40,
            forte: adxAtual >= 40
        };

        let severidade = 0;
        if (ultrapassouLimite) {
            severidade = Math.min(100, (variacaoAtual / limiar.adxMaxVariacao) * 60);
        }
        if (ultrapassouLimitePeriodo) {
            severidade = Math.min(100, severidade + 25);
        }
        if (adxContexto.forte && variacaoAtual > limiar.adxMaxVariacao * 0.8) {
            severidade += 15;
        }

        const padrao = this.detectarPadraoADX(adxAtual, variacaoAtual, adxContexto);

        let alerta = null;
        if (ultrapassouLimite) {
            alerta = {
                tipo: 'ADX_RAPIDO',
                mensagem: `ADX variou ${variacaoAtual.toFixed(1)} pontos em 1 vela (limite: ${limiar.adxMaxVariacao})`,
                severidade: severidade
            };
        } else if (ultrapassouLimitePeriodo && adxContexto.forte) {
            alerta = {
                tipo: 'ADX_FORTE_RAPIDO',
                mensagem: `ADX forte (${adxAtual.toFixed(1)}) + variação rápida - POSSÍVEL TOPO/FUNDO`,
                severidade: 75
            };
        }

        return {
            valor: adxAtual,
            variacao: variacaoAtual,
            variacao3Velas: variacao3Velas,
            aceleracao: aceleracao,
            contexto: adxContexto,
            velocidadeNormal: !ultrapassouLimite && !ultrapassouLimitePeriodo,
            ultrapassouLimite: ultrapassouLimite,
            ultrapassouLimitePeriodo: ultrapassouLimitePeriodo,
            padrao: padrao,
            alerta: alerta,
            severidade: severidade,
            limite: limiar.adxMaxVariacao
        };
    }

    analisarVelocidadePreco(precoAtual, candlesRecentes, limiar, timeframeKey) {
        if (!candlesRecentes || candlesRecentes.length < 5) {
            return {
                velocidadeNormal: true,
                alerta: null,
                severidade: 0
            };
        }

        const precos = candlesRecentes.map(c => parseFloat(c.close)).filter(p => !isNaN(p));
        if (precos.length < 3) {
            return {
                velocidadeNormal: true,
                alerta: null,
                severidade: 0
            };
        }

        const precoAnterior = precos[precos.length - 2] || precoAtual;
        const precoAntePenultimo = precos[precos.length - 3] || precoAnterior;

        const variacaoPercentual = Math.abs((precoAtual - precoAnterior) / precoAnterior * 100);
        const variacao3Velas = Math.abs((precoAtual - precos[precos.length - 4]) / precos[precos.length - 4] * 100) || 0;

        const volatilidade = this.calcularVolatilidade(precos);

        const ultimoCandle = candlesRecentes[candlesRecentes.length - 1];
        const tamanhoCandle = ultimoCandle ?
            Math.abs(parseFloat(ultimoCandle.high) - parseFloat(ultimoCandle.low)) / parseFloat(ultimoCandle.close) * 100 : 0;

        const padroesPreco = this.detectarPadroesPreco(candlesRecentes, variacaoPercentual, tamanhoCandle);

        const limiteVariacao = this.calcularLimiteVariacao(timeframeKey, volatilidade);
        const velocidadeAnormal = variacaoPercentual > limiteVariacao * 2;
        const aceleracaoAnormal = variacao3Velas > limiteVariacao * 3;

        let severidade = 0;
        if (velocidadeAnormal) {
            severidade = Math.min(100, (variacaoPercentual / limiteVariacao) * 50);
        }
        if (aceleracaoAnormal) {
            severidade = Math.min(100, severidade + 30);
        }
        if (tamanhoCandle > volatilidade * 3) {
            severidade += 20;
        }

        let alerta = null;
        if (velocidadeAnormal) {
            alerta = {
                tipo: 'PRECO_RAPIDO',
                mensagem: `Preço variou ${variacaoPercentual.toFixed(2)}% em 1 vela - MOVIMENTO BRUSCO`,
                severidade: severidade
            };
        } else if (tamanhoCandle > volatilidade * 4) {
            alerta = {
                tipo: 'VELA_GIGANTE',
                mensagem: `Vela com tamanho ${tamanhoCandle.toFixed(2)}% - EXCESSO DE VOLATILIDADE`,
                severidade: 70
            };
        }

        return {
            preco: precoAtual,
            variacaoPercentual: variacaoPercentual,
            variacao3Velas: variacao3Velas,
            volatilidade: volatilidade,
            tamanhoCandle: tamanhoCandle,
            velocidadeNormal: !velocidadeAnormal && !aceleracaoAnormal && tamanhoCandle < volatilidade * 3,
            padroes: padroesPreco,
            alerta: alerta,
            severidade: severidade
        };
    }

    analisarConjunto(analiseRSI, analiseADX, analisePreco, timeframeKey) {
        const severidadeTotal = (
            analiseRSI.severidade * 0.4 +
            analiseADX.severidade * 0.3 +
            analisePreco.severidade * 0.3
        );

        const rsiLento = !analiseRSI.ultrapassouLimite;
        const adxLento = !analiseADX.ultrapassouLimite;
        const precoLento = analisePreco.velocidadeNormal;

        const todosNormais = rsiLento && adxLento && precoLento;
        const todosRapidos = !rsiLento && !adxLento && !precoLento;
        const maioriaRapida = [rsiLento, adxLento, precoLento].filter(v => !v).length >= 2;

        const divergencias = [];
        if (!rsiLento && adxLento) {
            divergencias.push('RSI rápido mas ADX normal - MOVIMENTO SEM TENDÊNCIA');
        }
        if (!precoLento && rsiLento) {
            divergencias.push('Preço rápido mas RSI normal - MOMENTUM NÃO CONFIRMADO');
        }
        if (!adxLento && !precoLento && rsiLento) {
            divergencias.push('ADX e preço rápidos, RSI lento - POSSÍVEL DIVERGÊNCIA OCULTA');
        }

        let classificacao = 'NORMAL';
        let confiabilidade = 100;

        if (severidadeTotal > 70) {
            classificacao = 'CRÍTICO';
            confiabilidade = 20;
        } else if (severidadeTotal > 50) {
            classificacao = 'ALTO_RISCO';
            confiabilidade = 40;
        } else if (severidadeTotal > 30) {
            classificacao = 'MODERADO';
            confiabilidade = 60;
        } else if (todosRapidos) {
            classificacao = 'TODOS_RAPIDOS';
            confiabilidade = 30;
        } else if (maioriaRapida) {
            classificacao = 'MAIORIA_RAPIDA';
            confiabilidade = 45;
        }

        return {
            severidadeTotal: severidadeTotal,
            todosNormais: todosNormais,
            todosRapidos: todosRapidos,
            maioriaRapida: maioriaRapida,
            divergencias: divergencias,
            classificacao: classificacao,
            confiabilidade: confiabilidade,
            recomendacao: this.recomendarPorClassificacao(classificacao, timeframeKey)
        };
    }

    detectarPadroesPerigosos(rsiAtual, adxAtual, analiseRSI, analiseADX, timeframeKey) {
        const padroes = [];

        if ((rsiAtual > 75 || rsiAtual < 25) && analiseRSI.ultrapassouLimite) {
            padroes.push({
                tipo: 'EXTREMO_RAPIDO',
                nome: 'RSI Extremo com Salto Rápido',
                descricao: `RSI ${rsiAtual.toFixed(1)} em zona extrema + variação brusca`,
                severidade: 90,
                acao: '🚨 NÃO OPERAR - PROVÁVEL ARMADILHA'
            });
            this.padroesPerigosos.rsiExtremoSaltos++;
        }

        if (adxAtual > 40 && analiseADX.variacao > analiseADX.limite * 1.5) {
            padroes.push({
                tipo: 'ADX_FALSO',
                nome: 'ADX Forte com Variação Excessiva',
                descricao: `ADX ${adxAtual.toFixed(1)} subiu ${analiseADX.variacao.toFixed(1)} pts - POSSÍVEL EXAUSTÃO`,
                severidade: 85,
                acao: '⚠️ AGUARDAR CONFIRMAÇÃO - Pode ser topo/fundo'
            });
            this.padroesPerigosos.adxFalsoRompimento++;
        }

        if (analiseRSI.ultrapassouLimite && !analiseADX.ultrapassouLimite && adxAtual < 25) {
            padroes.push({
                tipo: 'DIVERGENCIA_VELOCIDADE',
                nome: 'RSI Rápido em Mercado Lateral',
                descricao: 'RSI variando rápido mas ADX baixo - MOVIMENTO FALSO',
                severidade: 75,
                acao: '❌ IGNORAR SINAL - Mercado sem tendência'
            });
            this.padroesPerigosos.divergenciasVelocidade++;
        }

        if (analiseRSI.aceleracao > 10 && analiseADX.aceleracao > 8) {
            padroes.push({
                tipo: 'ACELERACAO_PERIGOSA',
                nome: 'Aceleração Conjunta',
                descricao: 'RSI e ADX acelerando juntos - MOMENTUM INSUSTENTÁVEL',
                severidade: 80,
                acao: '⏳ AGUARDAR REVERSÃO ou CORREÇÃO'
            });
        }

        if (timeframeKey === 'M15' || timeframeKey === 'M5') {
            if (analiseRSI.severidade > 40 || analiseADX.severidade > 40) {
                padroes.push({
                    tipo: 'TIMEFRAME_PEQUENO_RAPIDO',
                    nome: 'Timeframe Rápido com Alta Velocidade',
                    descricao: `${timeframeKey} com indicadores acelerados - ALTO RUÍDO`,
                    severidade: 65,
                    acao: '🔍 CONFIRMAR EM TIMEFRAMES MAIORES (M30/1H)'
                });
            }
        }

        return padroes;
    }

    calcularFatorConfianca(analiseConjunta, padroesPerigosos) {
        let fator = 1.0;

        if (analiseConjunta.severidadeTotal > 0) {
            fator *= (1 - (analiseConjunta.severidadeTotal / 200));
        }

        if (analiseConjunta.classificacao === 'CRÍTICO') {
            fator *= 0.3;
        } else if (analiseConjunta.classificacao === 'ALTO_RISCO') {
            fator *= 0.5;
        } else if (analiseConjunta.classificacao === 'TODOS_RAPIDOS') {
            fator *= 0.4;
        } else if (analiseConjunta.classificacao === 'MAIORIA_RAPIDA') {
            fator *= 0.6;
        }

        fator *= (1 - (analiseConjunta.divergencias.length * 0.1));

        for (const padrao of padroesPerigosos) {
            fator *= (1 - (padrao.severidade / 200));
        }

        return Math.max(0.2, Math.min(1.0, fator));
    }

    gerarAlertas(analiseRSI, analiseADX, analisePreco, analiseConjunta, padroesPerigosos, timeframeKey) {
        const alertas = [];

        if (analiseRSI.alerta) alertas.push(analiseRSI.alerta);
        if (analiseADX.alerta) alertas.push(analiseADX.alerta);
        if (analisePreco.alerta) alertas.push(analisePreco.alerta);

        for (const divergencia of analiseConjunta.divergencias) {
            alertas.push({
                tipo: 'DIVERGENCIA',
                mensagem: divergencia,
                severidade: 60
            });
        }

        for (const padrao of padroesPerigosos) {
            alertas.push({
                tipo: padrao.tipo,
                mensagem: `[${padrao.nome}] ${padrao.descricao}`,
                severidade: padrao.severidade,
                acao: padrao.acao
            });
        }

        if (analiseConjunta.classificacao !== 'NORMAL') {
            alertas.push({
                tipo: 'CLASSIFICACAO',
                mensagem: `Classificação: ${analiseConjunta.classificacao} - Confiabilidade: ${analiseConjunta.confiabilidade}%`,
                severidade: analiseConjunta.severidadeTotal
            });
        }

        if (timeframeKey === 'M5' && analiseConjunta.severidadeTotal > 30) {
            alertas.push({
                tipo: 'TIMEFRAME_ALERTA',
                mensagem: `⚠️ M5 com severidade ${analiseConjunta.severidadeTotal.toFixed(0)}% - Validar em M15 antes de operar`,
                severidade: 50
            });
        }

        return alertas.sort((a, b) => b.severidade - a.severidade);
    }

    gerarRecomendacao(fatorConfianca, analiseConjunta, padroesPerigosos) {
        const padraoCritico = padroesPerigosos.find(p => p.severidade >= 85);
        if (padraoCritico) {
            return {
                acao: 'BLOQUEAR',
                motivo: `🚫 ${padraoCritico.acao} - ${padraoCritico.descricao}`,
                confiancaAjustada: fatorConfianca * 0.5
            };
        }

        if (padroesPerigosos.length > 0 && fatorConfianca < 0.5) {
            return {
                acao: 'BLOQUEAR',
                motivo: `⛔ Múltiplos padrões perigosos (${padroesPerigosos.length}) - Confiança ${(fatorConfianca * 100).toFixed(0)}%`,
                confiancaAjustada: fatorConfianca
            };
        }

        switch (analiseConjunta.classificacao) {
            case 'CRÍTICO':
                return {
                    acao: 'BLOQUEAR',
                    motivo: '🚫 MOVIMENTO CRÍTICO - Velocidade anormal em todos indicadores',
                    confiancaAjustada: fatorConfianca
                };
            case 'ALTO_RISCO':
                return {
                    acao: 'REDUZIR_PESO',
                    motivo: '⚠️ ALTO RISCO - Reduzir posição em 50%',
                    confiancaAjustada: fatorConfianca * 0.7
                };
            case 'MODERADO':
                return {
                    acao: 'CAUTELA',
                    motivo: '⚖️ Velocidade moderada - Operar com stop mais curto',
                    confiancaAjustada: fatorConfianca * 0.85
                };
            case 'NORMAL':
                return {
                    acao: 'PERMITIR',
                    motivo: '✅ Velocidade normal dos indicadores',
                    confiancaAjustada: fatorConfianca
                };
            default:
                return {
                    acao: 'PERMITIR_COM_RESSALVAS',
                    motivo: `🔍 Classificação: ${analiseConjunta.classificacao} - Validar manualmente`,
                    confiancaAjustada: fatorConfianca * 0.8
                };
        }
    }

    atualizarHistoricos(rsi, adx, preco, timeframeKey) {
        if (!this.historicoRSI[timeframeKey]) this.historicoRSI[timeframeKey] = [];
        if (!this.historicoADX[timeframeKey]) this.historicoADX[timeframeKey] = [];
        if (!this.historicoPrecos[timeframeKey]) this.historicoPrecos[timeframeKey] = [];

        this.historicoRSI[timeframeKey].push(rsi);
        this.historicoADX[timeframeKey].push(adx);
        this.historicoPrecos[timeframeKey].push(preco);

        if (this.historicoRSI[timeframeKey].length > this.maxHistorico) {
            this.historicoRSI[timeframeKey] = this.historicoRSI[timeframeKey].slice(-this.maxHistorico);
        }
        if (this.historicoADX[timeframeKey].length > this.maxHistorico) {
            this.historicoADX[timeframeKey] = this.historicoADX[timeframeKey].slice(-this.maxHistorico);
        }
        if (this.historicoPrecos[timeframeKey].length > this.maxHistorico) {
            this.historicoPrecos[timeframeKey] = this.historicoPrecos[timeframeKey].slice(-this.maxHistorico);
        }
    }

    calcularVariacaoPeriodo(historico, periodo) {
        if (!historico || historico.length < periodo + 1) return 0;
        const atual = historico[historico.length - 1];
        const passado = historico[historico.length - 1 - periodo];
        return Math.abs(atual - passado);
    }

    calcularAceleracao(historico) {
        if (!historico || historico.length < 4) return 0;
        const var1 = Math.abs(historico[historico.length - 1] - historico[historico.length - 2]);
        const var2 = Math.abs(historico[historico.length - 2] - historico[historico.length - 3]);
        const var3 = Math.abs(historico[historico.length - 3] - historico[historico.length - 4]);
        return (var1 - var2) + (var2 - var3) / 2;
    }

    calcularVolatilidade(precos) {
        if (!precos || precos.length < 5) return 1.0;
        const retornos = [];
        for (let i = 1; i < precos.length; i++) {
            retornos.push(Math.abs((precos[i] - precos[i - 1]) / precos[i - 1] * 100));
        }
        return retornos.reduce((a, b) => a + b, 0) / retornos.length;
    }

    calcularLimiteVariacao(timeframe, volatilidade) {
        const baseLimite = {
            M1: 0.4,
            M5: 0.8,
            M15: 1.2,
            M30: 1.8,
            H1: 2.5,
            H4: 4.0,
            H24: 6.0
        };
        return (baseLimite[timeframe] || 1.0) * Math.max(1, volatilidade / 2);
    }

    detectarPadraoRSI(rsi, variacao, aceleracao, limiar) {
        if (rsi > 80 && variacao > limiar.rsiMaxVariacao * 0.8) {
            return 'TOPO_ACELERADO';
        }
        if (rsi < 20 && variacao > limiar.rsiMaxVariacao * 0.8) {
            return 'FUNDO_ACELERADO';
        }
        if (aceleracao > 8 && variacao > limiar.rsiMaxVariacao * 0.6) {
            return 'MOMENTUM_ACELERANDO';
        }
        return 'NORMAL';
    }

    detectarPadraoADX(adx, variacao, contexto) {
        if (contexto.forte && variacao > 12) {
            return 'EXAUSTAO_TENDENCIA';
        }
        if (contexto.fraco && variacao > 10) {
            return 'FALSO_ROMPIMENTO';
        }
        return 'NORMAL';
    }

    detectarPadroesPreco(candles, variacao, tamanhoCandle) {
        const padroes = [];

        if (candles.length >= 3) {
            const ultimos3 = candles.slice(-3);
            const corpos = ultimos3.map(c => Math.abs(c.close - c.open));
            const sombrasSuperiores = ultimos3.map(c => c.high - Math.max(c.close, c.open));
            const sombrasInferiores = ultimos3.map(c => Math.min(c.close, c.open) - c.low);

            if (tamanhoCandle < 0.1 && variacao > 1.0) {
                padroes.push('EXAUSTAO_DOJI');
            }

            if (sombrasSuperiores[2] > tamanhoCandle * 2) {
                padroes.push('REJEICAO_ALTA');
            }
            if (sombrasInferiores[2] > tamanhoCandle * 2) {
                padroes.push('REJEICAO_BAIXA');
            }
        }

        return padroes;
    }

    recomendarPorClassificacao(classificacao, timeframe) {
        const recomendacoes = {
            'NORMAL': '✅ Operação permitida - velocidade normal',
            'MODERADO': '⚠️ Reduza posição e use stop mais curto',
            'ALTO_RISCO': '❌ Evitar entrar - aguardar normalização',
            'CRÍTICO': '🚫 BLOQUEAR TRADING - velocidade anormal detectada',
            'TODOS_RAPIDOS': '⛔ Todos indicadores acelerados - PROVÁVEL FALSO',
            'MAIORIA_RAPIDA': '🔍 Maioria dos indicadores rápidos - confirmar em timeframe maior'
        };
        return recomendacoes[classificacao] || '🔍 Analisar manualmente';
    }

    reset() {
        this.inicializarHistoricos();
        this.padroesPerigosos = {
            rsiExtremoSaltos: 0,
            adxFalsoRompimento: 0,
            divergenciasVelocidade: 0
        };
    }

    getEstatisticasGerais() {
        const stats = {};
        for (const [tf, historico] of Object.entries(this.historicoRSI)) {
            stats[tf] = {
                totalAnalises: historico.length,
                ultimoRSI: historico[historico.length - 1],
                ultimoADX: this.historicoADX[tf] ? this.historicoADX[tf][this.historicoADX[tf].length - 1] : null,
                mediaVariacaoRSI: this.calcularMediaVariacao(historico),
                mediaVariacaoADX: this.calcularMediaVariacao(this.historicoADX[tf] || [])
            };
        }
        return {
            padroesPerigosos: this.padroesPerigosos,
            timeframes: stats
        };
    }

    calcularMediaVariacao(historico) {
        if (!historico || historico.length < 2) return 0;
        let soma = 0;
        for (let i = 1; i < historico.length; i++) {
            soma += Math.abs(historico[i] - historico[i - 1]);
        }
        return soma / (historico.length - 1);
    }
}

module.exports = AnaliseVelocidadeIndicadores;
