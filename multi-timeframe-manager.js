// multi-timeframe-manager.js
const { SMOOTHING } = require('./config');

class MultiTimeframeManager {
    constructor() {
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
        
        this.TF_BASE_WEIGHT = {
            'M1': 1.0,
            'M5': 1.5,
            'M15': 2.0,
            'M30': 2.5,
            'H1': 3.0,
            'H4': 3.5,
            'H24': 4.0
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

    addAnalysis(timeframeKey, analysis) {
        if (this.timeframes[timeframeKey]) {
            this.timeframes[timeframeKey].analysis = analysis;
            this.allAnalyses[timeframeKey] = analysis;
            
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

    consolidateSignals() {
        let totalWeight = 0;
        let callWeight = 0;
        let putWeight = 0;
        let totalConfidence = 0;
        let timeframesCount = 0;
        const details = {};

        let callCount = 0, putCount = 0, holdCount = 0;

        for (const [key, analysis] of Object.entries(this.allAnalyses)) {
            if (!analysis) continue;
            
            const smoothedSignal = this.getSmoothedSignal(key);
            const signalForWeight = smoothedSignal || analysis.sinal;
            
            const weight = this.calcularPesoPorTF(key, analysis);
            
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

        const primarySignal = callWeight > putWeight ? 'CALL' : (putWeight > callWeight ? 'PUT' : 'HOLD');

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
            confidence = totalConfidence / (timeframesCount * 100);
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

        this.consolidatedSignal = {
            signal: primarySignal,
            confidence: confidence,
            agreement: agreement,
            details,
            timeframesAnalyzed: timeframesCount,
            simpleMajority: {
                signal: primarySignal,
                callCount,
                putCount,
                holdCount
            },
            allAnalyses: this.allAnalyses,
            divergencias: divergencias,
            timeframeDominante: timeframeDominante,
            recomendacao: divergencias.length > 1 ? 'AGUARDAR' : 
                          (confidence > 0.7 ? primarySignal : 'CAUTELA')
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
                recomendacao: 'USAR_COM_CAUTELA'
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
            recomendacao: 'AGUARDAR'
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
            divergencias: this.detectarDivergencias()
        };
    }
}

module.exports = MultiTimeframeManager;
