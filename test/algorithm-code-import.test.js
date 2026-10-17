import test from 'node:test';
import assert from 'node:assert/strict';
import { extractAlgorithmSource } from '../public/algorithm-code-import.js';

test('raw JavaScript preserves whitespace, template literals and source offsets', () => {
  const source =
    '\n  module.exports = class { getName(){ return `\n```js\nnot a fence\n\`\`\``; } };\n';
  assert.deepEqual(extractAlgorithmSource(source), { source, offset: 0, format: 'raw' });
  assert.deepEqual(extractAlgorithmSource('\uFEFF' + source), { source, offset: 1, format: 'raw' });
});

test('single JavaScript fence extracts exact body with original CRLF and diagnostic offset', () => {
  const source = '  module.exports = class {\r\n  getName() { return "한글"; }\r\n};';
  for (const [open, close] of [
    ['```javascript', '```'],
    ['~~~js', '~~~'],
    ['````JS', '`````'],
    ['```', '```'],
  ]) {
    const text = '\uFEFF \r\n' + open + '\r\n' + source + '\r\n' + close + '\r\n ';
    const extracted = extractAlgorithmSource(text);
    assert.equal(extracted.source, source);
    assert.equal(extracted.format, 'fenced');
    assert.equal(text.slice(extracted.offset, extracted.offset + source.length), source);
  }
});

test('ambiguous, wrong-language, empty and broken fences fail without combining blocks', () => {
  for (const text of [
    '',
    ' \n',
    null,
    '```python\nprint(1)\n```',
    '```json\n{}\n```',
    '```js\n\n```',
    '```js\nconst x=1;',
    '```js\nconst x=1;\n~~~',
    '```js\nconst x=1;\n```\n```js\nconst y=2;\n```',
    '```js\nconst x=1;\n```\n설명입니다.',
    '```js const x=1;```',
  ])
    assert.throws(() => extractAlgorithmSource(text));
});

test('large code is not truncated and prose preceding code remains raw for the execution checker', () => {
  const source = 'module.exports = class {};\n' + '// 원문\n'.repeat(100000);
  assert.equal(extractAlgorithmSource('```js\n' + source + '\n```').source, source);
  const prose = '설명 뒤에 코드가 있습니다.\n```js\nmodule.exports=class{};\n```';
  assert.equal(extractAlgorithmSource(prose).source, prose);
});
