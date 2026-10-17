import { api } from './account.js';
import { buildCopyablePrompt, hasPromptSource } from './prompt-builder.js';

export function initializePromptAssistant({ source, priorities, emptyAlgorithm }) {
  const $ = (id) => document.getElementById(id);
  let contract = null,
    loading = false,
    copying = false,
    current = null,
    revision = 0,
    documentEpoch = 0,
    timer;
  const copyStatus = (message = '') => {
    $('prompt-copy-status').textContent = message;
  };
  function renderControls() {
    $('copy-prompt').disabled = !current || copying || loading;
    $('select-prompt').disabled = !current;
    $('retry-prompt-contract').disabled = loading;
  }
  function refresh() {
    clearTimeout(timer);
    const code = source();
    const available = hasPromptSource(code, emptyAlgorithm);
    $('prompt-include-source').disabled = !available;
    if (!available) $('prompt-include-source').checked = false;
    let next = null,
      problem = '';
    if (contract) {
      try {
        next = buildCopyablePrompt(
          contract,
          {
            intent: $('prompt-include-source').checked ? 'modify' : 'generate',
            prompt: $('prompt').value,
            priorities: priorities(),
          },
          $('prompt-include-source').checked ? code : undefined,
        );
      } catch (error) {
        problem = error.message;
      }
    }
    if (current?.text !== next?.text) {
      revision++;
      copyStatus();
    }
    current = next;
    const text = next?.text || '';
    if ($('prompt-preview-text').value !== text) $('prompt-preview-text').value = text;
    $('prompt-summary').textContent = next
      ? `${next.includesSource ? '현재 코드 포함 · 수정 요청' : '코드 제외 · 신규 작성'} · ${next.length.toLocaleString('ko-KR')}자`
      : problem || '전략을 선택하거나 추가 요청을 입력하세요.';
    $('prompt-size-note').hidden = !next || next.length < 100000;
    renderControls();
    return next;
  }
  function scheduleRefresh() {
    clearTimeout(timer);
    // Invalidate success immediately; build long source text after typing pauses.
    revision++;
    copyStatus();
    current = null;
    $('prompt-preview-text').value = '';
    $('prompt-summary').textContent = '최신 입력을 반영하고 있습니다…';
    renderControls();
    timer = setTimeout(refresh, 120);
  }
  function selectText() {
    if (!current) return;
    $('prompt-preview').open = true;
    $('prompt-preview-text').focus();
    $('prompt-preview-text').select();
    $('prompt-preview-text').setSelectionRange(0, current.text.length);
  }
  async function loadContract() {
    if (loading) return;
    loading = true;
    contract = null;
    $('prompt-contract-status').textContent = '게임 규약을 준비하고 있습니다…';
    $('retry-prompt-contract').hidden = true;
    refresh();
    try {
      const loaded = await api('/api/algorithm-assistant/contract');
      // Validate even before a strategy is selected, so invalid contracts are retryable.
      buildCopyablePrompt(loaded, { intent: 'generate', prompt: '규약 확인', priorities: [] });
      contract = loaded;
      $('prompt-contract-status').textContent = '';
    } catch (error) {
      $('prompt-contract-status').textContent = `규약을 준비하지 못했습니다. ${error.message}`;
      $('retry-prompt-contract').hidden = false;
    } finally {
      loading = false;
      refresh();
    }
  }
  $('copy-prompt').onclick = async () => {
    if (copying || loading) return;
    const snapshot = refresh();
    if (!snapshot) return;
    const startedAt = revision;
    const startedDocument = documentEpoch;
    copying = true;
    renderControls();
    let failed = false;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      // No network await here: preserve the user's clipboard activation.
      await navigator.clipboard.writeText(snapshot.text);
    } catch {
      failed = true;
    } finally {
      copying = false;
      refresh();
      if (startedDocument !== documentEpoch) {
        // A previous document's clipboard completion must not update the new document.
      } else if (startedAt !== revision) {
        copyStatus('복사 중 입력이 변경되었습니다. 최신 프롬프트를 다시 복사하세요.');
      } else if (failed) {
        selectText();
        copyStatus(
          '자동 복사를 사용할 수 없습니다. 선택된 본문을 Ctrl+C 또는 기기의 복사 메뉴로 복사하세요.',
        );
      } else {
        copyStatus('프롬프트를 복사했습니다. 사용하는 AI에 붙여 넣으세요.');
      }
      renderControls();
    }
  };
  $('select-prompt').onclick = () => {
    if (!refresh()) return;
    selectText();
    copyStatus('본문을 선택했습니다. Ctrl+C 또는 기기의 복사 메뉴로 복사하세요.');
  };
  $('retry-prompt-contract').onclick = () => {
    void loadContract();
  };
  $('prompt-include-source').onchange = refresh;
  $('prompt-preview').addEventListener('toggle', () => {
    if ($('prompt-preview').open) refresh();
  });
  $('prompt').addEventListener('input', scheduleRefresh);
  $('code').addEventListener('input', scheduleRefresh);
  document.addEventListener('ai-priorities-changed', refresh);
  void loadContract();
  return {
    refresh,
    reset() {
      documentEpoch++;
      revision++;
      $('prompt-include-source').checked = false;
      $('prompt-preview').open = false;
      copyStatus();
      refresh();
    },
  };
}
