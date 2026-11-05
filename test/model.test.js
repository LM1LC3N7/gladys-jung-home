import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import {
  applied,
  buildModel,
  cleanText,
  datapointOf,
  functionOf,
  functionsOf,
  numberOf,
  scenesOf,
  valuesOf,
} from '../src/model.js';
import { fixtureFunctions, fixtureScenes } from './helpers/fakeGateway.js';

const gladys = createFakeGladys();
const idsOf = (type, id) => gladys.externalIds(type, id);
const build = (options = {}, functions = fixtureFunctions()) =>
  buildModel(
    idsOf,
    { gateway: 'snJH1', functions: functionsOf(functions), scenes: scenesOf(fixtureScenes()) },
    options,
  );
const fid = (f, key) => `ext:test-integration:function:snJH1_${f}:${key}`;
const writer = (model, f, key) => model.writers.get(fid(f, key));

test('strict numbers: empty, junk and exponents are unknown, never 0', () => {
  assert.equal(numberOf('21.5'), 21.5);
  assert.equal(numberOf('-3'), -3);
  for (const v of ['', ' ', 'NaN', '1e3', '0x10', '1,5', null, undefined, 12]) {
    assert.equal(numberOf(v), undefined, String(v));
  }
});

test('labels are printable and bounded; ids exact; nothing reaches a prototype', () => {
  assert.equal(cleanText('Hall\u0000\r\nLight  '), 'Hall Light');
  assert.equal(cleanText('x'.repeat(500)).length, 100);
  assert.equal(functionOf({ id: 'id../x', type: 'OnOff', datapoints: [] }), undefined);
  assert.equal(functionOf({ id: 'id:a', type: 'OnOff', datapoints: [] }), undefined);
  // A datapoint of another function is dropped.
  const fn = functionOf({
    id: 'ida',
    type: 'OnOff',
    datapoints: [{ id: 'idb-001', type: 'switch', values: [] }],
  });
  assert.equal(fn.datapoints.size, 0);
  const polluted = JSON.parse(
    '{"id":"ida-001","type":"switch","values":[{"key":"__proto__","value":"1"},{"key":"switch","value":"1"}],"__proto__":{"x":1}}',
  );
  const dp = datapointOf(polluted, 'ida');
  assert.equal(dp.values.get('switch'), '1');
  assert.equal({}.x, undefined);
  assert.equal(Object.prototype.x, undefined);
});

test('bounded lists: functions, datapoints, values, scenes', () => {
  const many = Array.from({ length: 400 }, (_, i) => ({
    id: `id${i}`,
    type: 'OnOff',
    datapoints: [],
  }));
  assert.equal(functionsOf(many).size, 300);
  const dps = Array.from({ length: 50 }, (_, i) => ({
    id: `ida-${i.toString(16).padStart(3, '0')}`,
    type: 'switch',
    values: [],
  }));
  assert.equal(functionOf({ id: 'ida', type: 'OnOff', datapoints: dps }).datapoints.size, 32);
  assert.equal(
    scenesOf(Array.from({ length: 300 }, (_, i) => ({ id: `id${i}`, label: 's' }))).length,
    200,
  );
  assert.deepEqual(functionsOf('not a list'), new Map());
});

