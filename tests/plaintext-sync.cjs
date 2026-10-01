// Run after installing ext dependencies: node --test tests/plaintext-sync.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('../ext/node_modules/typescript');
const CryptoJS = require('../ext/node_modules/crypto-js');
const { gzip, ungzip } = require('../ext/node_modules/pako');

const root = path.resolve(__dirname, '..');
const cookie = { name: 'session', value: '秘密', domain: 'example.test', path: '/', secure: false, httpOnly: true, sameSite: 'lax' };
const quiet = { log() {}, error() {}, warn() {}, info() {} };

function server(file) {
  const routes = {};
  const files = new Map();
  const app = { use() {}, get(url, handler) { routes[url] = handler; }, post(url, handler) { routes[url] = handler; }, all(url, handler) { routes[url] = handler; }, listen() {} };
  const fakeFs = { existsSync: key => files.has(key), mkdirSync() {}, writeFileSync: (key, value) => files.set(key, value), readFileSync: key => Buffer.from(files.get(key)), readdirSync: dir => [...files.keys()].filter(key => path.dirname(key) === dir).map(key => ({ name: path.basename(key), isFile: () => true })) };
  const dependencies = {
    express: () => app, path, fs: fakeFs, 'crypto-js': CryptoJS,
    './utils/logger': quiet, cors: () => () => {}, compression: () => () => {},
    multer: () => ({ array: () => () => {} }),
    'body-parser': { json: () => () => {}, urlencoded: () => () => {} },
    'express-rate-limit': () => () => {},
  };
  const context = { require: name => { if (!(name in dependencies)) throw new Error(name); return dependencies[name]; }, __dirname: path.dirname(file), process: { env: {}, on() {} }, console: quiet, Buffer };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), context);
  function request(url, body = {}, query = {}) {
    let result;
    const res = { set() {}, json(value) { result = JSON.parse(JSON.stringify(value)); }, send(value) { result = value; }, status(code) { throw new Error(`HTTP ${code}`); } };
    routes[url]({ body, query, params: { uuid: 'test-user' } }, res);
    return result;
  }
  return { request, files, context };
}

