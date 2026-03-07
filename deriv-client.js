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
        this.maxReconnectAttempts = 10;
        this.reconnectDelay = 1000;
        this.connecting = false;
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
                this.reconnectAttempts = 0;
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
                console.error('💥 WebSocket erro:', err);
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
                this.emit('close', code, reason);
                this._reconnect();
            });
        });
    }

    _reconnect() {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.error('🚫 Máximo de tentativas de reconexão atingido');
            return;
        }
        const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts);
        this.reconnectAttempts++;
        console.log(`🔄 Tentando reconectar em ${delay}ms (tentativa ${this.reconnectAttempts})`);
        setTimeout(() => {
            this.connect().catch(err => {
                console.error('❌ Falha na reconexão:', err.message);
            });
        }, delay);
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
            }, 30000); // ⬅️ AUMENTADO PARA 30 SEGUNDOS
            
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
            
            // ✅ MODIFICADO: extrair msg.candles ao invés de retornar a mensagem completa
            this.pendingRequests.set(reqId, { 
                resolve: (msg) => {
                    if (msg.error) {
                        reject(new Error(msg.error.message));
                    } else if (msg.candles && Array.isArray(msg.candles)) {
                        // ✅ Retorna APENAS o array de candles
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

    startPing() {
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
        if (this.ws) {
            this.ws.close();
        }
        this.connected = false;
        this.authorized = false;
    }
}

module.exports = DerivClient;
