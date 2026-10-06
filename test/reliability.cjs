const { test } = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const hap = require('hap-nodejs');
const { BlueAirDevice } = require('../dist/device/BlueAirDevice');
const { AirPurifierAccessory } = require('../dist/accessory/AirPurifierAccessory');
const BlueAirAwsApi = require('../dist/api/BlueAirAwsApi').default;
const { RequestPolicy, CloudCooldownError, retryAfterMs } = require('../dist/api/RequestPolicy');
const { CoalescedControl } = require('../dist/device/CoalescedControl');
const { BlueAirPlatform } = require('../dist/platform');

const quiet = { debug() {}, info() {}, warn() {}, error() {} };
function snapshot(overrides = {}) {
  return { id: 'fixture', name: 'Test 211i', sku: '109583', supportedSensors: ['pm1', 'pm2_5', 'pm10'],
    state: { standby: false, fanspeed: 11, automode: false, nightmode: false, childlock: false, brightness: 50, filterusage: 10 },
    sensorData: { pm1: 1, pm2_5: 0, pm10: 0 }, ...overrides };
}
function adapter(data = snapshot(), writer = async () => {}) {
  const device = new BlueAirDevice(data, writer);
  const platform = Object.assign(new EventEmitter(), { api: { hap }, Characteristic: hap.Characteristic,
    Service: hap.Service, config: { sliderBufferMs: 1 }, log: quiet });
  const accessory = new hap.Accessory('Test 211i', hap.uuid.generate('test211i'));
  const bridge = new AirPurifierAccessory(platform, accessory, device, {
    name: 'Test 211i', filterChangeLevel: 90, airQualitySensor: true, led: true, nightMode: true,
  });
  return { device, platform, accessory, bridge };
}

