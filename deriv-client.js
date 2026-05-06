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

        // ✅ FIX: sem limite máximo — reconecta para sempre com backoff
        this.maxReconnectDelay = 60000; // máximo 60s entre tentativas
        this.reconnectDelay = 1000;
        this.connecting = false;

        // ✅ FIX: Map de listeners para ticks (usado por getCurrentPrice no server.js)
        this._tickListeners = new Map();
    }

    connect() {
        return new Promise((resolve, reject) => {
            if (this.connecting) {
                reject(new Error('Já está conectando'));
                return;
            }
            if (this.connected && this.ws && this.ws.readyState === WebSocket.OPEN) {
                resolve(true);
                return;
            }

            this.connecting = true;
            this.ws = new WebSocket(this.endpoint);

            const connectionTimeout = setTimeout(() => {
                if (this.connecting) {
                    this.ws.terminate();
                    this.connecting = false;
                    reject(new Error('Timeout de conexão'));
                }
            }, 15000);

            this.ws.on('open', () => {
                clearTimeout(connectionTimeout);
                this.connecting = false;
                this.connected = true;
                this.reconnectAttempts = 0; // reset ao conectar com sucesso
                console.log('✅ WebSocket conectado');
                this.startPing();
                this.authorize().then(() => {
                    resolve(true);
                }).catch((err) => {
                    console.error('❌ Erro na autorização:', err);
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
                // Não rejeita aqui se já passou pelo 'open' — o 'close' vai tratar
                reject(err);
            });

            this.ws.on('close', (code, reason) => {
                console.log(`❌ WebSocket fechado: ${code} - ${reason}`);
                clearTimeout(connectionTimeout);
                this.connecting = false;
                this.connected = false;
                this.authorized = false;
                this.stopPing();

                // Rejeita todas as pendentes para não ficarem presas
                this._rejectAllPending('WebSocket fechado inesperadamente');

                this.emit('close', code, reason);
                this._reconnect();
            });
        });
    }

    // ✅ FIX: reconexão infinita com backoff exponencial até 60s (nunca desiste)
    _reconnect() {
        // Backoff exponencial: 1s, 2s, 4s, 8s, 16s, 32s, 60s, 60s, 60s...
        const delay = Math.min(
            this.reconnectDelay * Math.pow(2, this.reconnectAttempts),
            this.maxReconnectDelay
        );
        this.reconnectAttempts++;
        console.log(`🔄 Tentando reconectar em ${delay}ms (tentativa ${this.reconnectAttempts})`);

        setTimeout(() => {
            this.connect().catch(err => {
                console.error('❌ Falha na reconexão:', err.message);
                // _reconnect() será chamado novamente pelo evento 'close'
            });
        }, delay);
    }

    // ✅ FIX: rejeita todos os pedidos pendentes quando o WS fecha
    _rejectAllPending(reason) {
        if (this.pendingRequests.size > 0) {
            console.log(`⚠️ Rejeitando ${this.pendingRequests.size} pedidos pendentes: ${reason}`);
            for (const [id, { reject, timeout }] of this.pendingRequests) {
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
                console.error('❌ Erro autorização:', msg.error);
                this.authorized = false;
            }
            return;
        }

        if (msg.msg_type === 'pong') {
            return;
        }

        // ✅ FIX: distribui ticks para os listeners do getCurrentPrice
        if (msg.msg_type === 'tick' && msg.tick) {
            for (const [, handler] of this._tickListeners) {
                try { handler(msg); } catch (e) { /* ignora erros no handler */ }
            }
            return;
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
                        this.authorized = true;
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
            }, 30000);

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

    // ✅ FIX: addListener e removeListener para ticks (usado por getCurrentPrice no server.js)
    addListener(reqId, handler) {
        this._tickListeners.set(reqId, handler);
    }

    removeListener(reqId, handler) {
        this._tickListeners.delete(reqId);
    }

    // ✅ FIX: getConnectionStatus (chamado em /api/connection-status no server.js)
    getConnectionStatus() {
        const wsStateMap = { 0: 'CONNECTING', 1: 'OPEN', 2: 'CLOSING', 3: 'CLOSED' };
        return {
            status: this.connected && this.authorized ? 'ready' :
                    this.connected ? 'connected_not_authorized' :
                    this.connecting ? 'connecting' : 'disconnected',
            connected: this.connected,
            authorized: this.authorized,
            connecting: this.connecting,
            wsReadyState: this.ws ? wsStateMap[this.ws.readyState] ?? 'UNKNOWN' : 'NO_SOCKET',
            reconnectAttempts: this.reconnectAttempts,
            pendingRequests: this.pendingRequests.size,
            tickListeners: this._tickListeners.size,
            uptime: Math.floor(process.uptime())
        };
    }

    startPing() {
        this.stopPing(); // garante que não há duplicados
        this.pingInterval = setInterval(() => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                const pingReq = { ping: 1, req_id: this.reqId++ };
                this.ws.send(JSON.stringify(pingReq));
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
        this.stopPing();
        this._rejectAllPending('Desconexão manual');
        if (this.ws) {
            this.ws.close();
        }
        this.connected = false;
        this.authorized = false;
    }
}

module.exports = DerivClient;
