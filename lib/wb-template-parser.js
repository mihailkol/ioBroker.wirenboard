'use strict';

/**
 * wb-template-parser.js
 *
 * Парсит шаблоны wb-mqtt-serial (.json и .json.jinja) в два независимых
 * набора данных:
 *
 *  1. channels[]   — каналы для ЧТЕНИЯ (поллинг Modbus)
 *  2. parameters[] — параметры для ЗАПИСИ (конфигурация устройства)
 *
 * Поддерживаемые особенности шаблонов WB:
 *  - .json.jinja с Jinja2-синтаксисом (рендерим через nunjucks)
 *  - hex-адреса ("0x1400") и decimal
 *  - форматы: u8/s8/u16/s16/u24/s24/u32/s32/s64/u64/float/string/bcd*
 *  - word_order: big_endian (default) / little_endian
 *  - scale, offset, round_to
 *  - error_value (hex или decimal)
 *  - sporadic / semi-sporadic
 *  - enabled: false  → канал существует, но не опрашивается по умолчанию
 *  - condition       → сохраняем как строку, runtime решает включать ли канал
 *  - parameters (объект или массив) → writable-параметры устройства
 *  - reg_type: coil / discrete / holding / input / press_counter
 */

const nunjucks = require('nunjucks');
const path     = require('path');
const fs       = require('fs');

// ─── Jinja defaults для всех известных устройств ─────────────────────────────

const JINJA_DEFAULTS = {
    // MAI6
    CHANNELS_NUMBER: 6,
    TYPES_WITH_GAIN: [3, 257],
    TYPES_WITH_MIN_MAX: [5376, 4864, 4865, 4866, 5120, 5121],
    TYPES_WITH_SINGLE_VALUE_CHANNEL: [4864, 4865, 4866, 5120, 5121],
    TYPES_WITH_SINGLE_END: [1, 2, 3, 6, 4352, 4353, 4354, 4355, 4368, 4369,
        4370, 4371, 4384, 4385, 4386, 4387, 4400, 4401, 4402,
        4864, 4865, 4866, 5120, 5121, 5632, 5889, 5890, 5891,
        5892, 5893, 5894, 5895, 6144],
    // MR6C
    OUTPUTS_NUMBER: 6,
    CURTAINS_NUMBER: 3,
    MMATRIX_OUTPUTS_NUMBER: 8,
    CURTAINS_MMATRIX_OUTPUTS_NUMBER: 4,
    FIRST_INPUT: 0,
    // M1W2
    INPUTS_NUMBER: 2,
    FIRST_SENSOR: 1,
    SENSORS_NUMBER: 20,
    SENSORS_NUMBER_WITH_RESERVE: 40,
    // Generic
    title_en: 'Device',
    title_ru: 'Устройство',
    has_signature: true,
};

// ─── Маппинг WB-форматов ──────────────────────────────────────────────────────

const FORMAT_MAP = {
    u8:      { fmt: 'u16',    regs: 1 },
    s8:      { fmt: 's16',    regs: 1 },
    u16:     { fmt: 'u16',    regs: 1 },
    s16:     { fmt: 's16',    regs: 1 },
    u24:     { fmt: 'u32',    regs: 2 },
    s24:     { fmt: 's32',    regs: 2 },
    u32:     { fmt: 'u32',    regs: 2 },
    s32:     { fmt: 's32',    regs: 2 },
    s64:     { fmt: 's64',    regs: 4 },
    u64:     { fmt: 'u64',    regs: 4 },
    float:   { fmt: 'float',  regs: 2 },
    string:  { fmt: 'string', regs: 1 },
    bcd8:    { fmt: 'bcd',    regs: 1 },
    bcd16:   { fmt: 'bcd',    regs: 1 },
    bcd24:   { fmt: 'bcd',    regs: 2 },
    bcd32:   { fmt: 'bcd',    regs: 2 },
    'w1-id': { fmt: 'u64',    regs: 4 },
};

// ─── Маппинг WB control type → ioBroker role + type ─────────────────────────

