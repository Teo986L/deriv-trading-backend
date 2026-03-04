// multi-timeframe-manager.js
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
    }

    addAnalysis(timeframeKey, analysis) {
        if (this.timeframes[timeframeKey]) {
            this.timeframes[timeframeKey].analysis = analysis;
            this.allAnalyses[timeframeKey] = analysis;
        }
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
        const weights = { M1: 1, M5: 2, M15: 3, M30: 4, H1: 5, H4: 6, H24: 7 };
        let totalWeight = 0, callWeight = 0, putWeight = 0, totalConfidence = 0, timeframesCount = 0;
        const details = {};

        let callCount = 0, putCount = 0, holdCount = 0;

        for (const [key, analysis] of Object.entries(this.allAnalyses)) {
            const weight = weights[key] || 1;
            totalWeight += weight;

            if (analysis.sinal === 'CALL') {
                callCount++;
                callWeight += weight * (analysis.probabilidade || 0.5);
            } else if (analysis.sinal === 'PUT') {
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
                confidence: (analysis.probabilidade * 100).toFixed(1) + '%',
                price: analysis.preco_atual,
                trend: analysis.tendencia
            };
        }

        const primarySignal = callCount > putCount ? 'CALL' : (putCount > callCount ? 'PUT' : 'HOLD');

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
            confidence = callWeight / totalWeight;
        } else if (primarySignal === 'PUT') {
            confidence = putWeight / totalWeight;
        } else {
            confidence = totalConfidence / (timeframesCount * 100);
        }

        const majorityRatio = Math.max(callCount, putCount) / (callCount + putCount + holdCount);
        confidence = confidence * (0.8 + 0.2 * majorityRatio);
        confidence = Math.min(0.95, Math.max(0.05, confidence));

        const avgConfidence = timeframesCount > 0 ? totalConfidence / timeframesCount : 0;

        this.consolidatedSignal = {
            signal: primarySignal,
            confidence: confidence,
            agreement: agreement,
            details,
            avgConfidence,
            callWeight: callWeight.toFixed(2),
            putWeight: putWeight.toFixed(2),
            totalWeight,
            timeframesAnalyzed: timeframesCount,
            simpleMajority: {
                signal: primarySignal,
                callCount,
                putCount,
                holdCount
            },
            allAnalyses: this.allAnalyses
        };

        return this.consolidatedSignal;
    }
}

module.exports = MultiTimeframeManager;
