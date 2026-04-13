'use strict';

const ModbusClient = require('./modbus-client');

/**
 * DeviceManager управляет жизненным циклом устройств на одном шлюзе:
 *  - инициализация устройств из конфигурации
 *  - периодический поллинг каналов
 *  - переподключение при обрыве связи
 *  - сканирование шины (перебор slave ID, чтение сигнатур)
 *
 * Работает с шаблонами из wb-template-parser.js.
 * Каждый канал (channel) описывается полями:
 *   regType, address, count, format, scale, offset, errorValue,
 *   sporadic, enabled, condition, wordOrder
 */
class DeviceManager {
    /**
     * @param {object}   opts
     * @param {string}   opts.host
     * @param {number}   opts.port
     * @param {number}   [opts.pollInterval=10000]
     * @param {number}   [opts.requestTimeout=3000]
     * @param {object[]} opts.devices          — список устройств из конфигурации
     *   Каждый: { slaveId, deviceType, name, deviceId, template }
     *   где template — результат parseTemplate() из wb-template-parser
     * @param {function} opts.onDeviceReady    — async (deviceState) → void
     *   Вызывается когда устройство инициализировано и объекты можно создавать.
     *   DeviceManager ждёт завершения этого callback перед первым поллингом.
     * @param {function} opts.onStateChange    — (deviceId, channelId, value, unit) → void
     * @param {function} opts.onConnectionChange — (deviceId, connected) → void
     * @param {function} [opts.logger]
     */
    constructor(opts) {
        this.host          = opts.host;
        this.port          = opts.port;
        this.pollInterval  = opts.pollInterval  || 10000;
        this.fastPollInterval = opts.fastPollInterval || 500;

        this.onDeviceReady       = opts.onDeviceReady       || (() => Promise.resolve());
        this.onStateChange       = opts.onStateChange       || (() => {});
        this.onConnectionChange  = opts.onConnectionChange  || (() => {});
        this.log = opts.logger || (() => {});

        this.client = new ModbusClient({
            host:    opts.host,
            port:    opts.port,
            timeout: opts.requestTimeout || 3000,
            logger:  this.log,
        });

        // Map<slaveId, DeviceState>
        this._devices   = new Map();
        this._pollTimer = null;
        this._fastPollTimer = null;
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

        // Инициализируем все устройства последовательно
        for (const state of this._devices.values()) {
            await this._initDevice(state);
        }

        this._startPoll();
    }

    async stop() {
        this._stopping = true;
        this._stopPoll();
        await this.client.disconnect();
        this.log('DeviceManager: stopped');
    }

    /**
     * Сканирует шину в диапазоне slaveId [from, to].
     * @param {number}   from
     * @param {number}   to
     * @param {function} [onProgress] (current, total) => void
     * @returns {Array<{slaveId, signature}>}
     */
    async scan(from = 1, to = 247, onProgress = null) {
        const found = [];
        this.log(`Scanning bus: slave IDs ${from}–${to}`);

        if (!this.client.connected) {
            await this.client.connect();
        }

        for (let id = from; id <= to; id++) {
            if (this._stopping) break;
            if (onProgress) onProgress(id - from, to - from + 1);

            const sig = await this.client.readDeviceSignature(id);
            if (sig) {
                found.push({ slaveId: id, signature: sig });
                this.log(`  Found: slaveId=${id} sig="${sig}"`);
            }
            await _sleep(50);
        }

        this.log(`Scan complete: ${found.length} device(s) found`);
        return found;
    }

    getDevice(slaveId)  { return this._devices.get(slaveId) || null; }
    getAllDevices()      { return Array.from(this._devices.values()); }

    // ─── Регистрация устройства ───────────────────────────────────────────────

