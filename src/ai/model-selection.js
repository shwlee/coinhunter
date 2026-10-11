// Keep only one representative per text/code model family. IDs always come
// from the user's provider response; friendly labels never invent API access.
function candidate(provider, model) {
  const id = model.id;
  let match;
  if (provider === 'openai') {
    match =
      /^gpt-(\d+(?:\.\d+)*)(o)?(?:-(mini|pro|sol|astra|luna))?(?:-(\d{4}-\d{2}-\d{2}))?$/.exec(id);
    if (!match) return null;
    const kind = match[3] || 'standard';
    const family = { standard: 0, sol: 0, pro: 1, astra: 1, mini: 2, luna: 2 }[kind];
    return {
      family,
      version: match[1].split('.').map(Number),
      snapshot: match[4] || '',
      name: `GPT-${match[1]}${match[2] || ''}${match[3] ? ` ${kind[0].toUpperCase()}${kind.slice(1)}` : ''}`,
    };
  }
  if (provider === 'anthropic') {
    match = /^claude-(sonnet|opus|haiku|fable)-(\d+(?:-\d+)*?)(?:-(\d{8}))?$/.exec(id);
    if (!match) {
      const legacy = /^claude-(\d+(?:-\d+)*?)-(sonnet|opus|haiku)(?:-(\d{8}))?$/.exec(id);
      if (legacy) match = [legacy[0], legacy[2], legacy[1], legacy[3]];
    }
    if (!match) return null;
    const version = match[2].split('-').map(Number);
    return {
      family: ['sonnet', 'opus', 'haiku', 'fable'].indexOf(match[1]),
      version,
      snapshot: match[3] || '',
      name: `Claude ${match[1][0].toUpperCase()}${match[1].slice(1)} ${version.join('.')}`,
    };
  }
  if (provider === 'gemini') {
    match = /^gemini-(\d+(?:\.\d+)*)-(pro|flash|flash-lite)(?:-(preview|\d{3}))?$/.exec(id);
    if (!match) return null;
    const kind = { pro: 'Pro', flash: 'Flash', 'flash-lite': 'Flash-Lite' }[match[2]];
    return {
      family: ['pro', 'flash', 'flash-lite'].indexOf(match[2]),
      version: match[1].split('.').map(Number),
      snapshot: match[3] || '',
      name: `Gemini ${match[1]} ${kind}${match[3] === 'preview' ? ' (Preview)' : ''}`,
    };
  }
  return null;
}

function newer(a, b) {
  for (let i = 0; i < Math.max(a.version.length, b.version.length); i++) {
    const difference = (a.version[i] || 0) - (b.version[i] || 0);
    if (difference) return difference > 0;
  }
  // Prefer an undated ID at the same version, otherwise the newest snapshot.
  if (!a.snapshot || !b.snapshot) return !a.snapshot && !!b.snapshot;
  return a.snapshot > b.snapshot;
}

export function selectRepresentativeModels(provider, models, allowed = []) {
  const families = new Map();
  for (const model of models) {
    if (allowed.length && !allowed.includes(model.id)) continue;
    const choice = candidate(provider, model);
    if (!choice) continue;
    const previous = families.get(choice.family);
    if (!previous || newer(choice, previous.choice)) families.set(choice.family, { model, choice });
  }
  return [...families.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, { model, choice }]) => ({ ...model, name: choice.name }));
}
