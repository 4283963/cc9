export class WSMessageGateway {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.connected = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.reconnectDelay = 1000;

    this.handlers = new Map();
    this.queue = [];

    this.onConnect = null;
    this.onDisconnect = null;
    this.onError = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.url);

        this.ws.onopen = () => {
          console.log('[WS] Connected to server');
          this.connected = true;
          this.reconnectAttempts = 0;

          while (this.queue.length > 0) {
            const msg = this.queue.shift();
            this.send(msg.type, msg.payload);
          }

          if (this.onConnect) this.onConnect();
          resolve();
        };

        this.ws.onclose = (event) => {
          console.log('[WS] Connection closed:', event.code, event.reason);
          this.connected = false;

          if (this.onDisconnect) this.onDisconnect(event);

          if (!event.wasClean && this.reconnectAttempts < this.maxReconnectAttempts) {
            this.scheduleReconnect();
          }
        };

        this.ws.onerror = (error) => {
          console.error('[WS] Error:', error);
          if (this.onError) this.onError(error);
          reject(error);
        };

        this.ws.onmessage = (event) => {
          try {
            const message = JSON.parse(event.data);
            this.dispatchMessage(message);
          } catch (e) {
            console.error('[WS] Failed to parse message:', e);
          }
        };

      } catch (e) {
        console.error('[WS] Failed to create WebSocket:', e);
        reject(e);
      }
    });
  }

  scheduleReconnect() {
    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(1.5, this.reconnectAttempts - 1);

    console.log(`[WS] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

    setTimeout(() => {
      this.connect().catch(() => {
      });
    }, delay);
  }

  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }

  send(type, payload) {
    const message = { type, payload };

    if (!this.connected) {
      this.queue.push(message);
      return false;
    }

    try {
      this.ws.send(JSON.stringify(message));
      return true;
    } catch (e) {
      console.error('[WS] Failed to send message:', e);
      this.queue.push(message);
      return false;
    }
  }

  on(type, handler) {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, []);
    }
    this.handlers.get(type).push(handler);

    return () => this.off(type, handler);
  }

  off(type, handler) {
    const handlers = this.handlers.get(type);
    if (handlers) {
      const index = handlers.indexOf(handler);
      if (index > -1) {
        handlers.splice(index, 1);
      }
    }
  }

  dispatchMessage(message) {
    const { type, payload } = message;

    const handlers = this.handlers.get(type);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(payload, message);
        } catch (e) {
          console.error(`[WS] Handler error for type ${type}:`, e);
        }
      }
    }

    const wildcardHandlers = this.handlers.get('*');
    if (wildcardHandlers) {
      for (const handler of wildcardHandlers) {
        try {
          handler(message);
        } catch (e) {
          console.error('[WS] Wildcard handler error:', e);
        }
      }
    }
  }

  sendControl(action, data = {}) {
    return this.send('control', { action, ...data });
  }

  setChuteStatus(chuteId, status) {
    return this.sendControl('set_chute_status', {
      chute_id: chuteId,
      status: status
    });
  }

  setConveyorSpeed(speed) {
    return this.sendControl('set_speed', { speed });
  }

  isConnected() {
    return this.connected;
  }
}
