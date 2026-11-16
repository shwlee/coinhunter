import { analyze } from 'eslint-scope';

export const AUTHORING_PROFILE = 'javascript-preflight-v2';

function fail(node, code, message) {
  const error = new Error(message);
  error.pos = node.start;
  error.loc = node.loc.start;
  error.validation = { stage: 'policy', code, profileVersion: AUTHORING_PROFILE };
  throw error;
}

// Additional source inspection, not a complete allowlist or proof of termination.
// Runtime-internal fault fixtures deliberately use the lower-level policy/runtime.
export function inspectAuthoring(tree) {
  const functions = new Map();
  const methods = new Map();
  const calls = [];
  const violations = [];
  const stack = [{ node: tree, fn: null, owner: null }];
  while (stack.length) {
    let { node, fn, owner } = stack.pop();
    if (!node?.type) continue;
    if (node.type === 'TryStatement') violations.push(node);
    if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
      const entries = new Map();
      for (const member of node.body.body) {
        if (member.type !== 'MethodDefinition' || member.computed || member.static) continue;
        // Accessors are not ordinary callable methods.
        if (member.kind === 'method')
          entries.set(member.key.name ?? member.key.value, member.value);
        methods.set(member.value, { entries, kind: member.kind });
      }
    }
    if (
      ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type)
    ) {
      fn = node;
      owner =
        methods.get(node)?.entries ?? (node.type === 'ArrowFunctionExpression' ? owner : null);
      functions.set(node, []);
    }
    if (node.type === 'CallExpression' && fn) calls.push({ node, fn, owner });
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (let i = value.length - 1; i >= 0; i--)
          if (value[i]?.type) stack.push({ node: value[i], fn, owner });
      } else if (value?.type) stack.push({ node: value, fn, owner });
    }
  }
  if (violations.length)
    fail(
      violations.sort((a, b) => a.start - b.start)[0],
      'AR011',
      '사용자 try/catch/finally 코드는 사용할 수 없습니다.',
    );

  const scope = analyze(tree, {
    ecmaVersion: 2022,
    sourceType: 'script',
    nodejsScope: true,
    impliedStrict: true,
  });
  const bindings = new Map();
  for (const current of scope.scopes)
    for (const ref of current.references) bindings.set(ref.identifier, ref.resolved);
  for (const { node, fn, owner } of calls) {
    const callee = node.callee;
    let target;
    if (functions.has(callee)) target = callee;
    if (callee.type === 'Identifier') {
      const variable = bindings.get(callee);
      if (variable?.defs.length === 1) {
        const def = variable.defs[0];
        // Mutable/rebound aliases are not proven targets in this first profile.
        if (def.type === 'FunctionName' && !variable.references.some((ref) => ref.isWrite()))
          target = def.node;
        if (def.type === 'Variable' && def.parent?.kind === 'const') target = def.node.init;
      }
    } else if (callee.type === 'MemberExpression' && callee.object.type === 'ThisExpression') {
      const name = callee.computed ? callee.property.value : callee.property.name;
      target = owner?.get(name);
    }
    if (functions.has(target)) functions.get(fn).push({ target, call: node });
  }
  // Iterative DFS avoids overflowing the host stack on a large user call graph.
  const colors = new Map();
  for (const start of functions.keys()) {
    if (colors.has(start)) continue;
    colors.set(start, 1);
    const pending = [{ fn: start, index: 0 }];
    while (pending.length) {
      const frame = pending.at(-1);
      const edge = functions.get(frame.fn)[frame.index++];
      if (!edge) {
        colors.set(frame.fn, 2);
        pending.pop();
        continue;
      }
      if (colors.get(edge.target) === 1)
        fail(edge.call, 'AR009', '직접 재귀와 상호 재귀 호출은 사용할 수 없습니다.');
      if (!colors.has(edge.target)) {
        colors.set(edge.target, 1);
        pending.push({ fn: edge.target, index: 0 });
      }
    }
  }
}
