const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
function context(platform) {
  const ctx = vm.createContext({navigator: {platform}, setTimeout, clearTimeout});
  for (const file of ['platform.js', 'native.js'])
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension', file), 'utf8'), ctx);
  return ctx;
}
test('Windows platform copy and native failures have no Mac keychain instructions', () => {
  const ctx = context('Win32');
  assert.equal(ctx.THUPlatform.isWindows, true);
  assert.doesNotMatch(Object.values(ctx.THUNative.errors).join('\n'), /钥匙串|Mac/);
  const node = {dataset: {platform: 'storage-description'}, textContent: 'original'};
  ctx.THUPlatform.apply({querySelectorAll: () => [node]});
  assert.match(node.textContent, /Windows/);
  assert.match(ctx.THUPlatform.saving, /Windows/);
});
test('Mac platform retains existing user-facing copy', () => {
  const ctx = context('MacIntel');
  assert.equal(ctx.THUPlatform.isWindows, false);
  assert.match(ctx.THUNative.errors['keychain-locked'], /钥匙串/);
  const node = {dataset: {platform: 'storage-description'}, textContent: 'user-written Mac copy'};
  ctx.THUPlatform.apply({querySelectorAll: () => [node]});
  assert.equal(node.textContent, 'user-written Mac copy');
});
