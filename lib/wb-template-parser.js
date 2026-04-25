'use strict';

const fs   = require('fs');
const path = require('path');

/**
 * Парсер шаблонов WB-устройств.
 *
 * Формат шаблона (JSON-файл в lib/wb-templates/):
 * {
 *   "device_type": "WB-MR3LV",
 *   "signatures": ["WBMR3LV"],
 *
 *   "enums": {
 *     "in_mode": {
 *       "0": { "label": "Кнопка" },
 *       "3": { "label": "Отключён", "disables": ["in0_state", "in0_counter"] }
 *     }
 *   },
 *
 *   "channels": [
 *     {
 *       "id": "relay_k1",
 *       "name": "Реле K1"
 *     },
 *     {
 *       "id": "in0",
 *       "name": "Вход 1",
 *       "depends_on": { "setting": "in0_mode", "op": "!=", "value": 3 }
 *     },
 *     {
 *       "id": "in1N",
 *       "name": "Вход 1N",
 *       "depends_on": { "setting": "in1P_sensor_type", "not_flag": "differential" }
 *     }
 *   ],
 *
 *   "registers": [
 *     {
 *       "id":              "in0_mode",      — уникальный id в рамках шаблона
 *       "name":            "Режим входа 1",
 *       "channel":         "in0",           — ссылка на channels[].id
 *       "type":            "setting",       — system|fast|slow|setting|command
 *       "reg_type":        "holding",       — holding|input|coil|discrete
 *       "address":         9,
 *       "format":          "u16",           — u16|s16|u32|s32|u64|float|bool|string
 *       "word_order":      "be",            — be (default) | le
 *       "enum":            "in_mode",       — ссылка на enums{}
 *       "default":         0,
 *       "flat":            true,            — хранится в config.flat, влияет на топологию
 *       "device_register": false,           — false = только адаптер, не читать/писать железо
 *       "writable":        true,            — разрешена запись из UI (coil/holding)
 *       "scale":           0.01,
 *       "offset":          0,
 *       "unit":            "В",
 *       "error_value":     32767,           — значение = ошибка датчика
 *       "depends_on": {                     — условие активности регистра
 *         "setting": "in0_mode",            — id flat-регистра
 *         "op":      "!=",                  — ==|!=|<|>|<=|>=
 *         "value":   3
 *       }
 *       // или для enum-флага:
 *       "depends_on": {
 *         "setting":  "in1P_sensor_type",
 *         "not_flag": "differential"        — активен если у текущего значения НЕТ флага
 *       }
 *     }
 *   ]
 * }
 *
 * Типы регистров (type):
 *   system  — читается один раз при старте (серийник, FW)         → P3
 *   fast    — sporadic: дискретные входы, coil                    → P1
 *   slow    — аналог, счётчики, температура                       → P2
 *   setting — holding-параметры конфигурации (P4, по запросу)
 *   command — writable coil/holding (читается fast, пишется P0)
 */

// Приоритеты поллинга по типу регистра
const TYPE_PRIORITY = {
    system:  3,
    fast:    1,
    slow:    2,
    setting: 4,
    command: 1,
};

// ─── Публичный API ────────────────────────────────────────────────────────────

/**
 * Загружает все шаблоны из директории.
 * @param {string} dir
 * @returns {{ bySignature: Map, byType: Map, all: WbTemplate[], errors: [] }}
 */
function loadTemplatesFromDir(dir) {
    const result = {
        bySignature: new Map(),
        byType:      new Map(),
        all:         [],
        errors:      [],
    };

    if (!fs.existsSync(dir)) return result;

    for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith('.json')) continue;
        const filePath = path.join(dir, file);
        try {
            const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            const tmpl = new WbTemplate(raw);
            result.all.push(tmpl);
            result.byType.set(tmpl.deviceType, tmpl);
            // aliases — альтернативные device_type (для обратной совместимости конфигов)
            for (const alias of (raw.aliases || [])) {
                result.byType.set(alias, tmpl);
            }
            for (const sig of tmpl.signatures) {
                result.bySignature.set(sig.toUpperCase(), tmpl);
            }
        } catch (e) {
            result.errors.push({ file, error: e.message });
        }
    }
    return result;
}

/**
 * Загружает один шаблон из файла или объекта.
 * @param {string|object} src
 * @returns {WbTemplate}
 */
function loadTemplate(src) {
    const raw = typeof src === 'string'
        ? JSON.parse(fs.readFileSync(src, 'utf8'))
        : src;
    return new WbTemplate(raw);
}