    _registerDevice(cfg) {
        if (!cfg.template) {
            this.log(`DeviceManager: no template for "${cfg.deviceType}", skipping`);
            return null;
        }

        const state = {
            slaveId:    cfg.slaveId,
            deviceType: cfg.deviceType,
            name:       cfg.name || `${cfg.deviceType} [${cfg.slaveId}]`,
            deviceId:   cfg.deviceId || `${cfg.deviceType}_${cfg.slaveId}`,
            template:   cfg.template,
            // Берём только enabled каналы без условий (runtime-условия пока игнорируем)
            channels:   _getActiveChannels(cfg.template.channels, cfg.slaveId),
            connected:  false,
            initialized: false,
            lastValues: new Map(),
        };

        this._devices.set(cfg.slaveId, state);
        return state;
    }

    // ─── Инициализация ────────────────────────────────────────────────────────

    async _initDevice(state) {
        this.log(`Initializing ${state.name} (slaveId=${state.slaveId})`);

        // Проверяем связь: читаем серийный номер (регистр 270, input, u32)
        let connected = false;
        let serial = null;
        try {
            const words = await this.client.readInput(state.slaveId, 270, 2);
            serial = (words[0] & 0xFFFF) * 0x10000 + (words[1] & 0xFFFF);
            connected = true;
            this.log(`  ${state.name}: reachable, serial=${serial}`);
        } catch (err) {
            this.log(`  ${state.name}: not reachable (${err.message})`);
        }

        state.serial = serial;

        // Читаем конфиг-параметры с устройства (sensorType, mode и т.д.)
        if (connected) {
            state.deviceConfig = await this._readDeviceConfig(state);
            this.log(`  ${state.name}: config read, ${Object.keys(state.deviceConfig).length} params`);
        } else {
            state.deviceConfig = {};
        }

        state.initialized = true;

        // Ждём пока внешний код создаст ioBroker-объекты.
        // Только после этого запускаем первый поллинг — нет race condition.
        try {
            await this.onDeviceReady(state);
        } catch (err) {
            this.log(`onDeviceReady error for ${state.name}: ${err.message}`);
        }
        
        this._setConnected(state, connected);

        // Первый поллинг
        if (connected) {
            await this._pollDevice(state);
        }
    }

    /**
     * Читает конфиг-параметры устройства (isConfig:true) с реального железа.
     * Возвращает { paramId: value }
     */
    async _readDeviceConfig(state) {
        const config = {};
        const configParams = state.template.parameters.filter(p => p.isConfig);
        // Дедупликация по адресу — один адрес может быть в нескольких вариантах (MAI6)
        const seen = new Set();
        for (const p of configParams) {
            if (seen.has(p.address)) continue;
            seen.add(p.address);
            try {
                const val = await this.client.readHoldingU16(state.slaveId, p.address);
                config[p.id] = val;
            } catch (_) {}
        }
        return config;
    }

    // ─── Поллинг ──────────────────────────────────────────────────────────────

    _startPoll() {
        // Медленный поллинг — температура и прочие данные
        this._pollTimer = setInterval(() => {
            if (!this._stopping) this._pollAll(false).catch(() => {});
        }, this.pollInterval);

        // Быстрый поллинг — sporadic каналы (кнопки, счётчики)
        this._fastPollTimer = setInterval(() => {
            if (!this._stopping) this._pollAll(true).catch(() => {});
        }, this.fastPollInterval);
    }

    _stopPoll() {
        if (this._pollTimer) {
            clearInterval(this._pollTimer);
            this._pollTimer = null;
        }
        if (this._fastPollTimer) {
            clearInterval(this._fastPollTimer);
            this._fastPollTimer = null;
        }
    }

    async _pollAll(fastOnly = false) {
        for (const state of this._devices.values()) {
            if (this._stopping) break;
            await this._pollDevice(state, fastOnly);
        }
    }
    