test('roles: lights, dimmers, covers, thermostats, rockers, sensors; unsafe sockets are never a switch', () => {
  const model = build();
  const byId = new Map(model.devices.map((d) => [d.external_id.split('_').pop(), d]));
  const kinds = (f) =>
    byId.get(f).features.map((x) => `${x.category}/${x.type}${x.read_only ? '(ro)' : ''}`);
  assert.deepEqual(kinds('idlight1'), ['light/binary']);
  assert.deepEqual(kinds('iddim1'), ['light/binary', 'light/brightness']);
  assert.deepEqual(kinds('idblind1'), ['shutter/state', 'shutter/position']);
  assert.deepEqual(kinds('idrtr1'), [
    'thermostat/target-temperature',
    'button/push',
    'temperature-sensor/decimal(ro)',
  ]);
  assert.deepEqual(kinds('idsock1'), [
    'unknown/binary(ro)',
    'button/push',
    'energy-sensor/power(ro)',
  ]);
  assert.deepEqual(kinds('idsock2'), ['unknown/binary(ro)', 'button/push']);
  assert.deepEqual(kinds('idmeas1'), ['light-sensor/decimal(ro)']);
  assert.deepEqual(kinds('idrock1'), ['button/click(ro)', 'button/click(ro)']);
  for (const d of model.devices) {
    for (const f of d.features) {
      if (f.unit !== undefined)
        assert.ok(['celsius', 'watt', 'kilowatt', 'lux'].includes(f.unit), f.external_id);
    }
  }
  const safe = build({ safeSockets: new Set(['idsock2']) });
  const sock = safe.devices.find((d) => d.external_id.endsWith('_idsock2'));
  assert.deepEqual(
    sock.features.map((x) => `${x.category}/${x.type}`),
    ['switch/binary'],
  );
  assert.equal(model.counts.scenes, 2);
  assert.ok(
    model.devices.find((d) =>
      d.params.some((p) => p.name === 'JUNG_FUNCTION' && p.value === 'idsock2'),
    ),
  );
});

test('writes: protective off, stop, close, frost; bounds; never NaN, null nor ""', () => {
  const model = build({ safeSockets: new Set(['idsock2']) });
  const on = writer(model, 'idlight1', 'on');
  assert.deepEqual(
    { ...on.write(0), target: undefined },
    {
      target: undefined,
      fid: 'idlight1',
      dpid: 'idlight1-001',
      key: 'switch',
      value: '0',
      protective: true,
      kind: 'state',
    },
  );
  assert.equal(on.write(1).protective, false);
  for (const v of [2, -1, 0.5, null, '', true, 'x', NaN]) {
    assert.throws(() => on.write(v), /badValue/, String(v));
  }
  const bri = writer(model, 'iddim1', 'brightness');
  assert.equal(bri.write(0).key, 'switch', 'brightness 0 is a switch-off');
  assert.equal(bri.write(0).protective, true);
  assert.equal(bri.write(55.4).value, '55');
  assert.throws(() => bri.write(101), /badValue/);
  const state = writer(model, 'idblind1', 'state');
  assert.deepEqual(
    [state.write(-1).key, state.write(-1).value, state.write(-1).protective],
    ['level', '100', true],
  );
  assert.deepEqual(
    [state.write(0).key, state.write(0).value, state.write(0).protective],
    ['level_move', '0', true],
  );
  assert.deepEqual([state.write(1).value, state.write(1).protective], ['0', false]);
  const position = writer(model, 'idblind1', 'position');
  assert.equal(position.write(25).value, '75', 'Gladys 25 % open = 75 % closed');
  assert.equal(position.write(0).protective, true, 'position 0 is a close');
  assert.throws(() => position.write(-1), /badValue/);
  const setpoint = writer(model, 'idrtr1', 'setpoint');
  assert.equal(setpoint.write(21.74).value, '21.5', 'rounded down to the 0.5 step');
  assert.equal(setpoint.write(30).value, '30.0');
  assert.equal(setpoint.write(5).value, '5.0');
  assert.equal(setpoint.write(21).need, 'heating');
  for (const v of [30.1, 4.9, 65, null, ''])
    assert.throws(() => setpoint.write(v), /badValue/, String(v));
  const frost = writer(model, 'idrtr1', 'frost').write(1);
  assert.deepEqual(
    [frost.key, frost.value, frost.protective],
    ['temperature_ctrl_preset', 'frost', true],
  );
  assert.throws(() => writer(model, 'idrtr1', 'frost').write(0), /badValue/);
  const off = writer(build(), 'idsock2', 'off').write(1);
  assert.deepEqual([off.key, off.value, off.protective], ['switch', '0', true]);
  assert.equal(writer(model, 'idsock2', 'on').write(1).need, 'safe');
  const scene = model.writers.get('ext:test-integration:scene:snJH1_id0001:recall').write(1);
  assert.deepEqual([scene.scene, scene.need, scene.protective], ['id0001', 'scenes', false]);
});

