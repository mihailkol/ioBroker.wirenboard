'use strict';

const net = require('net');

/**
 * Приоритеты запросов:
 *   P0  WRITE   — команды записи (coil, holding): вытесняет поллинг
 *   P1  FAST    — дискретные входы, кнопки, coil-чтение (~100-200 мс)
 *   P2  SLOW    — аналог, счётчики, температура (~5-10 с)
 *   P3  SYSTEM  — серийник, FW — только при старте
 *   P4  SETTING — holding-настройки — по запросу из UI
 *
 * Принцип вытеснения:
 *   _drain() всегда берёт элемент из бакета с наименьшим индексом.
 *   Поэтому как только P0 попадает в очередь — он будет следующим
 *   после завершения текущего запроса (прерывать RTU-фрейм нельзя).
 *
 *   Поллинг при этом НЕ останавливается — он просто ждёт в очереди.
 *   Это устраняет гонку между _stopPolling/_startPolling и записью.
 */
const P = { WRITE: 0, FAST: 1, SLOW: 2, SYSTEM: 3, SETTING: 4 };

class ModbusClient {
    constructor(options) {
        this.host    = options.host;
        this.port    = options.port || 23;
        this.timeout = options.timeout || 3000;
        this.log     = options.logger || (() => {});

        this._socket       = null;
        this._connected    = false;
        this._connecting   = false;
        this._connectQueue = [];

        // Пять бакетов: индекс = приоритет (0 = самый высокий)
        this._queues = [[], [], [], [], []];
        this._busy   = false;

        this._buf     = Buffer.alloc(0);
        this._pending = null;
    }

    // ─── Подключение ───────────────────────────────────────────────────────────

    connect() {
        if (this._connected) return Promise.resolve();
        if (this._connecting) {
            return new Promise((resolve, reject) =>
                this._connectQueue.push({ resolve, reject })
            );
        }
        this._connecting = true;
        this.log(`Connecting to ${this.host}:${this.port}...`);

        return new Promise((resolve, reject) => {
            const sock = net.connect({ host: this.host, port: this.port });

            const connectTimer = setTimeout(() => {
                sock.destroy();
                onError(new Error(`Connection timeout to ${this.host}:${this.port}`));
            }, this.timeout);

            const onError = (err) => {
                clearTimeout(connectTimer);
                this._connecting = false;
                this._socket = null;
                this._connectQueue.forEach(p => p.reject(err));
                this._connectQueue = [];
                reject(err);
            };

            sock.once('error', onError);
            sock.once('connect', () => {
                clearTimeout(connectTimer);
                sock.removeListener('error', onError);
                sock.on('error', (err) => this._onSocketError(err));
                sock.on('close', ()    => this._onSocketClose());
                sock.on('data',  (d)   => this._onData(d));

                this._socket     = sock;
                this._connected  = true;
                this._connecting = false;
                this._buf        = Buffer.alloc(0);
                this.log(`Connected to ${this.host}:${this.port}`);

                this._connectQueue.forEach(p => p.resolve());
                this._connectQueue = [];
                resolve();
            });
        });
    }

    async disconnect() {
        if (this._socket) { this._socket.destroy(); this._socket = null; }
        this._connected = false;
        this.log(`Disconnected from ${this.host}:${this.port}`);
    }

    get connected() { return this._connected; }

    // ─── Socket-события ────────────────────────────────────────────────────────

    _onSocketError(err) {
        this.log(`Socket error: ${err.message}`);
        this._failPending(err);
    }

    _onSocketClose() {
        this._connected = false;
        this._socket    = null;
        this.log(`Socket closed`);
        this._failPending(new Error('Connection closed'));
    }

    _failPending(err) {
        if (this._pending) {
            clearTimeout(this._pending.timer);
            this._pending.reject(err);
            this._pending = null;
        }
    }

    _onData(chunk) {
        if (!this._pending) { this._buf = Buffer.alloc(0); return; }
        this._buf = Buffer.concat([this._buf, chunk]);
        if (this._buf.length >= this._pending.expectedLen) {
            const frame = this._buf.slice(0, this._pending.expectedLen);
            this._buf   = this._buf.slice(this._pending.expectedLen);
            clearTimeout(this._pending.timer);
            const { resolve } = this._pending;
            this._pending = null;
            resolve(frame);
        }
    }