    async _pollDevice(state, fastOnly = false) {
        let anyOk = false;

        for (const ch of state.channels) {
            if (this._stopping) break;

            // fastOnly=true — опрашиваем только sporadic каналы
            // fastOnly=false — опрашиваем только не-sporadic
            if (fastOnly && !ch.sporadic) continue;
            if (!fastOnly && ch.sporadic) continue;

            try {
                const result = await _readChannel(ch, state.slaveId, this.client);
                if (result === null) continue;

                anyOk = true;

                const prev = state.lastValues.get(ch.id);

                if (result.error) {
                    if (prev !== null) {
                        state.lastValues.set(ch.id, null);
                        this.onStateChange(state.deviceId, ch.id, null, ch.unit);
                    }
                    continue;
                }

                if (ch.sporadic && prev === result.value) continue;

                state.lastValues.set(ch.id, result.value);
                this.onStateChange(state.deviceId, ch.id, result.value, ch.unit);

            } catch (err) {
                this.log(`Poll ${state.name}/${ch.id}: ${err.message}`);
            }
        }

        // connection обновляем только при полном поллинге
        if (!fastOnly) this._setConnected(state, anyOk);
    }

    _setConnected(state, connected) {
        if (state.connected !== connected) {
            state.connected = connected;
            this.onConnectionChange(state.deviceId, connected);
        }
    }
}

// ─── Чтение канала ────────────────────────────────────────────────────────────

/**
 * Читает значение одного канала через Modbus.
 * Возвращает { value, error? } или null если канал не поддерживается.
 */
async function _readChannel(ch, slaveId, client) {
    const addr = ch.address;
    const sid  = ch.slaveId || slaveId;
    let raw;

    try {
        switch (ch.regType) {
            case 'coil':
                raw = await client.readCoil(sid, addr);
                return { value: raw !== 0 };

            case 'discrete':
                raw = await client.readDiscreteInput(sid, addr);
                return { value: raw !== 0 };

            case 'input':
            case 'holding':
                raw = await _readFormatted(ch, sid, client);
                break;

            case 'press_counter':
                // press_counter читается как обычный input u16
                raw = await client.readInputU16(sid, addr);
                return { value: raw };

            default:
                return null;
        }
    } catch (_) {
        return null;
    }

    if (raw === null) return null;

    // Проверяем error_value
    if (ch.errorValue !== null && ch.errorValue !== undefined) {
        // Для знаковых форматов errorValue хранится как беззнаковое (0x7FFF → 32767)
        if (raw === ch.errorValue) return { value: null, error: true };
    }

    // Применяем scale и offset
    let value;
    if (ch.format === 'bool') {
        value = raw !== 0;
    } else if (ch.format === 'string') {
        value = raw; // уже строка
    } else {
        value = raw * (ch.scale || 1) + (ch.offset || 0);
        if (ch.roundTo) {
            value = Math.round(value / ch.roundTo) * ch.roundTo;
        }
        // Ограничиваем точность числа
        value = Math.round(value * 1e9) / 1e9;
    }

    return { value };
}

