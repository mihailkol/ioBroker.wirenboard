'use strict';

/**
 * wb-template-parser.js  (v3 — условные каналы)
 *
 * Парсит WB-шаблоны в структуру:
 *
 *   template {
 *     deviceType, title, signatures, deprecated,
 *     info:     { serial, fwVersion, uptime, ... },
 *     channels: [ { id, name, condition, measurements[], settings[] } ],
 *     resolveChannels(flatConfig, sensorCounts?) → Channel[]
 *   }
 *
 * Channel.condition — строка вида "in1_mode==0" из шаблона.
 * Measurement.condition — то же самое.
 *
 * resolveChannels(flatConfig, sensorCounts):
 *   flatConfig   = { in1_mode: 0, in2_mode: 1, ... }  — значения holding-параметров
 *   sensorCounts = { gg_in1_temp: 3, gg_in2_temp: 0 } — сколько 1-Wire датчиков опрашивать
 *   → возвращает только активные каналы с обрезанными measurements
 */

const nunjucks = require('nunjucks');
const path     = require('path');
const fs       = require('fs');

// ─── Системные каналы → поле info ────────────────────────────────────────────

const INFO_FIELDS = {
    'Serial':                 'serial',
    'Серийный номер':         'serial',
    'FW Version':             'fwVersion',
    'Версия прошивки':        'fwVersion',
    'FW_Version':             'fwVersion',
    'Uptime':                 'uptime',
    'Время работы с момента включения': 'uptime',
    'HW Batch Number':        'hwBatch',
    'Номер партии':           'hwBatch',
    'HW_Batch_Number':        'hwBatch',
    'MCU Temperature':        'mcuTemp',
    'Температура МК':         'mcuTemp',
    'MCU Voltage':            'mcuVoltage',
    'Supply Voltage':         'supplyVoltage',
    'Напряжение питания':     'supplyVoltage',
    'Minimum Voltage Since Startup':     'minVoltage',
    'Minimum MCU Voltage Since Startup': 'minMcuVoltage',
    'Internal Temperature':   'internalTemp',
    'Температура внутри модуля': 'internalTemp',
    '5V Output':              'output5v',
    'Напряжение на клеммах 5V': 'output5v',
    'Internal 5V Bus Voltage':'bus5v',
    'Напряжение внутренней шины 5В': 'bus5v',
    'AVCC Reference':         'avcc',
};

// ─── Jinja defaults ───────────────────────────────────────────────────────────

const JINJA_DEFAULTS = {
    CHANNELS_NUMBER: 6,
    TYPES_WITH_GAIN: [3, 257],
    TYPES_WITH_MIN_MAX: [5376, 4864, 4865, 4866, 5120, 5121],
    TYPES_WITH_SINGLE_VALUE_CHANNEL: [4864, 4865, 4866, 5120, 5121],
    TYPES_WITH_SINGLE_END: [1,2,3,6,4352,4353,4354,4355,4368,4369,4370,4371,
        4384,4385,4386,4387,4400,4401,4402,4864,4865,4866,5120,5121,
        5632,5889,5890,5891,5892,5893,5894,5895,6144],
    OUTPUTS_NUMBER: 6,
    CURTAINS_NUMBER: 3,
    MMATRIX_OUTPUTS_NUMBER: 8,
    CURTAINS_MMATRIX_OUTPUTS_NUMBER: 4,
    FIRST_INPUT: 0,
    INPUTS_NUMBER: 2,
    FIRST_SENSOR: 1,
    SENSORS_NUMBER: 20,
    SENSORS_NUMBER_WITH_RESERVE: 40,
    title_en: 'Device',
    title_ru: 'Устройство',
    has_signature: true,
};

// ─── Маппинги ─────────────────────────────────────────────────────────────────

const FORMAT_MAP = {
    u8:      { fmt:'u16',    regs:1 },  s8:    { fmt:'s16',    regs:1 },
    u16:     { fmt:'u16',    regs:1 },  s16:   { fmt:'s16',    regs:1 },
    u24:     { fmt:'u32',    regs:2 },  s24:   { fmt:'s32',    regs:2 },
    u32:     { fmt:'u32',    regs:2 },  s32:   { fmt:'s32',    regs:2 },
    s64:     { fmt:'s64',    regs:4 },  u64:   { fmt:'u64',    regs:4 },
    float:   { fmt:'float',  regs:2 },
    string:  { fmt:'string', regs:1 },
    bcd8:    { fmt:'bcd',    regs:1 },  bcd16: { fmt:'bcd',    regs:1 },
    bcd24:   { fmt:'bcd',    regs:2 },  bcd32: { fmt:'bcd',    regs:2 },
    'w1-id': { fmt:'u64',    regs:4 },
};

