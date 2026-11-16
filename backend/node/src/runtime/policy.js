import { parse } from 'acorn';

export const TURN_LIMIT_MS = 500;
export const ALGORITHM_MEMORY_LIMIT_BYTES = 32 * 1024 * 1024;

export function validateSource(source) {
  if (typeof source !== 'string') throw new Error('코드는 문자열이어야 합니다.');
  const tree = parse(source, {
    ecmaVersion: 2022,
    sourceType: 'script',
    ranges: true,
    locations: true,
  });
  const stack = [tree];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (
      node.async ||
      node.generator ||
      node.type === 'AwaitExpression' ||
      node.type === 'ImportExpression' ||
      node.type === 'StaticBlock' ||
      ((node.type === 'MethodDefinition' || node.type === 'PropertyDefinition') && node.static)
    ) {
      const error = new Error('비동기·generator·import·static 코드는 사용할 수 없습니다.');
      error.pos = node.start;
      error.loc = node.loc.start;
      error.validation = {
        stage: 'policy',
        code:
          node.static || node.type === 'StaticBlock'
            ? 'AR003'
            : node.type === 'ImportExpression'
              ? 'AR002'
              : 'AR004',
      };
      throw error;
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const child of value) stack.push(child);
      } else if (value && typeof value === 'object') stack.push(value);
    }
  }
  return tree;
}
