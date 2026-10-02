import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { ungzip } from 'pako';

const require = createRequire(import.meta.url);
const config = {
  uuid: 'test-uuid', password: 'test-password', endpoint: 'https://sync.example',
  headers: 'Authorization: Bearer test:token', with_storage: 0, no_cache: 1,
};
const cookie = { name: 'session', value: 'test', domain: 'example.com', path: '/', secure: true, sameSite: 'unspecified', hostOnly: true };

function setup(fetch, setCookie = async details => details) {
  const storage = {};
  const badge = { setBadgeText() {}, setBadgeBackgroundColor() {} };
  const context = {
    console: { log() {} }, Error, fetch, navigator: { userAgent: 'Firefox/140.0' },
    setTimeout() {}, alert() {},
    browser: {
      browserAction: badge,
      cookies: { getAll: async () => [cookie], set: setCookie },
      storage: { local: {
        get: async key => ({ [key]: storage[key] }),
        set: async entries => Object.assign(storage, entries),
      } },
    },
  };
  function load(file, dependencies = {}) {
    const source = readFileSync(new URL(`../utils/${file}.ts`, import.meta.url), 'utf8');
    const compiled = ts.transpileModule(source, { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
    } });
    const exports = {};
    runInNewContext(compiled.outputText, {
      ...context, exports, require: name => dependencies[name] || require(name),
    });
    return exports;
  }
  const functions = load('functions');
  return { ...functions, ...load('messaging', { './functions': functions }) };
}

for (const mode of ['legacy', 'aes-128-cbc-fixed', 'none']) {
  test(`Chrome configuration uploads and restores cookies in Firefox (${mode})`, async () => {
    let uploaded;
    let saved;
    const api = setup(async (url, request) => {
      assert.equal(request.headers.Authorization, 'Bearer test:token');
      if (request.method === 'POST') {
        uploaded = JSON.parse(ungzip(request.body, { to: 'string' }));
        return { ok: true, json: async () => ({ action: 'done' }) };
      }
      return { ok: true, json: async () => uploaded };
    }, async details => { saved = details; return details; });
    assert.equal((await api.handleConfigMessage({ ...config, type: 'up', crypto_type: mode })).message, 'done');
    assert.equal((await api.handleConfigMessage({ ...config, type: 'down', crypto_type: mode })).message, 'done');
    assert.equal(saved.value, cookie.value);
    assert.equal(saved.sameSite, 'unspecified');
    assert.equal(saved.url, 'https://example.com/');
    assert.equal(saved.domain, undefined);
  });
}

test('HTTP authentication failures reach the manual sync result', async () => {
  const api = setup(async () => ({ ok: false, status: 401 }));
  for (const type of ['up', 'down']) {
    const result = await api.handleConfigMessage({ ...config, type });
    assert.notEqual(result.message, 'done');
    assert.match(result.note, /HTTP 401/);
  }
});

test('Firefox restores insecure unspecified cookies without converting them to SameSite=None', async () => {
  const cookies = [
    { ...cookie, name: 'event_filter', secure: false },
    { ...cookie, name: 'lax_cookie', secure: false, sameSite: 'lax' },
    { ...cookie, name: 'strict_cookie', secure: false, sameSite: 'strict' },
    { ...cookie, name: 'cross_site', sameSite: 'no_restriction' },
    { ...cookie, name: 'default_cookie', secure: false, sameSite: undefined },
  ];
  const restored = [];
  const api = setup(async () => ({ ok: true, json: async () => ({
    encrypted: JSON.stringify({ cookie_data: { 'example.com': cookies } }), crypto_type: 'none',
  }) }), async details => {
    if (details.sameSite === 'no_restriction' && !details.secure) {
      throw new Error('SameSite=None requires Secure');
    }
    restored.push(details);
    return details;
  });
  const result = await api.handleConfigMessage({ ...config, type: 'down', crypto_type: 'none' });
  assert.equal(result.message, 'done');
  assert.equal(restored.length, cookies.length);
  for (let i = 0; i < cookies.length; i++) {
    assert.equal(restored[i].sameSite, cookies[i].sameSite);
    assert.equal(restored[i].secure, cookies[i].secure);
    assert.equal(restored[i].url, `${cookies[i].secure ? 'https' : 'http'}://example.com/`);
  }
});

test('editing an insecure unspecified cookie preserves its SameSite and Secure attributes', async () => {
  let saved;
  const original = { ...cookie, name: 'event_filter', secure: false };
  const api = setup(async () => { throw new Error('Unexpected network request'); }, async details => {
    assert.equal(details.sameSite, 'unspecified');
    assert.equal(details.secure, false);
    saved = { ...original, ...details };
    return saved;
  });
  await api.apply_browser_cookie_value(original, 'updated');
  assert.equal(saved.value, 'updated');
  assert.equal(saved.url, 'http://example.com/');
});

test('an explicit insecure SameSite=None cookie reports rejection without silently changing its attributes', async () => {
  const original = { ...cookie, secure: false, sameSite: 'no_restriction' };
  const api = setup(async () => ({ ok: true, json: async () => ({
    encrypted: JSON.stringify({ cookie_data: { 'example.com': [original] } }), crypto_type: 'none',
  }) }), async details => {
    assert.equal(details.secure, false);
    assert.equal(details.sameSite, 'no_restriction');
    throw new Error('SameSite=None requires Secure');
  });
  const result = await api.handleConfigMessage({ ...config, type: 'down', crypto_type: 'none' });
  assert.notEqual(result.message, 'done');
  assert.match(result.note, /SameSite=None requires Secure/);
});

test('a rejected Cookie reports partial failure and continues restoring other cookies', async () => {
  const restored = [];
  const data = { cookie_data: { 'example.com': [cookie, { ...cookie, name: 'other' }] } };
  const api = setup(async () => ({ ok: true, json: async () => ({ encrypted: JSON.stringify(data), crypto_type: 'none' }) }), async details => {
    restored.push(details.name);
    if (details.name === 'session') throw new Error('Cookie permission denied');
    return details;
  });
  const result = await api.handleConfigMessage({ ...config, type: 'down', crypto_type: 'none' });
  assert.notEqual(result.message, 'done');
  assert.match(result.note, /1 个 Cookie 写入失败：Cookie permission denied/);
  assert.deepEqual(restored, ['session', 'other']);
});

test('missing server data and malformed headers report useful errors', async () => {
  let requests = 0;
  const api = setup(async () => { requests++; return { ok: true, json: async () => ({}) }; });
  const missing = await api.handleConfigMessage({ ...config, type: 'down' });
  assert.match(missing.note, /UUID/);
  for (const type of ['up', 'down']) {
    const invalid = await api.handleConfigMessage({ ...config, type, headers: 'invalid' });
    assert.match(invalid.note, /Header/);
  }
  assert.equal(requests, 1);
});