    // ─── Приоритетная очередь ─────────────────────────────────────────────────

    /**
     * Добавляет задачу в бакет priority и запускает drain.
     * Возвращает Promise.
     */
    _enqueue(priority, item) {
        return new Promise((resolve, reject) => {
            const p = Math.min(Math.max(priority | 0, 0), 4);
            this._queues[p].push({ ...item, resolve, reject });
            this._drain();
        });
    }

    /** Извлекает следующий элемент из очереди по приоритету. */
    _dequeue() {
        for (const q of this._queues) {
            if (q.length > 0) return q.shift();
        }
        return null;
    }

    async _drain() {
        if (this._busy) return;
        this._busy = true;

        while (true) {
            const item = this._dequeue();
            if (!item) break;

            const { slaveId, fc, resolve, reject } = item;
            const rawReq      = item._rawReq      || _makeRequest(slaveId, fc, item.address, item.count);
            const expectedLen = item._expectedLen || (3 + item.count * 2 + 2);

            const doRequest = () => new Promise((res, rej) => {
                this._pending = {
                    resolve: res, reject: rej, expectedLen,
                    timer: setTimeout(() => {
                        this._pending = null;
                        this._buf = Buffer.alloc(0);
                        rej(new Error('Timed out'));
                    }, this.timeout),
                };
                this._socket.write(rawReq);
            });

            try {
                if (!this._connected) await this.connect();

                let frame;
                try {
                    frame = await doRequest();
                } catch (err) {
                    this._connected = false;
                    if (this._socket) { this._socket.destroy(); this._socket = null; }
                    this._buf = Buffer.alloc(0);
                    this.log(`Reconnecting after: ${err.message}`);
                    await this.connect();
                    frame = await doRequest();
                }

                if (item._customResolve) {
                    resolve(frame);
                } else if (fc === 0x05 || fc === 0x06) {
                    resolve();
                } else {
                    const words = [];
                    for (let i = 0; i < item.count; i++)
                        words.push(frame.readUInt16BE(3 + i * 2));
                    resolve(words);
                }
            } catch (err) {
                reject(err);
            }

            // Межкадровый интервал RTU
            await _sleep(5);
        }

        this._busy = false;
    }

    // ─── Read API ──────────────────────────────────────────────────────────────

    /** FC01 — Read Coils. */
    readCoil(slaveId, address, priority = P.FAST) {
        const req = _makeRequest(slaveId, 0x01, address, 1);
        return this._enqueue(priority, {
            slaveId, fc: 0x01, address, count: 1,
            _rawReq: req, _expectedLen: 6, _customResolve: true,
        }).then(frame => frame[3] & 0x01);
    }

    /** FC02 — Read Discrete Inputs. */
    readDiscreteInput(slaveId, address, priority = P.FAST) {
        const req = _makeRequest(slaveId, 0x02, address, 1);
        return this._enqueue(priority, {
            slaveId, fc: 0x02, address, count: 1,
            _rawReq: req, _expectedLen: 6, _customResolve: true,
        }).then(frame => frame[3] & 0x01);
    }

    /** FC03 — Read Holding Registers. */
    readHolding(slaveId, address, count = 1, priority = P.SLOW) {
        return this._enqueue(priority, { slaveId, fc: 0x03, address, count });
    }

    /** FC04 — Read Input Registers. */
    readInput(slaveId, address, count = 1, priority = P.SLOW) {
        return this._enqueue(priority, { slaveId, fc: 0x04, address, count });
    }

