// -----------------------------------------------------------------------------
// The answers of the gateway turned into Gladys devices (pure: no network).
//
// A gateway "function" is one mesh element (docs/gateway-rest-api.md):
//   { id: "id0a1b2c3d4e5f607", type: "OnOff", label: "Hall",
//     datapoints: [{ id: "id0a1b2c3d4e5f607-001", type: "switch",
//                    values: [{ key: "switch", value: "0" }] }] }
// Every value is a string. Only known keys are copied (no prototype from the
// network), counts and lengths are bounded, numbers are strict ('' is unknown).
//
// External ids (frozen, documented in docs/ and CLAUDE.md): device
// `function:<gateway>_<function id>`, scene `scene:<gateway>_<scene id>`,
// <gateway> being `sn<serial>` (or `mac<MAC>` on a firmware without the
// serial). The function id is "id" + md5(node UUID + element) on the
// gateway: kept across firmware updates, new after a re-provisioning.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
} from '@gladysassistant/integration-sdk';
import { FUNCTION_ID } from './config.js';
import { CLICK, COVER_STATE, LIMITS, PRESSED, SETPOINT } from './constants.js';
import { featureName } from './i18n.js';

const DATAPOINT_SUFFIX = /^[0-9a-f]{3}$/i;
const SCENE_ID = /^id[0-9A-Za-z]{1,16}$/;

/** A label from the network: printable, trimmed, bounded; '' when none. */
export function cleanText(value, max = LIMITS.text) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[^\x20-\x7e\u00a0-\u024f\u2000-\u206f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim();
}

/** A strict decimal number from a string of the gateway ('' and junk are unknown). */
export function numberOf(text) {
  if (typeof text !== 'string' || !/^-?\d{1,9}(\.\d{1,6})?$/.test(text.trim())) return undefined;
  return Number(text.trim());
}

/** A datapoint: `{ id, fid, suffix, type, values: Map<key, string> }`, or undefined. */
export function datapointOf(raw, fid) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const id = typeof raw.id === 'string' ? raw.id : '';
  const cut = id.lastIndexOf('-');
  const owner = id.slice(0, cut);
  const suffix = id.slice(cut + 1);
  if (cut < 0 || !FUNCTION_ID.test(owner) || !DATAPOINT_SUFFIX.test(suffix)) return undefined;
  if (fid !== undefined && owner !== fid) return undefined;
  const values = new Map();
  if (Array.isArray(raw.values)) {
    for (const entry of raw.values.slice(0, LIMITS.values)) {
      if (
        entry &&
        typeof entry.key === 'string' &&
        /^[a-z_]{1,40}$/.test(entry.key) &&
        typeof entry.value === 'string' &&
        entry.value.length <= 100
      ) {
        values.set(entry.key, entry.value);
      }
    }
  }
  const type = typeof raw.type === 'string' && /^[a-z_]{1,40}$/.test(raw.type) ? raw.type : '';
  return { id, fid: owner, suffix: suffix.toLowerCase(), type, values };
}

/** One function: `{ id, type, label, datapoints: Map<dpid, datapoint> }`, or undefined. */
export function functionOf(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  if (typeof raw.id !== 'string' || !FUNCTION_ID.test(raw.id)) return undefined;
  const type = typeof raw.type === 'string' && /^[A-Za-z]{1,40}$/.test(raw.type) ? raw.type : '';
  const datapoints = new Map();
  if (Array.isArray(raw.datapoints)) {
    for (const entry of raw.datapoints.slice(0, LIMITS.datapoints)) {
      const dp = datapointOf(entry, raw.id);
      if (dp && !datapoints.has(dp.id)) datapoints.set(dp.id, dp);
    }
  }
  return { id: raw.id, type, label: cleanText(raw.label), datapoints };
}

/** The function list of the gateway, bounded: Map<fid, function>. */
export function functionsOf(list) {
  const out = new Map();
  if (!Array.isArray(list)) return out;
  for (const raw of list.slice(0, LIMITS.functions)) {
    const fn = functionOf(raw);
    if (fn && !out.has(fn.id)) out.set(fn.id, fn);
  }
  return out;
}

