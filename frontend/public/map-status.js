export function mapStatus(entry) {
  if (!entry) return '미게시';
  const state = entry.publishedRevision === null ? '미게시' : entry.enabled ? '노출 중' : '비노출';
  return `${state}${entry.publishedRevision !== null && entry.draftRevision !== undefined && entry.draftRevision !== entry.publishedRevision ? ' · 수정본 미게시' : ''}`;
}
