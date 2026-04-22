'use strict';

const utils         = require('@iobroker/adapter-core');
const path          = require('path');
const fs            = require('fs');
const DeviceManager = require('./lib/device-manager');
const ObjectManager = require('./lib/object-manager');
const { loadTemplatesFromDir } = require('./lib/wb-template-parser');

class Wirenboard extends utils.Adapter {
    constructor(options) {
        super({ ...options, name: 'wirenboard' });

        this._managers   = [];              // DeviceManager[] — по одному на шлюз
        this._objManager = null;
        // stateId → { channelId, settingId, slaveId, mgr }
        this._writableMap = new Map();

        this.on('ready',       this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('message',     this.onMessage.bind(this));
        this.on('unload',      this.onUnload.bind(this));
    }

    // ─── Старт ────────────────────────────────────────────────────────────────

    async onReady() {
        this.log.info('Wiren Board adapter starting...');

        const templates = this._loadTemplates();
        this.log.info(`Loaded ${templates.bySignature.size} device templates`);

        this._objManager = new ObjectManager(this);
        await this._objManager.ensureAdapterInfo();

        const gateways = this.config.gateways || [];
        const devices  = this.config.devices  || [];

        if (!gateways.length) {
            this.log.warn('No gateways configured');
            return;
        }

        await Promise.all(
            gateways
                .filter(gw => gw.enabled !== false)
                .map(gw => this._startGateway(gw, devices, templates)
                    .catch(e => this.log.error(`Gateway "${gw.name}" start error: ${e.message}`))
                )
        );

        await this._updateGlobalConnection();
    }

    // ─── Запуск шлюза ─────────────────────────────────────────────────────────

    async _startGateway(gw, allDevices, templates) {
        this.log.info(`Starting gateway "${gw.name}" (${gw.host}:${gw.port})`);

        const gwDevices = allDevices
            .filter(d => d.enabled !== false && d.gateway === gw.name)
            .map(d => {
                const tmpl = templates.byType.get(d.deviceType);
                if (!tmpl) {
                    this.log.warn(`No template for device type "${d.deviceType}", skipping`);
                    return null;
                }
                return {
                    slaveId:    d.slaveId,
                    deviceType: d.deviceType,
                    name:       d.name,
                    deviceId:   _makeDeviceId(gw, d),
                    template:   tmpl,
                };
            })
            .filter(Boolean);

        if (!gwDevices.length) {
            this.log.warn(`Gateway "${gw.name}": no valid devices`);
            return;
        }

        const mgr = new DeviceManager({
            host:             gw.host,
            port:             gw.port,
            pollInterval:     gw.pollInterval         || this.config.pollInterval     || 10000,
            fastPollInterval: this.config.fastPollInterval || 500,
            requestTimeout:   this.config.requestTimeout  || 3000,
            devices:          gwDevices,

            onDeviceReady: async (deviceState) => {
                this.log.debug(`Device ready: ${deviceState.deviceId}`);
                try {
                    // 1. Базовые объекты (device-канал + info.*)
                    await this._objManager.ensureDeviceChannel({
                        deviceId:   deviceState.deviceId,
                        name:       deviceState.name,
                        deviceType: deviceState.deviceType,
                        slaveId:    deviceState.slaveId,
                    });

                    // 2. Серийный номер
                    if (deviceState.serial) {
                        await this.setStateAsync(
                            `${deviceState.deviceId}.info.serial`,
                            deviceState.serial, true
                        );
                    }

                    // 3. Загружаем сохранённую конфигурацию
                    const savedConfig = await this._loadDeviceConfig(deviceState.deviceId);

                    if (savedConfig && Object.keys(savedConfig).length) {
                        this.log.info(`${deviceState.deviceId}: applying saved config`);
                        await this._applyConfig(deviceState, savedConfig, mgr, false);
                    } else {
                        // Новое устройство — читаем holding-параметры с железа
                        const flat = await mgr.readFlatConfig(deviceState.deviceId);
                        const initialConfig = { flat, sensors: {}, settings: {} };
                        await this._applyConfig(deviceState, initialConfig, mgr, false);
                        await this._saveDeviceConfig(deviceState.deviceId, initialConfig);
                        this.log.info(`${deviceState.deviceId}: new device, read ${Object.keys(flat).length} params from hardware`);
                    }

                    // 4. Регистрируем writable settings
                    this._registerWritable(deviceState, mgr);
                } catch (e) {
                    this.log.error(`onDeviceReady error (${deviceState.deviceId}): ${e.message}\n${e.stack}`);
                }
            },

            // Новый колбэк: { deviceId, channelId, measurementId, value }
            onMeasurement: async (deviceId, channelId, measurementId, value) => {
                // stateId вида: deviceId.channelId.measurementId
                const stateId = `${deviceId}.${channelId}.${measurementId}`;
                try {
                    await this.setStateAsync(stateId, { val: value, ack: true });
                } catch (e) {
                    this.log.debug(`setStateAsync ${stateId}: ${e.message}`);
                }
            },

            onConnectionChange: async (deviceId, connected) => {
                try {
                    await this.setStateAsync(`${deviceId}.info.connection`, connected, true);
                    await this._updateGlobalConnection();
                } catch (e) {
                    this.log.debug(`connection state error: ${e.message}`);
                }
            },

            logger: (msg) => this.log.debug(msg),
        });

        // Создаём базовые объекты до старта
        for (const dev of gwDevices) {
            await this._objManager.ensureDeviceChannel(dev);
        }

        this._managers.push(mgr);
        await mgr.start();
        this.log.info(`Gateway "${gw.name}": started`);
    }

    // ─── Применение конфигурации ──────────────────────────────────────────────

    /**
     * Применяет конфигурацию к устройству:
     *  1. При необходимости записывает settings в holding-регистры
     *  2. Создаёт объекты ioBroker для активных каналов
     *  3. Обновляет список каналов поллинга в DeviceManager
     *
     * config = { [channelId]: { [settingId]: value } }
     */
    async _applyConfig(deviceState, config, mgr, writeToDevice = true) {
        const { deviceId, template, slaveId } = deviceState;

        // 1. Записываем rw-settings в устройство
        // config.settings = { [channelId]: { [settingId]: value } }
        if (writeToDevice && deviceState.connected) {
            const settingsToWrite = config.settings || {};
            for (const [channelId, settingsMap] of Object.entries(settingsToWrite)) {
                for (const [settingId, value] of Object.entries(settingsMap)) {
                    if (value === null || value === undefined || value === -1) continue;
                    try {
                        await mgr.writeSetting(deviceId, channelId, settingId, value);
                    } catch (e) {
                        this.log.warn(`${deviceId}: failed to write ${channelId}/${settingId}: ${e.message}`);
                    }
                }
            }
        }

        // 2. Резолвим активные каналы с учётом конфига
        const activeChannels = this._resolveChannels(template, config);

        // 3. Применяем
        await this._applyChannels(deviceState, activeChannels, mgr);

        // 4. Сохраняем конфиг
        deviceState.savedConfig = config;
        this.log.info(`${deviceId}: config applied, ${activeChannels.length} active channels`);
    }

    /**
     * Создаёт объекты ioBroker и обновляет поллинг для списка каналов.
     */
    async _applyChannels(deviceState, channels, mgr) {
        const { deviceId, slaveId } = deviceState;

        // Удаляем старые объекты и стейты измерений (не трогаем info.*)
        try {
            const existing = await this.getObjectListAsync({
                startkey: `${deviceId}.`,
                endkey:   `${deviceId}.\u9999`,
            });
            for (const row of (existing?.rows || [])) {
                const id = row.id;
                if (id.includes('.info.') || id.endsWith('.config') || id === deviceId) continue;
                // Удаляем стейт если объект — state
                if (row.value?.type === 'state') {
                    try { await this.delStateAsync(id); } catch (_) {}
                }
                await this.delObjectAsync(id);
            }
        } catch (e) {
            this.log.debug(`cleanup error: ${e.message}`);
        }

        // Создаём объекты для активных каналов
        await this._objManager.createChannelObjects(deviceId, channels);

        // Обновляем DeviceManager
        mgr.updateChannels(deviceId, channels.map(ch => ({ ...ch, slaveId })));

        // Регистрируем writable стейты для подписки
        this._registerWritable(deviceState, mgr);
    }

    /**
     * Резолвит активные каналы на основе сохранённого конфига.
     *
     * Конфиг хранится в формате:
     * {
     *   flat:     { in1_mode: 0, in2_mode: 1 },  // holding-параметры устройства
     *   sensors:  { gg_in1_temp: 3 },              // лимиты 1-Wire датчиков
     * }
     *
     * Для обратной совместимости принимаем и плоский формат { paramId: value }.
     */
    _resolveChannels(template, config) {
        if (!config || !Object.keys(config).length) {
            // Нет конфига — каналы без condition (безусловно активные)
            return template.channels.filter(ch => !ch.condition);
        }

        const flatConfig   = config.flat   || {};
        const sensorCounts = config.sensors || {};

        return template.resolveChannels(flatConfig, sensorCounts);
    }

    // ─── Writable states ──────────────────────────────────────────────────────

    _registerWritable(deviceState, mgr) {
        // Сначала удаляем старые записи для этого устройства
        for (const [k] of this._writableMap) {
            if (k.startsWith(`${this.namespace}.${deviceState.deviceId}.`)) {
                this._writableMap.delete(k);
            }
        }

        let hasWritable = false;
        for (const ch of deviceState.channels) {
            // Writable settings (holding-параметры)
            for (const s of ch.settings) {
                if (!s.write) continue;
                const stateId = `${this.namespace}.${deviceState.deviceId}.${ch.id}.${s.id}`;
                this._writableMap.set(stateId, {
                    type: 'setting',
                    channelId: ch.id,
                    settingId: s.id,
                    mgr,
                    deviceId: deviceState.deviceId,
                });
                hasWritable = true;
            }
            // Writable measurements (coil — реле и т.п.)
            for (const m of ch.measurements) {
                this.log.debug(`registerWritable: ${ch.id}.${m.id} regType=${m.regType} writable=${m.writable}`);
                if (!m.writable) continue;
                const stateId = `${this.namespace}.${deviceState.deviceId}.${ch.id}.${m.id}`;
                this._writableMap.set(stateId, {
                    type: 'channel',
                    channelId: ch.id,
                    measurementId: m.id,
                    mgr,
                    deviceId: deviceState.deviceId,
                });
                hasWritable = true;
            }
        }

        if (hasWritable) {
            this.subscribeStates(`${deviceState.deviceId}.*`);
        }
    }

    // ─── State change ─────────────────────────────────────────────────────────

    async onStateChange(id, state) {
        if (!state || state.ack) return;

        const info = this._writableMap.get(id);
        if (!info) return;

        const { type, channelId, mgr, deviceId } = info;
        this.log.info(`Write ${id}: type=${type} channelId=${channelId} measurementId=${info.measurementId} settingId=${info.settingId}`);
        try {
            if (type === 'channel') {
                await mgr.writeChannel(deviceId, channelId, info.measurementId, state.val);
            } else {
                await mgr.writeSetting(deviceId, channelId, info.settingId, state.val);
            }
            this.log.info(`Written ${id} = ${state.val}`);
            await this.setStateAsync(id, state.val, true);
        } catch (err) {
            this.log.error(`Write error ${id}: ${err.message}\n${err.stack}`);
        }
    }

    // ─── Сообщения от UI ──────────────────────────────────────────────────────

    async onMessage(obj) {
        if (!obj || typeof obj !== 'object') return;

        const respond = (result) => {
            if (obj.callback) this.sendTo(obj.from, obj.command, result, obj.callback);
        };

        switch (obj.command) {

            case 'scan': {
                const { from = 1, to = 247, host, port } = obj.message || {};
                if (!host || !port) { respond({ error: 'host and port required' }); return; }

                const ScanClient = require('./lib/modbus-client');
                const scanClient = new ScanClient({
                    host, port,
                    timeout: 500,  // короткий таймаут для сканирования
                    logger: () => {},
                });
                try {
                    await scanClient.connect();
                    const found = [];
                    for (let id = from; id <= to; id++) {
                        let sig = null;

                        // Вариант 1: input 200, один символ на регистр (новые устройства: MR3LV и др.)
                        if (!sig) {
                            try {
                                const words = await scanClient.readInput(id, 200, 8);
                                let str = '';
                                for (const w of words) {
                                    if (!w) break;
                                    str += String.fromCharCode(w & 0xFF);
                                }
                                const s = str.trim();
                                if (s && /^[A-Z0-9_-]+$/.test(s)) sig = s;
                            } catch (_) {}
                        }

                        // Вариант 2: holding 200, два символа на регистр (старые устройства)
                        if (!sig) {
                            try {
                                const words = await scanClient.readHolding(id, 200, 8);
                                let str = '';
                                for (const w of words) {
                                    const hi = (w >> 8) & 0xFF, lo = w & 0xFF;
                                    if (!hi) break; str += String.fromCharCode(hi);
                                    if (!lo) break; str += String.fromCharCode(lo);
                                }
                                const s = str.trim();
                                if (s && /^[A-Z0-9_-]+$/.test(s)) sig = s;
                            } catch (_) {}
                        }

                        // Вариант 3: holding 0, один символ в младшем байте (MAP3E)
                        if (!sig) {
                            try {
                                const words = await scanClient.readHolding(id, 0, 12);
                                let str = '';
                                for (let i = 2; i < words.length; i++) {
                                    const lo = words[i] & 0xFF;
                                    if (!lo) break;
                                    str += String.fromCharCode(lo);
                                }
                                const s = str.trim();
                                if (s && /^[A-Z0-9_-]+$/.test(s)) sig = s;
                            } catch (_) {}
                        }

                        if (sig) {
                            found.push({ slaveId: id, signature: sig });
                            this.log.info(`Scan: found ${sig} at slave ${id}`);
                        }
                        // Прогресс каждые 10 адресов
                        if ((id - from) % 10 === 0) {
                            const pct = Math.round((id - from) / (to - from + 1) * 100);
                            this.log.debug(`Scan progress: ${pct}% (slave ${id})`);
                        }
                        await _sleep(50);
                    }
                    respond({ result: found });
                } catch (e) {
                    respond({ error: e.message });
                } finally {
                    await scanClient.disconnect();
                }
                break;
            }

            case 'listGateways': {
                respond({
                    result: this._managers.map(m => ({
                        host:      m.host,
                        port:      m.port,
                        connected: m.client.connected,
                        devices:   m.getAllDevices().map(d => ({
                            deviceId:   d.deviceId,
                            name:       d.name,
                            slaveId:    d.slaveId,
                            deviceType: d.deviceType,
                            connected:  d.connected,
                        })),
                    })),
                });
                break;
            }

            case 'readRaw': {
                const { host, port, slaveId, regType, address, count = 1 } = obj.message || {};
                const mgr = this._managers.find(m => m.host === host && m.port === port);
                if (!mgr) { respond({ error: 'Gateway not found' }); return; }
                try {
                    const words = regType === 'holding'
                        ? await mgr.client.readHolding(slaveId, address, count)
                        : await mgr.client.readInput(slaveId, address, count);
                    respond({ result: words });
                } catch (e) {
                    respond({ error: e.message });
                }
                break;
            }

            case 'applyConfig': {
                // config = { [channelId]: { [settingId]: value } }
                const { deviceId, config } = obj.message || {};
                const deviceState = this._findDeviceState(deviceId);
                if (!deviceState) { respond({ error: `Device ${deviceId} not found` }); return; }
                const mgr = this._findManager(deviceId);
                if (!mgr) { respond({ error: `Manager for ${deviceId} not found` }); return; }
                try {
                    await this._applyConfig(deviceState, config, mgr, true);
                    await this._saveDeviceConfig(deviceId, config);
                    respond({ result: 'ok' });
                } catch (e) {
                    respond({ error: e.message });
                }
                break;
            }

            case 'getDeviceInfo': {
                const { deviceId } = obj.message || {};
                const deviceState = this._findDeviceState(deviceId);
                if (!deviceState) { respond({ error: `Device ${deviceId} not found` }); return; }
                const savedConfig = await this._loadDeviceConfig(deviceId);

                respond({
                    result: {
                        deviceId,
                        name:        deviceState.name,
                        deviceType:  deviceState.deviceType,
                        connected:   deviceState.connected,
                        serial:      deviceState.serial,
                        info:        deviceState.info,
                        savedConfig: savedConfig || {},
                        // Все каналы шаблона с полными дескрипторами для UI
                        channels: deviceState.template.channels.map(ch => ({
                            id:        ch.id,
                            name:      ch.name,
                            condition: ch.condition || null,
                            measurements: (ch.measurements || []).map(m => ({
                                id: m.id, name: m.name, writable: m.writable || false,
                            })),
                            settings: (ch.settings || []).map(s => ({
                                id:        s.id,
                                name:      s.name,
                                states:    s.states,
                                default:   s.default,
                                min:       s.min,
                                max:       s.max,
                                write:     s.write,
                                isConfig:  s.isConfig || false,
                                condition: s.condition || null,
                            })),
                        })),
                        // isConfig-параметры (режимы входов) — отдельный список
                        configParams: (deviceState.template.configParams || []).map(s => ({
                            id:      s.id,
                            name:    s.name,
                            states:  s.states,
                            default: s.default,
                            isConfig: true,
                        })),
                    },
                });
                break;
            }

            case 'getConfig': {
                respond({ result: {
                    gateways: this.config.gateways || [],
                    devices:  this.config.devices  || [],
                }});
                break;
            }

            case 'saveConfig': {
                const { gateways, devices } = obj.message || {};
                try {
                    await this.extendForeignObjectAsync(`system.adapter.${this.namespace}`, {
                        native: { gateways, devices }
                    });
                    respond({ result: 'ok' });
                } catch (e) {
                    respond({ error: e.message });
                }
                break;
            }

            case 'restart': {
                respond({ result: 'ok' });
                setTimeout(() => this.restart(), 500);
                break;
            }

            default:
                respond({ error: `Unknown command: ${obj.command}` });
        }
    }

    // ─── Остановка ────────────────────────────────────────────────────────────

    async onUnload(callback) {
        try {
            this.log.info('Wiren Board adapter stopping...');
            await Promise.all(this._managers.map(m => m.stop()));
            this._managers = [];
            await this.setStateAsync('info.connection', false, true);
        } catch (e) {
            this.log.error(`onUnload error: ${e.message}`);
        } finally {
            callback();
        }
    }

    // ─── Утилиты ──────────────────────────────────────────────────────────────

    _loadTemplates() {
        const templatesDir = path.join(__dirname, 'lib', 'wb-templates');
        if (!fs.existsSync(templatesDir)) {
            this.log.warn(`Templates directory not found: ${templatesDir}`);
            return { bySignature: new Map(), byType: new Map(), all: [] };
        }
        const result = loadTemplatesFromDir(templatesDir);
        for (const e of result.errors) {
            this.log.warn(`Template parse error ${e.file}: ${e.error}`);
        }
        return result;
    }

    async _loadDeviceConfig(deviceId) {
        try {
            const state = await this.getStateAsync(`${deviceId}.config`);
            if (state?.val) {
                return typeof state.val === 'string' ? JSON.parse(state.val) : state.val;
            }
        } catch (_) {}
        return null;
    }

    async _saveDeviceConfig(deviceId, config) {
        await this.setObjectNotExistsAsync(`${deviceId}.config`, {
            type:   'state',
            common: { name:'Device configuration', type:'json', role:'config', read:true, write:true },
            native: {},
        });
        await this.setStateAsync(`${deviceId}.config`, JSON.stringify(config), true);
    }

    _findDeviceState(deviceId) {
        for (const mgr of this._managers) {
            for (const dev of mgr.getAllDevices()) {
                if (dev.deviceId === deviceId) return dev;
            }
        }
        return null;
    }

    _findManager(deviceId) {
        for (const mgr of this._managers) {
            if (mgr.getAllDevices().some(d => d.deviceId === deviceId)) return mgr;
        }
        return null;
    }

    async _updateGlobalConnection() {
        const anyOnline = this._managers.some(m =>
            m.getAllDevices().some(d => d.connected)
        );
        await this.setStateAsync('info.connection', anyOnline, true);
    }
}

// ─── Вспомогательные ──────────────────────────────────────────────────────────

function _makeDeviceId(gw, devCfg) {
    const gwPart  = (gw.name  || 'gw').replace(/[^a-zA-Z0-9_]/g, '_');
    const devPart = (devCfg.name || `${devCfg.deviceType}_${devCfg.slaveId}`)
        .replace(/[^a-zA-Z0-9_]/g, '_');
    return `${gwPart}_${devPart}`;
}

function _sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

// ─── Точка входа ──────────────────────────────────────────────────────────────

if (require.main !== module) {
    module.exports = options => new Wirenboard(options);
} else {
    new Wirenboard();
}