/** The scene list: `[{ id, label }]`, bounded. */
export function scenesOf(list) {
  const out = [];
  const seen = new Set();
  if (!Array.isArray(list)) return out;
  for (const raw of list.slice(0, LIMITS.scenes)) {
    const id = raw?.id;
    if (typeof id !== 'string' || !SCENE_ID.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label: cleanText(raw.label) });
  }
  return out;
}

/** The value of `key` in a datapoint (falls back to the datapoint type as key). */
const valueOf = (dp, key = dp.type) => dp?.values.get(key);

/** "0"/"1" -> 0/1, else undefined. */
const bit = (text) => (text === '0' ? 0 : text === '1' ? 1 : undefined);

const intIn = (text, min, max) => {
  const n = numberOf(text);
  return Number.isInteger(n) && n >= min && n <= max ? n : undefined;
};

/** Quantities by unit: the Gladys category, type and unit; others are not published. */
const QUANTITY_UNITS = {
  '°c': {
    category: C.TEMPERATURE_SENSOR,
    type: T.SENSOR.DECIMAL,
    unit: 'celsius',
    min: -50,
    max: 100,
  },
  w: { category: C.ENERGY_SENSOR, type: T.ENERGY_SENSOR.POWER, unit: 'watt', min: 0, max: 100_000 },
  kw: {
    category: C.ENERGY_SENSOR,
    type: T.ENERGY_SENSOR.POWER,
    unit: 'kilowatt',
    min: 0,
    max: 100,
  },
  lux: { category: C.LIGHT_SENSOR, type: T.SENSOR.DECIMAL, unit: 'lux', min: 0, max: 200_000 },
  lx: { category: C.LIGHT_SENSOR, type: T.SENSOR.DECIMAL, unit: 'lux', min: 0, max: 200_000 },
};

export const quantityKind = (dp) =>
  QUANTITY_UNITS[cleanText(valueOf(dp, 'quantity_unit') ?? '', 10).toLowerCase()];

/** A command value of Gladys: a finite number, never null, '' nor a boolean. */
function commandNumber(value) {
  if (value === null || value === undefined || typeof value === 'boolean') return undefined;
  if (typeof value === 'string' && value.trim() === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export class Refusal extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'Refusal';
    this.refusal = code;
  }
}

const bad = () => {
  throw new Refusal('badValue');
};

/**
 * The role of a function, from its type and datapoints; undefined when not offered.
 * The datapoints the role needs are returned with it.
 */
export function roleOf(fn) {
  const byType = (type) => [...fn.datapoints.values()].find((dp) => dp.type === type);
  const quantities = [...fn.datapoints.values()].filter((dp) => dp.type === 'quantity');
  const sw = byType('switch');
  switch (fn.type) {
    case 'OnOff':
      return sw ? { role: 'light', sw, quantities } : undefined;
    case 'DimmerLight':
    case 'ColorLight': {
      const brightness = byType('brightness');
      if (sw && brightness) return { role: 'dimmer', sw, brightness, quantities };
      return sw ? { role: 'light', sw, quantities } : undefined;
    }
    case 'Socket':
      return sw ? { role: 'socket', sw, quantities } : undefined;
    case 'Position':
    case 'PositionAndAngle': {
      const level = byType('level');
      return level ? { role: 'cover', level, quantities } : undefined;
    }
    case 'Thermostat': {
      const ctrl = byType('temperature_ctrl');
      return ctrl || quantities.length > 0 ? { role: 'thermostat', ctrl, quantities } : undefined;
    }
    case 'RockerSwitch': {
      const up = byType('up_request');
      const down = byType('down_request');
      return up || down ? { role: 'rocker', up, down, quantities: [] } : undefined;
    }
    case 'Measurement':
      return quantities.length > 0 ? { role: 'sensor', quantities } : undefined;
    default:
      return undefined;
  }
}

export function emptyModel() {
  return {
    devices: [],
    /** datapoint id -> [{ featureId, read(dp) }] */
    readers: new Map(),
    /** feature id -> { target, write(value) -> op } */
    writers: new Map(),
    /** datapoint id -> { featureId, fid } for the rocker presses */
    buttons: new Map(),
    /** function id -> Gladys device external id (and scene key -> device) */
    targetDevices: new Map(),
    /** function id -> role */
    roles: new Map(),
    counts: { functions: 0, offered: 0, skipped: 0, scenes: 0, quantities: 0 },
  };
}

