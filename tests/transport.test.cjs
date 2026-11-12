const {test} = require('node:test');
const assert = require('node:assert/strict');
const config = require('../native/config.json');
const vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
function setup() {
  let timeout, onMessage, onDisconnect, closed = 0, request;
  const ctx = vm.createContext({Promise, clearTimeout() {}, setTimeout(fn) {timeout = fn; return 1;}});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/native.js'), 'utf8'), ctx);
  const chrome = {runtime: {connectNative(host) {
    assert.equal(host, config.host);
    return {onMessage: {addListener(fn) {onMessage=fn;}}, onDisconnect: {addListener(fn) {onDisconnect=fn;}},
      disconnect() {closed++;}, postMessage(value) {request = value;}};
  }}};
  return {chrome, call: () => ctx.THUNative.call(chrome, {op: 'get', role: 'identity'}),
    message: value => onMessage(value), disconnect: () => onDisconnect(), timeout: () => timeout(),
    get closed() {return closed;}, get request() {return request;}};
}
test('native protocol mismatch fails closed and closes the pipe', async () => {
  const h = setup(), pending = h.call(); h.message({protocol: 2, ok: true, password: 'synthetic'});
  const r = await pending; assert.equal(r.error, 'protocol-mismatch'); assert.equal(r.password, undefined); assert.equal(h.closed, 1);
});
test('timeout disconnects and a late response cannot revive the request', async () => {
  const h = setup(), pending = h.call(); h.timeout(); h.message({protocol: 1, ok: true, password: 'late'});
  const r = await pending; assert.equal(r.error, 'helper-timeout'); assert.equal(r.password, undefined); assert.equal(h.closed, 1);
});
test('missing host or connection error produces actionable failure', async () => {
  const h = setup(), pending = h.call(); h.disconnect(); assert.equal((await pending).error, 'helper-unavailable');
});
test('valid native reply is delivered once and connection is closed', async () => {
  const h = setup(), pending = h.call(); h.message({protocol: 1, ok: true, username: 'fixture', password: 'synthetic'}); h.disconnect();
  assert.equal((await pending).password, 'synthetic'); assert.equal(h.closed, 1); assert.equal(h.request.protocol, 1);
});

test('browser transport uses the same protocol as the packaged native host', async () => {
  const h = setup(), pending = h.call();
  assert.equal(h.request.protocol, config.protocol);
  h.message({protocol: config.protocol, ok: true});
  assert.equal((await pending).ok, true);
});
