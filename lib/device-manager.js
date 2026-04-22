'use strict';

const ModbusClient = require('./modbus-client');

/**
 * DeviceManager  (v2 — иерархическая модель каналов)
 *
 * Работает с шаблонами новой структуры:
 *   template.info          — системные регистры (serial, fwVersion, uptime)
 *   template.channels[]    — каналы { id, name, measurements[], settings[] }
 *
 * Поллинг:
 *   - _fastPollTimer  (fastPollInterval) — sporadic measurements
 *   - _pollTimer      (pollInterval)     — остальные measurements
 *
 * Запись:
 *   writeSettings(deviceId, channelId, settingId, value) → Promise
 *
 * Состояние устройства (DeviceState):
 *   { slaveId, deviceType, name, deviceId, template,
 *     channels,      ← активные каналы (после resolveSettings)
 *     connected, initialized, lastValues, serial, info }
 */
class DeviceManager {
    /**
     * @param {object}   opts
     * @param {string}   opts.host
     * @param {number}   opts.port
     * @param {number}   [opts.pollInterval=10000]
     * @param {number}   [opts.fastPollInterval=500]
     * @param {number}   [opts.requestTimeout=3000]
     * @param {object[]} opts.devices
     *   { slaveId, deviceType, name, deviceId, template }
     * @param {function} opts.onDeviceReady    async (deviceState) → void
     * @param {function} opts.onMeasurement    (deviceId, channelId, measurementId, value) → void
     * @param {function} opts.onConnectionChange (deviceId, connected) → void
     * @param {function} [opts.logger]
     */
    constructor(opts) {
        this.host             = opts.host;
        this.port             = opts.port;
        this.pollInterval     = opts.pollInterval     || 10000;
        this.fastPollInterval = opts.fastPollInterval || 500;

        this.onDeviceReady      = opts.onDeviceReady      || (() => Promise.resolve());
        this.onMeasurement      = opts.onMeasurement      || (() => {});
        this.onConnectionChange = opts.onConnectionChange || (() => {});
        this.log = opts.logger || (() => {});

        // Короткий таймаут для поллинга — не блокируем надолго
        // Для записи используем тот же клиент но с ожиданием окончания поллинга
        this.client = new ModbusClient({
            host:    opts.host,
            port:    opts.port,
            timeout: Math.min(opts.requestTimeout || 3000, 1000),
            logger:  this.log,
        });

        this._devices    = new Map();   // slaveId → DeviceState
        this._pollTimer  = null;
        this._fastTimer  = null;
        this._stopping   = false;
        this._writing    = false;   // флаг записи — поллинг пропускает итерацию
        this._activePoll = false;   // true пока выполняется _pollAll

        for (const cfg of (opts.devices || [])) {
            this._registerDevice(cfg);
        }
    }

    // ─── Публичный API ────────────────────────────────────────────────────────

    async start() {
        this._stopping = false;
        this.log(`DeviceManager: starting (${this.host}:${this.port})`);
        try {
            await this.client.connect();
        } catch (err) {
            this.log(`DeviceManager: initial connect failed (${err.message}), will retry`);
        }

        for (const state of this._devices.values()) {
            await this._initDevice(state);
        }
        this._startPolling();
    }

    async stop() {
        this._stopping = true;
        this._stopPolling();
        await this.client.disconnect();

        this.log('DeviceManager: stopped');
    }

    getDevice(slaveId) { return this._devices.get(slaveId) || null; }
    getAllDevices()     { return Array.from(this._devices.values()); }

    /**
     * Записывает значение setting-параметра в устройство.
     * @param {string} deviceId
     * @param {string} channelId
     * @param {string} settingId
     * @param {number} value
     */
    async writeSetting(deviceId, channelId, settingId, value) {
        const state = this._findByDeviceId(deviceId);
        if (!state) throw new Error(`Device ${deviceId} not found`);

        const ch = state.channels.find(c => c.id === channelId);
        if (!ch) throw new Error(`Channel ${channelId} not found`);

        const setting = ch.settings.find(s => s.id === settingId);
        if (!setting) throw new Error(`Setting ${settingId} not found`);
        if (!setting.write) throw new Error(`Setting ${settingId} is read-only`);

        this._stopPolling();
        this._writing = true;
        if (this.client._reqQueue) {
            this.client._reqQueue.forEach(item => { try { item.reject(new Error('cancelled')); } catch(_) {} });
            this.client._reqQueue = [];
        }
        try {
            if (!this.client.connected) {
                await this.client.connect();
            }
            await _writeSetting(setting, state.slaveId, value, this.client);
        } finally {
            this._writing = false;
            this._startPolling();
        }
        this.log(`Written ${deviceId}/${channelId}/${settingId} = ${value}`);
    }