/**
 * @param {(type: string, id: string) => { device: string, feature: (k: string) => string }} idsOf gladys.externalIds
 * @param {{ gateway: string, functions: Map<string, object>, scenes?: object[] }} inventory
 *   gateway: `sn<serial>` or `mac<MAC>`
 * @param {{ language?: 'fr'|'en', safeSockets?: Set<string> }} options
 */
export function buildModel(idsOf, { gateway, functions, scenes = [] }, options = {}) {
  const { language = 'fr', safeSockets = new Set() } = options;
  const model = emptyModel();
  const name = (key) => featureName(key, language);

  for (const fn of functions.values()) {
    model.counts.functions += 1;
    const found = roleOf(fn);
    if (!found) {
      model.counts.skipped += 1;
      continue;
    }
    model.counts.offered += 1;
    const ids = idsOf('function', `${gateway}_${fn.id}`);
    const features = [];
    const add = (key, spec, { dp, read, write } = {}) => {
      const featureId = ids.feature(key);
      features.push({
        name: name(key),
        external_id: featureId,
        category: spec.category,
        type: spec.type,
        min: spec.min ?? 0,
        max: spec.max ?? 1,
        ...(spec.unit ? { unit: spec.unit } : {}),
        read_only: !write,
        has_feedback: Boolean(write && read),
        keep_history: spec.history ?? true,
      });
      if (dp && read) {
        const list = model.readers.get(dp.id) ?? [];
        list.push({ featureId, read });
        model.readers.set(dp.id, list);
      }
      if (write) model.writers.set(featureId, { target: fn.id, write });
      return featureId;
    };
    const { role } = found;
    model.roles.set(fn.id, role);
    const op = (dp, key, value, extra) => ({
      target: fn.id,
      fid: fn.id,
      dpid: dp.id,
      key,
      value: String(value),
      ...extra,
    });
    const off = () => op(found.sw, 'switch', 0, { protective: true, kind: 'state' });
    const onOff = (need) => (value) => {
      const v = commandNumber(value);
      if (v === 0) return off();
      if (v === 1) return op(found.sw, 'switch', 1, { protective: false, kind: 'state', need });
      return bad();
    };
    const readBit = (dp) => bit(valueOf(dp, 'switch'));

    if (role === 'light' || role === 'dimmer') {
      add(
        'on',
        { category: C.LIGHT, type: T.LIGHT.BINARY },
        { dp: found.sw, read: readBit, write: onOff() },
      );
      if (role === 'dimmer') {
        add(
          'brightness',
          { category: C.LIGHT, type: T.LIGHT.BRIGHTNESS, max: 100 },
          {
            dp: found.brightness,
            read: (dp) => intIn(valueOf(dp, 'brightness'), 0, 100),
            write: (value) => {
              const v = commandNumber(value);
              if (v === undefined || v < 0 || v > 100) return bad();
              // 0 is "off": the protective path, on the switch.
              if (Math.round(v) === 0) return off();
              return op(found.brightness, 'brightness', Math.round(v), {
                protective: false,
                kind: 'state',
              });
            },
          },
        );
      }
    } else if (role === 'socket') {
      if (safeSockets.has(fn.id)) {
        add(
          'on',
          { category: C.SWITCH, type: T.SWITCH.BINARY },
          { dp: found.sw, read: readBit, write: onOff('safe') },
        );
      } else {
        // Not declared safe: never a switch (an "everything on" of a voice
        // assistant or a scene would reach it). Its state, and a button that only turns it off.
        add(
          'state',
          { category: C.UNKNOWN, type: T.SENSOR.BINARY },
          { dp: found.sw, read: readBit },
        );
        add(
          'off',
          { category: C.BUTTON, type: T.BUTTON.PUSH, min: PRESSED, max: PRESSED, history: false },
          {
            write: (value) => (commandNumber(value) === PRESSED ? off() : bad()),
          },
        );
      }
    } else if (role === 'cover') {
      const level = found.level;
      // Gateway `level` is percent CLOSED (100 closed); Gladys position is percent open.
      const close = () => op(level, 'level', 100, { protective: true, kind: 'move' });
      const stop = () => op(level, 'level_move', 0, { protective: true, kind: 'move' });
      add(
        'state',
        { category: C.SHUTTER, type: T.SHUTTER.STATE, min: -1, max: 1 },
        {
          write: (value) => {
            const v = commandNumber(value);
            if (v === COVER_STATE.CLOSE) return close();
            if (v === COVER_STATE.STOP) return stop();
            if (v === COVER_STATE.OPEN) {
              return op(level, 'level', 0, { protective: false, kind: 'move' });
            }
            return bad();
          },
        },
      );
      add(
        'position',
        { category: C.SHUTTER, type: T.SHUTTER.POSITION, max: 100 },
        {
          dp: level,
          read: (dp) => {
            const closed = intIn(valueOf(dp, 'level'), 0, 100);
            return closed === undefined ? undefined : 100 - closed;
          },
          write: (value) => {
            const v = commandNumber(value);
            if (v === undefined || v < 0 || v > 100) return bad();
            const position = Math.round(v);
            if (position === 0) return close();
            return op(level, 'level', 100 - position, { protective: false, kind: 'move' });
          },
        },
      );
    } else if (role === 'thermostat') {
      if (found.ctrl) {
        const ctrl = found.ctrl;
        add(
          'setpoint',
          {
            category: C.THERMOSTAT,
            type: T.THERMOSTAT.TARGET_TEMPERATURE,
            unit: 'celsius',
            min: SETPOINT.min,
            max: SETPOINT.max,
          },
          {
            dp: ctrl,
            read: (dp) => {
              const v = numberOf(valueOf(dp, 'temperature_ctrl'));
              return v !== undefined && v >= 0 && v <= 40 ? v : undefined;
            },
            write: (value) => {
              const v = commandNumber(value);
              if (v === undefined || v < SETPOINT.min || v > SETPOINT.max) return bad();
              // Steps of 0.5 °C, rounded down (never above what was asked), within 5..30.
              const stepped = Math.floor(v / SETPOINT.step) * SETPOINT.step;
              const bounded = Math.min(SETPOINT.max, Math.max(SETPOINT.min, stepped));
              return op(ctrl, 'temperature_ctrl', bounded.toFixed(1), {
                protective: false,
                kind: 'state',
                need: 'heating',
              });
            },
          },
        );
        // Frost protection: the floor setpoint, never held back.
        add(
          'frost',
          { category: C.BUTTON, type: T.BUTTON.PUSH, min: PRESSED, max: PRESSED, history: false },
          {
            write: (value) =>
              commandNumber(value) === PRESSED
                ? op(ctrl, 'temperature_ctrl_preset', 'frost', { protective: true, kind: 'state' })
                : bad(),
          },
        );
      }
    } else if (role === 'rocker') {
      for (const [key, dp] of [
        ['up', found.up],
        ['down', found.down],
      ]) {
        if (!dp) continue;
        const featureId = add('press_' + key, {
          category: C.BUTTON,
          type: T.BUTTON.CLICK,
          min: 0,
          max: 10,
          history: true,
        });
        model.buttons.set(dp.id, { featureId, fid: fn.id });
      }
    }

    for (const dp of found.quantities ?? []) {
      const kind = quantityKind(dp);
      if (!kind) continue;
      model.counts.quantities += 1;
      add(`q${dp.suffix}`, kind, {
        dp,
        read: (d) => {
          const v = numberOf(valueOf(d, 'quantity'));
          return v !== undefined && v >= kind.min && v <= kind.max ? v : undefined;
        },
      });
    }

    if (features.length === 0) {
      model.counts.offered -= 1;
      model.counts.skipped += 1;
      continue;
    }
    model.targetDevices.set(fn.id, ids.device);
    model.devices.push({
      name: fn.label || `${fn.type} ${fn.id}`,
      external_id: ids.device,
      model: fn.type,
      features,
      params: [
        { name: 'JUNG_FUNCTION', value: fn.id },
        { name: 'JUNG_TYPE', value: fn.type },
        // The datapoints of the stops: a stop leaves even before the first read.
        ...[
          ['JUNG_SWITCH', found.sw],
          ['JUNG_LEVEL', found.level],
          ['JUNG_SETPOINT', found.ctrl],
        ]
          .filter(([, dp]) => dp)
          .map(([name, dp]) => ({ name, value: dp.id })),
      ],
    });
  }

  for (const scene of scenes) {
    const ids = idsOf('scene', `${gateway}_${scene.id}`);
    const featureId = ids.feature('recall');
    const target = `scene:${scene.id}`;
    model.counts.scenes += 1;
    model.writers.set(featureId, {
      target,
      write: (value) =>
        commandNumber(value) === PRESSED
          ? { target, scene: scene.id, protective: false, kind: 'scene', need: 'scenes' }
          : bad(),
    });
    model.targetDevices.set(target, ids.device);
    model.devices.push({
      name: scene.label || `Scene ${scene.id}`,
      external_id: ids.device,
      model: 'Scene',
      features: [
        {
          name: name('recall'),
          external_id: featureId,
          category: C.BUTTON,
          type: T.BUTTON.PUSH,
          min: PRESSED,
          max: PRESSED,
          read_only: false,
          has_feedback: false,
          keep_history: false,
        },
      ],
      params: [{ name: 'JUNG_SCENE', value: scene.id }],
    });
  }
  return model;
}

