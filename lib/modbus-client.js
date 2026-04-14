'use strict';

const net = require('net');

/**
 * Нативный Modbus RTU over TCP клиент (без сторонних зависимостей).
 * Работает с WB-MGE и аналогичными шлюзами на порту 23.
 */
class ModbusClient {
    constructor(options) {
        this.host    = options.host;
        this.port    = options.port || 23;
        this.timeout = options.timeout || 3000;
        this.log     = options.logger || (() => {});

        this._socket     = null;
        this._connected  = false;
        this._connecting = false;
        this._connectQueue = [];

        this._busy     = false;
        this._reqQueue = [];

        this._buf     = Buffer.alloc(0);
        this._pending = null;
    }

    static _crc16(buf) {
        let crc = 0xFFFF;
        for (const b of buf) {
            crc ^= b;
            for (let i = 0; i < 8; i++)
                crc = (crc & 1) ? (crc >>> 1) ^ 0xA001 : crc >>> 1;
        }
        return crc;
    }

    static _makeRequest(slaveId, fc, address, count) {
        const buf = Buffer.from([
            slaveId, fc,
            (address >> 8) & 0xFF, address & 0xFF,
            (count   >> 8) & 0xFF, count   & 0xFF,
        ]);
        const crc = ModbusClient._crc16(buf);
        return Buffer.concat([buf, Buffer.from([crc & 0xFF, crc >> 8])]);
    }



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

            // Таймаут на установку TCP соединения
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
        // Если нет ожидающего запроса — сбрасываем буфер (мусор от предыдущих таймаутов)
        if (!this._pending) {
            this._buf = Buffer.alloc(0);
            return;
        }
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
    
    _request(slaveId, fc, address, count) {
        return new Promise((resolve, reject) => {
            this._reqQueue.push({ slaveId, fc, address, count, resolve, reject });
            this._drainQueue();
        });
    }

    async _drainQueue() {
        if (this._busy || this._reqQueue.length === 0) return;
        this._busy = true;

        const item = this._reqQueue.shift();
        const { slaveId, fc, address, count, resolve, reject } = item;

        // FC06/FC02 передают готовый запрос и ожидаемую длину
        const rawReq      = item._rawReq || ModbusClient._makeRequest(slaveId, fc, address, count);
        const expectedLen = item._expectedLen || (3 + count * 2 + 2);

        const doRequest = async () => {
            return new Promise((res, rej) => {
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
        };

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
                // Кастомный resolve — передаём весь фрейм
                resolve(frame);
            } else if (fc === 0x06) {
                // FC06: ответ — эхо запроса (8 байт), просто подтверждаем успех
                resolve();
            } else {
                const words = [];
                for (let i = 0; i < count; i++)
                    words.push(frame.readUInt16BE(3 + i * 2));
                resolve(words);
            }
        } catch (err) {
            reject(err);
        } finally {
            this._busy = false;
            setImmediate(() => this._drainQueue());
        }
    }

    /**
     * FC01 — Read Coils (1 бит, read/write).
     * Возвращает 0 или 1.
     */
    async readCoil(slaveId, address) {
        const req = ModbusClient._makeRequest(slaveId, 0x01, address, 1);
        return new Promise((resolve, reject) => {
            this._reqQueue.push({
                slaveId, fc: 0x01, address, count: 1,
                _rawReq: req,
                _expectedLen: 6,
                resolve: (frame) => resolve(frame[3] & 0x01),
                reject,
                _customResolve: true,
            });
            this._drainQueue();
        });
    }

    /**
     * FC02 — Read Discrete Inputs (1 бит, read-only).
     * Возвращает 0 или 1.
     */
    async readDiscreteInput(slaveId, address) {
        // FC02: ответ — slave(1) fc(1) byteCount(1) data(N bytes) CRC(2)
        // 1 бит упакован в байт, нам нужен бит 0
        const req = ModbusClient._makeRequest(slaveId, 0x02, address, 1);
        // expectedLen = 3 + 1 + 2 = 6 (1 байт данных)
        return new Promise((resolve, reject) => {
            this._reqQueue.push({
                slaveId, fc: 0x02, address, count: 1,
                _rawReq: req,
                _expectedLen: 6,
                resolve: (frame) => resolve(frame[3] & 0x01),
                reject,
                _customResolve: true,
            });
            this._drainQueue();
        });
    }

