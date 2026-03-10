// analyzers/sistema-dupla-tendencia.js
class SistemaDuplaTendencia {
    constructor() {
        this.historicoTendencias = [];
    }

    // Funções auxiliares de cálculo
    calcularMediaExponencial(valores, periodo) {
        if (!valores || valores.length === 0) return 0;
        if (valores.length < periodo) {
            return valores.reduce((a, b) => a + b, 0) / valores.length;
        }
        
        const k = 2 / (periodo + 1);
        let ema = valores[0];
        
        for (let i = 1; i < valores.length; i++) {
            ema = valores[i] * k + ema * (1 - k);
        }
        
        return ema;
    }

    calcularMediaSimples(valores, periodo) {
        if (!valores || valores.length === 0) return 0;
        if (valores.length < periodo) {
            return valores.reduce((a, b) => a + b, 0) / valores.length;
        }
        const slice = valores.slice(-periodo);
        return slice.reduce((a, b) => a + b, 0) / periodo;
    }

    // Análise de tendência baseada em médias
    analisarTendenciaPreco(candles) {
        if (!candles || candles.length < 10) {
            return { sinal: 'HOLD', forca: 0, confiabilidade: 0.3 };
        }

        const fechamentos = candles.map(c => c.close);
        
        // Médias de diferentes períodos
        const mediaCurta = this.calcularMediaExponencial(fechamentos.slice(-5), 5);
        const mediaMedia = this.calcularMediaExponencial(fechamentos.slice(-10), 10);
        const mediaLonga = this.calcularMediaExponencial(fechamentos.slice(-20), 20);
        
        const precoAtual = fechamentos[fechamentos.length - 1];
        
        // Determinar tendência
        let sinal = 'HOLD';
        let forca = 0;
        let razoes = [];
        
        // Tendência de alta
        if (mediaCurta > mediaMedia && mediaMedia > mediaLonga) {
            sinal = 'CALL';
            forca = Math.abs((mediaCurta - mediaLonga) / mediaLonga * 100);
            razoes.push('Médias alinhadas em alta');
        }
        // Tendência de baixa
        else if (mediaCurta < mediaMedia && mediaMedia < mediaLonga) {
            sinal = 'PUT';
            forca = Math.abs((mediaCurta - mediaLonga) / mediaLonga * 100);
            razoes.push('Médias alinhadas em baixa');
        }
        // Possível reversão
        else if (mediaCurta > mediaMedia && mediaMedia < mediaLonga) {
            if (precoAtual > mediaCurta) {
                sinal = 'CALL';
                forca = 0.3;
                razoes.push('Possível fundo (golden cross)');
            }
        }
        else if (mediaCurta < mediaMedia && mediaMedia > mediaLonga) {
            if (precoAtual < mediaCurta) {
                sinal = 'PUT';
                forca = 0.3;
                razoes.push('Possível topo (death cross)');
            }
        }
        
        // Calcular confiabilidade baseada na distância entre médias
        const distanciaCurtaMedia = Math.abs(mediaCurta - mediaMedia) / mediaMedia * 100;
        const distanciaMediaLonga = Math.abs(mediaMedia - mediaLonga) / mediaLonga * 100;
        const confiabilidade = Math.min(0.9, (distanciaCurtaMedia + distanciaMediaLonga) / 5);
        
        return {
            sinal,
            forca,
            confiabilidade: Math.max(0.3, Math.min(0.9, confiabilidade)),
            razoes,
            medias: { curta: mediaCurta, media: mediaMedia, longa: mediaLonga },
            preco: precoAtual
        };
    }

    // Análise de MACD completa
    analisarMACDCompleto(macdData) {
        if (!macdData || !macdData.valido) {
            return { sinal: 'HOLD', forca: 0, confiabilidade: 0.3 };
        }
        
        const { macd, sinal, histograma } = macdData;
        
        let sinalMACD = 'HOLD';
        let forca = Math.abs(histograma) * 1000;
        let razoes = [];
        let confiabilidade = 0.5;
        
        // MACD e linha de sinal ambos positivos
        if (macd > 0 && sinal > 0) {
            if (histograma > 0) {
                sinalMACD = 'CALL';
                confiabilidade = 0.8 + (forca / 10);
                razoes.push('MACD e sinal positivos com histograma crescente');
            } else {
                sinalMACD = 'CALL';
                confiabilidade = 0.6;
                razoes.push('MACD positivo mas perdendo força');
            }
        }
        // MACD e linha de sinal ambos negativos
        else if (macd < 0 && sinal < 0) {
            if (histograma < 0) {
                sinalMACD = 'PUT';
                confiabilidade = 0.8 + (forca / 10);
                razoes.push('MACD e sinal negativos com histograma decrescente');
            } else {
                sinalMACD = 'PUT';
                confiabilidade = 0.6;
                razoes.push('MACD negativo mas perdendo força');
            }
        }
        // Zona neutra
        else {
            if (histograma > 0) {
                sinalMACD = 'CALL';
                confiabilidade = 0.5;
                razoes.push('MACD neutro com momentum positivo');
            } else if (histograma < 0) {
                sinalMACD = 'PUT';
                confiabilidade = 0.5;
                razoes.push('MACD neutro com momentum negativo');
            }
        }
        
        return {
            sinal: sinalMACD,
            forca,
            confiabilidade: Math.min(0.95, confiabilidade),
            razoes,
            valores: { macd, sinal, histograma }
        };
    }

