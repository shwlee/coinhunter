import test from 'node:test';
import assert from 'node:assert/strict';
import { selectRepresentativeModels as select } from '../src/ai/model-selection.js';

const models = (...ids) => ids.map((id) => ({ id, name: id, generationVerified: false }));

test('OpenAI offers at most three families and hides snapshots and specialized models', () => {
  const result = select(
    'openai',
    models(
      'gpt-5',
      'gpt-5.4',
      'gpt-5.4-2026-03-01',
      'gpt-5-mini',
      'gpt-5.4-mini',
      'gpt-5.4-pro',
      'gpt-5.4-nano',
      'gpt-audio',
      'gpt-image-1',
      'text-embedding-3-small',
      'gpt-5.3-codex',
      'gpt-5-chat-latest',
    ),
  );
  assert.deepEqual(
    result.map((m) => m.id),
    ['gpt-5.4', 'gpt-5.4-pro', 'gpt-5.4-mini'],
  );
  assert.equal(result[0].name, 'GPT-5.4');
  assert.equal(result[0].generationVerified, false);
  assert.deepEqual(
    select(
      'openai',
      models('gpt-6-sol', 'gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna', 'gpt-5-mini'),
    ).map((m) => m.id),
    ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna'],
  );
});

test('Claude collapses dated models without inventing unavailable aliases', () => {
  const result = select(
    'anthropic',
    models(
      'claude-3-5-sonnet-20241022',
      'claude-sonnet-4-5-20250929',
      'claude-sonnet-4-5-20251001',
      'claude-opus-4-1',
      'claude-haiku-4-5',
      'claude-fable-5-1',
    ),
  );
  assert.deepEqual(
    result.map((m) => m.id),
    ['claude-sonnet-4-5-20251001', 'claude-opus-4-1', 'claude-haiku-4-5', 'claude-fable-5-1'],
  );
  assert.equal(result[0].name, 'Claude Sonnet 4.5');
  assert.equal(
    select('anthropic', models('claude-sonnet-4-5-20251001', 'claude-sonnet-4-5'))[0].id,
    'claude-sonnet-4-5',
  );
});

test('Gemini offers Pro, Flash and Flash-Lite with clearly marked preview', () => {
  const result = select(
    'gemini',
    models(
      'gemini-2.5-pro',
      'gemini-3.1-pro-preview',
      'gemini-2.5-flash',
      'gemini-3.8-flash',
      'gemini-3.5-flash-lite',
      'gemini-3.8-flash-tts',
      'gemini-3-pro-image',
      'gemini-2.5-flash-native-audio-preview-12-2025',
      'gemini-embedding-001',
    ),
  );
  assert.deepEqual(
    result.map((m) => m.id),
    ['gemini-3.1-pro-preview', 'gemini-3.8-flash', 'gemini-3.5-flash-lite'],
  );
  assert.equal(result[0].name, 'Gemini 3.1 Pro (Preview)');
});

test('administrative allowlists narrow available choices and unknown IDs never become choices', () => {
  assert.deepEqual(
    select('openai', models('gpt-5', 'gpt-5.4', 'gpt-image-1'), [
      'gpt-5',
      'not-returned',
      'gpt-image-1',
    ]).map((m) => m.id),
    ['gpt-5'],
  );
  assert.deepEqual(select('openai', models('future-unknown', 'gpt-image-1')), []);
  assert.deepEqual(select('unknown', models('gpt-5')), []);
});
