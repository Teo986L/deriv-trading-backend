// config.js
module.exports = {
    WS_ENDPOINT: "wss://ws.binaryws.com/websockets/v3?app_id=1089",
    API_TOKEN: process.env.API_TOKEN || "1Jd2sESxdZ24Luv",
    CANDLE_COUNT: 300,

    INDICATOR_CONFIG: {
        RSI_PERIOD: 14,
        ADX_PERIOD: 14,
        MACD_FAST: 12,
        MACD_SLOW: 26,
        MACD_SIGNAL: 9
    },

    // 🔥 Modos de trading com thresholds específicos
    TRADING_MODES: {
        SNIPER: {
            name: 'SNIPER',
            minConfidence: 0.60,
            description: 'Entradas cirúrgicas de 1-15 minutos',
            timeframes: ['M1', 'M5', 'M15']
        },
        HUNTER: {
            name: 'CAÇADOR',
            minConfidence: 0.50,
            description: 'Ondas médias de 15-60 minutos',
            timeframes: ['M5', 'M15', 'H1']
        },
        FISHER: {
            name: 'PESCADOR',
            minConfidence: 0.40,
            description: 'Grandes movimentos de horas a dias',
            timeframes: ['M15', 'H1', 'H4']
        }
    },

    // 🔥 Modo de trading ativo
    TRADING_MODE: "PADRÃO",

    // 🔥 Thresholds ajustados para melhor performance
    PROB_BUY_THRESHOLD: 0.55,
    PROB_SELL_THRESHOLD: 0.45,
    MIN_CALL_CONFIRMATIONS: 3,      // Reduzido de 4
    MIN_PUT_CONFIRMATIONS: 3,       // Mantido

    TIMEFRAMES: {
        M1: 60,
        M5: 300,
        M15: 900,
        M30: 1800,
        H1: 3600,
        H4: 14400,
        H24: 86400
    },

    BOT_SHIELD_CONFIG: {
        MIN_CONFIDENCE: 65,          // Reduzido de 75
        USE_CLOSED_CANDLES_ONLY: true,
        ELLIOTT_WEIGHT_REDUCTION: 0.3,
        MAX_ALLOWED_DELAY_MS: 30000,
        BLOCK_HIGH_IMPACT_TIMES: true,
        HIGH_IMPACT_TIMES: [
            { hour: 7, minute: 0, duration: 30 },
            { hour: 13, minute: 0, duration: 30 },
            { hour: 20, minute: 0, duration: 30 }
        ]
    },

    MARKET_STATE: {
        STRONG_BULL_TREND: "STRONG_BULL_TREND",
        STRONG_BEAR_TREND: "STRONG_BEAR_TREND",
        BULLISH_CORRECTION: "BULLISH_CORRECTION",
        BEARISH_CORRECTION: "BEARISH_CORRECTION",
        TRANSITION: "TRANSITION",
        RANGE: "RANGE",
        EXHAUSTION: "EXHAUSTION",
        NO_TRADE: "NO_TRADE"
    },

    SIGNAL_TYPE: {
        TREND_CONTINUATION: "TREND_CONTINUATION",
        PULLBACK: "PULLBACK",
        TRANSITION: "TRANSITION",
        RANGE_BREAKOUT: "RANGE_BREAKOUT",
        NONE: "NONE"
    },

    // 🔥 Configurações por tipo de ativo (otimizadas)
    ConfigAtivo: {
        getConfig(simbolo) {
            const tipo = this._detectarTipoAtivo(simbolo);
            
            const configs = {
                commodity: { 
                    nome: 'Commodity',
                    rsi_oversold: 25,
                    rsi_overbought: 75,
                    rsi_extreme_oversold: 15,
                    rsi_extreme_overbought: 85,
                    prob_compra: 0.60,
                    prob_venda: 0.40,
                    peso_tecnica: 0.65,
                    atr_multiplier: 2.0,
                    min_probabilidade: 0.52,
                    tendencia_peso_extra: 1.2,
                    limite_volatilidade_min: 0.05,
                    limite_volatilidade_max: 2.0,
                    usar_adx_corrigido: true,
                    agressividade: 1.2,
                    stop_padrao_pct: 0.8,
                    alvo_moderado_pct: 2.0
                },
                
                indice_normal: { 
                    nome: 'Índice Normal',
                    rsi_oversold: 25,
                    rsi_overbought: 75,
                    rsi_extreme_oversold: 15,
                    rsi_extreme_overbought: 85,
                    prob_compra: 0.58,
                    prob_venda: 0.42,
                    peso_tecnica: 0.60,
                    atr_multiplier: 1.5,
                    min_probabilidade: 0.50,
                    tendencia_peso_extra: 1.1,
                    limite_volatilidade_min: 0.10,
                    limite_volatilidade_max: 2.5,
                    usar_adx_corrigido: true,
                    agressividade: 1.0,
                    stop_padrao_pct: 0.6,
                    alvo_moderado_pct: 1.8
                },
                
                // 🔥 Volatility Index otimizado
                volatility_index: { 
                    nome: 'Volatility Index',
                    rsi_oversold: 20,
                    rsi_overbought: 80,
                    rsi_extreme_oversold: 15,
                    rsi_extreme_overbought: 85,
                    prob_compra: 0.55,
                    prob_venda: 0.45,
                    peso_tecnica: 0.55,
                    atr_multiplier: 1.5,
                    min_probabilidade: 0.45,
                    tendencia_peso_extra: 1.2,
                    limite_volatilidade_min: 0.05,
                    limite_volatilidade_max: 1.5,
                    usar_adx_corrigido: true,
                    agressividade: 1.3,
                    stop_padrao_pct: 0.4,
                    alvo_moderado_pct: 1.2
                },
                
                criptomoeda: { 
                    nome: 'Criptomoeda',
                    rsi_oversold: 20,
                    rsi_overbought: 80,
                    rsi_extreme_oversold: 15,
                    rsi_extreme_overbought: 85,
                    prob_compra: 0.60,
                    prob_venda: 0.40,
                    peso_tecnica: 0.70,
                    atr_multiplier: 2.0,
                    min_probabilidade: 0.50,
                    tendencia_peso_extra: 1.3,
                    limite_volatilidade_min: 0.10,
                    limite_volatilidade_max: 3.0,
                    usar_adx_corrigido: true,
                    agressividade: 1.3,
                    stop_padrao_pct: 0.6,
                    alvo_moderado_pct: 2.0
                }
            };
            
            return configs[tipo] || configs.indice_normal;
        },
        
        _detectarTipoAtivo(simbolo) {
            if (!simbolo) return 'indice_normal';
            
            simbolo = simbolo.toUpperCase();
            
            if (simbolo.startsWith('R_')) return 'volatility_index';
            else if (simbolo.startsWith('1HZ')) return 'volatility_index';
            else if (simbolo.startsWith('BOOM') || simbolo.startsWith('CRASH')) return 'volatility_index';
            else if (simbolo.includes('XAU') || simbolo.includes('XAG') || simbolo.includes('OIL')) return 'commodity';
            else if (simbolo.includes('CRY') || simbolo.includes('BTC') || simbolo.includes('ETH')) return 'criptomoeda';
            else if (simbolo.includes('frx')) return 'forex';
            else return 'indice_normal';
        }
    }
};
