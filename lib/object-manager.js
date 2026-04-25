'use strict';

/**
 * ObjectManager — создаёт и обновляет объекты в дереве ioBroker.
 */
class ObjectManager {
    constructor(adapter) {
        this.adapter = adapter;
    }

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

    async createChannelObjects(deviceId, channels) {
        for (const ch of channels) {
            // Используем extendObjectAsync чтобы гарантированно обновить тип
            await this.adapter.extendObjectAsync(`${deviceId}.${ch.id}`, {
                type:   'channel',
                common: { name: ch.name || ch.id },
                native: {},
            });

            // Measurements
            for (const m of (ch.measurements || [])) {
                const isWritable = m.writable === true;
                const ioType     = _formatToIoType(m.format);
                const ioRole     = isWritable          ? 'switch'
                    : ioType === 'boolean'              ? 'indicator'
                    : ioType === 'string'               ? 'info'
                    : 'value';

                await this.adapter.extendObjectAsync(`${deviceId}.${ch.id}.${m.id}`, {
                    type:   'state',
                    common: {
                        name:  m.name,
                        type:  ioType,
                        role:  ioRole,
                        unit:  m.unit || '',
                        read:  true,
                        write: isWritable,
                    },
                    native: {
                        address: m.address,
                        regType: m.regType,
                        format:  m.format,
                    },
                });
            }

            // Settings
            for (const s of (ch.settings || [])) {
                // Enum-настройки всегда number, bool-форматы → boolean, остальное → number
                const ioType = s.states ? 'number' : _formatToIoType(s.format);
                await this.adapter.extendObjectAsync(`${deviceId}.${ch.id}.${s.id}`, {
                    type:   'state',
                    common: {
                        name:   s.name,
                        type:   ioType,
                        role:   'value',
                        read:   true,
                        write:  s.write !== false,
                        min:    s.min  != null ? s.min  : undefined,
                        max:    s.max  != null ? s.max  : undefined,
                        states: s.states || undefined,
                        def:    s.default != null ? s.default : undefined,
                    },
                    native: {
                        address: s.address,
                        format:  s.format,
                    },
                });
            }
        }
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Modbus формат → тип ioBroker.
 *   bool / discrete / coil  → 'boolean'
 *   string                  → 'string'
 *   всё остальное           → 'number'
 */
function _formatToIoType(format) {
    if (!format) return 'number';
    if (format === 'bool' || format === 'boolean') return 'boolean';
    if (format === 'string') return 'string';
    return 'number';
}

module.exports = ObjectManager;