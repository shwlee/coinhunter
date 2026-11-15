import { STRATEGY_TEMPLATES, PRIORITY_WEIGHTS } from './strategy-templates.js';

export const MAX_STRATEGY_PROMPT_CHARACTERS = 8000;
export const MAX_STRATEGY_PRIORITIES = 3;
const invalid = (message = '전략 입력을 확인하세요.') =>
  Object.assign(new Error(message), { code: 'invalid_input', status: 400 });

export function expandStrategyPriorities(priorities) {
  if (
    !Array.isArray(priorities) ||
    priorities.length > MAX_STRATEGY_PRIORITIES ||
    new Set(priorities).size !== priorities.length ||
    Array.from(priorities).some((id) => !STRATEGY_TEMPLATES.some((item) => item.id === id))
  )
    throw invalid();
  const pairs = [
    ['shoes', 'avoidShoes'],
    ['hammer', 'avoidHammer'],
    ['double', 'avoidDouble'],
    ['jump', 'avoidJump'],
  ];
  if (pairs.some(([a, b]) => priorities.includes(a) && priorities.includes(b)))
    throw invalid('같은 아이템의 획득과 회피를 함께 선택할 수 없습니다.');
  return priorities.map((id, index) => {
    const template = STRATEGY_TEMPLATES.find((item) => item.id === id);
    return {
      rank: index + 1,
      weight: PRIORITY_WEIGHTS[index],
      name: template.label,
      instruction: template.description,
    };
  });
}

// Shared browser/server validation without provider, credential or model dependencies.
export function normalizeStrategyInput(input) {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => !['intent', 'prompt', 'priorities'].includes(key)) ||
    !['generate', 'modify'].includes(input.intent) ||
    typeof input.prompt !== 'string' ||
    input.prompt.length > MAX_STRATEGY_PROMPT_CHARACTERS
  )
    throw invalid();
  expandStrategyPriorities(input.priorities);
  if (!input.prompt.trim() && !input.priorities.length) throw invalid();
  return { intent: input.intent, prompt: input.prompt.trim(), priorities: [...input.priorities] };
}

export function buildStrategyRequest(input, source) {
  const normalized = normalizeStrategyInput(input);
  if (source !== undefined && typeof source !== 'string')
    throw invalid('수정할 코드를 확인하세요.');
  return {
    intent: normalized.intent,
    priorities: expandStrategyPriorities(normalized.priorities),
    request: normalized.prompt,
    ...(source === undefined ? {} : { source }),
  };
}