const TYPE_ROLE_MAP = {
    switch:            { role:'switch',                  type:'boolean' },
    pushbutton:        { role:'button',                  type:'boolean' },
    alarm:             { role:'sensor.alarm',            type:'boolean' },
    temperature:       { role:'value.temperature',       type:'number'  },
    humidity:          { role:'value.humidity',          type:'number'  },
    pressure:          { role:'value.pressure',          type:'number'  },
    illuminance:       { role:'value.brightness',        type:'number'  },
    lux:               { role:'value.brightness',        type:'number'  },
    voltage:           { role:'value.voltage',           type:'number'  },
    current:           { role:'value.current',           type:'number'  },
    power:             { role:'value.power',             type:'number'  },
    power_consumption: { role:'value.power.consumption', type:'number'  },
    energy:            { role:'value.power.consumption', type:'number'  },
    resistance:        { role:'value',                   type:'number'  },
    concentration:     { role:'value',                   type:'number'  },
    range:             { role:'level',                   type:'number'  },
    value:             { role:'value',                   type:'number'  },
    rel_humidity:      { role:'value.humidity',          type:'number'  },
    text:              { role:'text',                    type:'string'  },
    rgb:               { role:'level.color.rgb',         type:'string'  },
    'w1-id':           { role:'text',                    type:'string'  },
};

// ─── Утилиты ───────────────────────────────────────────────────────────────────

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
    const s = String(val).trim();
    return /^0[xX]/.test(s) ? parseInt(s, 16) : parseInt(s, 10);
}

function safeId(name) {
    return String(name)
        .replace(/[^a-zA-Z0-9_]/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '');
}

function getFormatInfo(wbFormat) {
    return FORMAT_MAP[(wbFormat || 'u16').toLowerCase()] || FORMAT_MAP['u16'];
}

function getRoleAndType(wbType, regType) {
    if (regType === 'coil' || regType === 'discrete') return { role:'switch', type:'boolean' };
    return TYPE_ROLE_MAP[(wbType || 'value').toLowerCase()] || { role:'value', type:'number' };
}

function parseStates(item) {
    if (!Array.isArray(item.enum) || !Array.isArray(item.enum_titles)) return null;
    if (!item.enum_titles.length) return null;
    const s = {};
    item.enum.forEach((v, i) => { s[String(v)] = item.enum_titles[i] ?? String(v); });
    return s;
}

function cleanCondition(cond) {
    if (!cond) return null;
    return String(cond).replace(/\s+/g, ' ').trim() || null;
}

// ─── Evaluator условий ────────────────────────────────────────────────────────

/**
 * Вычисляет condition-строку против плоского конфига.
 * @param {string} condition
 * @param {object} flatConfig  { paramId: numericValue }
 * @returns {boolean}
 */
function evalCondition(condition, flatConfig) {
    if (!condition) return true;
    const cond = condition.replace(/\s+/g, '').replace(/[()]/g, '');
    return cond.split('||').some(part =>
        part.split('&&').every(expr => _evalExpr(expr, flatConfig))
    );
}

function _evalExpr(expr, cfg) {
    let m;
    m = expr.match(/^isDefined\((\w+)\)==(\d+)$/);
    if (m) return (cfg[m[1]] !== undefined ? 1 : 0) === parseInt(m[2]);

    m = expr.match(/^(\w+)==(-?\d+)$/);
    if (m) return Number(cfg[m[1]]) === parseInt(m[2]);

    m = expr.match(/^(\w+)!=(-?\d+)$/);
    if (m) return Number(cfg[m[1]]) !== parseInt(m[2]);

    m = expr.match(/^(\w+)>=(-?\d+)$/);
    if (m) return Number(cfg[m[1]]) >= parseInt(m[2]);

    m = expr.match(/^(\w+)<=(-?\d+)$/);
    if (m) return Number(cfg[m[1]]) <= parseInt(m[2]);

    return true;
}

// ─── Jinja рендеринг ───────────────────────────────────────────────────────────

