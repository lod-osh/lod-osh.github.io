#!/usr/bin/env node
/*
 * check-docs.js — checks the Ecosystem Check API docs against the in-browser demo server.
 *
 * What it does
 *   1. Completeness: every endpoint, parameter, schema field, tag, and response has a description,
 *      and every request body and success/error response has an example.
 *   2. Examples vs schemas: every documented example is validated against its schema.
 *   3. Docs vs demo: each endpoint is called with the documented examples (plus deliberately bad requests).
 *      Every status code returned must be documented, and every response body must match its schema.
 *
 * Run it (Node 18+):
 *   npm install ajv ajv-formats
 *   node check-docs.js [path-to-ecosystem-check-api.html]
 *
 * Exit code is 0 when every check passes and 1 otherwise.
 * The demo is simulated, so this confirms that the docs match the demo, not a production service.
 */
const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const file = process.argv[2] || path.join(__dirname, 'ecosystem-check-api.html');
const html = fs.readFileSync(file, 'utf8');
const js = html.split('<script>').pop().split('</script>')[0];

// The page keeps the spec, the demo server, and the page wiring in one script. Load the first two.
const specEnd = js.indexOf('// ---- Light / dark theme');
const mockStart = js.indexOf('// ---- In-browser mock server');
const mockEnd = js.indexOf('// ---- Demo prefill');
if (specEnd < 0 || mockStart < 0 || mockEnd < 0) { console.error('Could not find the spec and demo server in ' + file); process.exit(2); }
const spec = new Function(js.slice(0, specEnd) + ';return openApiSpec;')();

globalThis.window = globalThis;
// Live sources are not part of this check, so make the demo's own network access fail deterministically.
// (The demo captures window.fetch when it loads, so this must be set first.)
globalThis.fetch = () => Promise.reject(new TypeError('offline'));
globalThis.demoDataMode = 'sample';
new Function(js.slice(mockStart, mockEnd))();

const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
const compiled = {};
function validate(schema, data, label) {
  let fn;
  if (schema.$ref) {
    const name = schema.$ref.split('/').pop();
    fn = compiled[name] || (compiled[name] = ajv.compile({ $ref: '#/components/schemas/' + name, components: spec.components }));
  } else {
    fn = ajv.compile(Object.assign({ components: spec.components }, schema));
  }
  if (fn(data)) return true;
  problem('schema mismatch in ' + label + ': ' + fn.errors.slice(0, 3).map(e => (e.instancePath || '/') + ' ' + e.message).join('; '));
  return false;
}
let problems = 0;
function problem(msg) { problems++; console.log('  x ' + msg); }

// ---------- 1. completeness ----------
console.log('1. Completeness');
const bareStatus = /^(OK|Created|No Content|Bad Request|Not Found|Conflict|Unprocessable Entity|Too Many Requests|Bad Gateway)$/;
let endpoints = 0;
for (const [p, ops] of Object.entries(spec.paths)) {
  for (const [m, op] of Object.entries(ops)) {
    endpoints++;
    const id = m.toUpperCase() + ' ' + p;
    if (!op.summary) problem(id + ': no summary');
    if (!op.description) problem(id + ': no description');
    (op.parameters || []).forEach(x => { if (!x.description) problem(id + ': parameter ' + x.name + ' has no description'); });
    if (op.requestBody) {
      const mt = op.requestBody.content['application/json'];
      if (!op.requestBody.description) problem(id + ': request body has no description');
      if (mt.example === undefined) problem(id + ': request body has no example');
    }
    for (const [code, r] of Object.entries(op.responses)) {
      if (bareStatus.test(r.description)) problem(id + ' ' + code + ': response has only a status phrase');
      if (r.content && r.content['application/json'].example === undefined) problem(id + ' ' + code + ': response has no example');
    }
  }
}
function walk(schemaName, node, trail) {
  if (!node || typeof node !== 'object' || !node.properties) return;
  for (const [k, v] of Object.entries(node.properties)) {
    if (!v.$ref && !v.description) problem('schema ' + schemaName + ': field ' + trail + k + ' has no description');
    walk(schemaName, v, trail + k + '.');
    if (v.items) walk(schemaName, v.items, trail + k + '[].');
  }
}
for (const [name, sc] of Object.entries(spec.components.schemas)) {
  if (sc.enum && !sc.description) problem('enum ' + name + ' has no description');
  walk(name, sc, '');
}
(spec.tags || []).forEach(t => { if (!t.description) problem('tag ' + t.name + ' has no description'); });
if (!spec.info.description) problem('info has no description');
console.log('   ' + endpoints + ' endpoints checked');

