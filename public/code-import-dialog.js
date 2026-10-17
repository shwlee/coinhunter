import { api } from './account.js';
import { extractAlgorithmSource } from './algorithm-code-import.js';

export function initializeCodeImport({ contents, documentVersion, applySource, notice }) {
  const $ = (id) => document.getElementById(id);
  const dialog = $('code-import-dialog'),
    input = $('imported-code');
  let token = 0,
    active = null,
    busy = false,
    validated = null,
    baseline = '',
    version = null;
  const status = (state, text = '') => {
    $('import-code-status').dataset.state = state;
    $('import-code-status').textContent = text;
  };
  function controls() {
    $('check-imported-code').disabled = busy || !input.value.trim();
    $('check-imported-code').textContent = busy ? '검사 중…' : '코드 검사';
    $('check-imported-code').setAttribute('aria-busy', String(busy));
    $('apply-imported-code').disabled = busy || !validated || validated.raw !== input.value;
  }
  function invalidate() {
    token++;
    active?.abort();
    active = null;
    busy = false;
    validated = null;
    controls();
  }
  function clear() {
    invalidate();
    input.value = '';
    baseline = '';
    version = null;
    status('idle');
    controls();
  }
  function reset() {
    if (dialog.open) dialog.close();
    clear();
  }
  $('open-code-import').disabled = false;
  $('open-code-import').onclick = () => {
    if (dialog.open) return;
    clear();
    baseline = contents();
    version = documentVersion();
    dialog.showModal();
    input.focus();
  };
  $('cancel-code-import').onclick = reset;
  dialog.addEventListener('cancel', invalidate);
  dialog.addEventListener('close', () => {
    if (!dialog.open) clear();
  });
  input.addEventListener('input', () => {
    invalidate();
    status('changed', '코드가 변경되었습니다. 다시 검사하세요.');
  });
  $('check-imported-code').onclick = async () => {
    if (busy || !dialog.open) return;
    invalidate();
    const currentToken = token,
      raw = input.value,
      startVersion = version;
    let extracted;
    try {
      extracted = extractAlgorithmSource(raw);
    } catch (error) {
      status('error', error.message);
      return;
    }
    busy = true;
    active = new AbortController();
    const signal = active.signal;
    controls();
    status('pending', '변수·필수 함수·사용 제한과 샘플 실행을 검사하고 있습니다…');
    try {
      const result = await api('/api/algorithms/validate', {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        body: extracted.source,
      });
      if (
        currentToken !== token ||
        !dialog.open ||
        startVersion !== documentVersion() ||
        raw !== input.value
      )
        return;
      if (result.ok !== true)
        throw new Error('실행 검사 결과를 확인할 수 없습니다. 다시 검사하세요.');
      validated = { raw, source: extracted.source };
      status(
        'success',
        '실행 전 검사 통과 · 샘플 이동 24회 확인. 모든 맵과 실행 분기를 보장하지는 않습니다. 적용 후 테스트 플레이로 확인하세요.',
      );
    } catch (error) {
      if (currentToken !== token || signal.aborted || !dialog.open) return;
      let position = '';
      if (Number.isInteger(error.diagnostic?.line) && Number.isInteger(error.diagnostic?.column)) {
        position = `검사 대상 코드 ${error.diagnostic.line}줄 ${error.diagnostic.column}열 · `;
        if (Number.isInteger(error.diagnostic.offset)) {
          const offset = Math.max(
            0,
            Math.min(raw.length, extracted.offset + error.diagnostic.offset),
          );
          input.focus();
          input.setSelectionRange(offset, Math.min(raw.length, offset + 1));
        }
      }
      status('error', position + error.message);
    } finally {
      if (currentToken === token) {
        active = null;
        busy = false;
        controls();
      }
    }
  };
  $('apply-imported-code').onclick = () => {
    if (!dialog.open || busy || !validated || validated.raw !== input.value) return;
    if (version !== documentVersion()) {
      reset();
      notice('편집 문서가 변경되었습니다. 코드를 다시 가져와 검사하세요.');
      return;
    }
    if (
      baseline !== contents() &&
      !confirm('가져오기를 연 이후 편집 내용이 변경되었습니다. 검사한 코드로 교체할까요?')
    )
      return;
    const source = validated.source;
    applySource(source);
    reset();
    notice(
      '검사한 코드를 편집기에 적용했습니다. 실행 취소로 되돌릴 수 있으며 테스트 후 저장하세요.',
    );
  };
  controls();
  return { reset };
}
