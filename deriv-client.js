// deriv-client.js
const WebSocket = require('ws');
const EventEmitter = require('events');

class DerivClient extends EventEmitter {
    constructor(token, endpoint = "wss://ws.binaryws.com/websockets/v3?app_id=1089") {
        super();
        this.token = token;
        this.endpoint = endpoint;
        this.ws = null;
        this.reqId = 1;
        this.connected = false;
        this.authorized = false;
        this.pendingRequests = new Map();
        this.pingInterval = null;
        this.reconnectAttempts = 0;
        this.maxReconnectDelay = 60000;
        this.reconnectDelay = 1000;
        this.connecting = false;
        this._shouldReconnect = true;

        // Map de listeners para ticks (usado por getCurrentPrice no server.js)
        this._tickListeners = new Map();

        // ✅ [NOVO] Último tick recebido por símbolo — para consulta rápida sem novo pedido WS
        this._lastTicksBySymbol = new Map();

        // ✅ [NOVO] Limpeza periódica de listeners antigos (memory leak protection)
        this._listenerCleanupInterval = setInterval(() => {
            this._cleanupOldTickListeners(30000);
        }, 30000);
    }

    connect() {
        return new Promise((resolve, reject) => {
            if (this.connecting) {
                reject(new Error('Já está conectando'));
                return;
            }
            if (this.connected && this.authorized && this.ws && this.ws.readyState === WebSocket.OPEN) {
                resolve(true);
                return;
            }

            this.connecting = true;
            this.ws = new WebSocket(this.endpoint);

            const connectionTimeout = setTimeout(() => {
                if (this.connecting) {
                    this.ws.terminate();
                    this.connecting = false;
                    reject(new Error('Timeout de conexão WebSocket'));
                }
            }, 15000);

            this.ws.on('open', () => {
                clearTimeout(connectionTimeout);
                this.connecting = false;
                this.connected = true;
                this.reconnectAttempts = 0;
                console.log('✅ WebSocket conectado');
                this.startPing();
                this.authorize()
                    .then(() => resolve(true))
                    .catch((err) => {
                        console.error('❌ Erro na autorização:', err.message);
                        reject(err);
                    });
            });

            this.ws.on('message', (data) => {
                try {
                    const msg = JSON.parse(data);
                    this._handleMessage(msg);
                } catch (e) {
                    console.error('❌ Erro ao parsear mensagem:', e);
                }
            });

            this.ws.on('error', (err) => {
                console.error('💥 WebSocket erro:', err.message);
                clearTimeout(connectionTimeout);
                this.connecting = false;
                this.connected = false;
                this.authorized = false;
                this.stopPing();
                this.emit('error', err);
                reject(err);
            });

            this.ws.on('close', (code, reason) => {
                console.log(`❌ WebSocket fechado: ${code} - ${reason}`);
                clearTimeout(connectionTimeout);
                this.connecting = false;
                this.connected = false;
                this.authorized = false;
                this.stopPing();
                this._rejectAllPending('WebSocket fechado inesperadamente');
                this.emit('close', code, reason);
                this._reconnect();
            });
        });
    }

    _reconnect() {
        if (!this._shouldReconnect) {
            console.log('🛑 _reconnect() cancelado (cliente abandonado pelo servidor)');
            return;
        }

        const delay = Math.min(
            this.reconnectDelay * Math.pow(2, this.reconnectAttempts),
            this.maxReconnectDelay
        );
        this.reconnectAttempts++;
        console.log(`🔄 Reconectando em ${delay}ms (tentativa ${this.reconnectAttempts})`);

        setTimeout(() => {
            if (!this._shouldReconnect) return;
            this.connect().catch(err => {
                console.error('❌ Falha na reconexão:', err.message);
            });
        }, delay);
    }

    _rejectAllPending(reason) {
        if (this.pendingRequests.size > 0) {
            console.log(`⚠️ Rejeitando ${this.pendingRequests.size} pedidos pendentes: ${reason}`);
            for (const [, { reject, timeout }] of this.pendingRequests) {
                clearTimeout(timeout);
                reject(new Error(reason));
            }
            this.pendingRequests.clear();
        }
    }

    _handleMessage(msg) {
        if (msg.msg_type === 'authorize') {
            if (!msg.error) {
                this.authorized = true;
                console.log('✅ Autorizado com sucesso');
            } else {
                console.error('❌ Erro autorização:', msg.error.message);
                this.authorized = false;
            }

            const reqId = msg.echo_req?.req_id;
            if (reqId && this.pendingRequests.has(reqId)) {
                const { resolve, reject, timeout } = this.pendingRequests.get(reqId);
                clearTimeout(timeout);
                this.pendingRequests.delete(reqId);
                if (msg.error) {
                    reject(new Error(msg.error.message));
                } else {
                    resolve(msg);
                }
            }
            return;
        }

        if (msg.msg_type === 'pong') {
            return;
        }

        // ✅ [ATUALIZADO] Ticks: guarda no histórico antes de broadcast
        if (msg.msg_type === 'tick' && msg.tick) {
            const tick = msg.tick;
            const symbol = tick.symbol;
            const enrichedTick = {
                quote: tick.quote,
                epoch: tick.epoch || Math.floor(Date.now() / 1000),
                receivedAt: Date.now(),
                id: tick.id || null
            };

            // Guarda como último tick conhecido deste símbolo
            if (symbol) {
                this._lastTicksBySymbol.set(symbol, enrichedTick);
            }

            // Broadcast para todos os listeners ativos
            let deliveredCount = 0;
            for (const [, handler] of this._tickListeners) {
                try { 
                    handler({ tick: enrichedTick, msg_type: 'tick' }); 
                    deliveredCount++;
                } catch (e) { /* ignora erros no handler */ }
            }
            if (deliveredCount === 0) {
                // Ninguém estava à espera — log silencioso para debug
                // console.log(`📡 Tick ${symbol}=${enrichedTick.quote} (sem listeners ativos)`);
            }
            return;
        }

        // Resolve pedidos normais (candles, etc.)
        const reqId = msg.echo_req?.req_id;
        if (reqId && this.pendingRequests.has(reqId)) {
            const { resolve, reject, timeout } = this.pendingRequests.get(reqId);
            clearTimeout(timeout);
            this.pendingRequests.delete(reqId);
            if (msg.error) {
                reject(new Error(msg.error.message));
            } else {
                resolve(msg);
            }
        }
    }

