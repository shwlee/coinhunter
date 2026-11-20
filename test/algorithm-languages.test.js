import test from 'node:test';
import assert from 'node:assert/strict';
import {
  algorithmLanguage,
  languageFromFilename,
  unavailableLanguage,
  DEFAULT_CAPABILITIES,
  emptyAlgorithmFor,
  diagnosticPosition,
} from '../frontend/public/algorithm-languages.js';

test('language metadata defaults old records to JavaScript and rejects unknown languages', () => {
  assert.equal(algorithmLanguage().extension, '.js');
  assert.equal(algorithmLanguage(null).extension, '.js');
  assert.equal(languageFromFilename('Player.CS'), 'csharp');
  assert.equal(languageFromFilename('player.js'), 'javascript');
  assert.throws(() => algorithmLanguage('python'));
  assert.throws(() => languageFromFilename('player.cs.js.exe'));
});
test('C# capability requires both explicit enablement and a signed in user', () => {
  assert.equal(unavailableLanguage(DEFAULT_CAPABILITIES, 'javascript', false), '');
  assert.ok(unavailableLanguage(DEFAULT_CAPABILITIES, 'csharp', true));
  const enabled = { languages: [{ id: 'csharp', enabled: true, requiresLogin: true }] };
  assert.ok(unavailableLanguage(enabled, 'csharp', false));
  assert.equal(unavailableLanguage(enabled, 'csharp', true), '');
});
test('C# diagnostics map one-based source coordinates to UTF-16 offsets including CRLF', () => {
  const source = 'public class Player {\r\n  한글 오류\r\n}';
  const position = diagnosticPosition({ details: [{ code: 'AX001', line: 2, column: 3 }] }, source);
  assert.equal(source.slice(position.offset, position.offset + 2), '한글');
  assert.equal(diagnosticPosition({ detail: { line: 7, column: 1 } }, source), null);
  assert.equal(
    diagnosticPosition({ detail: { code: 'AR012', line: null, column: null } }, source),
    null,
  );
  assert.equal(
    emptyAlgorithmFor('csharp').includes(
      'public int MoveNext(int[] map, int myPosition, int[] items)',
    ),
    true,
  );
});