// ─── WbTemplate ───────────────────────────────────────────────────────────────

class WbTemplate {
    constructor(raw) {
        _validate(raw);

        this.deviceType = raw.device_type;
        this.signatures = (raw.signatures || []).map(s => s.toUpperCase());
        this.enums      = raw.enums || {};

        // Индекс каналов id → raw channel obj
        this._channelDefs = new Map();
        for (const ch of raw.channels || []) {
            this._channelDefs.set(ch.id, ch);
        }

        // Все регистры (полный список)
        this._registerDefs = raw.registers || [];

        // Быстрый поиск по id
        this._registerById = new Map();
        for (const r of this._registerDefs) {
            this._registerById.set(r.id, r);
        }

        // configParams — flat-регистры для чтения с железа (влияют на топологию)
        // Только те у которых device_register !== false
        this.configParams = this._registerDefs.filter(
            r => r.flat && r.device_register !== false
        );

        // info — системные регистры (serial, fw_version)
        // Строим объект совместимый со старым форматом для device-manager
        this.info = this._buildInfo();
    }
    /**
     * Возвращает активные каналы с учётом текущего конфига.
     *
     * @param {object} flatConfig   — { [registerId]: value } из config.flat
     * @param {object} sensorCounts — { [channelId]: count } (для M1W2)
     * @returns {ChannelDescriptor[]}
     */
    resolveChannels(flatConfig = {}, sensorCounts = {}) {
        const activeChannels = [];

        for (const [chId, chDef] of this._channelDefs) {
            // Проверяем условие активности канала
            if (!this._channelActive(chDef, flatConfig)) continue;

            // Собираем активные регистры этого канала
            const regs = this._registerDefs.filter(r => r.channel === chId);

            const measurements = [];
            const settings     = [];

            for (const r of regs) {
                // Проверяем зависимость регистра
                if (!this._registerActive(r, flatConfig)) continue;

                const desc = this._buildRegDesc(r, flatConfig, sensorCounts);
                if (!desc || desc.length === 0) continue;

                if (r.type === 'setting') {
                    settings.push(...desc);
                } else {
                    measurements.push(...desc);
                }
            }

            if (measurements.length === 0 && settings.length === 0) continue;

            activeChannels.push(new ChannelDescriptor({
                id:           chId,
                name:         chDef.name || chId,
                measurements,
                settings,
            }));
        }

        return activeChannels;
    }

    // ─── Внутренние методы ────────────────────────────────────────────────────

    /**
     * Проверяет активен ли канал по depends_on.
     */
    _channelActive(chDef, flatConfig) {
        if (!chDef.depends_on) return true;
        return this._evalDepends(chDef.depends_on, flatConfig);
    }

    /**
     * Проверяет активен ли регистр по depends_on.
     */
    _registerActive(regDef, flatConfig) {
        if (!regDef.depends_on) return true;
        return this._evalDepends(regDef.depends_on, flatConfig);
    }

    /**
     * Вычисляет условие depends_on.
     * Поддерживает два формата:
     *   { setting, op, value }           — сравнение значения
     *   { setting, not_flag }            — проверка отсутствия флага у текущего enum-значения
     *   { setting, has_flag }            — проверка наличия флага
     */
    _evalDepends(dep, flatConfig) {
        let settingVal = flatConfig[dep.setting];

        // Если значение не задано — берём default из шаблона (важно для adapter_* настроек)
        if (settingVal === undefined || settingVal === null) {
            const regDef = this._registerById.get(dep.setting);
            if (regDef && regDef.default !== undefined && regDef.default !== null) {
                settingVal = regDef.default;
            } else {
                return true; // нет default — показываем
            }
        }

        // Режим флага enum
        if (dep.not_flag || dep.has_flag) {
            const flag    = dep.not_flag || dep.has_flag;
            const enumKey = this._findEnumForSetting(dep.setting);
            if (!enumKey) return true;
            const enumDef = this.enums[enumKey];
            if (!enumDef) return true;
            const valueDef = enumDef[String(settingVal)];
            const hasFlag  = !!(valueDef && valueDef[flag]);
            return dep.not_flag ? !hasFlag : hasFlag;
        }

        // Режим сравнения
        const lhs = Number(settingVal);
        const rhs = Number(dep.value);
        switch (dep.op) {
            case '==': return lhs === rhs;
            case '!=': return lhs !== rhs;
            case '<':  return lhs <   rhs;
            case '>':  return lhs >   rhs;
            case '<=': return lhs <=  rhs;
            case '>=': return lhs >=  rhs;
            default:   return true;
        }
    }