function renderJinja(source, extraVars = {}) {
    const env = new nunjucks.Environment(null, { autoescape:false, throwOnUndefined:false });

    env.addGlobal('joiner', function(sep = ', ') {
        let first = true;
        return () => { if (first) { first = false; return ''; } return sep; };
    });

    env.addGlobal('isDefined', val => (val !== undefined && val !== null) ? 1 : 0);

    env.addFilter('format', function(fmt, ...args) {
        let i = 0;
        return String(fmt).replace(/%([sdx%])/g, (_, spec) => {
            if (spec === '%') return '%';
            const v = args[i++];
            if (spec === 'x') return Number(v).toString(16);
            if (spec === 'd') return String(Math.floor(Number(v)));
            return String(v);
        });
    });

    return env.renderString(source, { ...JINJA_DEFAULTS, ...extraVars });
}

// ─── Очистка JSON ──────────────────────────────────────────────────────────────

function cleanJson(str) {
    return str
        .replace(/\/\/[^\n]*/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/,(\s*[}\]])/g, '$1');
}

// ─── Парсинг базового дескриптора регистра ─────────────────────────────────────

function parseRegBase(item) {
    const address = parseAddress(item.address);
    if (isNaN(address)) return null;

    const regType   = item.reg_type || 'input';
    const wbFormat  = (item.format || 'u16').toLowerCase();
    const fmtInfo   = getFormatInfo(wbFormat);
    const wordOrder = (item.word_order || 'big_endian').includes('little') ? 'le' : 'be';

    let fmt  = fmtInfo.fmt;
    let regs = fmtInfo.regs;

    if (regType === 'coil' || regType === 'discrete') fmt = 'bool';
    if (['switch','pushbutton','alarm'].includes((item.type||'').toLowerCase())) fmt = 'bool';
    if (wbFormat === 'string' && item.string_data_size) regs = Math.ceil(item.string_data_size / 2);

    return { address, regType, format: fmt, count: regs, wordOrder };
}

// ─── Парсинг Measurement ──────────────────────────────────────────────────────

function parseMeasurement(item, t) {
    const base = parseRegBase(item);
    if (!base) return null;

    if (item.enabled === false) return null;
    if (base.format === 'string') return null;
    if (base.regType === 'press_counter') return null;
    if (base.regType === 'holding') return null;

    const roleType = getRoleAndType(item.type, base.regType);
    const name = t(item.name || item.title || `reg_${base.address}`);

    // id: берём оригинальный item.id если есть,
    // иначе строим из типа регистра + адреса чтобы избежать "2", "2_2" и т.п.
    const rawId = item.id
        ? safeId(item.id)
        : safeId(name).match(/^\d/)
            ? `${base.regType}_${base.address}`   // имя начинается с цифры — плохой id
            : safeId(name);

    return {
        id:         rawId,
        name,
        ...base,
        scale:      item.scale     !== undefined ? Number(item.scale)     : 1,
        offset:     item.offset    !== undefined ? Number(item.offset)    : 0,
        roundTo:    item.round_to  !== undefined ? Number(item.round_to)  : null,
        unit:       item.units || item.unit || '',
        role:       roleType.role,
        type:       roleType.type,
        errorValue: parseErrorValue(item.error_value),
        sporadic:   !!(item.sporadic || item['semi-sporadic']),
        condition:  cleanCondition(item.condition),
        // coil и switch-типы могут быть writable
        writable:   base.regType === 'coil' || (base.regType === 'holding' && item.readonly !== true),
    };
}

// ─── Парсинг Setting ──────────────────────────────────────────────────────────

function parseSetting(id, item, t) {
    const base = parseRegBase(item);
    if (!base) return null;

    const name = t(item.name || item.title || id);

    const states = parseStates(item);

    // isConfig: параметр определяет топологию каналов (какие каналы активны).
    // Критерий из оригинального адаптера:
    //   - есть enum с >= 2 значениями
    //   - нет condition (сам задаёт условия, не зависит от других)
    //   - группа не press/general (это тонкая настройка, не топология)
    const groupId = (item.group || '').toLowerCase();
    const isConfig = !!(item.required || (
        !item.condition &&
        states &&
        Object.keys(states).length >= 2 &&
        item.group &&
        !groupId.includes('press') &&
        !groupId.includes('general') &&
        !groupId.includes('debug') &&
        !groupId.includes('hw') &&
        !groupId.includes('output')  // outputs_restore_state и т.п. — не топология
    ));

    return {
        id:        safeId(id),
        name,
        ...base,
        scale:     item.scale   !== undefined ? Number(item.scale)   : 1,
        min:       item.min     !== undefined ? Number(item.min)     : null,
        max:       item.max     !== undefined ? Number(item.max)     : null,
        default:   item.default !== undefined ? item.default         : null,
        states,
        condition: cleanCondition(item.condition),
        isConfig,
        write:     true,
    };
}