    /**
     * Записывает значение writable measurement (coil или holding).
     */
    async writeChannel(deviceId, channelId, measurementId, value) {
        const state = this._findByDeviceId(deviceId);
        if (!state) throw new Error(`Device ${deviceId} not found`);

        const ch = state.channels.find(c => c.id === channelId);
        if (!ch) throw new Error(`Channel ${channelId} not found`);

        const m = ch.measurements.find(m => m.id === measurementId);
        if (!m) throw new Error(`Measurement ${measurementId} not found`);
        if (!m.writable) throw new Error(`Measurement ${measurementId} is not writable`);

        // Останавливаем поллинг, очищаем очередь, пишем, возобновляем
        this._stopPolling();
        this._writing = true;
        // Очищаем накопившиеся запросы поллинга из очереди
        // Сбрасываем очередь и переподключаемся для гарантированно чистого соединения
        if (this.client._reqQueue) {
            this.client._reqQueue.forEach(item => { try { item.reject(new Error('cancelled')); } catch(_) {} });
            this.client._reqQueue = [];
        }
        try {
            if (!this.client.connected) {
                await this.client.connect();
            }
            if (m.regType === 'coil') {
                await this.client.writeCoil(state.slaveId, m.address, !!value);
            } else if (m.regType === 'holding') {
                await _writeSetting(m, state.slaveId, value, this.client);
            } else {
                throw new Error(`Cannot write regType ${m.regType}`);
            }
        } finally {
            this._writing = false;
            this._startPolling();
        }
        this.log(`Written channel ${deviceId}/${channelId}/${measurementId} = ${value}`);
    }

    /**
     * Читает все settings устройства с железа.
     * Возвращает { [channelId]: { [settingId]: value } }
     */
    async readAllSettings(deviceId) {
        const state = this._findByDeviceId(deviceId);
        if (!state) throw new Error(`Device ${deviceId} not found`);

        const result = {};
        for (const ch of state.channels) {
            if (!ch.settings.length) continue;
            result[ch.id] = {};
            for (const s of ch.settings) {
                try {
                    const raw = await this.client.readHoldingU16(state.slaveId, s.address);
                    result[ch.id][s.id] = _applyScale(raw, s);
                } catch (_) {}
            }
        }
        return result;
    }

    /**
     * Читает holding-параметры которые влияют на топологию каналов (in1_mode и т.д.)
     * Возвращает плоский объект { [paramId]: numericValue }
     */
    async readFlatConfig(deviceId) {
        const state = this._findByDeviceId(deviceId);
        if (!state) return {};

        const flat = {};
        const seen = new Set();

        // Читаем isConfig-параметры из template.configParams
        for (const s of (state.template.configParams || [])) {
            if (seen.has(s.address)) continue;
            seen.add(s.address);
            try {
                const raw = await this.client.readHoldingU16(state.slaveId, s.address);
                flat[s.id] = raw;
            } catch (_) {}
        }

        return flat;
    }

    // ─── Регистрация ──────────────────────────────────────────────────────────

    _registerDevice(cfg) {
        if (!cfg.template) {
            this.log(`DeviceManager: no template for "${cfg.deviceType}", skipping`);
            return null;
        }

        const state = {
            slaveId:     cfg.slaveId,
            deviceType:  cfg.deviceType,
            name:        cfg.name || `${cfg.deviceType} [${cfg.slaveId}]`,
            deviceId:    cfg.deviceId || `${cfg.deviceType}_${cfg.slaveId}`,
            template:    cfg.template,
            channels:    [],        // будет заполнено после onDeviceReady
            connected:   false,
            initialized: false,
            lastValues:  new Map(), // `${channelId}.${measurementId}` → value
            serial:      null,
            info:        {},        // { serial, fwVersion, uptime, ... }
        };

        this._devices.set(cfg.slaveId, state);
        return state;
    }

    // ─── Инициализация устройства ─────────────────────────────────────────────