    analisarTendenciasDuplas(candles, macdData, rsi, adxData) {
        // Análise de preço (tendência de curto prazo)
        const tendenciaPreco = this.analisarTendenciaPreco(candles);
        
        // Análise de MACD (tendência de médio prazo)
        const tendenciaMACD = this.analisarMACDCompleto(macdData);
        
        // Verificar convergência/divergência
        const mesmaDirecao = tendenciaPreco.sinal === tendenciaMACD.sinal;
        const ambosFortes = tendenciaPreco.confiabilidade > 0.7 && tendenciaMACD.confiabilidade > 0.7;
        const peloMenosUmForte = tendenciaPreco.confiabilidade > 0.6 || tendenciaMACD.confiabilidade > 0.6;
        
        let tipoConvergencia = '';
        let risco = 'BAIXO';
        let sinalFinal = 'HOLD';
        let probabilidadeBase = 0.5;
        let explicacao = '';
        
        if (mesmaDirecao && ambosFortes) {
            tipoConvergencia = tendenciaPreco.sinal === 'CALL' ? 'CONVERGÊNCIA BULLISH FORTE' : 'CONVERGÊNCIA BEARISH FORTE';
            risco = 'BAIXO';
            sinalFinal = tendenciaPreco.sinal;
            probabilidadeBase = 0.85;
            explicacao = 'Ambas as tendências concordam com força';
        }
        else if (mesmaDirecao && peloMenosUmForte) {
            tipoConvergencia = tendenciaPreco.sinal === 'CALL' ? 'CONVERGÊNCIA BULLISH' : 'CONVERGÊNCIA BEARISH';
            risco = 'MÉDIO';
            sinalFinal = tendenciaPreco.sinal;
            probabilidadeBase = 0.7;
            explicacao = 'Tendências concordam, mas uma é fraca';
        }
        else if (mesmaDirecao) {
            tipoConvergencia = 'CONVERGÊNCIA FRACA';
            risco = 'MÉDIO';
            sinalFinal = tendenciaPreco.sinal;
            probabilidadeBase = 0.6;
            explicacao = 'Tendências concordam, mas ambas são fracas';
        }
        else {
            // Divergência
            if (tendenciaPreco.confiabilidade > tendenciaMACD.confiabilidade * 1.5) {
                tipoConvergencia = 'PRICE ACTION MAIS FORTE';
                risco = 'MÉDIO';
                sinalFinal = tendenciaPreco.sinal;
                probabilidadeBase = 0.6;
                explicacao = 'Seguindo price action (mais forte que MACD)';
            }
            else if (tendenciaMACD.confiabilidade > tendenciaPreco.confiabilidade * 1.5) {
                tipoConvergencia = 'MACD MAIS FORTE';
                risco = 'MÉDIO';
                sinalFinal = tendenciaMACD.sinal;
                probabilidadeBase = 0.6;
                explicacao = 'Seguindo MACD (mais forte que price action)';
            }
            else {
                tipoConvergencia = 'DIVERGÊNCIA';
                risco = 'ALTO';
                sinalFinal = 'HOLD';
                probabilidadeBase = 0.4;
                explicacao = 'Tendências em conflito sem dominância clara';
            }
        }
        
        // Ajustar probabilidade com base no ADX
        if (adxData && adxData.adx) {
            const adx = adxData.adx;
            if (adx > 30) {
                probabilidadeBase += 0.1;
                explicacao += ' | ADX forte confirmando';
            } else if (adx < 15) {
                probabilidadeBase -= 0.1;
                explicacao += ' | ADX fraco - tendência lateral';
            }
        }
        
        // Ajustar com base no RSI (evitar extremos)
        if (rsi) {
            if (sinalFinal === 'CALL' && rsi > 75) {
                probabilidadeBase -= 0.15;
                explicacao += ' | RSI sobrecomprado - cautela';
            } else if (sinalFinal === 'PUT' && rsi < 25) {
                probabilidadeBase -= 0.15;
                explicacao += ' | RSI sobrevendido - cautela';
            }
        }
        
        const resultado = {
            tendenciaCurtoPrazo: {
                sinal: tendenciaPreco.sinal,
                forca: tendenciaPreco.forca,
                confiabilidade: tendenciaPreco.confiabilidade,
                razoes: tendenciaPreco.razoes
            },
            tendenciaMedioPrazo: {
                sinal: tendenciaMACD.sinal,
                forca: tendenciaMACD.forca,
                confiabilidade: tendenciaMACD.confiabilidade,
                razoes: tendenciaMACD.razoes
            },
            convergencia: {
                mesmaDirecao,
                tipo: tipoConvergencia,
                risco,
                sinalFinal,
                probabilidade: Math.max(0.3, Math.min(0.9, probabilidadeBase)),
                explicacao
            },
            rsi,
            adx: adxData?.adx || 0,
            timestamp: Date.now()
        };
        
        this.historicoTendencias.push(resultado);
        if (this.historicoTendencias.length > 100) {
            this.historicoTendencias = this.historicoTendencias.slice(-100);
        }
        
        return resultado;
    }

    calcularSinalFinal(analiseDupla) {
        if (!analiseDupla) {
            return { sinal: "HOLD", probabilidade: 0.5, motivo: "Sem dados suficientes", acao: "AGUARDAR" };
        }
        
        const { convergencia } = analiseDupla;
        
        return {
            sinal: convergencia.sinalFinal,
            probabilidade: convergencia.probabilidade,
            motivo: `${convergencia.tipo} - ${convergencia.explicacao}`,
            acao: convergencia.sinalFinal === 'HOLD' ? 'AGUARDAR' : `${convergencia.sinalFinal} COM ${convergencia.risco} RISCO`
        };
    }
}

module.exports = SistemaDuplaTendencia;
