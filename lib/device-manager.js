'use strict';

const ModbusClient = require('./modbus-client');
const { PRIORITY: P } = require('./modbus-client');

/**
 * DeviceManager — управляет поллингом и записью для одного TCP-шлюза.
 *
 * Ключевые изменения:
 *   1. writeChannel / writeSetting / writeConfigParam НЕ останавливают поллинг.
 *      Запись ставится в P0 в ModbusClient — выполнится сразу после
 *      завершения текущего RTU-фрейма. Поллинг ждёт в очереди.
 *   2. Поллинг передаёт приоритет в каждый запрос:
 *      sporadic (fast) → P.FAST, остальные → P.SLOW, системные → P.SYSTEM.
 *   3. Убран флаг _writing и вся логика stop/start вокруг записи.
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
     * @param {function} opts.onDeviceReady
     * @param {function} opts.onMeasurement
     * @param {function} opts.onConnectionChange
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

        this.client = new ModbusClient({
            host:    opts.host,
            port:    opts.port,
            timeout: Math.min(opts.requestTimeout || 3000, 1000),
            logger:  this.log,
        });

        this._devices   = new Map();
        this._pollTimer = null;
        this._fastTimer = null;
        this._stopping  = false;

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
     * Записывает writable measurement (coil / holding). P0.
     * Поллинг не останавливается — просто ждёт в очереди.
     */
    async writeChannel(deviceId, channelId, measurementId, value) {
        const { state, ch, m } = this._resolveWritable(deviceId, channelId, measurementId);
        if (!m.writable) throw new Error(`Measurement ${measurementId} is not writable`);

        if (!this.client.connected) await this.client.connect();

        if (m.regType === 'coil') {
            await this.client.writeCoil(state.slaveId, m.address, !!value);
        } else if (m.regType === 'holding') {
            await this.client.writeHolding(state.slaveId, m.address, _toRaw(value, m));
        } else {
            throw new Error(`Cannot write regType ${m.regType}`);
        }

        this.log(`Written channel ${deviceId}/${channelId}/${measurementId} = ${value}`);
    }

    /**
     * Записывает setting-параметр (holding). P0.
     */
    async writeSetting(deviceId, channelId, settingId, value) {
        const state = this._findByDeviceId(deviceId);
        if (!state) throw new Error(`Device ${deviceId} not found`);

        const ch = state.channels.find(c => c.id === channelId);
        if (!ch) throw new Error(`Channel ${channelId} not found`);

        const setting = ch.settings.find(s => s.id === settingId);
        if (!setting) throw new Error(`Setting ${settingId} not found`);
        if (!setting.write) throw new Error(`Setting ${settingId} is read-only`);

        if (!this.client.connected) await this.client.connect();
        await this.client.writeHolding(state.slaveId, setting.address, _toRaw(value, setting));
        this.log(`Written ${deviceId}/${channelId}/${settingId} = ${value}`);
    }

    /**
     * Записывает configParam (holding). P0.
     */
    async writeConfigParam(deviceId, paramId, address, value) {
        const state = this._findByDeviceId(deviceId);
        if (!state) throw new Error(`Device ${deviceId} not found`);
        if (!this.client.connected) await this.client.connect();
        await this.client.writeHolding(state.slaveId, address, value & 0xFFFF);
    }

    /**
     * Читает все settings с железа. P.SETTING — низкий приоритет.
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
                    const raw = await this.client.readHoldingU16(state.slaveId, s.address, P.SETTING);
                    result[ch.id][s.id] = _applyScale(raw, s);
                } catch (_) {}
            }
        }
        return result;
    }

    /**
     * Читает holding-параметры топологии каналов (in1_mode и т.д.). P.SETTING.
     */
    async readFlatConfig(deviceId) {
        const state = this._findByDeviceId(deviceId);
        if (!state) return {};

        const flat = {};
        const seen = new Set();
        for (const s of (state.template.configParams || [])) {
            if (seen.has(s.address)) continue;
            seen.add(s.address);
            try {
                const raw = await this.client.readHoldingU16(state.slaveId, s.address, P.SETTING);
                flat[s.id] = raw;
            } catch (_) {}
        }
        return flat;
    }

    /**
     * Обновляет активные каналы (вызывается из main.js после applyConfig).
     */
    updateChannels(deviceId, channels) {
        const state = this._findByDeviceId(deviceId);
        if (!state) return;
        state.channels = channels;
        state.lastValues.clear();
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
            channels:    [],
            connected:   false,
            initialized: false,
            lastValues:  new Map(),
            serial:      null,
            info:        {},
        };
        this._devices.set(cfg.slaveId, state);
        return state;
    }

    // ─── Инициализация ────────────────────────────────────────────────────────

    async _initDevice(state) {
        this.log(`Initializing ${state.name} (slaveId=${state.slaveId})`);

        let connected = false;
        const infoDesc   = state.template.info || {};
        const serialDesc = infoDesc.serial;

        if (serialDesc) {
            try {
                const words = await this.client.readInput(
                    state.slaveId, serialDesc.address, serialDesc.count || 2, P.SYSTEM
                );
                const serial = (words[0] & 0xFFFF) * 0x10000 + (words[1] & 0xFFFF);
                state.serial = serial;
                state.info.serial = serial;
                connected = true;
                this.log(`  ${state.name}: reachable, serial=${serial}`);
            } catch (err) {
                this.log(`  ${state.name}: not reachable (${err.message})`);
            }
        }

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

    // ─── Поллинг ──────────────────────────────────────────────────────────────

    _startPolling() {
        if (this._pollTimer) return;
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
        for (const state of this._devices.values()) {
            if (this._stopping) break;
            await this._pollDevice(state, fastOnly);
        }
    }

    async _pollDevice(state, fastOnly) {
        let anyOk = false;

        // Heartbeat при медленном цикле
        if (!fastOnly) {
            const serialDesc = state.template.info && state.template.info.serial;
            if (serialDesc) {
                try {
                    await this.client.readInput(
                        state.slaveId, serialDesc.address, serialDesc.count || 2, P.SYSTEM
                    );
                    anyOk = true;
                } catch (_) {}
            }
        }

        for (const ch of state.channels) {
            if (this._stopping) break;

            for (const m of ch.measurements) {
                if (fastOnly  && !m.sporadic) continue;
                if (!fastOnly &&  m.sporadic) continue;

                const priority = m.sporadic ? P.FAST : P.SLOW;

                try {
                    const result = await _readMeasurement(m, state.slaveId, this.client, priority);
                    if (result === null) continue;

                    anyOk = true;
                    const key  = `${ch.id}.${m.id}`;
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

    _resolveWritable(deviceId, channelId, measurementId) {
        const state = this._findByDeviceId(deviceId);
        if (!state) throw new Error(`Device ${deviceId} not found`);
        const ch = state.channels.find(c => c.id === channelId);
        if (!ch) throw new Error(`Channel ${channelId} not found`);
        const m = ch.measurements.find(m => m.id === measurementId);
        if (!m) throw new Error(`Measurement ${measurementId} not found`);
        return { state, ch, m };
    }
}

// ─── Чтение measurement ───────────────────────────────────────────────────────

async function _readMeasurement(m, slaveId, client, priority) {
    if (m.regType === 'discrete') {
        try {
            return { value: (await client.readDiscreteInput(slaveId, m.address, priority)) !== 0 };
        } catch (_) { return null; }
    }

    if (m.regType === 'coil') {
        try {
            return { value: (await client.readCoil(slaveId, m.address, priority)) !== 0 };
        } catch (_) { return null; }
    }

    if (m.regType !== 'input' && m.regType !== 'holding') return null;

    let raw;
    try {
        raw = await _readFormatted(m, slaveId, client, priority);
    } catch (_) { return null; }
    if (raw === null) return null;

    if (m.errorValue !== null && m.errorValue !== undefined && raw === m.errorValue) {
        return { value: null, error: true };
    }

    let value;
    if (m.format === 'bool') {
        value = raw !== 0;
    } else if (typeof raw === 'string') {
        value = raw;
    } else {
        value = raw * (m.scale || 1) + (m.offset || 0);
        if (m.roundTo) value = Math.round(value / m.roundTo) * m.roundTo;
        value = Math.round(value * 1e9) / 1e9;
    }
    return { value };
}

async function _readInfoField(desc, slaveId, client) {
    try {
        const raw = await _readFormatted(desc, slaveId, client, P.SYSTEM);
        if (raw === null) return null;
        return typeof raw === 'string' ? raw : raw * (desc.scale || 1) + (desc.offset || 0);
    } catch (_) { return null; }
}

async function _readFormatted(desc, slaveId, client, priority) {
    const addr = desc.address;
    const read = desc.regType === 'holding'
        ? (a, c) => client.readHolding(slaveId, a, c, priority)
        : (a, c) => client.readInput(slaveId, a, c, priority);

    switch (desc.format) {
        case 'bool':
        case 'u16': { const [w] = await read(addr, 1); return w & 0xFFFF; }
        case 's16': { const [w] = await read(addr, 1); const v = w & 0xFFFF; return v >= 0x8000 ? v - 0x10000 : v; }
        case 'u32': {
            const [hi, lo] = await read(addr, 2);
            return desc.wordOrder === 'le'
                ? (lo & 0xFFFF) * 0x10000 + (hi & 0xFFFF)
                : (hi & 0xFFFF) * 0x10000 + (lo & 0xFFFF);
        }
        case 's32': {
            const words = await read(addr, 2);
            const [hi, lo] = desc.wordOrder === 'le' ? [words[1], words[0]] : words;
            const u = (hi & 0xFFFF) * 0x10000 + (lo & 0xFFFF);
            return u >= 0x80000000 ? u - 0x100000000 : u;
        }
        case 'u64': {
            const words = await read(addr, 4);
            const [w3,w2,w1,w0] = desc.wordOrder === 'le' ? words.reverse() : words;
            const val = (BigInt(w3&0xFFFF)<<48n)|(BigInt(w2&0xFFFF)<<32n)|(BigInt(w1&0xFFFF)<<16n)|BigInt(w0&0xFFFF);
            return Number(val);
        }
        case 'float': {
            const w = await read(addr, 2);
            const [hi, lo] = desc.wordOrder === 'le' ? [w[1], w[0]] : w;
            const buf = Buffer.allocUnsafe(4);
            buf.writeUInt16BE(hi & 0xFFFF, 0); buf.writeUInt16BE(lo & 0xFFFF, 2);
            return buf.readFloatBE(0);
        }
        case 'string': {
            const words = await read(addr, desc.count || 1);
            let str = '';
            for (const w of words) {
                const hi = (w>>8)&0xFF, lo = w&0xFF;
                if (!hi) break; str += String.fromCharCode(hi);
                if (!lo) break; str += String.fromCharCode(lo);
            }
            return str.trim();
        }
        default: return null;
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _toRaw(value, desc) {
    const scale = desc.scale || 1;
    let raw = typeof value === 'number' ? Math.round(value / scale) : Math.round(value);
    if (raw < 0) raw = raw + 0x10000;
    return raw & 0xFFFF;
}

function _applyScale(raw, desc) {
    return raw * (desc.scale || 1) + (desc.offset || 0);
}

module.exports = DeviceManager;