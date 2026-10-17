// Accept raw JavaScript or a single fenced block, never guess among alternatives.
export function extractAlgorithmSource(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('가져올 코드를 붙여 넣으세요.');
  const bom = value.startsWith('\uFEFF') ? 1 : 0;
  const raw = value.slice(bom);
  const trimmed = raw.trim();
  if (!/^(?:`{3,}|~{3,})/.test(trimmed)) return { source: raw, offset: bom, format: 'raw' };
  const opening = /^(`{3,}|~{3,})([^\r\n]*)\r?\n/.exec(trimmed);
  const invalid = () =>
    new Error(
      '원문 JavaScript 또는 JavaScript 코드 블록 하나만 붙여 넣으세요. 설명과 여러 코드 블록은 제거하세요.',
    );
  if (!opening || !['', 'js', 'javascript'].includes(opening[2].trim().toLowerCase()))
    throw invalid();
  const marker = opening[1][0],
    length = opening[1].length;
  const closing = new RegExp('\\r?\\n' + marker + '{' + length + ',}[ \\t]*$').exec(trimmed);
  if (!closing) throw invalid();
  const source = trimmed.slice(opening[0].length, closing.index);
  if (!source.trim() || new RegExp('^' + marker + '{' + length + ',}[^\\r\\n]*$', 'm').test(source))
    throw invalid();
  return {
    source,
    offset: bom + raw.length - raw.trimStart().length + opening[0].length,
    format: 'fenced',
  };
}
