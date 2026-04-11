'use strict';

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
            requestTimeout:  this.config.requestTimeout || 3000,
            devices:         gwDevices,

            onDeviceReady: async (deviceState) => {
                this.log.debug(`Device ready: ${deviceState.deviceId}`);
                try {
                    await this._objManager.createDeviceObjects(deviceState);
                    // Регистрируем writable каналы для подписки
                    this._registerWritable(deviceState, mgr);
                } catch (e) {
                    this.log.error(`createDeviceObjects error (${deviceState.deviceId}): ${e.message}`);
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

        await mgr.start();
        this._managers.push(mgr);
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