function extension(fetch) {
  const local = { 'LS-example.test': JSON.stringify({ token: 'local-secret' }) };
  const restored = [];
  const exports = {};
  const browser = {
    storage: { local: { async get(key) { return key === null ? local : { [key]: local[key] }; }, async set(values) { Object.assign(local, values); } } },
    cookies: { async getAll() { return [cookie]; }, async set(value) { restored.push(value); } },
    action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
  };
  const source = ts.transpileModule(fs.readFileSync(path.join(root, 'ext/utils/functions.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(source, { exports, require: name => name === 'crypto-js' ? CryptoJS : { gzip }, browser, fetch, console: quiet, alert() {}, setTimeout() {} });
  return { exports, local, restored };
}

for (const file of ['api/app.js', 'docker/app.js']) {
  test(`${file}: plaintext upload, storage and cookie/LocalStorage restoration without a password`, async () => {
    const api = server(path.join(root, file));
    let uploaded;
    const ext = extension(async (url, options) => {
      if (url.endsWith('/update')) {
        uploaded = JSON.parse(ungzip(options.body, { to: 'string' }));
        return { json: async () => api.request('/update', uploaded) };
      }
      return { json: async () => api.request('/get/:uuid') };
    });
    const config = { uuid: 'test-user', password: '', endpoint: 'http://private.test', crypto_type: 'none', domains: 'example.test', with_storage: 1 };
    assert.equal((await ext.exports.upload_cookie(config)).action, 'done');
    assert.equal(uploaded.crypto_type, 'none');
    const plaintext = JSON.parse(uploaded.encrypted);
    assert.equal(plaintext.cookie_data['example.test'][0].value, cookie.value);
    assert.equal(plaintext.local_storage_data['example.test'].token, 'local-secret');
    assert.equal(JSON.parse([...api.files.values()][0]).encrypted, uploaded.encrypted);
    assert.deepEqual(api.request('/get/:uuid', { password: 'ignored' }, { crypto_type: 'legacy' }), plaintext);
    delete ext.local['LS-example.test'];
    // A stored plaintext marker must also override a stale local algorithm setting.
    assert.equal((await ext.exports.download_cookie({ ...config, crypto_type: 'legacy' })).action, 'done');
    assert.equal(ext.restored[0].value, cookie.value);
    assert.equal(JSON.parse(ext.local['LS-example.test']).token, 'local-secret');
  });
}

for (const mode of ['legacy', 'aes-128-cbc-fixed']) {
  test(`API and extension retain ${mode} encrypted sync`, async () => {
    const api = server(path.join(root, 'api/app.js'));
    let uploaded;
    const ext = extension(async (url, options) => {
      if (url.endsWith('/update')) {
        uploaded = JSON.parse(ungzip(options.body, { to: 'string' }));
        return { json: async () => api.request('/update', uploaded) };
      }
      return { json: async () => api.request('/get/:uuid') };
    });
    const config = { uuid: 'test-user', password: 'secret', endpoint: 'http://private.test', crypto_type: mode, domains: 'example.test' };
    assert.equal((await ext.exports.upload_cookie(config)).action, 'done');
    assert.throws(() => JSON.parse(uploaded.encrypted));
    assert.equal(api.request('/get/:uuid', { password: 'secret' }).cookie_data['example.test'][0].value, cookie.value);
    assert.equal((await ext.exports.download_cookie(config)).action, 'done');
    assert.equal(ext.restored[0].value, cookie.value);
    assert.equal(await ext.exports.upload_cookie({ ...config, password: '' }), false);
  });
}

for (const file of ['api/app.js', 'docker/app.js']) {
  test(`${file}: query every UUID, isolate bad records and decrypt without importing cookies`, async () => {
    const api = server(path.join(root, file));
    const data = { cookie_data: { 'example.test': [cookie] }, local_storage_data: { 'example.test': { token: 'test' } } };
    api.request('/update', { uuid: 'plain', crypto_type: 'none', encrypted: JSON.stringify(data) });
    for (const mode of ['legacy', 'aes-128-cbc-fixed']) {
      const encrypt = server(path.join(root, 'api/app.js')).context.cookie_encrypt;
      api.request('/update', { uuid: mode, crypto_type: mode, encrypted: encrypt(mode, data, 'secret', mode) });
    }
    api.files.set(path.join(root, path.dirname(file), 'data/broken.json'), '{invalid');
    api.files.set(path.join(root, path.dirname(file), 'data/ignored.txt'), 'ignore');
    let request;
    const ext = extension(async (url, options) => {
      request = { url, options };
      return { ok: true, json: async () => api.request('/records') };
    });
    const records = await ext.exports.query_uploaded_cookies('http://private.test/', 'secret', 'Authorization: Bearer abc:def');
    assert.equal(request.url, 'http://private.test/records');
    assert.equal(request.options.headers.Authorization, 'Bearer abc:def');
    assert.equal(records.length, 4);
    assert.equal(records.filter(record => record.data).length, 3);
    assert.equal(records.find(record => record.uuid === 'broken').error, '服务端记录无法读取');
    assert.equal(ext.restored.length, 0);
    const noPassword = await ext.exports.query_uploaded_cookies('http://private.test', '');
    assert.equal(noPassword.filter(record => record.data).length, 1);
    assert.match(noPassword.find(record => record.uuid === 'legacy').error, /填写对应密码/);
    const wrongPassword = await ext.exports.query_uploaded_cookies('http://private.test', 'wrong');
    assert.equal(wrongPassword.filter(record => record.data).length, 1);
    assert.match(wrongPassword.find(record => record.uuid === 'legacy').error, /无法解密/);
  });
}

test('toolbar opens a settings tab with context and reuses it without navigating away from drafts', async () => {
  let click;
  let existing = [];
  const created = [], updated = [], focused = [];
  const browser = {
    runtime: { id: 'test', getURL: url => `chrome-extension://test${url}`, onInstalled: { addListener() {} } },
    action: { onClicked: { addListener: handler => { click = handler; } } },
    alarms: { onAlarm: { addListener() {} } },
    tabs: { async query() { return existing; }, async create(options) { created.push(options); }, async update(id, options) { updated.push({ id, options }); } },
    windows: { async update(id, options) { focused.push({ id, options }); } },
  };
  const source = ts.transpileModule(fs.readFileSync(path.join(root, 'ext/entrypoints/background.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  vm.runInNewContext(source, { exports, require: name => name === 'webextension-polyfill' ? browser : {}, defineBackground: handler => handler(), console: quiet, URLSearchParams });
  await click({ id: 123, url: 'chrome://newtab/' });
  const url = new URL(created[0].url);
  assert.equal(url.pathname, '/popup.html');
  assert.equal(url.searchParams.get('targetTabId'), '123');
  assert.equal(url.searchParams.get('targetUrl'), 'chrome://newtab/');
  existing = [{ id: 789, windowId: 456, url: created[0].url }];
  await click({ id: 124, url: 'https://example.test' });
  assert.equal(created.length, 1);
  assert.equal(updated[0].id, 789);
  assert.equal(updated[0].options.active, true);
  assert.equal(updated[0].options.url, undefined);
  assert.equal(focused[0].id, 456);
});

test('record query reports an unsupported server endpoint', async () => {
  const ext = extension(async () => ({ ok: false, status: 404 }));
  await assert.rejects(ext.exports.query_uploaded_cookies('http://private.test', ''), /请更新服务端/);
});

for (const minutes of [-1, 0, 60]) {
  test(`cookie restoration lifetime ${minutes}: long-term, session or custom`, async () => {
    const ext = extension(async () => ({ json: async () => ({ crypto_type: 'none', encrypted: JSON.stringify({ cookie_data: { 'example.test': [cookie] } }) }) }));
    const before = Math.floor(Date.now() / 1000);
    assert.equal((await ext.exports.download_cookie({ uuid: 'test', password: '', endpoint: 'http://private.test', expire_minutes: minutes })).action, 'done');
    const restored = ext.restored[0];
    if (minutes === 0) {
      assert.equal('expirationDate' in restored, false);
    } else {
      const duration = minutes === -1 ? 400 * 24 * 60 * 60 : minutes * 60;
      assert.ok(restored.expirationDate >= before + duration);
      assert.ok(restored.expirationDate <= Math.floor(Date.now() / 1000) + duration);
    }
  });
}