// ─── Основной парсер ──────────────────────────────────────────────────────────

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
    const deprecated = !!raw.deprecated;
    const signatures = (raw.hw || []).map(h => h.signature).filter(Boolean);

    // i18n
    const translations = dev.translations || {};
    const i18n = Object.assign({}, translations.ru || {}, translations.en || {});
    const t = str => (str && i18n[str]) ? i18n[str] : (str || '');

    const title = t(raw.title) || t(dev.name) || deviceType;

    // ── info-каналы ───────────────────────────────────────────────────────
    const info = {};
    const nonInfoChannels = [];

    for (const ch of (dev.channels || [])) {
        const chName  = t(ch.name || ch.title || '');
        const infoKey = INFO_FIELDS[ch.name] || INFO_FIELDS[chName];
        if (infoKey) {
            const base = parseRegBase(ch);
            if (base) {
                info[infoKey] = {
                    ...base,
                    scale:  ch.scale  !== undefined ? Number(ch.scale)  : 1,
                    offset: ch.offset !== undefined ? Number(ch.offset) : 0,
                    name:   chName,
                };
            }
        } else {
            nonInfoChannels.push(ch);
        }
    }

    if (!info.serial) {
        info.serial = { regType:'input', address:270, format:'u32', count:2, wordOrder:'be', scale:1, offset:0 };
    }

    // ── Группируем каналы по group ────────────────────────────────────────
    // Служебные группы которые не нужны пользователю
    const SKIP_GROUP_PATTERNS = [
        /^gg_w1_bus/,      // шина 1-Wire (новые датчики, счётчики — служебное)
        /^gg_.*_status$/,  // статус датчиков (OK/fail)
        /^gg_.*_sensors$/, // ID датчиков
        /^g_debug/,        // отладка
        /^gg_debug/,       // отладка
    ];

    const groupOrder = [];
    const groupChMap = new Map();

    for (const ch of nonInfoChannels) {
        const groupId = ch.group || '_default';
        if (SKIP_GROUP_PATTERNS.some(re => re.test(groupId))) continue;
        if (!groupChMap.has(groupId)) {
            groupOrder.push(groupId);
            groupChMap.set(groupId, { rawChannels: [] });
        }
        groupChMap.get(groupId).rawChannels.push(ch);
    }

    // Имена групп
    const groupNames = {};
    for (const g of (dev.groups || [])) {
        if (g.id) groupNames[g.id] = t(g.title) || g.id;
    }

    // ── Settings из parameters ────────────────────────────────────────────
    const rawParams  = dev.parameters || {};
    const paramItems = Array.isArray(rawParams)
        ? rawParams.map((p, i) => [p.id || String(i), p])
        : Object.entries(rawParams);

    const groupSettingsMap = new Map();
    for (const [pid, pval] of paramItems) {
        const setting = parseSetting(pid, pval, t);
        if (!setting) continue;
        const gid = pval.group || '_general';
        if (!groupSettingsMap.has(gid)) groupSettingsMap.set(gid, []);
        groupSettingsMap.get(gid).push(setting);
    }

    // ── Сборка каналов (все, включая условные) ────────────────────────────
    const channels = [];

    for (const groupId of groupOrder) {
        const { rawChannels } = groupChMap.get(groupId);

        const seenMIds = new Map();
        const measurements = rawChannels
            .map(ch => parseMeasurement(ch, t))
            .filter(Boolean)
            .map(m => {
                const base = m.id;
                const n    = seenMIds.get(base) || 0;
                seenMIds.set(base, n + 1);
                if (n > 0) m = { ...m, id: `${base}_${n + 1}` };
                return m;
            });

        if (measurements.length === 0) continue;

        // Channel condition: канал активен если все measurements имеют одинаковое condition
        // (M1W2: все measurements группы имеют "in1_mode==0").
        // Если measurements имеют разные conditions (MAI6) — channel condition = null,
        // активность определяется на уровне каждого measurement в resolveChannels.
        const firstCond = measurements[0]?.condition || null;
        const allSameCond = measurements.every(m => (m.condition || null) === firstCond);
        const channelCondition = allSameCond ? firstCond : null;

        const settings = groupSettingsMap.get(groupId) || [];

        channels.push({
            id:        safeId(groupId),
            name:      groupNames[groupId] || groupId,
            condition: channelCondition,
            measurements,
            settings,
        });
    }

    // ── resolveChannels ───────────────────────────────────────────────────
    /**
     * Возвращает активные каналы для данной конфигурации.
     *
     * @param {object} flatConfig
     *   Плоский объект holding-параметров: { in1_mode: 0, in2_mode: 1, ... }
     *
     * @param {object} [sensorCounts]
     *   Ограничение 1-Wire датчиков: { gg_in1_temp: 3, gg_in2_temp: 5 }
     *   Если не задано — берём все measurements канала.
     *
     * @returns {Channel[]}
     */
    const resolveChannels = (flatConfig, sensorCounts = {}) => {
        const cfg    = flatConfig || {};
        const result = [];

        for (const ch of channels) {
            // Фильтр по condition канала
            if (ch.condition && !evalCondition(ch.condition, cfg)) continue;

            // Фильтруем measurements по их conditions
            let active = ch.measurements.filter(m =>
                !m.condition || evalCondition(m.condition, cfg)
            );

            // Дедупликация по адресу: если несколько measurements читают один адрес
            // (напр. IN_1_P_Value/Value_2/Value_3/Value_4 — масштабированные варианты),
            // оставляем только первый активный для каждого адреса.
            const seenAddresses = new Set();
            active = active.filter(m => {
                if (seenAddresses.has(m.address)) return false;
                seenAddresses.add(m.address);
                return true;
            });

            // Обрезаем 1-Wire датчики по лимиту
            // Если канал имеет bus*_temp* measurements — применяем лимит из sensorCounts.
            // При limit=0 убираем и bus-датчики и External_Sensor (канал не настроен).
            // Для каналов с 1-Wire датчиками:
            // - External_Sensor_N (адрес 7/8) всегда работает когда датчик физически подключён
            // - bus_tempN (адреса 1536+) работают только после регистрации через устройство
            // Стратегия: всегда показываем External_Sensor, bus-датчики — только если sensorCounts > 0
            const busRe  = /^bus\d+_temp\d+$/;
            const extRe  = /^External_Sensor/i;
            const hasBus = active.some(m => busRe.test(m.id));

            if (hasBus) {
                const limit = sensorCounts[ch.id] || 0;
                const busOnes = active
                    .filter(m => busRe.test(m.id))
                    .sort((a, b) => {
                        const na = parseInt(a.id.match(/\d+$/)?.[0] || 0);
                        const nb = parseInt(b.id.match(/\d+$/)?.[0] || 0);
                        return na - nb;
                    })
                    .slice(0, limit);
                // External_Sensor оставляем всегда, bus — только по лимиту
                const extOnes = active.filter(m => extRe.test(m.id));
                const others  = active.filter(m => !busRe.test(m.id) && !extRe.test(m.id));
                active = [...others, ...extOnes, ...busOnes];
            }

            if (active.length === 0) continue;

            result.push({ ...ch, measurements: active });
        }

        return result;
    };

    // ── Собираем плоский список isConfig-параметров ──────────────────────────
    // Это параметры типа in1_mode которые определяют топологию каналов.
    // Хранятся отдельно от channels т.к. их group не совпадает с group каналов.
    const configParams = [];
    const seenConfigAddr = new Set();
    for (const [pid, pval] of paramItems) {
        const setting = parseSetting(pid, pval, t);
        if (!setting || !setting.isConfig) continue;
        if (seenConfigAddr.has(setting.address)) continue;
        seenConfigAddr.add(setting.address);
        configParams.push(setting);
    }

    return { deviceType, title, signatures, deprecated, info, channels, configParams, resolveChannels };
}

// ─── Загрузчик директории ─────────────────────────────────────────────────────

function loadTemplatesFromDir(dir) {
    const bySignature = new Map();
    const byType      = new Map();
    const all         = [];
    const errors      = [];

    const files = fs.readdirSync(dir).filter(f =>
        (f.endsWith('.json') || f.endsWith('.jinja')) && !f.includes('.schema.')
    );

    for (const file of files) {
        try {
            const source   = fs.readFileSync(path.join(dir, file), 'utf8');
            const template = parseTemplate(source, file);
            if (template.deprecated) continue;
            all.push(template);
            byType.set(template.deviceType, template);
            for (const sig of template.signatures) bySignature.set(sig, template);
        } catch (e) {
            errors.push({ file, error: e.message });
        }
    }

    return { bySignature, byType, all, errors };
}

module.exports = { parseTemplate, loadTemplatesFromDir, renderJinja, evalCondition };