import { aiError, openAiLimitError } from './providers.js';

// Parse SSE framing independently of transport chunk boundaries. Only counters
// and lifecycle stages leave this module; partial code/reasoning stays private.
export async function readOpenAiStream(response, signal, onProgress = () => {}) {
  if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream'))
    throw aiError('invalid_response');
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let buffer = '',
    data = [],
    bytes = 0,
    frameBytes = 0,
    receivedChars = 0,
    completed = null;
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', cancel, { once: true });
  function dispatch() {
    if (!data.length) return;
    const raw = data.join('\n');
    data = [];
    frameBytes = 0;
    if (raw === '[DONE]') return;
    let event;
    try {
      event = JSON.parse(raw);
    } catch {
      throw aiError('invalid_response');
    }
    if (!event || typeof event !== 'object' || typeof event.type !== 'string')
      throw aiError('invalid_response');
    if (['response.created', 'response.in_progress'].includes(event.type))
      onProgress({ phase: 'accepted', receivedChars });
    else if (event.type === 'response.output_text.delta') {
      if (typeof event.delta !== 'string') throw aiError('invalid_response');
      receivedChars += [...event.delta].length;
      if (receivedChars > 4 * 1024 * 1024) throw aiError('invalid_response');
      onProgress({ phase: 'receiving', receivedChars });
    } else if (event.type === 'response.refusal.delta') throw aiError('refused', 422);
    else if (['response.completed', 'response.incomplete'].includes(event.type)) {
      if (!event.response || typeof event.response !== 'object') throw aiError('invalid_response');
      if (
        (event.type === 'response.completed' && event.response.status !== 'completed') ||
        (event.type === 'response.incomplete' && event.response.status !== 'incomplete')
      )
        throw aiError('invalid_response');
      completed = event.response;
    } else if (['response.failed', 'error'].includes(event.type)) {
      const error = event.response?.error || event.error || event;
      const knownLimits = [
        'insufficient_quota',
        'credit_balance_exhausted',
        'organization_spend_limit_exceeded',
        'project_spend_limit_exceeded',
        'organization_usage_limit_exceeded',
        'usage_limit_exceeded',
        'rate_limit_exceeded',
        'slow_down',
      ];
      if (knownLimits.includes(error.code) || error.type === 'insufficient_quota')
        throw openAiLimitError({ error });
      if (error.code === 'context_length_exceeded') throw aiError('input_too_large', 422);
      if (error.code === 'model_not_found') throw aiError('model_unavailable', 422);
      throw aiError('unavailable', 503);
    }
  }
  function consume(final = false) {
    while (buffer.length) {
      const index = buffer.search(/[\r\n]/);
      if (index < 0) break;
      if (buffer[index] === '\r' && index === buffer.length - 1 && !final) break;
      const line = buffer.slice(0, index);
      const newline = buffer[index] === '\r' && buffer[index + 1] === '\n' ? 2 : 1;
      buffer = buffer.slice(index + newline);
      if (!line) dispatch();
      else if (line.startsWith('data:')) {
        const value = line.slice(5).replace(/^ /, '');
        frameBytes += Buffer.byteLength(value);
        if (frameBytes > 4 * 1024 * 1024) throw aiError('invalid_response');
        data.push(value);
      }
      if (completed) return;
    }
    if (Buffer.byteLength(buffer) > 4 * 1024 * 1024) throw aiError('invalid_response');
  }
  try {
    if (signal.aborted) throw aiError('cancelled', 409);
    while (!completed) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw aiError('cancelled', 409);
      if (done) {
        buffer += decoder.decode();
        consume(true);
        // EOF without a complete framed terminal event must never yield a candidate.
        if (!completed) throw aiError('stream_interrupted', 502);
        break;
      }
      bytes += value.byteLength;
      if (bytes > 16 * 1024 * 1024) throw aiError('invalid_response');
      buffer += decoder.decode(value, { stream: true });
      consume();
    }
    return { body: completed, receivedChars };
  } finally {
    signal.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