/** The Gladys values of one datapoint: `[{ featureId, value }]`. */
export function valuesOf(model, dp) {
  const out = [];
  for (const { featureId, read } of model.readers.get(dp.id) ?? []) {
    const value = read(dp);
    if (value !== undefined) out.push({ featureId, value });
  }
  return out;
}

/** Whether a datapoint read shows what `op` asked (undefined when it does not tell). */
export function applied(op, dp) {
  if (!dp) return undefined;
  const seen = dp.values.get(op.key);
  if (seen === undefined) return undefined;
  if (op.key === 'temperature_ctrl') {
    const n = numberOf(seen);
    return n === undefined ? undefined : Math.abs(n - Number(op.value)) < 0.05;
  }
  if (op.key === 'level' || op.key === 'brightness' || op.key === 'switch') {
    const n = numberOf(seen);
    return n === undefined ? undefined : n === Number(op.value);
  }
  return seen.trim().toLowerCase() === op.value;
}

/** A press of a rocker, from a live datapoint frame: CLICK on the press edge. */
export const pressOf = (dp) => (valueOf(dp) === '1' ? CLICK : undefined);

const DATAPOINT_ID = /^(id[A-Za-z0-9]{1,40})-[0-9a-f]{3}$/i;

/**
 * The stop a created device asks for when the function list is not known (yet):
 * after a restart before the first read, or another gateway answering. Only
 * protective commands, from the device's own params (its datapoints);
 * undefined for anything else.
 */