    authorize() {
        return new Promise((resolve, reject) => {
            if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
                reject(new Error('WebSocket não está conectado'));
                return;
            }
            const req = { authorize: this.token, req_id: this.reqId++ };
            const reqId = req.req_id;
            const timeout = setTimeout(() => {
                this.pendingRequests.delete(reqId);
                reject(new Error('Timeout na autorização'));
            }, 30000);

            this.pendingRequests.set(reqId, {
                resolve: (msg) => {
                    if (!msg.error) {
                        resolve(true);
                    } else {
                        reject(new Error(msg.error.message));
                    }
                },
                reject,
                timeout
            });
            this.ws.send(JSON.stringify(req));
        });
    }

    getCandles(symbol, count = 400, granularity = 3600) {
        return new Promise((resolve, reject) => {
            if (!this.connected || !this.authorized) {
                reject(new Error('Não conectado ou não autorizado'));
                return;
            }
            const req = {
                ticks_history: symbol,
                adjust_start_time: 1,
                count,
                end: 'latest',
                granularity,
                style: 'candles',
                req_id: this.reqId++
            };
            const reqId = req.req_id;

            const timeout = setTimeout(() => {
                this.pendingRequests.delete(reqId);
                reject(new Error(`Timeout na requisição de candles (${symbol}, ${granularity}s)`));
            }, 12000);

            this.pendingRequests.set(reqId, {
                resolve: (msg) => {
                    if (msg.error) {
                        reject(new Error(msg.error.message));
                    } else if (msg.candles && Array.isArray(msg.candles)) {
                        resolve(msg.candles);
                    } else {
                        reject(new Error('Formato de resposta inválido da Deriv'));
                    }
                },
                reject,
                timeout
            });
            this.ws.send(JSON.stringify(req));
        });
    }

    // ✅ [NOVO] Obtém o último tick conhecido de um símbolo sem fazer novo pedido WS
    getLastTick(symbol) {
        const tick = this._lastTicksBySymbol.get(symbol);
        if (!tick) return null;
        const ageMs = Date.now() - tick.receivedAt;
        return { ...tick, ageMs };
    }

    // ✅ [NOVO] Verifica se há um tick fresco (dentro de maxAgeMs) para o símbolo
    hasFreshTick(symbol, maxAgeMs = 5000) {
        const tick = this._lastTicksBySymbol.get(symbol);
        if (!tick) return false;
        return (Date.now() - tick.receivedAt) < maxAgeMs;
    }

    addListener(reqId, handler) {
        // ✅ [NOVO] Adiciona timestamp para permitir limpeza automática
        this._tickListeners.set(reqId, handler);
        handler._addedAt = Date.now();
    }

    removeListener(reqId) {
        this._tickListeners.delete(reqId);
    }

    // ✅ [NOVO] Remove listeners que não foram removidos manualmente (memory leak protection)
    _cleanupOldTickListeners(maxAgeMs = 30000) {
        const now = Date.now();
        let removed = 0;
        for (const [reqId, handler] of this._tickListeners) {
            if (handler._addedAt && (now - handler._addedAt) > maxAgeMs) {
                this._tickListeners.delete(reqId);
                removed++;
            }
        }
        if (removed > 0) {
            console.log(`🧹 Limpeza automática: ${removed} tick listener(s) antigo(s) removido(s)`);
        }
    }

    getConnectionStatus() {
        const wsStateMap = { 0: 'CONNECTING', 1: 'OPEN', 2: 'CLOSING', 3: 'CLOSED' };
        return {
            status: this.connected && this.authorized ? 'ready' :
                    this.connected ? 'connected_not_authorized' :
                    this.connecting ? 'connecting' : 'disconnected',
            connected: this.connected,
            authorized: this.authorized,
            connecting: this.connecting,
            wsReadyState: this.ws ? (wsStateMap[this.ws.readyState] ?? 'UNKNOWN') : 'NO_SOCKET',
            reconnectAttempts: this.reconnectAttempts,
            pendingRequests: this.pendingRequests.size,
            tickListeners: this._tickListeners.size,
            lastTickSymbols: Array.from(this._lastTicksBySymbol.keys()),
            shouldReconnect: this._shouldReconnect,
            uptime: Math.floor(process.uptime())
        };
    }

    startPing() {
        this.stopPing();
        this.pingInterval = setInterval(() => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({ ping: 1, req_id: this.reqId++ }));
            }
        }, 30000);
    }

    stopPing() {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }
    }

    disconnect() {
        this._shouldReconnect = false;
        this.stopPing();

        // ✅ [NOVO] Limpa intervalo de cleanup e listeners pendentes
        if (this._listenerCleanupInterval) {
            clearInterval(this._listenerCleanupInterval);
            this._listenerCleanupInterval = null;
        }
        this._tickListeners.clear();
        this._lastTicksBySymbol.clear();

        this._rejectAllPending('Desconexão manual');
        if (this.ws) {
            this.ws.close();
        }
        this.connected = false;
        this.authorized = false;
    }
}

module.exports = DerivClient;