const TYPE_ROLE_MAP = {
    switch:            { role: 'switch',                  type: 'boolean' },
    pushbutton:        { role: 'button',                  type: 'boolean' },
    alarm:             { role: 'sensor.alarm',            type: 'boolean' },
    temperature:       { role: 'value.temperature',       type: 'number'  },
    humidity:          { role: 'value.humidity',          type: 'number'  },
    pressure:          { role: 'value.pressure',          type: 'number'  },
    illuminance:       { role: 'value.brightness',        type: 'number'  },
    lux:               { role: 'value.brightness',        type: 'number'  },
    voltage:           { role: 'value.voltage',           type: 'number'  },
    current:           { role: 'value.current',           type: 'number'  },
    power:             { role: 'value.power',             type: 'number'  },
    power_consumption: { role: 'value.power.consumption', type: 'number'  },
    energy:            { role: 'value.power.consumption', type: 'number'  },
    resistance:        { role: 'value',                   type: 'number'  },
    concentration:     { role: 'value',                   type: 'number'  },
    range:             { role: 'level',                   type: 'number'  },
    value:             { role: 'value',                   type: 'number'  },
    rel_humidity:      { role: 'value.humidity',          type: 'number'  },
    text:              { role: 'text',                    type: 'string'  },
    rgb:               { role: 'level.color.rgb',         type: 'string'  },
    'w1-id':           { role: 'text',                    type: 'string'  },
};

// ─── Утилиты ──────────────────────────────────────────────────────────────────

function parseAddress(addr) {
    if (typeof addr === 'number') return addr;
    if (typeof addr === 'string') {
        const s = addr.trim();
        return /^0[xX]/.test(s) ? parseInt(s, 16) : parseInt(s, 10);
    }
    return NaN;
}

function parseErrorValue(val) {
    if (val === undefined || val === null) return null;
    if (typeof val === 'number') return val;
    if (typeof val === 'string') {
        const s = val.trim();
        const n = /^0[xX]/.test(s) ? parseInt(s, 16) : parseInt(s, 10);
        // Конвертируем беззнаковые 0x7FFF → signed -1 не нужен,
        // но 0xFFFFFFFF как u32 нужно сохранить как число
        return n;
    }
    return null;
}

function safeId(name) {
    return String(name)
        .replace(/[^a-zA-Z0-9_]/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '');
}

function getFormatInfo(wbFormat) {
    const key = (wbFormat || 'u16').toLowerCase();
    return FORMAT_MAP[key] || FORMAT_MAP['u16'];
}

function getRoleAndType(wbType, regType) {
    if (regType === 'coil' || regType === 'discrete') {
        return { role: 'switch', type: 'boolean' };
    }
    const key = (wbType || 'value').toLowerCase();
    return TYPE_ROLE_MAP[key] || { role: 'value', type: 'number' };
}

// ─── Рендеринг Jinja ──────────────────────────────────────────────────────────

function renderJinja(source, extraVars = {}) {
    const env = new nunjucks.Environment(null, { autoescape: false, throwOnUndefined: false });

    // joiner() — создаёт разделитель, пропускающий первый вызов
    env.addGlobal('joiner', function(sep) {
        sep = sep !== undefined ? sep : ', ';
        let first = true;
        return function() {
            if (first) { first = false; return ''; }
            return sep;
        };
    });

    // isDefined() — проверяет что переменная определена (используется в MAI6 conditions)
    env.addGlobal('isDefined', function(val) {
        return (val !== undefined && val !== null) ? 1 : 0;
    });

    // Фильтр format: "%x"|format(value) → sprintf-подобное форматирование
    // В MAI6: "0x{{ \"%x\"|format(ch_num) }}400" → "0x1400"
    env.addFilter('format', function(fmt, ...args) {
        let result = String(fmt);
        let argIndex = 0;
        result = result.replace(/%([sd%x])/g, (match, spec) => {
            if (spec === '%') return '%';
            const val = args[argIndex++];
            if (spec === 'x') return Number(val).toString(16);
            if (spec === 'd') return String(Math.floor(Number(val)));
            return String(val);
        });
        return result;
    });

    const vars = { ...JINJA_DEFAULTS, ...extraVars };
    return env.renderString(source, vars);
}

// ─── Очистка JSON ─────────────────────────────────────────────────────────────

function cleanJson(str) {
    return str
        .replace(/\/\/[^\n]*/g, '')           // однострочные комментарии
        .replace(/\/\*[\s\S]*?\*\//g, '')      // многострочные комментарии
        .replace(/,(\s*[}\]])/g, '$1');        // trailing commas
}

// ─── Парсинг одного канала или параметра ──────────────────────────────────────

