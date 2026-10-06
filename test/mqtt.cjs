const { test } = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const vm = require('node:vm');
const fs = require('node:fs');
const { BlueAirMqtt } = require('../dist/api/BlueAirMqtt');
const { BlueAirDevice } = require('../dist/device/BlueAirDevice');
const { BlueAirPlatform } = require('../dist/platform');
const BlueAirAwsApi = require('../dist/api/BlueAirAwsApi').default;
const { Region, defaultConfig, defaultDeviceConfig } = require('../dist/platformUtils');
const hap = require('hap-nodejs');
const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const tick = () => new Promise(resolve => setImmediate(resolve));
const auth = () => ({ host: 'fixture.invalid', userId: 'account', headers: { 'X-Amz-CustomAuthorizer-Token': 'fixture' }, expiresAt: Date.now() + 86400000 });
function session(ttl = 1200, credentials = async () => auth()) {
  const clients = [];
  const mqtt = new BlueAirMqtt(credentials, new Map([['device', ttl]]), (url, options) => {
    const c = Object.assign(new EventEmitter(), { url, options, subscriptions: [], ended: false });
    c.subscribe = (topic, opts, callback) => { c.subscriptions.push(topic); callback(null, [{ topic, qos: 0 }]); };
    c.end = () => { c.ended = true; c.emit('close'); };
    clients.push(c);
    return c;
  });
  const message = (topic, data, retain = false) => clients[clients.length - 1].emit('message', topic, Buffer.from(JSON.stringify(data)), { retain });
  return { mqtt, clients, message };
}
const snapshot = (overrides = {}) => ({ id: 'device', name: 'Test', sku: '110035', state: { fanspeed: 11, standby: false },
  supportedSensors: ['pm1', 'pm2_5', 'pm10'], sensorData: { pm1: 1, pm2_5: 2, pm10: 3 }, ...overrides });

test('MQTT authenticates securely, subscribes once, validates payloads and detects silent sensor loss', async () => {
  const { mqtt, clients, message } = session();
  const readings = [];
  mqtt.on('sensors', (...args) => readings.push(args));
  try {
    mqtt.start(); mqtt.start(); await tick();
    assert.equal(clients.length, 1);
    const c = clients[0];
    assert.equal(c.options.reconnectPeriod, 0);
    assert.equal(c.options.wsOptions.rejectUnauthorized, true);
    assert.equal(c.options.wsOptions.headers['X-Amz-CustomAuthorizer-Token'], 'fixture');
    c.emit('connect');
    assert.equal(c.subscriptions.length, 3);
    assert.equal(mqtt.isHealthy(), false);
    message('d/device/s/5s', [{ n: 'pm2_5', v: 5 }, { n: 'pm1', v: -1 }, { n: 'pm10', v: '20' }, { n: 'unknown', v: 5 }]);
    assert.deepEqual(readings[0][1], { pm2_5: 5 });
    assert.equal(mqtt.isHealthy(), true);
    assert.equal(mqtt.isHealthy(Date.now() + 46000), false);
    message('d/device/s/5s', [{ n: 'pm2_5', v: 99 }], true);
    message('d/other/s/5s', [{ n: 'pm2_5', v: 99 }]);
    c.emit('message', 'd/device/s/5s', Buffer.from('bad json'), {});
    assert.equal(readings.length, 1);
  } finally { mqtt.stop(); }
  assert.equal(clients[0].ended, true);
  assert.equal(mqtt.renewTimers.size, 0);
});

test('MQTT rejects duplicate and older shadows and orders connectivity events', async () => {
  const { mqtt, clients, message } = session();
  const states = [], online = [];
  mqtt.on('state', (...args) => states.push(args));
  mqtt.on('online', (...args) => online.push(args));
  try {
    mqtt.start(); await tick(); clients[0].emit('connect');
    const shadow = version => ({ current: { version, timestamp: Date.now() / 1000, state: { reported: { fanspeed: 51 } } } });
    message('$aws/things/device/shadow/update/documents', shadow(4));
    message('$aws/things/device/shadow/update/documents', shadow(4));
    message('$aws/things/device/shadow/update/documents', shadow(3));
    assert.equal(states.length, 1);
    message('c/account/s/event', { o: 'device', et: 'Connected', ts: 100 });
    message('c/account/s/event', { o: 'device', et: 'NotConnected', ts: 99 });
    message('c/account/s/event', { o: 'device', et: 'NotConnected', ts: 101 });
    assert.deepEqual(online.map(item => item[1]), [true, false]);
  } finally { mqtt.stop(); }
});

test('stream TTL renews subscriptions without unsubscribe or extra connections', async () => {
  const { mqtt, clients } = session(1);
  try {
    mqtt.start(); await tick(); clients[0].emit('connect');
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.equal(clients.length, 1);
    assert.equal(clients[0].subscriptions.filter(topic => topic === 'd/device/s/5s').length, 2);
  } finally { mqtt.stop(); }
});

test('disconnect has one reconnect owner and missing credentials degrade safely', async () => {
  const { mqtt, clients } = session();
  try {
    mqtt.start(); await tick(); clients[0].emit('connect');
    clients[0].emit('error', new Error('Sensitive error must not be logged'));
    clients[0].emit('close');
    assert.equal(mqtt.failures, 1);
    assert.equal(mqtt.client, undefined);
    assert.ok(mqtt.reconnectTimer);
  } finally { mqtt.stop(); }
  const missing = session(1200, async () => undefined);
  missing.mqtt.start(); await tick();
  assert.equal(missing.clients.length, 0);
  assert.equal(missing.mqtt.failures, 1);
  missing.mqtt.stop();
});