    /**
     * Находит имя enum для регистра по его id.
     */
    _findEnumForSetting(settingId) {
        const regDef = this._registerById.get(settingId);
        return regDef ? regDef.enum : null;
    }

    /**
     * Строит дескриптор(ы) регистра для device-manager.
     * Возвращает массив MeasurementDescriptor (для settings — один объект).
     *
     * Для setting-регистров возвращает SettingDescriptor в массиве.
     */
    _buildRegDesc(r, flatConfig, sensorCounts) {
        if (r.type === 'setting') {
            return [new SettingDescriptor(r, this.enums)];
        }

        // Для адаптерных (не device_register) — не создаём measurement
        if (r.device_register === false) return [];

        return [new MeasurementDescriptor(r)];
    }

    /**
     * Строит объект info для device-manager (совместимость).
     * Ищет регистры с id === 'serial', 'fw_version' и т.д.
     */
    _buildInfo() {
        const info = {};
        for (const r of this._registerDefs) {
            if (r.type !== 'system') continue;
            info[r.id] = {
                address:  r.address,
                count:    r.count || _formatWordCount(r.format),
                regType:  r.reg_type,
                format:   r.format,
                scale:    r.scale,
                offset:   r.offset,
            };
        }
        return info;
    }
}

// ─── Дескрипторы ─────────────────────────────────────────────────────────────

class ChannelDescriptor {
    constructor({ id, name, measurements, settings }) {
        this.id           = id;
        this.name         = name;
        this.measurements = measurements;
        this.settings     = settings;
    }
}

class MeasurementDescriptor {
    constructor(r) {
        this.id          = r.id;
        this.name        = r.name;
        this.regType     = r.reg_type;
        this.address     = r.address;
        this.format      = r.format  || 'u16';
        this.wordOrder   = r.word_order || 'be';
        this.scale       = r.scale;
        this.offset      = r.offset;
        this.unit        = r.unit;
        this.errorValue  = r.error_value;
        this.writable    = r.writable || false;
        this.sporadic    = r.type === 'fast' || r.type === 'command';
        this.priority    = TYPE_PRIORITY[r.type] || 2;
    }
}

class SettingDescriptor {
    constructor(r, enums) {
        this.id        = r.id;
        this.name      = r.name;
        this.address   = r.device_register === false ? null : r.address;
        this.format    = r.format || 'u16';
        this.scale     = r.scale;
        this.offset    = r.offset;
        this.default   = r.default;
        this.min       = r.min;
        this.max       = r.max;
        this.write     = r.device_register !== false; // адаптерные не пишем
        this.isConfig  = r.flat || false;
        this.condition = r.depends_on || null;

        // Разворачиваем enum в states {value: label}
        if (r.enum && enums[r.enum]) {
            this.states = {};
            for (const [k, v] of Object.entries(enums[r.enum])) {
                this.states[k] = typeof v === 'object' ? v.label : v;
            }
        } else {
            this.states = null;
        }
    }
}

// ─── Вспомогательные ──────────────────────────────────────────────────────────

function _formatWordCount(format) {
    switch (format) {
        case 'u32': case 's32': case 'float': return 2;
        case 'u64': case 's64':               return 4;
        default:                               return 1;
    }
}

function _validate(raw) {
    if (!raw || typeof raw !== 'object') throw new Error('Template must be an object');
    if (!raw.device_type) throw new Error('Missing device_type');
    if (!Array.isArray(raw.channels))  throw new Error('Missing channels[]');
    if (!Array.isArray(raw.registers)) throw new Error('Missing registers[]');

    // Проверяем уникальность id регистров
    const ids = new Set();
    for (const r of raw.registers) {
        if (!r.id)      throw new Error(`Register missing id`);
        if (!r.channel) throw new Error(`Register "${r.id}" missing channel`);
        if (!r.type)    throw new Error(`Register "${r.id}" missing type`);
        if (ids.has(r.id)) throw new Error(`Duplicate register id: "${r.id}"`);
        ids.add(r.id);
    }

    // Проверяем что каналы регистров существуют
    const chIds = new Set((raw.channels || []).map(c => c.id));
    for (const r of raw.registers) {
        if (!chIds.has(r.channel)) {
            throw new Error(`Register "${r.id}" references unknown channel "${r.channel}"`);
        }
    }
}

module.exports = { loadTemplatesFromDir, loadTemplate, WbTemplate };