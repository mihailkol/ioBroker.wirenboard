'use strict';

/**
 * ObjectManager — создаёт и обновляет объекты в дереве ioBroker.
 *
 * Структура объектов (новая иерархия):
 *   wirenboard.0
 *     ├── info.connection                    ← общий статус адаптера
 *     └── <gwName>_<devName>                 ← device
 *         ├── info                           ← channel
 *         │   ├── connection                 ← онлайн/офлайн
 *         │   └── serial                     ← серийный номер
 *         ├── <channelId>                    ← channel (L1, sensor1, ...)
 *         │   ├── <measurementId>            ← state ro (voltage, current, ...)
 *         │   └── <settingId>                ← state rw (turns, phi, ...)
 *         └── ...
 */
class ObjectManager {
    constructor(adapter) {
        this.adapter = adapter;
    }

    /**
     * Создаёт глобальный info.connection адаптера.
     * Вызывается один раз в onReady.
     */
    async ensureAdapterInfo() {
        await this.adapter.setObjectNotExistsAsync('info', {
            type:   'channel',
            common: { name: 'Info' },
            native: {},
        });
        await this.adapter.setObjectNotExistsAsync('info.connection', {
            type:   'state',
            common: {
                name:  'Connection',
                type:  'boolean',
                role:  'indicator.connected',
                read:  true,
                write: false,
                def:   false,
            },
            native: {},
        });
    }

    /**
     * Создаёт device-узел и служебные info-объекты устройства.
     * Вызывается до старта поллинга.
     */
    async ensureDeviceChannel(devCfg) {
        const { deviceId, name, deviceType, slaveId } = devCfg;

        await this.adapter.setObjectNotExistsAsync(deviceId, {
            type:   'device',
            common: { name: name || deviceType },
            native: { slaveId, deviceType },
        });

        await this.adapter.setObjectNotExistsAsync(`${deviceId}.info`, {
            type:   'channel',
            common: { name: 'Info' },
            native: {},
        });

        await this.adapter.setObjectNotExistsAsync(`${deviceId}.info.connection`, {
            type:   'state',
            common: {
                name:  'Connection',
                type:  'boolean',
                role:  'indicator.connected',
                read:  true,
                write: false,
                def:   false,
            },
            native: {},
        });
        await this.adapter.setStateAsync(`${deviceId}.info.connection`, false, true);

        await this.adapter.setObjectNotExistsAsync(`${deviceId}.info.serial`, {
            type:   'state',
            common: {
                name:  'Serial number',
                type:  'number',
                role:  'info.serial',
                read:  true,
                write: false,
            },
            native: {},
        });
    }

    /**
     * Создаёт иерархию объектов для активных каналов устройства.
     *
     * channels = [
     *   { id, name, measurements: [...], settings: [...] },
     *   ...
     * ]
     *
     * Результирующее дерево:
     *   deviceId.channelId                  ← channel
     *   deviceId.channelId.measurementId    ← state, ro
     *   deviceId.channelId.settingId        ← state, rw
     */
    async createChannelObjects(deviceId, channels) {
        for (const ch of channels) {
            // Папка канала
            await this.adapter.setObjectAsync(`${deviceId}.${ch.id}`, {
                type:   'channel',
                common: { name: ch.name || ch.id },
                native: {},
            });

            // Measurements — read-only стейты
            for (const m of (ch.measurements || [])) {
                await this.adapter.setObjectAsync(`${deviceId}.${ch.id}.${m.id}`, {
                    type:   'state',
                    common: {
                        name:  m.name,
                        type:  m.type  || 'number',
                        role:  m.role  || 'value',
                        unit:  m.unit  || '',
                        read:  true,
                        write: false,
                    },
                    native: {
                        address: m.address,
                        regType: m.regType,
                        format:  m.format,
                    },
                });
            }

            // Settings — read-write стейты
            for (const s of (ch.settings || [])) {
                await this.adapter.setObjectAsync(`${deviceId}.${ch.id}.${s.id}`, {
                    type:   'state',
                    common: {
                        name:   s.name,
                        type:   'number',
                        role:   'value',
                        read:   true,
                        write:  s.write !== false,
                        min:    s.min  !== null ? s.min  : undefined,
                        max:    s.max  !== null ? s.max  : undefined,
                        states: s.states || undefined,
                        def:    s.default !== null ? s.default : undefined,
                    },
                    native: {
                        address: s.address,
                        regType: s.regType,
                        format:  s.format,
                    },
                });
            }
        }
    }
}

module.exports = ObjectManager;