test('shutdown while authentication is pending cannot create a connection', async () => {
  let finish;
  const s = session(1200, () => new Promise(resolve => { finish = resolve; }));
  s.mqtt.start(); s.mqtt.stop(); finish(auth()); await tick();
  assert.equal(s.clients.length, 0);
});

test('fresh push values survive partial and older historical REST, then expire honestly', () => {
  const now = Date.now();
  const d = new BlueAirDevice(snapshot());
  d.applyPush({ fanspeed: 51 }, { pm2_5: 9 }, now + 10);
  d.updateState(snapshot({ state: { fanspeed: 11 }, stateTimestamps: { fanspeed: now - 300000 },
    sensorData: { pm2_5: 99 }, sensorTimestamps: { pm2_5: now - 300000 }, historicalSensors: ['pm2_5'] }), 'rest', now + 20);
  assert.equal(d.sensorData.pm2_5, 9);
  assert.equal(d.state.fanspeed, 51);
  d.updateState(snapshot({ state: {}, sensorData: {} }), 'rest', now + 30);
  assert.equal(d.sensorData.pm2_5, 9);
  d.applyPush({}, { pm1: 6 }, now + 40);
  assert.equal(d.sensorData.pm2_5, 9);
  assert.equal(d.sensorData.pm1, 6);
  d.expireSensors(now + 600041);
  assert.equal(d.sensorData.pm2_5, undefined);
  assert.equal(d.sensorData.aqi, undefined);
  assert.equal(d.sensorDiagnostics().pm2_5.available, false);
});

test('long reconciliation switches to fallback once without postponing every poll', async () => {
  const api = Object.assign(new EventEmitter(), { hap, platformAccessory: hap.Accessory, registerPlatformAccessories() {} });
  const p = new BlueAirPlatform(quiet, { platform: 'blueair-purifier', username: 'fixture', password: 'fixture', accountUuid: 'fixture',
    devices: [{ id: 'device', name: 'Test' }] }, api);
  p.blueAirApi.getDeviceStatus = async () => [snapshot()];
  try {
    await p.getValidDevicesStatus();
    let healthy = true;
    p.mqtt = { isHealthy: () => healthy, stop() {} };
    p.watchdog._onTimeout();
    assert.equal(p.polling._idleTimeout, 900000);
    healthy = false;
    p.watchdog._onTimeout();
    const fallback = p.polling;
    assert.equal(fallback._idleTimeout, 60000);
    p.watchdog._onTimeout();
    assert.equal(p.polling, fallback);
  } finally { api.emit('shutdown'); }
});

test('command acknowledgement awaits a matching fresh report and never retries on confirmation timeout', async () => {
  let writes = 0;
  const d = new BlueAirDevice(snapshot(), async () => { writes++; }, true);
  const outcomes = [];
  d.on('commandConfirmation', (...args) => outcomes.push(args));
  try {
    await d.setState('fanspeed', 51);
    assert.equal(outcomes.length, 0);
    d.applyPush({ fanspeed: 51 }, {}, Date.now() - 60000);
    assert.equal(outcomes.length, 0);
    d.applyPush({ fanspeed: 51 }, {}, Date.now());
    assert.deepEqual(outcomes, [['fanspeed', 'reported']]);
    await d.setState('fanspeed', 91);
    d.pendingReports.get('fanspeed').timer._onTimeout();
    assert.deepEqual(outcomes[1], ['fanspeed', 'unconfirmed']);
    assert.equal(writes, 2);
  } finally { d.stop(); }
});

test('cloud login retains MQTT authorization separately from public diagnostics', async () => {
  const api = new BlueAirAwsApi('fixture', 'fixture', Region.US, quiet);
  const token = `a.${Buffer.from(JSON.stringify({ username: 'account' })).toString('base64url')}.c`;
  api.apiCall = async () => ({ access_token: token, expires_in: 86400,
    'ba_X-Amz-CustomAuthorizer-Name': 'name', 'ba_X-Amz-CustomAuthorizer-Signature': 'signature', 'ba_X-Amz-CustomAuthorizer-Token': 'token' });
  await api.getAwsAccessToken('fixture');
  const creds = await api.getMqttCredentials();
  assert.match(creds.host, /us-east-2/);
  assert.equal(creds.userId, 'account');
  assert.equal(creds.headers['X-Amz-CustomAuthorizer-Signature'], 'signature');
  assert.ok(creds.expiresAt > Date.now() + 86000000);
});

test('UI sends explicit false values and empty device arrays instead of stripping defaults', async () => {
  const html = fs.readFileSync('homebridge-ui/public/index.html', 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  let onChange, updated;
  const initial = { ...defaultConfig, devices: [{ ...defaultDeviceConfig, id: 'device', temperatureSensor: true, germShield: true }] };
  const homebridge = { showSpinner() {}, hideSpinner() {}, addEventListener() {},
    request: async (path, data) => path === '/getDefaults' ? { defaultConfig, defaultDeviceConfig } : data.config,
    getPluginConfig: async () => [initial], getPluginConfigSchema: async () => ({}),
    createForm: () => ({ onChange: callback => { onChange = callback; } }), updatePluginConfig: async data => { updated = data; } };
  await vm.runInNewContext(script, { homebridge, document: { getElementById: () => ({ addEventListener() {} }) } });
  await onChange({ ...initial, devices: [{ id: 'device', temperatureSensor: false, germShield: false }] });
  assert.equal(updated[0].devices[0].temperatureSensor, false);
  assert.equal(updated[0].devices[0].germShield, false);
  await onChange({ ...initial, devices: [] });
  assert.equal(updated[0].devices.length, 0);
});
