'use strict';

// ─── Служебные имена каналов (не опрашиваем) ────────────────────────────────────
const SYSTEM_CHANNEL_NAMES = new Set([
    'Serial', 'Серийный номер',
    'Uptime', 'Время работы с момента включения',
    'FW Version', 'Версия прошивки', 'FW_Version',
    'HW Batch Number', 'Номер партии', 'HW_Batch_Number',
    'MCU Temperature', 'Температура МК',
    'MCU Voltage',
    'Supply Voltage', 'Напряжение питания',
    'Minimum Voltage Since Startup',
    'Minimum MCU Voltage Since Startup',
    'Internal Temperature', 'Температура внутри модуля',
    '5V Output', 'Напряжение на клеммах 5V',
    'Internal 5V Bus Voltage', 'Напряжение внутренней шины 5В',
    'AVCC Reference',
]);

const utils          = require('@iobroker/adapter-core');
const path           = require('path');
const DeviceManager  = require('./lib/device-manager');
const ObjectManager  = require('./lib/object-manager');
const { parseTemplate, loadTemplatesFromDir } = require('./lib/wb-template-parser');
const fs             = require('fs');

class Wirenboard extends utils.Adapter {
    constructor(options) {
        super({ ...options, name: 'wirenboard' });

        this._managers    = [];   // DeviceManager[] — по одному на шлюз
        this._objManager  = null; // ObjectManager
        this._writableMap = new Map(); // stateId → { ch, slaveId, manager }

        this.on('ready',       this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('message',     this.onMessage.bind(this));
        this.on('unload',      this.onUnload.bind(this));
    }

    // ─── Старт ────────────────────────────────────────────────────────────────

    async onReady() {
        this.log.info('Wiren Board adapter starting...');

        // Загружаем WB-шаблоны устройств
        const templates = this._loadTemplates();
        this.log.info(`Loaded ${templates.bySignature.size} device templates`);

        this._objManager = new ObjectManager(this);

        const gateways = this.config.gateways || [];
        const devices  = this.config.devices  || [];

        if (gateways.length === 0) {
            this.log.warn('No gateways configured');
            return;
        }

        // Запускаем все шлюзы параллельно
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

        // Устройства этого шлюза
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

        if (gwDevices.length === 0) {
            this.log.warn(`Gateway "${gw.name}": no valid devices configured`);
            return;
        }

        const mgr = new DeviceManager({
            host:            gw.host,
            port:            gw.port,
            pollInterval:    gw.pollInterval    || this.config.pollInterval    || 10000,
            fastPollInterval: this.config.fastPollInterval || 500,
            requestTimeout:  this.config.requestTimeout || 3000,
            devices:         gwDevices,

            onDeviceReady: async (deviceState) => {
                this.log.debug(`Device ready: ${deviceState.deviceId}`);
                try {
                    // Создаём базовые объекты устройства
                    await this._objManager.ensureDeviceChannel({
                        deviceId:   deviceState.deviceId,
                        name:       deviceState.name,
                        deviceType: deviceState.deviceType,
                        slaveId:    deviceState.slaveId,
                    });

                    // Сохраняем серийный номер
                    if (deviceState.serial) {
                        await this.setStateAsync(`${deviceState.deviceId}.info.serial`, deviceState.serial, true);
                    }

                    // Читаем сохранённую конфигурацию из ioBroker
                    const savedConfig = await this._loadDeviceConfig(deviceState.deviceId);

                    if (savedConfig && Object.keys(savedConfig).length > 0) {
                        // Есть сохранённая конфигурация — применяем её
                        this.log.info(`${deviceState.deviceId}: applying saved config`);
                        await this._applyConfig(deviceState, savedConfig, mgr);
                    } else {
                        const seen = new Set();
                        const defaultConfig = {};
                        for (const p of deviceState.template.parameters.filter(p => p.isConfig)) {
                            if (!seen.has(p.address)) {
                                seen.add(p.address);
                                defaultConfig[p.id] = -1;
                            }
                        }
                        await this._saveDeviceConfig(deviceState.deviceId, defaultConfig);
                        this.log.info(`${deviceState.deviceId}: new device, configure in tab`);
                    }

                    // Регистрируем writable каналы для подписки
                    this._registerWritable(deviceState, mgr);
                } catch (e) {
                    this.log.error(`onDeviceReady error (${deviceState.deviceId}): ${e.message}
${e.stack}`);
                }
            },

            onStateChange: async (deviceId, channelId, value, unit) => {
                const stateId = `${deviceId}.${channelId}`;
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

        // Создаём канальные объекты в ioBroker до старта менеджера
        for (const dev of gwDevices) {
            await this._objManager.ensureDeviceChannel(dev);
        }

        this._managers.push(mgr);
        await mgr.start();

    }

    // ─── Writable states ──────────────────────────────────────────────────────

    _registerWritable(deviceState, mgr) {
        const writableChannels = deviceState.template.parameters
            .filter(p => p.writable);

        for (const ch of writableChannels) {
            const stateId = `${this.namespace}.${deviceState.deviceId}.${ch.id}`;
            this._writableMap.set(stateId, {
                ch,
                slaveId: deviceState.slaveId,
                mgr,
            });
        }

        if (writableChannels.length > 0) {
            this.subscribeStates(`${deviceState.deviceId}.*`);
        }
    }

    // ─── State change (запись в устройство) ───────────────────────────────────

    async onStateChange(id, state) {
        if (!state || state.ack) return;

        const info = this._writableMap.get(id);
        if (!info) return;

        const { ch, slaveId, mgr } = info;

        try {
            await _writeChannel(ch, slaveId, state.val, mgr.client);
            this.log.info(`Written ${id} = ${state.val}`);
            await this.setStateAsync(id, state.val, true);
        } catch (err) {
            this.log.error(`Write error ${id}: ${err.message}`);
        }
    }

    // ─── Сообщения от UI (консоль, сканирование) ──────────────────────────────

    async onMessage(obj) {
        if (!obj || typeof obj !== 'object') return;

        const respond = (result) => {
            if (obj.callback) this.sendTo(obj.from, obj.command, result, obj.callback);
        };

        switch (obj.command) {
            case 'scan': {
                // Сканировать шину указанного шлюза
                const { gatewayName, from = 1, to = 247 } = obj.message || {};
                const mgr = this._managers.find(m =>
                    m.host === obj.message?.host && m.port === obj.message?.port
                );
                if (!mgr) {
                    respond({ error: 'Gateway not found or not connected' });
                    return;
                }
                try {
                    const found = await mgr.scan(from, to, (cur, total) => {
                        // Прогресс отправляем как промежуточный результат
                        this.sendTo(obj.from, 'scanProgress', { cur, total }, obj.callback);
                    });
                    respond({ result: found });
                } catch (e) {
                    respond({ error: e.message });
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
                // Прямое чтение регистра для диагностики
                const { host, port, slaveId, regType, address, count = 1 } = obj.message || {};
                const mgr = this._managers.find(m => m.host === host && m.port === port);
                if (!mgr) { respond({ error: 'Gateway not found' }); return; }
                try {
                    let words;
                    if (regType === 'holding') {
                        words = await mgr.client.readHolding(slaveId, address, count);
                    } else {
                        words = await mgr.client.readInput(slaveId, address, count);
                    }
                    respond({ result: words });
                } catch (e) {
                    respond({ error: e.message });
                }
                break;
            }

            case 'applyConfig': {
                // Применить конфигурацию устройства
                const { deviceId, config } = obj.message || {};
                const deviceState = this._findDeviceState(deviceId);
                if (!deviceState) { respond({ error: `Device ${deviceId} not found` }); return; }
                const mgr = this._findManager(deviceId);
                if (!mgr) { respond({ error: `Manager for ${deviceId} not found` }); return; }
                try {
                    await this._applyConfig(deviceState, config, mgr);
                    await this._saveDeviceConfig(deviceId, config);
                    respond({ result: 'ok' });
                } catch (e) {
                    respond({ error: e.message });
                }
                break;
            }

            case 'getDeviceInfo': {
                // Получить информацию об устройстве для таба
                const { deviceId } = obj.message || {};
                const deviceState = this._findDeviceState(deviceId);
                if (!deviceState) { respond({ error: `Device ${deviceId} not found` }); return; }
                const savedConfig = await this._loadDeviceConfig(deviceId);
                respond({
                    result: {
                        deviceId,
                        name:         deviceState.name,
                        deviceType:   deviceState.deviceType,
                        connected:    deviceState.connected,
                        serial:       deviceState.serial,
                        hardwareConfig: deviceState.deviceConfig,
                        savedConfig:  savedConfig || {},
                        configParams: deviceState.template.parameters
                            .filter(p => p.isConfig)
                            .filter((p, i, arr) => arr.findIndex(x => x.address === p.address) === i)
                            .map(p => ({
                                id:       p.id,
                                name:     p.name,
                                address:  p.address,
                                states:   p.states,
                                defaultVal: p.defaultVal,
                            })),
                    },
                });
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

    // ─── Утилиты ─────────────────────────────────────────────────────────────

    _loadTemplates() {
        // Ищем шаблоны в папке lib/wb-templates/ адаптера
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

    // ─── Конфигурация устройств ──────────────────────────────────────────────────

    async _loadDeviceConfig(deviceId) {
        try {
            const state = await this.getStateAsync(`${deviceId}.config`);
            if (state && state.val) {
                return typeof state.val === 'string' ? JSON.parse(state.val) : state.val;
            }
        } catch (_) {}
        return null;
    }

    async _saveDeviceConfig(deviceId, config) {
        // Создаём объект если нет
        await this.setObjectNotExistsAsync(`${deviceId}.config`, {
            type:   'state',
            common: {
                name:  'Device configuration',
                type:  'json',
                role:  'config',
                read:  true,
                write: true,
            },
            native: {},
        });
        await this.setStateAsync(`${deviceId}.config`, JSON.stringify(config), true);
    }

    /**
     * Применяет конфигурацию к устройству:
     * 1. Записывает конфиг-параметры в holding-регистры устройства
     * 2. Создаёт ioBroker-объекты для каналов которые активны в данной конфигурации
     * 3. Обновляет список каналов для поллинга
     */

    async _applyConfig(deviceState, config, mgr) {
        const { deviceId, template, slaveId } = deviceState;

        // 1. Записываем в регистры устройства
        for (const [paramId, value] of Object.entries(config)) {
            const param = template.parameters.find(p => p.id === paramId && p.isConfig);
            if (!param) continue;
            try {
                await mgr.client.writeHolding(slaveId, param.address, value & 0xFFFF);
                this.log.debug(`${deviceId}: wrote ${paramId}=${value} to 0x${param.address.toString(16)}`);
            } catch (e) {
                this.log.warn(`${deviceId}: failed to write ${paramId}: ${e.message}`);
            }
        }

        // 2. Определяем активные каналы на основе конфига
        deviceState.deviceConfig = config;
        const activeChannels = this._resolveActiveChannels(template, config);

        // 2.5. Удаляем старые объекты каналов
        try {
            const existing = await this.getObjectListAsync({
                startkey: `${deviceId}.`,
                endkey:   `${deviceId}.\u9999`,
            });
            for (const row of (existing?.rows || [])) {
                const id = row.id;
                if (id.includes('.info.') || id.endsWith('.config') || id === deviceId) continue;
                await this.delObjectAsync(id);
            }
        } catch (e) {
            this.log.debug(`cleanup error: ${e.message}`);
        }

        // 3. Создаём объекты для активных каналов
        await this._objManager.createChannelObjects(deviceId, activeChannels);

        // 4. Обновляем каналы поллинга
        deviceState.channels = activeChannels.map(ch => ({ ...ch, slaveId }));

        this.log.info(`${deviceId}: config applied, ${activeChannels.length} active channels`);
    }

    /**
     * Определяет какие каналы активны при данной конфигурации.
     * Разбирает condition строки из шаблона.
     */
    _resolveActiveChannels(template, config) {
        const seenIds = new Set();
        return template.channels.filter(ch => {
            if (ch.enabled === false) return false;
            if (ch.role === 'button') return false;
            if (ch.regType === 'coil') return false;
            if (ch.regType === 'press_counter') return false;
            if (ch.format === 'string') return false;
            if (ch.role === 'text') return false;
            if (ch.id && ch.id.startsWith('bus') && ch.address >= 1536 && ch.address <= 3900) return false;
            if (ch.format === 'u64' && ch.regType !== 'input') return false;
            if (ch.id && SYSTEM_CHANNEL_NAMES && SYSTEM_CHANNEL_NAMES.has(ch.name)) return false;

            // Если вход помечен как неактивен (-1) — пропускаем его каналы
            if (ch.condition) {
                const inMatch = ch.condition.match(/in(\d+)_(?:mode|type)/);
                if (inMatch) {
                    const inNum = inMatch[1];
                    const modeKey = `in${inNum}_mode`;
                    const typeKey = ch.condition.includes('_n_type') ? `in${inNum}_n_type` : `in${inNum}_type`;
                    if (config[modeKey] === -1) return false;
                    if (config[typeKey] === -1) return false;
                }
            }

            if (!ch.condition) return true;

            let active;
            try {
                active = _evalCondition(ch.condition, config);
            } catch (_) {
                active = true;
            }

            if (!active) return false;

            // Дедупликация — оставляем первый активный канал с каждым id
            if (seenIds.has(ch.id)) return false;
            seenIds.add(ch.id);
            return true;
        });
    }

    _findDeviceState(deviceId) {
        this.log.info(`findDeviceState: looking for "${deviceId}", managers=${this._managers.length}`);
        for (const mgr of this._managers) {
            const devs = mgr.getAllDevices();
            this.log.info(`findDeviceState: manager has ${devs.length} devices: ${devs.map(d => d.deviceId).join(', ')}`);
            for (const dev of devs) {
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

// ─── Запись в канал ───────────────────────────────────────────────────────────

async function _writeChannel(ch, slaveId, value, client) {
    const sid = ch.slaveId || slaveId;

    if (ch.regType === 'coil') {
        await client.writeCoil(sid, ch.address, !!value);
        return;
    }

    // holding: конвертируем значение обратно в сырой регистр
    let raw = value;
    if (ch.scale && ch.scale !== 1) {
        raw = Math.round(value / ch.scale);
    } else {
        raw = Math.round(value);
    }

    // Знаковые значения → беззнаковые для Modbus
    if (raw < 0) raw = raw + 0x10000;

    await client.writeHolding(sid, ch.address, raw & 0xFFFF);
}


// ─── Простой evaluator для WB condition-строк ────────────────────────────────────
/**
 * Разбирает условия вида:
 *   "in1_mode==0"
 *   "in1_mode==1"
 *   "in1_mode==0||in2_mode==0"
 *   "isDefined(in1_mode)==0||in1_mode==0"
 *
 * @param {string} condition
 * @param {object} config  { paramId: value }
 * @returns {boolean}
 */
function _evalCondition(condition, config) {
    if (!condition) return true;

    // Убираем пробелы, переносы и скобки
    const cond = condition.replace(/\s+/g, '').replace(/[()]/g, '');

    const orParts = cond.split('||');

    return orParts.some(part => {
        const andParts = part.split('&&');
        return andParts.every(expr => _evalExpr(expr, config));
    });
}

function _evalExpr(expr, config) {
    // isDefined(x)==0 → x не определён или равен 0
    const isDefinedMatch = expr.match(/^isDefined\((\w+)\)==(\d+)$/);
    if (isDefinedMatch) {
        const [, name, val] = isDefinedMatch;
        const defined = config[name] !== undefined ? 1 : 0;
        return defined === parseInt(val);
    }

    // x==val
    const eqMatch = expr.match(/^(\w+)==(-?\d+)$/);
    if (eqMatch) {
        const [, name, val] = eqMatch;
        return Number(config[name]) === parseInt(val);
    }

    // x!=val
    const neqMatch = expr.match(/^(\w+)!=(-?\d+)$/);
    if (neqMatch) {
        const [, name, val] = neqMatch;
        return Number(config[name]) !== parseInt(val);
    }

    // x>=val
    const gteMatch = expr.match(/^(\w+)>=(-?\d+)$/);
    if (gteMatch) {
        const [, name, val] = gteMatch;
        return Number(config[name]) >= parseInt(val);
    }

    // x<=val
    const lteMatch = expr.match(/^(\w+)<=(-?\d+)$/);
    if (lteMatch) {
        const [, name, val] = lteMatch;
        return Number(config[name]) <= parseInt(val);
    }

    return true; // неизвестное выражение — пропускаем
}

// ─── Безопасный ID устройства ─────────────────────────────────────────────────

function _makeDeviceId(gw, devCfg) {
    const gwPart  = (gw.name  || 'gw').replace(/[^a-zA-Z0-9_]/g, '_');
    const devPart = (devCfg.name || `${devCfg.deviceType}_${devCfg.slaveId}`)
        .replace(/[^a-zA-Z0-9_]/g, '_');
    return `${gwPart}_${devPart}`;
}

// ─── Точка входа ──────────────────────────────────────────────────────────────

if (require.main !== module) {
    module.exports = options => new Wirenboard(options);
} else {
    new Wirenboard();
}