// ---------- 2. examples vs schemas ----------
console.log('2. Examples against schemas');
let examples = 0;
for (const [p, ops] of Object.entries(spec.paths)) {
  for (const [m, op] of Object.entries(ops)) {
    const id = m.toUpperCase() + ' ' + p;
    if (op.requestBody) {
      const mt = op.requestBody.content['application/json'];
      examples++; validate(mt.schema, mt.example, id + ' request');
    }
    for (const [code, r] of Object.entries(op.responses)) {
      if (!r.content) continue;
      const mt = r.content['application/json'];
      if (mt.example !== undefined) { examples++; validate(mt.schema, mt.example, id + ' ' + code + ' response'); }
    }
  }
}
console.log('   ' + examples + ' examples checked');

// ---------- 3. docs vs demo ----------
console.log('3. Demo responses against the docs');
const BASE = 'https://api.example-ecosystem-check.com/v1';
const seen = new Set();
async function call(method, urlPath, body) {
  const init = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await window.fetch(new Request(BASE + urlPath, init));
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch (e) { /* 204 has no body */ }
  const key = urlPath.split('?')[0].replace(/^\/locations\/[^/]+$/, '/locations/{locationId}').replace(/^\/alerts\/[^/]+$/, '/alerts/{alertId}');
  const op = spec.paths[key] && spec.paths[key][method.toLowerCase()];
  const id = method + ' ' + key + ' -> ' + res.status;
  if (!op || !op.responses[res.status]) { problem('status not documented: ' + id); return { status: res.status, json }; }
  seen.add(method + ' ' + key + ' ' + res.status);
  const content = op.responses[res.status].content;
  if (content && json !== null) validate(content['application/json'].schema, json, id);
  return { status: res.status, json };
}
const example = (p, m) => spec.paths[p][m].requestBody.content['application/json'].example;
function expect(cond, msg) { if (!cond) problem(msg); }