    async readHolding(slaveId, address, count = 1) {
        return this._request(slaveId, 0x03, address, count);
    }

    async readInput(slaveId, address, count = 1) {
        return this._request(slaveId, 0x04, address, count);
    }

    async readHoldingU16(slaveId, address) {
        const [val] = await this.readHolding(slaveId, address, 1);
        return val;
    }

    async readInputU16(slaveId, address) {
        const [val] = await this.readInput(slaveId, address, 1);
        return val;
    }

    async readInputS16(slaveId, address) {
        const val = await this.readInputU16(slaveId, address);
        return val >= 0x8000 ? val - 0x10000 : val;
    }

    async readInputS32(slaveId, address) {
        const [hi, lo] = await this.readInput(slaveId, address, 2);
        const u = (hi & 0xFFFF) * 0x10000 + (lo & 0xFFFF);
        return u >= 0x80000000 ? u - 0x100000000 : u;
    }

    /**
     * Читаем 4 последовательных input-регистра как u64 big-endian.
     * Возвращает число (может терять точность для очень больших значений,
     * но для счётчиков энергии в кВт·ч это несущественно).
     */
    async readInputU64(slaveId, address) {
        const [w3, w2, w1, w0] = await this.readInput(slaveId, address, 4);
        // w3 — старший, w0 — младший
        // Используем BigInt для точного вычисления, потом конвертируем в Number
        const val = (BigInt(w3 & 0xFFFF) << 48n) |
                    (BigInt(w2 & 0xFFFF) << 32n) |
                    (BigInt(w1 & 0xFFFF) << 16n) |
                    BigInt(w0 & 0xFFFF);
        return Number(val);
    }

    async readInputBlock(slaveId, startAddress, count) {
        const words = await this.readInput(slaveId, startAddress, count);
        const map = new Map();
        for (let i = 0; i < words.length; i++) map.set(startAddress + i, words[i]);
        return map;
    }

    async writeHolding(slaveId, address, value) {
        // FC06 Write Single Register
        const safeVal = value & 0xFFFF;
        const req = ModbusClient._makeRequest(slaveId, 0x06, address, safeVal);

        return new Promise((resolve, reject) => {
            this._reqQueue.push({
                slaveId, fc: 0x06, address, count: safeVal,
                _rawReq: req,
                _expectedLen: 8,
                resolve: () => resolve(),
                reject,
            });
            this._drainQueue();
        });
    }

    async writeCoil(slaveId, address, value) {
        // FC05 Write Single Coil: value=true → 0xFF00, false → 0x0000
        const coilVal = value ? 0xFF00 : 0x0000;
        const req = ModbusClient._makeRequest(slaveId, 0x05, address, coilVal);
        return new Promise((resolve, reject) => {
            this._reqQueue.push({
                slaveId, fc: 0x05, address, count: coilVal,
                _rawReq: req,
                _expectedLen: 8,
                resolve: () => resolve(),
                reject,
            });
            this._drainQueue();
        });
    }

    async readDeviceSignature(slaveId) {
        // Вариант 1: регистр 200, два символа на регистр (M1W2, MAI6)
        try {
            const words = await this.readHolding(slaveId, 200, 8);
            let str = '';
            for (const w of words) {
                const hi = (w >> 8) & 0xFF;
                const lo = w & 0xFF;
                if (hi === 0) break;
                str += String.fromCharCode(hi);
                if (lo === 0) break;
                str += String.fromCharCode(lo);
            }
            if (str.trim()) return str.trim();
        } catch (_) {}

        // Вариант 2: регистр 0, один символ на регистр в младшем байте (MAP3E)
        try {
            const words = await this.readHolding(slaveId, 0, 12);
            // Пропускаем первые 2 регистра (служебные), читаем с регистра 2
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
            const [hi, lo] = await this.readInput(slaveId, 270, 2);
            return (hi & 0xFFFF) * 0x10000 + (lo & 0xFFFF);
        } catch (_) { return null; }
    }
}

module.exports = ModbusClient;