test('reads: the values of a datapoint; out of range is no measure', () => {
  const model = build();
  const dp = (id, values) =>
    datapointOf({ id, type: id.endsWith('010') ? 'quantity' : 'x', values }, id.split('-')[0]);
  const read = (id, values) => valuesOf(model, dp(id, values)).map((v) => v.value);
  assert.deepEqual(read('idblind1-001', [{ key: 'level', value: '100' }]), [0]);
  assert.deepEqual(read('idblind1-001', [{ key: 'level', value: '' }]), []);
  assert.deepEqual(
    read('idrtr1-010', [
      { key: 'quantity', value: '' },
      { key: 'quantity_unit', value: '°C' },
    ]),
    [],
  );
  assert.deepEqual(
    read('idrtr1-010', [
      { key: 'quantity', value: '999' },
      { key: 'quantity_unit', value: '°C' },
    ]),
    [],
  );
  assert.deepEqual(
    read('idsock1-010', [
      { key: 'quantity', value: 'Aus' },
      { key: 'quantity_unit', value: 'W' },
    ]),
    [],
  );
  assert.deepEqual(
    read('idsock1-010', [
      { key: 'quantity', value: '12.5' },
      { key: 'quantity_unit', value: 'W' },
    ]),
    [12.5],
  );
});

test('applied: what a read must show for a command to be done', () => {
  const op = { key: 'temperature_ctrl', value: '21.5' };
  const at = (values) => datapointOf({ id: 'idr-001', values }, 'idr');
  assert.equal(applied(op, at([{ key: 'temperature_ctrl', value: '21.50' }])), true);
  assert.equal(applied(op, at([{ key: 'temperature_ctrl', value: '20' }])), false);
  assert.equal(applied(op, at([])), undefined);
  assert.equal(applied({ key: 'switch', value: '0' }, at([{ key: 'switch', value: '0' }])), true);
  assert.equal(
    applied({ key: 'switch', value: '0' }, at([{ key: 'switch', value: '' }])),
    undefined,
  );
  assert.equal(
    applied(
      { key: 'temperature_ctrl_preset', value: 'frost' },
      at([{ key: 'temperature_ctrl_preset', value: 'Frost ' }]),
    ),
    true,
  );
  assert.equal(applied({ key: 'switch', value: '0' }, undefined), undefined);
});

test('stopFromDevice: only stops, only from datapoints of the function itself', async () => {
  const { stopFromDevice } = await import('../src/model.js');
  const model = build();
  const params = (f) => model.devices.find((d) => d.external_id.endsWith(`_${f}`)).params;
  const fire = (f, key, value, p = params(f)) =>
    stopFromDevice({ params: p }, { external_id: fid(f, key) }, value);
  assert.deepEqual(
    [
      fire('idlight1', 'on', 0).dpid,
      fire('idlight1', 'on', 0).value,
      fire('idlight1', 'on', 0).protective,
    ],
    ['idlight1-001', '0', true],
  );
  assert.equal(fire('idlight1', 'on', 1), undefined);
  assert.equal(fire('iddim1', 'brightness', 0).key, 'switch');
  assert.equal(fire('iddim1', 'brightness', 40), undefined);
  assert.equal(fire('idsock2', 'off', 1).dpid, 'idsock2-001');
  assert.equal(fire('idsock2', 'state', 0), undefined, 'a socket has no cover stop');
  assert.equal(fire('idblind1', 'state', 0).key, 'level_move');
  assert.equal(fire('idblind1', 'state', -1).value, '100');
  assert.equal(fire('idblind1', 'position', 0).value, '100');
  assert.equal(fire('idblind1', 'state', 1), undefined, 'an opening is no stop');
  assert.equal(fire('idblind1', 'position', 50), undefined);
  assert.equal(fire('idrtr1', 'frost', 1).key, 'temperature_ctrl_preset');
  assert.equal(fire('idrtr1', 'setpoint', 5), undefined);
  // A datapoint of another function, or a bad id, is never used.
  const forged = [
    { name: 'JUNG_FUNCTION', value: 'idlight1' },
    { name: 'JUNG_SWITCH', value: 'idother-001' },
  ];
  assert.equal(fire('idlight1', 'on', 0, forged), undefined);
  assert.equal(fire('idlight1', 'on', 0, [{ name: 'JUNG_FUNCTION', value: 'id../x' }]), undefined);
  assert.equal(stopFromDevice(undefined, undefined, 0), undefined);
});