(async () => {
  await call('GET', '/ecosystem/check?lat=34.7465&lon=-92.2896&radiusMiles=15');
  await call('GET', '/ecosystem/check?lat=34.7&lon=-92.3&include=air,water');
  await call('GET', '/ecosystem/check?lat=34.7&lon=-92.3&include=');
  await call('GET', '/ecosystem/check');
  await call('GET', '/ecosystem/check?lat=48.8&lon=2.3');
  await call('GET', '/locations');
  await call('GET', '/locations?limit=0');
  expect((await call('POST', '/locations', example('/locations', 'post'))).status === 201, 'POST /locations example did not create a location');
  await call('POST', '/locations', example('/locations', 'post'));
  await call('POST', '/locations', { name: 'x' });
  await call('POST', '/locations', { name: 'Paris', lat: 48.85, lon: 2.35 });
  await call('GET', '/locations/loc_1');
  await call('GET', '/locations/nope');
  expect((await call('PUT', '/locations/loc_1', example('/locations/{locationId}', 'put'))).status === 200, 'PUT location example failed');
  await call('PUT', '/locations/loc_1', { lat: 34.7, lon: -92.3 });
  await call('PUT', '/locations/nope', { name: 'A', lat: 34.7, lon: -92.3 });
  await call('PUT', '/locations/loc_1', { name: 'Paris', lat: 48.85, lon: 2.35 });
  await call('PUT', '/locations/loc_1', { name: 'Denver, CO', lat: 34.7, lon: -92.3 });
  expect((await call('PATCH', '/locations/loc_1', example('/locations/{locationId}', 'patch'))).status === 200, 'PATCH location example failed');
  await call('PATCH', '/locations/loc_1', {});
  await call('PATCH', '/locations/nope', { radiusMiles: 20 });
  await call('PATCH', '/locations/loc_1', { name: 'denver, co' });
  await call('PATCH', '/locations/loc_1', { lat: 48.85, lon: 2.35 });
  await call('GET', '/alerts');
  await call('GET', '/alerts?status=zzz');
  const created = await call('POST', '/alerts', example('/alerts', 'post'));
  expect(created.status === 201, 'POST /alerts example failed');
  await call('POST', '/alerts', { locationId: 'loc_1' });
  await call('POST', '/alerts', Object.assign({}, example('/alerts', 'post'), { locationId: 'zzz' }));
  await call('POST', '/alerts', { locationId: 'loc_1', conditions: [{ parameter: 'aqi', min: 100, max: 1 }], delivery: { type: 'email', target: 'a@b.co' } });
  await call('GET', '/alerts/alert_1');
  await call('GET', '/alerts/nope');
  const put = await call('PUT', '/alerts/alert_1', example('/alerts/{alertId}', 'put'));
  expect(put.status === 200, 'PUT alert example failed');
  const reset = await call('PUT', '/alerts/alert_1', { locationId: 'loc_1', conditions: [{ parameter: 'aqi', min: 1 }], delivery: { type: 'email', target: 'a@b.co' } });
  expect(reset.json && reset.json.name === null && reset.json.match === 'all' && reset.json.cooldownMinutes === 60 && reset.json.status === 'active', 'PUT alert: omitted fields do not reset to the documented defaults');
  await call('PUT', '/alerts/alert_1', { locationId: 'loc_1' });
  await call('PUT', '/alerts/alert_1', { locationId: 'loc_1', conditions: [{ parameter: 'aqi', min: 5, max: 1 }], delivery: { type: 'email', target: 'a@b.co' } });
  await call('PUT', '/alerts/nope', example('/alerts/{alertId}', 'put'));
  expect((await call('PATCH', '/alerts/alert_1', example('/alerts/{alertId}', 'patch'))).status === 200, 'PATCH alert example failed');
  await call('PATCH', '/alerts/alert_1', {});
  await call('PATCH', '/alerts/alert_1', { locationId: 'loc_1' });
  await call('PATCH', '/alerts/nope', { status: 'paused' });
  await call('PATCH', '/alerts/alert_1', { conditions: [{ parameter: 'aqi', min: 9, max: 1 }] });
  await call('DELETE', '/locations/loc_1');
  await call('DELETE', '/alerts/alert_1');
  await call('DELETE', '/alerts/alert_2');
  await call('DELETE', '/alerts/nope');
  await call('DELETE', '/locations/loc_2');
  await call('DELETE', '/locations/nope');
  globalThis.demoDataMode = 'live'; // network is offline here, so every source fails and the API must answer 502
  const realConsole = globalThis.console; globalThis.console = {}; // the demo logs each failed source; keep the output clean
  try { await call('GET', '/ecosystem/check?lat=34.7&lon=-92.3&include=air'); } finally { globalThis.console = realConsole; }

  const never = [];
  for (const [p, ops] of Object.entries(spec.paths)) for (const [m, op] of Object.entries(ops)) for (const c of Object.keys(op.responses)) {
    if (!seen.has(m.toUpperCase() + ' ' + p + ' ' + c)) never.push(m.toUpperCase() + ' ' + p + ' ' + c);
  }
  console.log('   documented but not produced by the demo: ' + (never.join(', ') || 'none'));
  console.log(problems ? '\n' + problems + ' problem(s) found' : '\nAll checks passed');
  process.exit(problems ? 1 : 0);
})();