function parseChannel(item, parentGroup) {
    const address = parseAddress(item.address);
    if (isNaN(address)) return null;

    const regType  = item.reg_type || 'input';
    const wbFormat = (item.format || 'u16').toLowerCase();
    const fmtInfo  = getFormatInfo(wbFormat);
    const roleType = getRoleAndType(item.type, regType);
    const wordOrder = (item.word_order || 'big_endian').includes('little') ? 'le' : 'be';

    // writable: holding и coil допускают запись
    let writable = (regType === 'holding' || regType === 'coil');
    if (item.readonly === true || item.readonly === 'true') writable = false;

    // Формат и тип: coil/discrete/switch → bool
    let fmt  = fmtInfo.fmt;
    let type = roleType.type;
    if (regType === 'coil' || regType === 'discrete') {
        fmt = 'bool'; type = 'boolean';
    }
    if (['switch', 'pushbutton', 'alarm'].includes((item.type || '').toLowerCase())) {
        fmt = 'bool'; type = 'boolean';
    }

    // Количество регистров: для string — из string_data_size
    let regs = fmtInfo.regs;
    if (wbFormat === 'string' && item.string_data_size) {
        regs = Math.ceil(item.string_data_size / 2);
    }

    // states из enum + enum_titles
    let states = null;
    if (Array.isArray(item.enum) && Array.isArray(item.enum_titles) && item.enum_titles.length > 0) {
        states = {};
        item.enum.forEach((val, i) => {
            states[String(val)] = item.enum_titles[i] !== undefined
                ? item.enum_titles[i]
                : String(val);
        });
    }

    const name = item.name || item.title || `ch_${address}`;

    return {
        id:         safeId(item.id || name),
        name,
        group:      item.group || parentGroup || null,
        regType,
        address,
        count:      regs,
        format:     fmt,
        wordOrder,
        scale:      item.scale  !== undefined ? Number(item.scale)  : 1,
        offset:     item.offset !== undefined ? Number(item.offset) : 0,
        roundTo:    item.round_to !== undefined ? Number(item.round_to) : null,
        unit:       item.units || item.unit || '',
        role:       roleType.role,
        type,
        writable,
        errorValue: parseErrorValue(item.error_value),
        states,
        min:        item.min !== undefined ? Number(item.min) : null,
        max:        item.max !== undefined ? Number(item.max) : null,
        sporadic:   !!(item.sporadic || item['semi-sporadic']),
        enabled:    item.enabled !== false,
        condition:  item.condition || null,
        defaultVal: item.default !== undefined ? item.default : null,
    };
}

// ─── Парсинг parameters ───────────────────────────────────────────────────────

function parseParameters(params) {
    if (!params) return [];

    // parameters может быть объектом { id: {...} } или массивом [{...}]
    const items = Array.isArray(params)
        ? params
        : Object.entries(params).map(([id, v]) => ({ id, ...v }));

    return items
        .filter(item => item && parseAddress(item.address) !== NaN)
        .map(item => parseChannel(item, null))
        .filter(Boolean);
}

// ─── Основной парсер ──────────────────────────────────────────────────────────

/**
 * Парсит один WB-шаблон.
 *
 * @param {string} source   — содержимое файла
 * @param {string} filename — имя файла
 * @returns {WbTemplate}
 */
function parseTemplate(source, filename = '') {
    let jsonText = source;

    if (filename.endsWith('.jinja') || filename.endsWith('.jinja2')) {
        jsonText = renderJinja(source);
    }

    let raw;
    try {
        raw = JSON.parse(cleanJson(jsonText));
    } catch (e) {
        throw new Error(`JSON parse error in "${filename}": ${e.message}`);
    }

    const dev        = raw.device || {};
    const deviceType = raw.device_type || dev.id || path.basename(filename, '.json');
    const title      = raw.title || dev.name || deviceType;
    const deprecated = !!raw.deprecated;

    const signatures = (raw.hw || []).map(h => h.signature).filter(Boolean);

    const channels   = (dev.channels || [])
        .map(ch => parseChannel(ch, null))
        .filter(Boolean);

    const parameters = parseParameters(dev.parameters);

    return { deviceType, title, signatures, deprecated, channels, parameters };
}

// ─── Загрузчик директории ─────────────────────────────────────────────────────

/**
 * Загружает все шаблоны из директории.
 *
 * @param {string} dir
 * @returns {{ bySignature: Map, byType: Map, all: WbTemplate[], errors: object[] }}
 */
function loadTemplatesFromDir(dir) {
    const bySignature = new Map();
    const byType      = new Map();
    const all         = [];
    const errors      = [];

    const files = fs.readdirSync(dir).filter(f =>
        (f.endsWith('.json') || f.endsWith('.jinja')) &&
        !f.includes('.schema.')
    );

    for (const file of files) {
        try {
            const source   = fs.readFileSync(path.join(dir, file), 'utf8');
            const template = parseTemplate(source, file);
            if (template.deprecated) continue;
            all.push(template);
            byType.set(template.deviceType, template);
            for (const sig of template.signatures) {
                bySignature.set(sig, template);
            }
        } catch (e) {
            errors.push({ file, error: e.message });
        }
    }

    return { bySignature, byType, all, errors };
}

module.exports = { parseTemplate, loadTemplatesFromDir, parseChannel, parseParameters, renderJinja };