export function stopFromDevice(device, feature, value) {
  const param = (name) => {
    const found = (Array.isArray(device?.params) ? device.params : []).find(
      (p) => p?.name === name,
    );
    return typeof found?.value === 'string' ? found.value : undefined;
  };
  const fid = param('JUNG_FUNCTION');
  if (!fid || !FUNCTION_ID.test(fid)) return undefined;
  const dpOf = (name) => {
    const id = param(name);
    const m = id ? DATAPOINT_ID.exec(id) : null;
    return m && m[1] === fid ? id : undefined;
  };
  const key = String(feature?.external_id ?? '')
    .split(':')
    .pop();
  const v = commandNumber(value);
  const op = (dpid, k, val, kind) =>
    dpid ? { target: fid, fid, dpid, key: k, value: val, protective: true, kind } : undefined;
  const sw = dpOf('JUNG_SWITCH');
  const level = dpOf('JUNG_LEVEL');
  const ctrl = dpOf('JUNG_SETPOINT');
  // A cover is the function with a level datapoint (its `state` and `position`).
  if ((key === 'state' || key === 'position') && level) {
    if ((key === 'state' && v === COVER_STATE.CLOSE) || (key === 'position' && v === 0)) {
      return op(level, 'level', '100', 'move');
    }
    if (key === 'state' && v === COVER_STATE.STOP) return op(level, 'level_move', '0', 'move');
    return undefined;
  }
  if ((key === 'on' || key === 'brightness') && v === 0) return op(sw, 'switch', '0', 'state');
  if (key === 'off' && v === PRESSED) return op(sw, 'switch', '0', 'state');
  if (key === 'frost' && v === PRESSED)
    return op(ctrl, 'temperature_ctrl_preset', 'frost', 'state');
  return undefined;
}