test('air-quality classification uses the newly received concentration', () => {
  const device = new BlueAirDevice(snapshot());
  device.updateState(snapshot({ sensorData: { pm2_5: 100, pm10: 0 } }));
  assert.equal(device.sensorData.aqi, 182);
});
test('above-scale concentrations remain maximally polluted', () => {
  assert.equal(new BlueAirDevice(snapshot({ sensorData: { pm2_5: 400 } })).sensorData.aqi, 500);
  assert.equal(new BlueAirDevice(snapshot({ sensorData: { pm10: 1000 } })).sensorData.aqi, 500);
});
test('missing/invalid readings are unknown and stale readings are cleared', () => {
  const device = new BlueAirDevice(snapshot());
  device.updateState(snapshot({ sensorData: {} }));
  assert.equal(device.sensorData.aqi, undefined);
  assert.equal(device.sensorData.pm2_5, undefined);
  assert.equal(new BlueAirDevice(snapshot({ sensorData: { pm2_5: NaN, pm10: -1 } })).sensorData.aqi, undefined);
});
test('PM10 fractional values do not fall through the breakpoint gaps', () => {
  assert.ok(new BlueAirDevice(snapshot({ sensorData: { pm10: 154.7 } })).sensorData.aqi > 50);
});
test('unsupported VOC is absent, missing PM2.5 fails rather than reporting zero, PM1 is exposed', () => {
  const { accessory, bridge, device } = adapter();
  const sensor = accessory.getService(hap.Service.AirQualitySensor);
  assert.ok(!sensor.characteristics.some(c => c.UUID === hap.Characteristic.VOCDensity.UUID));
  assert.ok(sensor.characteristics.some(c => c.displayName === 'PM1 Density'));
  device.updateState(snapshot({ sensorData: {} }));
  assert.throws(() => bridge.getPM2_5Density(), hap.HapStatusError);
  assert.equal(bridge.getAirQuality(), hap.Characteristic.AirQuality.UNKNOWN);
});
test('filter notifications update FilterMaintenance and clamp remaining life', () => {
  const { accessory, device, bridge } = adapter();
  device.updateState(snapshot({ state: { ...device.state, filterusage: 95 } }));
  const filter = accessory.getService(hap.Service.FilterMaintenance);
  assert.equal(filter.getCharacteristic(hap.Characteristic.FilterLifeLevel).value, 5);
  assert.equal(filter.getCharacteristic(hap.Characteristic.FilterChangeIndication).value, 1);
  assert.ok(!accessory.getService(hap.Service.AirPurifier).characteristics.some(c => c.UUID === hap.Characteristic.FilterLifeLevel.UUID));
  device.state.filterusage = 120;
  assert.equal(bridge.getFilterLifeLevel(), 0);
});
test('failed command rejects the HomeKit write and preserves the prior snapshot', async () => {
  const device = new BlueAirDevice(snapshot(), async () => { throw new Error('Cloud rejected'); });
  await assert.rejects(device.setState('fanspeed', 75), /Cloud rejected/);
  assert.equal(device.state.fanspeed, 11);
});
test('concurrent commands are serialized and each caller gets its own result', async () => {
  const calls = [];
  const device = new BlueAirDevice(snapshot(), async (_, value) => {
    calls.push(value);
    await new Promise(r => setTimeout(r, 2));
    if (value === 75) throw new Error('Failed second command');
  });
  const results = await Promise.allSettled([device.setState('fanspeed', 50), device.setState('fanspeed', 75)]);
  assert.deepEqual(calls, [50, 75]);
  assert.deepEqual(results.map(r => r.status), ['fulfilled', 'rejected']);
  assert.equal(device.state.fanspeed, 50);
});
test('slider submissions collapse to the final value and failures reject every waiter', async () => {
  const calls = [];
  const control = new CoalescedControl(async value => calls.push(value), 2);
  await Promise.all([control.submit(20), control.submit(40), control.submit(80)]);
  assert.deepEqual(calls, [80]);
  const failed = new CoalescedControl(async () => { throw new Error('rejected'); }, 1);
  const results = await Promise.allSettled([failed.submit(20), failed.submit(80)]);
  assert.ok(results.every(result => result.status === 'rejected'));
});
test('shutdown cancels unsent slider values', async () => {
  const calls = [];
  const control = new CoalescedControl(async value => calls.push(value), 100);
  const pending = control.submit(80);
  control.cancel();
  await assert.rejects(pending, /cancelled/);
  assert.deepEqual(calls, []);
});
test('manual speed exits Night and Auto; supported hardware maps its top speed to 100%', async () => {
  const data = snapshot({ hardware: 'nb_high', state: { ...snapshot().state, nightmode: true, automode: true } });
  const writes = [];
  const { bridge } = adapter(data, async (key, value) => writes.push([key, value]));
  await bridge.setRotationSpeed(100);
  assert.deepEqual(writes, [['nightmode', false], ['automode', false], ['fanspeed', 91]]);
  assert.equal(bridge.getRotationSpeed(), 100);
});
test('rate limits cause one network request and further calls respect the cooldown', async () => {
  const original = global.fetch;
  let calls = 0;
  global.fetch = async () => { calls++; return new Response('{}', { status: 229 }); };
  try {
    const api = new BlueAirAwsApi('fixture', 'fixture', 'USA', quiet);
    await assert.rejects(api.apiCall('/fixture'), CloudCooldownError);
    await assert.rejects(api.apiCall('/fixture'), CloudCooldownError);
    assert.equal(calls, 1);
    assert.ok(api.cooldownMs > 0);
  } finally { global.fetch = original; }
});
test('device writes with ambiguous HTTP errors are not replayed', async () => {
  const original = global.fetch;
  let calls = 0;
  global.fetch = async () => { calls++; return new Response('{}', { status: 502 }); };
  try {
    const api = new BlueAirAwsApi('fixture', 'fixture', 'USA', quiet);
    api.last_login = Date.now();
    await assert.rejects(api.setDeviceStatus('fixture', 'fanspeed', 91), /502/);
    assert.equal(calls, 1);
  } finally { global.fetch = original; }
});
test('Retry-After supports seconds and dates; cooldown blocks queued calls', () => {
  assert.equal(retryAfterMs('120'), 120000);
  assert.equal(retryAfterMs(new Date(120000).toUTCString(), 60000), 60000);
  const policy = new RequestPolicy();
  const error = policy.throttle('120');
  assert.equal(error.retryAfterMs, 120000);
  assert.throws(() => policy.assertReady(), CloudCooldownError);
});
test('login is single-flight and authentication rejection starts a long cooldown', async () => {
  const api = new BlueAirAwsApi('fixture', 'fixture', 'USA', quiet);
  let calls = 0;
  api.gigyaApi.getGigyaSession = async () => { calls++; await new Promise(r => setTimeout(r, 1)); return { token: '', secret: '' }; };
  api.gigyaApi.getGigyaJWT = async () => ({ jwt: '' });
  api.getAwsAccessToken = async () => ({ accessToken: 'fixture', idToken: '', userId: 'fixture' });
  await Promise.all([api.login(), api.login()]);
  assert.equal(calls, 1);
  api.gigyaApi.getGigyaSession = async () => { throw new CloudCooldownError(900000); };
  await assert.rejects(api.login(), CloudCooldownError);
  assert.ok(api.cooldownMs >= 899000);
});
test('telemetry scans backwards per sensor instead of discarding sparse rows', async () => {
  const api = new BlueAirAwsApi('fixture', 'fixture', 'USA', quiet);
  api.apiCall = async () => [{ did: 'fixture', sensors: ['pm2_5', 'pm10'], datapoints: [['1', '15', '2'], ['2', null, '3']] }];
  assert.deepEqual(await api.getDeviceTelemetry('fixture', 'fixture', ['pm2_5','pm10']), { pm2_5: 15, pm10: 3 });
  assert.deepEqual(await api.getDeviceTelemetry('fixture', 'another-device', ['pm2_5','pm10']), {});
});
test('partial PM data triggers fallback, live data wins, and history calls are cached', async () => {
  const api = new BlueAirAwsApi('fixture', 'fixture', 'USA', quiet);
  api.last_login = Date.now();
  let calls = 0;
  api.apiCall = async () => ({ deviceInfo: [{ id: 'fixture', configuration: { di: { name: 'Test', sku: '109583' },
    ds: { particles: { sn: ['pm2_5', 'pm10'] } } }, states: [], sensordata: [{ n: 'pm10', v: 3, t: 0 }] }] });
  api.getDeviceTelemetry = async () => { calls++; return { pm2_5: 15, pm10: 99 }; };
  const first = await api.getDeviceStatus('fixture', ['fixture']);
  const second = await api.getDeviceStatus('fixture', ['fixture']);
  assert.deepEqual(first[0].sensorData, { pm2_5: 15, pm10: 3 });
  assert.deepEqual(second[0].sensorData, first[0].sensorData);
  assert.equal(calls, 1);
});