    // Удобные обёртки
    async readHoldingU16(slaveId, address, priority = P.SLOW) {
        const [v] = await this.readHolding(slaveId, address, 1, priority);
        return v;
    }
    async readInputU16(slaveId, address, priority = P.SLOW) {
        const [v] = await this.readInput(slaveId, address, 1, priority);
        return v;
    }
    async readInputS16(slaveId, address, priority = P.SLOW) {
        const v = await this.readInputU16(slaveId, address, priority);
        return v >= 0x8000 ? v - 0x10000 : v;
    }
    async readInputS32(slaveId, address, priority = P.SLOW) {
        const [hi, lo] = await this.readInput(slaveId, address, 2, priority);
        const u = (hi & 0xFFFF) * 0x10000 + (lo & 0xFFFF);
        return u >= 0x80000000 ? u - 0x100000000 : u;
    }
    async readInputU64(slaveId, address, priority = P.SLOW) {
        const [w3, w2, w1, w0] = await this.readInput(slaveId, address, 4, priority);
        const val = (BigInt(w3 & 0xFFFF) << 48n) | (BigInt(w2 & 0xFFFF) << 32n)
                  | (BigInt(w1 & 0xFFFF) << 16n) |  BigInt(w0 & 0xFFFF);
        return Number(val);
    }
    async readInputBlock(slaveId, startAddress, count, priority = P.SLOW) {
        const words = await this.readInput(slaveId, startAddress, count, priority);
        const map = new Map();
        for (let i = 0; i < words.length; i++) map.set(startAddress + i, words[i]);
        return map;
    }

    // ─── Write API — всегда P0 ─────────────────────────────────────────────────

    /** FC05 — Write Single Coil. P0. */
    writeCoil(slaveId, address, value) {
        const coilVal = value ? 0xFF00 : 0x0000;
        const req = _makeRequest(slaveId, 0x05, address, coilVal);
        return this._enqueue(P.WRITE, {
            slaveId, fc: 0x05, address, count: coilVal,
            _rawReq: req, _expectedLen: 8,
        });
    }

    /** FC06 — Write Single Register. P0. */
    writeHolding(slaveId, address, value) {
        const safeVal = value & 0xFFFF;
        const req = _makeRequest(slaveId, 0x06, address, safeVal);
        return this._enqueue(P.WRITE, {
            slaveId, fc: 0x06, address, count: safeVal,
            _rawReq: req, _expectedLen: 8,
        });
    }

    // ─── Системные методы ──────────────────────────────────────────────────────

    async readDeviceSignature(slaveId) {
        // Вариант 1: holding 200, два символа на регистр (M1W2, MAI6)
        try {
            const words = await this.readHolding(slaveId, 200, 8, P.SYSTEM);
            let str = '';
            for (const w of words) {
                const hi = (w >> 8) & 0xFF, lo = w & 0xFF;
                if (hi === 0) break; str += String.fromCharCode(hi);
                if (lo === 0) break; str += String.fromCharCode(lo);
            }
            if (str.trim()) return str.trim();
        } catch (_) {}

        // Вариант 2: holding 0, один символ в младшем байте (MAP3E)
        try {
            const words = await this.readHolding(slaveId, 0, 12, P.SYSTEM);
            let str = '';
            for (let i = 2; i < words.length; i++) {
                const lo = words[i] & 0xFF;
                if (!lo) break;
                str += String.fromCharCode(lo);
            }
            if (str.trim()) return str.trim();
        } catch (_) {}

        return null;
    }

    async readSerial(slaveId) {
        try {
            const [hi, lo] = await this.readInput(slaveId, 270, 2, P.SYSTEM);
            return (hi & 0xFFFF) * 0x10000 + (lo & 0xFFFF);
        } catch (_) { return null; }
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _makeRequest(slaveId, fc, address, count) {
    const buf = Buffer.from([
        slaveId, fc,
        (address >> 8) & 0xFF, address & 0xFF,
        (count   >> 8) & 0xFF, count   & 0xFF,
    ]);
    const crc = _crc16(buf);
    return Buffer.concat([buf, Buffer.from([crc & 0xFF, crc >> 8])]);
}

function _crc16(buf) {
    let crc = 0xFFFF;
    for (const b of buf) {
        crc ^= b;
        for (let i = 0; i < 8; i++)
            crc = (crc & 1) ? (crc >>> 1) ^ 0xA001 : crc >>> 1;
    }
    return crc;
}

function _sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

module.exports = ModbusClient;
module.exports.PRIORITY = P;