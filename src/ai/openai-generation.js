import { writeFile } from 'node:fs/promises';
import { validModelId } from './contracts.js';
import { aiError, openAiLimitError } from './providers.js';
import { readOpenAiStream } from './response-stream.js';

export function createOpenAiGeneration({
  fetchImpl = globalThis.fetch,
  maxInputBytes = 131072,
  maxOutputTokens = 8192,
} = {}) {
  return {
    id: 'openai',
    async generate({
      credential,
      modelId,
      instructions,
      input,
      signal,
      outputPath,
      onProgress = () => {},
    }) {
      if (
        !validModelId(modelId) ||
        typeof credential !== 'string' ||
        !credential ||
        /[^\x21-\x7e]/.test(credential)
      )
        throw aiError('invalid_input', 400);
      if (Buffer.byteLength(instructions) + Buffer.byteLength(input) > maxInputBytes)
        throw aiError('input_too_large', 422);
      let response;
      try {
        if (signal.aborted) throw aiError('cancelled', 409);
        response = await fetchImpl('https://api.openai.com/v1/responses', {
          method: 'POST',
          redirect: 'error',
          signal,
          headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: modelId,
            instructions,
            input,
            store: false,
            stream: true,
            truncation: 'disabled',
            max_output_tokens: maxOutputTokens,
            text: {
              format: {
                type: 'json_schema',
                name: 'coin_hunter_algorithm',
                strict: true,
                schema: {
                  type: 'object',
                  properties: { source: { type: 'string' }, explanation: { type: 'string' } },
                  required: ['source', 'explanation'],
                  additionalProperties: false,
                },
              },
            },
          }),
        });
        if (!response.ok) {
          if ([401, 403].includes(response.status)) throw aiError('credential_invalid', 422);
          if (response.status === 429) {
            let body;
            try {
              body = await readJsonBody(response, signal);
            } catch {
              /* Keep a safe generic rate limit error for malformed error bodies. */
            }
            throw openAiLimitError(body);
          }
          if (response.status === 404) throw aiError('model_unavailable', 422);
          if ([400, 413].includes(response.status)) {
            // Examine error codes only. Never return provider messages/body/key material.
            const body = await readJsonBody(response, signal);
            throw aiError(
              ['context_length_exceeded', 'input_too_large'].includes(body?.error?.code)
                ? 'input_too_large'
                : 'model_unavailable',
              422,
            );
          }
          throw aiError('unavailable', 503);
        }
        const { body, receivedChars } = await readOpenAiStream(response, signal, onProgress);
        if (body.status === 'incomplete')
          throw aiError(
            body.incomplete_details?.reason === 'max_output_tokens' ? 'truncated' : 'refused',
            422,
          );
        if (body.status !== 'completed' || !Array.isArray(body.output))
          throw aiError('invalid_response');
        const parts = body.output
          .filter((item) => item.type === 'message' && item.role === 'assistant')
          .flatMap((item) => item.content || []);
        if (parts.some((item) => item.type === 'refusal')) throw aiError('refused', 422);
        const text = parts
          .filter((part) => part.type === 'output_text')
          .map((part) => part.text)
          .join('');
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch {
          throw aiError('invalid_response');
        }
        if (
          !parsed ||
          typeof parsed.source !== 'string' ||
          !parsed.source.trim() ||
          typeof parsed.explanation !== 'string' ||
          parsed.explanation.length > 12000 ||
          Object.keys(parsed).some((key) => !['source', 'explanation'].includes(key)) ||
          parsed.source.includes(credential) ||
          parsed.explanation.includes(credential)
        )
          throw aiError('invalid_response');
        if (signal.aborted) throw aiError('cancelled', 409);
        await writeFile(outputPath, parsed.source, { flag: 'wx', mode: 0o600 });
        onProgress({ phase: 'generated', receivedChars });
        const usage = {};
        for (const key of ['input_tokens', 'output_tokens', 'total_tokens'])
          if (Number.isSafeInteger(body.usage?.[key]) && body.usage[key] >= 0)
            usage[key] = body.usage[key];
        return { explanation: parsed.explanation, usage, finishReason: 'complete' };
      } catch (error) {
        if (signal.aborted) throw aiError('cancelled', 409);
        if (error.code && error.status) throw error;
        throw aiError(response?.ok ? 'invalid_response' : 'network_error');
      } finally {
        if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
      }
    },
  };
}

async function readJsonBody(response, signal) {
  if (!response.body) throw aiError('invalid_response');
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw aiError('cancelled', 409);
      if (done) break;
      length += value.byteLength;
      if (length > 4 * 1024 * 1024) throw aiError('invalid_response');
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
