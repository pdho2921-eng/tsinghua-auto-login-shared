const THUNative = require('../extension/native.js');
const contentGlobals = {
  THUNative,
  THUNotice: require('../extension/notice.js'),
  Event: class { constructor(type, options) { this.type = type; Object.assign(this, options); } },
  HTMLInputElement: {prototype: Object.defineProperty({}, 'value', {set(value) { this.value = value; }})}
};
const element = () => ({style: {}, textContent: '', setAttribute() {}, prepend() {}, append() {}, addEventListener() {}, remove() {}});
module.exports = {contentGlobals, element};
