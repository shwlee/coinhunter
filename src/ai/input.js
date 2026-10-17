import { readFile } from 'node:fs/promises';
import { normalizeStrategyInput, buildStrategyRequest } from '../../public/algorithm-strategy.js';
import { loadAlgorithmContract } from '../algorithm-assistant/contract.js';
import { aiError } from './providers.js';

export function validateGenerationInput(input) {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).some(
      (key) => !['connectionId', 'modelId', 'intent', 'prompt', 'priorities'].includes(key),
    ) ||
    typeof input.connectionId !== 'string' ||
    typeof input.modelId !== 'string'
  )
    throw aiError('invalid_input', 400);
  try {
    const strategy = normalizeStrategyInput({
      intent: input.intent,
      prompt: input.prompt,
      priorities: input.priorities,
    });
    return { connectionId: input.connectionId, modelId: input.modelId, ...strategy };
  } catch (error) {
    if (error.code !== 'invalid_input') throw error;
    throw Object.assign(aiError('invalid_input', 400), { message: error.message });
  }
}

export async function buildGenerationInput(input, sourcePath = null) {
  const contract = await loadAlgorithmContract();
  const request = buildStrategyRequest(
    { intent: input.intent, prompt: input.prompt, priorities: input.priorities },
    sourcePath ? await readFile(sourcePath, 'utf8') : undefined,
  );
  return {
    instructions: `${contract.instructions}\n\n${contract.outputInstructions.api}`,
    input: JSON.stringify(request),
  };
}