async function _readFormatted(ch, slaveId, client) {
    const addr    = ch.address;
    const read    = ch.regType === 'holding'
        ? (a, c) => client.readHolding(slaveId, a, c)
        : (a, c) => client.readInput(slaveId, a, c);
    const readU16 = ch.regType === 'holding'
        ? () => client.readHoldingU16(slaveId, addr)
        : () => client.readInputU16(slaveId, addr);

    switch (ch.format) {
        case 'bool':
        case 'u16': {
            const [w] = await read(addr, 1);
            return w & 0xFFFF;
        }
        case 's16': {
            const v = await readU16();
            return v >= 0x8000 ? v - 0x10000 : v;
        }
        case 'u32': {
            const [hi, lo] = await read(addr, 2);
            if (ch.wordOrder === 'le') return (lo & 0xFFFF) * 0x10000 + (hi & 0xFFFF);
            return (hi & 0xFFFF) * 0x10000 + (lo & 0xFFFF);
        }
        case 's32': {
            const words = await read(addr, 2);
            const [hi, lo] = ch.wordOrder === 'le' ? [words[1], words[0]] : words;
            const u = (hi & 0xFFFF) * 0x10000 + (lo & 0xFFFF);
            return u >= 0x80000000 ? u - 0x100000000 : u;
        }
        case 'u64': {
            const words = await read(addr, 4);
            const [w3, w2, w1, w0] = ch.wordOrder === 'le'
                ? [words[3], words[2], words[1], words[0]]
                : words;
            const val = (BigInt(w3 & 0xFFFF) << 48n) |
                        (BigInt(w2 & 0xFFFF) << 32n) |
                        (BigInt(w1 & 0xFFFF) << 16n) |
                        BigInt(w0 & 0xFFFF);
            return Number(val);
        }
        case 's64': {
            const words = await read(addr, 4);
            const [w3, w2, w1, w0] = ch.wordOrder === 'le'
                ? [words[3], words[2], words[1], words[0]]
                : words;
            const val = (BigInt(w3 & 0xFFFF) << 48n) |
                        (BigInt(w2 & 0xFFFF) << 32n) |
                        (BigInt(w1 & 0xFFFF) << 16n) |
                        BigInt(w0 & 0xFFFF);
            // signed 64-bit
            return Number(val >= 0x8000000000000000n ? val - 0x10000000000000000n : val);
        }
        case 'float': {
            const [hi, lo] = ch.wordOrder === 'le'
                ? await read(addr, 2).then(w => [w[1], w[0]])
                : await read(addr, 2);
            const buf = Buffer.allocUnsafe(4);
            buf.writeUInt16BE(hi & 0xFFFF, 0);
            buf.writeUInt16BE(lo & 0xFFFF, 2);
            return buf.readFloatBE(0);
        }
        case 'bcd': {
            const words = await read(addr, ch.count || 1);
            // BCD: каждый nibble — одна десятичная цифра
            let result = 0;
            for (const w of words) {
                result = result * 100
                    + ((w >> 12) & 0xF) * 10 + ((w >> 8) & 0xF)  // старший байт
                    + ((w >> 4)  & 0xF) * 10 + (w & 0xF);         // младший байт — нет, исправим
            }
            return result;
        }
        case 'string': {
            const words = await read(addr, ch.count || 1);
            let str = '';
            for (const w of words) {
                const hi = (w >> 8) & 0xFF;
                const lo = w & 0xFF;
                if (hi === 0) break;
                str += String.fromCharCode(hi);
                if (lo === 0) break;
                str += String.fromCharCode(lo);
            }
            return str.trim();
        }
        default:
            return null;
    }
}

// ─── Вспомогательные ─────────────────────────────────────────────────────────

/**
 * Возвращает каналы которые нужно опрашивать:
 *  - enabled !== false
 *  - нет условия (condition) — условные каналы зависят от runtime параметров
 *    и обрабатываются отдельно
 *  - не pushbutton (только для записи)
 */
// Служебные каналы которые мы создаём сами в ensureDeviceChannel
const SYSTEM_CHANNEL_NAMES = new Set(['Serial', 'Uptime', 'FW Version', 'HW Batch Number',
    'MCU Temperature', 'MCU Voltage', 'Supply Voltage', 'Minimum Voltage Since Startup',
    'Minimum MCU Voltage Since Startup', 'Internal Temperature', '5V Output',
    'Internal 5V Bus Voltage', 'AVCC Reference']);

function _getActiveChannels(channels, slaveId) {
    return channels
        .filter(ch => ch.enabled !== false)           // только включённые
        .filter(ch => ch.role !== 'button')            // pushbutton не опрашиваем
        .filter(ch => ch.format !== 'string')          // строковые каналы (FW Version и др.)
        .filter(ch => ch.format !== 'u64' || ch.regType === 'input')  // u64 holding (1-Wire ID)
        .filter(ch => !SYSTEM_CHANNEL_NAMES.has(ch.name))  // служебные каналы
        .map(ch => ({ ...ch, slaveId: ch.slaveId || slaveId }));
}

function _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = DeviceManager;