    async _initDevice(state) {
        this.log(`Initializing ${state.name} (slaveId=${state.slaveId})`);

        let connected = false;

        // Читаем системную информацию (serial обязателен для проверки связи)
        const infoDesc = state.template.info || {};
        const serialDesc = infoDesc.serial;

        if (serialDesc) {
            try {
                const words = await this.client.readInput(state.slaveId, serialDesc.address, serialDesc.count || 2);
                const serial = (words[0] & 0xFFFF) * 0x10000 + (words[1] & 0xFFFF);
                state.serial = serial;
                state.info.serial = serial;
                connected = true;
                this.log(`  ${state.name}: reachable, serial=${serial}`);
            } catch (err) {
                this.log(`  ${state.name}: not reachable (${err.message})`);
            }
        }

        // Читаем остальные info-поля (fwVersion, uptime) — некритично
        if (connected) {
            for (const [key, desc] of Object.entries(infoDesc)) {
                if (key === 'serial') continue;
                try {
                    const val = await _readInfoField(desc, state.slaveId, this.client);
                    if (val !== null) state.info[key] = val;
                } catch (_) {}
            }
        }

        state.initialized = true;

        // Отдаём управление внешнему коду: он создаёт объекты ioBroker
        // и устанавливает state.channels через updateChannels()
        try {
            await this.onDeviceReady(state);
        } catch (err) {
            this.log(`onDeviceReady error for ${state.name}: ${err.message}`);
        }

        this._setConnected(state, connected);

        if (connected && state.channels.length > 0) {
            await this._pollDevice(state, false);
        }
    }

    /**
     * Обновляет активные каналы устройства (вызывается из main.js после applyConfig).
     * channels — массив { id, name, measurements[], settings[] }
     */
    updateChannels(deviceId, channels) {
        const state = this._findByDeviceId(deviceId);
        if (!state) return;
        state.channels = channels;
        state.lastValues.clear();
    }

    // ─── Поллинг ──────────────────────────────────────────────────────────────

    _startPolling() {
        this._pollTimer = setInterval(() => {
            if (!this._stopping) this._pollAll(false).catch(() => {});
        }, this.pollInterval);

        this._fastTimer = setInterval(() => {
            if (!this._stopping) this._pollAll(true).catch(() => {});
        }, this.fastPollInterval);
    }

    _stopPolling() {
        clearInterval(this._pollTimer); this._pollTimer = null;
        clearInterval(this._fastTimer); this._fastTimer = null;
    }

    async _pollAll(fastOnly) {
        if (this._writing) return;  // пропускаем тик пока идёт запись
        this._activePoll = true;
        try {
            for (const state of this._devices.values()) {
                if (this._stopping || this._writing) break;
                await this._pollDevice(state, fastOnly);
            }
        } finally {
            this._activePoll = false;
        }
    }

    async _pollDevice(state, fastOnly) {
        let anyOk = false;

        // Heartbeat: при медленном поллинге всегда читаем serial
        // чтобы connection работал даже если каналов нет
        if (!fastOnly && !this._writing) {
            const serialDesc = state.template.info && state.template.info.serial;
            if (serialDesc) {
                try {
                    await this.client.readInput(state.slaveId, serialDesc.address, serialDesc.count || 2);
                    anyOk = true;
                } catch (_) {}
            }
        }

        for (const ch of state.channels) {
            if (this._stopping) break;

            for (const m of ch.measurements) {
                if (this._writing) break;  // прерываем поллинг при запросе записи
                if (fastOnly && !m.sporadic) continue;
                if (!fastOnly && m.sporadic) continue;

                try {
                    const result = await _readMeasurement(m, state.slaveId, this.client);
                    if (result === null) continue;

                    anyOk = true;
                    const key = `${ch.id}.${m.id}`;
                    const prev = state.lastValues.get(key);

                    if (result.error) {
                        if (prev !== null && prev !== undefined) {
                            state.lastValues.set(key, null);
                            this.onMeasurement(state.deviceId, ch.id, m.id, null);
                        }
                        continue;
                    }

                    if (m.sporadic && prev === result.value) continue;

                    state.lastValues.set(key, result.value);
                    this.onMeasurement(state.deviceId, ch.id, m.id, result.value);

                } catch (err) {
                    this.log(`Poll ${state.name}/${ch.id}/${m.id}: ${err.message}`);
                }
            }
        }

        if (!fastOnly) this._setConnected(state, anyOk);
    }

    _setConnected(state, connected) {
        if (state.connected !== connected) {
            state.connected = connected;
            this.onConnectionChange(state.deviceId, connected);
        }
    }

    _findByDeviceId(deviceId) {
        for (const s of this._devices.values()) {
            if (s.deviceId === deviceId) return s;
        }
        return null;
    }
}

// ─── Чтение measurement ───────────────────────────────────────────────────────