function testPlatform() {
  const api = Object.assign(new EventEmitter(), { hap, platformAccessory: hap.Accessory,
    registerPlatformAccessories() {} });
  const platform = new BlueAirPlatform(quiet, { platform: 'blueair-purifier', name: 'Test',
    username: 'fixture', password: 'fixture', accountUuid: 'fixture', devices: [{ id: 'fixture', name: 'Test' }] }, api);
  return { api, platform };
}
test('failed startup recovers on the next refresh without creating duplicate accessories', async () => {
  const { api, platform } = testPlatform();
  let calls = 0;
  let registrations = 0;
  api.registerPlatformAccessories = () => registrations++;
  platform.blueAirApi.getDeviceStatus = async () => {
    if (++calls === 1) throw new Error('Temporary outage');
    return [snapshot()];
  };
  try {
    await platform.getValidDevicesStatus();
    assert.equal(platform.initialized, false);
    assert.equal(platform.pollFailures, 1);
    await platform.getValidDevicesStatus();
    await platform.getValidDevicesStatus();
    assert.equal(platform.initialized, true);
    assert.equal(platform.devices.length, 1);
    assert.equal(registrations, 1);
  } finally { api.emit('shutdown'); }
});
test('overlapping refreshes are single-flight and shutdown discards an in-flight startup', async () => {
  const { api, platform } = testPlatform();
  let finish;
  let calls = 0;
  platform.blueAirApi.getDeviceStatus = async () => {
    calls++;
    return new Promise(resolve => { finish = resolve; });
  };
  const first = platform.getValidDevicesStatus();
  await new Promise(resolve => setImmediate(resolve));
  await platform.getValidDevicesStatus();
  assert.equal(calls, 1);
  api.emit('shutdown');
  finish([snapshot()]);
  await first;
  assert.equal(platform.devices.length, 0);
  assert.equal(platform.polling, null);
});
test('shutdown rejects a device command queued behind a cloud operation', async () => {
  const { api, platform } = testPlatform();
  platform.blueAirApi.getDeviceStatus = async () => [snapshot()];
  await platform.getValidDevicesStatus();
  const release = await platform.operationMutex.acquire();
  let writes = 0;
  platform.blueAirApi.setDeviceStatus = async () => writes++;
  const pending = platform.devices[0].setState('fanspeed', 91);
  await new Promise(resolve => setImmediate(resolve));
  api.emit('shutdown');
  release();
  await assert.rejects(pending, /shutting down/);
  assert.equal(writes, 0);
});
