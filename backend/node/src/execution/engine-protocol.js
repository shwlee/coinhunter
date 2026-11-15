// Parent/engine wire contract only; not a running host and not the player invocation transport.
import { TextDecoder } from 'node:util';

export const ENGINE_CONTRACT_VERSION = 1;
export const ENGINE_MAX_FRAME_BYTES = 4 * 1024 * 1024;
const messageTypes = new Set([
  'initialize',
  'prepared',
  'start',
  'snapshot',
  'stop',
  'closed',
  'failed',
  'recording-status',
  'ack',
]);
const keys = new Set([
  'contractVersion',
  'matchId',
  'messageId',
  'correlationId',
  'type',
  'payload',
]);
const uuid = (value) =>
  typeof value === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value) &&
  value !== '00000000-0000-0000-0000-000000000000';

export function validateEngineEnvelope(message) {
  if (
    !message ||
    typeof message !== 'object' ||
    Array.isArray(message) ||
    Object.keys(message).some((key) => !keys.has(key)) ||
    message.contractVersion !== ENGINE_CONTRACT_VERSION ||
    !uuid(message.matchId) ||
    !uuid(message.messageId) ||
    (message.correlationId != null && !uuid(message.correlationId)) ||
    !messageTypes.has(message.type) ||
    !message.payload ||
    typeof message.payload !== 'object' ||
    Array.isArray(message.payload)
  )
    throw new Error('Invalid engine envelope or unsupported contract version.');
  const stack = [[message, 1]];
  while (stack.length) {
    const [value, depth] = stack.pop();
    if (depth > 64) throw new Error('Engine envelope exceeds its nesting limit.');
    for (const child of Object.values(value)) {
      if (child && typeof child === 'object') stack.push([child, depth + 1]);
    }
  }
  return message;
}

export function encodeEngineFrame(message, maxBytes = ENGINE_MAX_FRAME_BYTES) {
  validateEngineEnvelope(message);
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  if (payload.length === 0 || payload.length > maxBytes)
    throw new Error('Engine frame exceeds its byte limit.');
  const frame = Buffer.allocUnsafe(payload.length + 4);
  frame.writeUInt32BE(payload.length);
  payload.copy(frame, 4);
  return frame;
}

export class EngineFrameDecoder {
  constructor(maxBytes = ENGINE_MAX_FRAME_BYTES) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > 16 * 1024 * 1024)
      throw new Error('Invalid frame byte limit.');
    this.maxBytes = maxBytes;
    this.header = Buffer.alloc(4);
    this.headerUsed = 0;
    this.body = null;
    this.bodyUsed = 0;
    this.failed = false;
    this.ended = false;
  }

  // Consume each iterator before feeding another chunk. No complete-frame queue is retained here.
  *push(chunk) {
    if (this.failed || this.ended || this.processing)
      throw new Error('Engine decoder is closed or still processing.');
    this.processing = true;
    let offset = 0;
    try {
      while (offset < chunk.length) {
        if (!this.body) {
          const take = Math.min(4 - this.headerUsed, chunk.length - offset);
          chunk.copy(this.header, this.headerUsed, offset, offset + take);
          this.headerUsed += take;
          offset += take;
          if (this.headerUsed < 4) continue;
          const length = this.header.readUInt32BE();
          if (length === 0 || length > this.maxBytes)
            throw new Error('Invalid engine frame length.');
          this.body = Buffer.allocUnsafe(length);
        }
        const take = Math.min(this.body.length - this.bodyUsed, chunk.length - offset);
        chunk.copy(this.body, this.bodyUsed, offset, offset + take);
        this.bodyUsed += take;
        offset += take;
        if (this.bodyUsed === this.body.length) {
          let message;
          try {
            message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(this.body));
          } catch {
            throw new Error('Malformed engine envelope.');
          }
          validateEngineEnvelope(message);
          this.body = null;
          this.bodyUsed = 0;
          this.headerUsed = 0;
          yield message;
        }
      }
    } catch (error) {
      this.failed = true;
      this.body = null;
      throw error;
    } finally {
      if (offset < chunk.length) this.failed = true;
      this.processing = false;
    }
  }

  end() {
    this.ended = true;
    if (this.failed || this.processing || this.body || this.headerUsed)
      throw new Error('Truncated engine frame.');
  }
}