async function _readMeasurement(m, slaveId, client) {
    // discrete — читаем как boolean
    if (m.regType === 'discrete') {
        try {
            const raw = await client.readDiscreteInput(slaveId, m.address);
            return { value: raw !== 0 };
        } catch (_) {
            return null;
        }
    }

    // coil — читаем и пишем как boolean
    if (m.regType === 'coil') {
        try {
            const raw = await client.readCoil(slaveId, m.address);
            return { value: raw !== 0 };
        } catch (_) {
            return null;
        }
    }

    if (m.regType !== 'input' && m.regType !== 'holding') return null;

    let raw;
    try {
        raw = await _readFormatted(m, slaveId, client);
    } catch (_) {
        return null;
    }

    if (raw === null) return null;

    if (m.errorValue !== null && m.errorValue !== undefined && raw === m.errorValue) {
        return { value: null, error: true };
    }

    let value;
    if (m.format === 'bool') {
        value = raw !== 0;
    } else {
        value = raw * (m.scale || 1) + (m.offset || 0);
        if (m.roundTo) value = Math.round(value / m.roundTo) * m.roundTo;
        value = Math.round(value * 1e9) / 1e9;
    }

    return { value };
}

async function _readInfoField(desc, slaveId, client) {
    try {
        const raw = await _readFormatted(desc, slaveId, client);
        if (raw === null) return null;
        const scale = desc.scale || 1;
        const offset = desc.offset || 0;
        return typeof raw === 'string' ? raw : raw * scale + offset;
    } catch (_) {
        return null;
    }
}

async function _readFormatted(desc, slaveId, client) {
    const addr = desc.address;
    const read = desc.regType === 'holding'
        ? (a, c) => client.readHolding(slaveId, a, c)
        : (a, c) => client.readInput(slaveId, a, c);

    switch (desc.format) {
        case 'bool':
        case 'u16': {
            const [w] = await read(addr, 1);
            return w & 0xFFFF;
        }
        case 's16': {
            const [w] = await read(addr, 1);
            const v = w & 0xFFFF;
            return v >= 0x8000 ? v - 0x10000 : v;
        }
        case 'u32': {
            const [hi, lo] = await read(addr, 2);
            if (desc.wordOrder === 'le') return (lo & 0xFFFF) * 0x10000 + (hi & 0xFFFF);
            return (hi & 0xFFFF) * 0x10000 + (lo & 0xFFFF);
        }
        case 's32': {
            const words = await read(addr, 2);
            const [hi, lo] = desc.wordOrder === 'le' ? [words[1], words[0]] : words;
            const u = (hi & 0xFFFF) * 0x10000 + (lo & 0xFFFF);
            return u >= 0x80000000 ? u - 0x100000000 : u;
        }
        case 'u64': {
            const words = await read(addr, 4);
            const [w3, w2, w1, w0] = desc.wordOrder === 'le'
                ? [words[3], words[2], words[1], words[0]] : words;
            const val = (BigInt(w3 & 0xFFFF) << 48n) | (BigInt(w2 & 0xFFFF) << 32n)
                      | (BigInt(w1 & 0xFFFF) << 16n) |  BigInt(w0 & 0xFFFF);
            return Number(val);
        }
        case 's64': {
            const words = await read(addr, 4);
            const [w3, w2, w1, w0] = desc.wordOrder === 'le'
                ? [words[3], words[2], words[1], words[0]] : words;
            const val = (BigInt(w3 & 0xFFFF) << 48n) | (BigInt(w2 & 0xFFFF) << 32n)
                      | (BigInt(w1 & 0xFFFF) << 16n) |  BigInt(w0 & 0xFFFF);
            return Number(val >= 0x8000000000000000n ? val - 0x10000000000000000n : val);
        }
        case 'float': {
            const w = await read(addr, 2);
            const [hi, lo] = desc.wordOrder === 'le' ? [w[1], w[0]] : w;
            const buf = Buffer.allocUnsafe(4);
            buf.writeUInt16BE(hi & 0xFFFF, 0);
            buf.writeUInt16BE(lo & 0xFFFF, 2);
            return buf.readFloatBE(0);
        }
        case 'string': {
            const words = await read(addr, desc.count || 1);
            let str = '';
            for (const w of words) {
                const hi = (w >> 8) & 0xFF, lo = w & 0xFF;
                if (!hi) break; str += String.fromCharCode(hi);
                if (!lo) break; str += String.fromCharCode(lo);
            }
            return str.trim();
        }
        default:
            return null;
    }
}

// ─── Запись setting ───────────────────────────────────────────────────────────

async function _writeSetting(setting, slaveId, value, client) {
    let raw = typeof value === 'number' ? Math.round(value / (setting.scale || 1)) : Math.round(value);
    if (raw < 0) raw = raw + 0x10000;
    await client.writeHolding(slaveId, setting.address, raw & 0xFFFF);
}

function _applyScale(raw, setting) {
    return raw * (setting.scale || 1) + (setting.offset || 0);
}

module.exports = DeviceManager;