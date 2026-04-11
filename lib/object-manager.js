'use strict';

/**
 * ObjectManager — создаёт и обновляет объекты в дереве ioBroker.
 *
 * Структура объектов:
 *   wirenboard.0
 *     ├── info.connection              ← общий статус
 *     ├── <gwName>_<devName>           ← channel (устройство)
 *     │   ├── info.connection          ← онлайн/офлайн
 *     │   ├── info.serial              ← серийный номер
 *     │   ├── <channelId>              ← state (значение канала)
 *     │   └── ...
 */
class ObjectManager {
    /**
     * @param {import('@iobroker/adapter-core').Adapter} adapter
     */
    constructor(adapter) {
        this.adapter = adapter;
    }

    /**
     * Создаёт channel верхнего уровня для устройства и служебные объекты.
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
     * Создаёт state-объекты для всех каналов устройства.
     * Вызывается из onDeviceReady — после инициализации, до первого поллинга.
     *
     * @param {object} deviceState — объект из DeviceManager
     */
    async createDeviceObjects(deviceState) {
        const { deviceId, template } = deviceState;
        this.adapter.log.info(`createDeviceObjects: ${deviceId}, channels=${template.channels.length}, params=${template.parameters.length}`);
        let created = 0, skipped = 0;
        // Создаём объекты для каналов (read-only данные)
        for (const ch of template.channels) {
            // Пропускаем disabled и условные каналы
            if (ch.enabled === false) { skipped++; continue; }
            if (ch.role === 'button')  { skipped++; continue; }
            created++;

            // Создаём group-папку если есть
            if (ch.group) {
                await this.adapter.setObjectNotExistsAsync(`${deviceId}.${ch.group}`, {
                    type:   'channel',
                    common: { name: ch.group },
                    native: {},
                });
            }

            const stateId = ch.group
                ? `${deviceId}.${ch.group}.${ch.id}`
                : `${deviceId}.${ch.id}`;

            await this.adapter.setObjectAsync(stateId, {
                type:   'state',
                common: {
                    name:  ch.name,
                    type:  ch.type  || 'number',
                    role:  ch.role  || 'value',
                    unit:  ch.unit  || '',
                    read:  true,
                    write: false,
                    states: ch.states || undefined,
                },
                native: {
                    address: ch.address,
                    regType: ch.regType,
                    format:  ch.format,
                },
            });
            this.adapter.log.info(`createDeviceObjects done: created=${created}, skipped=${skipped}`);

        }

        // Создаём объекты для writable параметров
        for (const p of template.parameters) {
            if (!p.writable) continue;

            await this.adapter.setObjectAsync(`${deviceId}.${p.id}`, {
                type:   'state',
                common: {
                    name:   p.name,
                    type:   p.type  || 'number',
                    role:   p.role  || 'value',
                    unit:   p.unit  || '',
                    read:   true,
                    write:  true,
                    min:    p.min   !== null ? p.min   : undefined,
                    max:    p.max   !== null ? p.max   : undefined,
                    states: p.states || undefined,
                    def:    p.defaultVal !== null ? p.defaultVal : undefined,
                },
                native: {
                    address: p.address,
                    regType: p.regType,
                    format:  p.format,
                    scale:   p.scale,
                },
            });
        }
    }
}

module.exports = ObjectManager;
