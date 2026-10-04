import { parse } from 'acorn';

export const TURN_LIMIT_MS = 500;

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
      throw new Error('비동기·generator·import·static 코드는 사용할 수 없습니다.');
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const child of value) stack.push(child);
      } else if (value && typeof value === 'object') stack.push(value);
    }
  }
  return tree;
}
