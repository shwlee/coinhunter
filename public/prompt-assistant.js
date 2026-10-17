import { api } from './account.js';
import { buildCopyablePrompt, hasPromptSource, validatePromptContract } from './prompt-builder.js';
import { normalizeStrategyInput } from './algorithm-strategy.js';

export function initializePromptAssistant({ source, priorities, emptyAlgorithm }) {
  const $ = (id) => document.getElementById(id);
  let contract = null,
    loading = false,
    copying = false,
    current = null,
    previousInput = null,
    previousProblem = '',
    revision = 0,
    documentEpoch = 0;
  const copyStatus = (message = '', state = '') => {
    $('prompt-copy-status').textContent = message;
    $('prompt-copy-status').dataset.state = state;
  };
  function sameInput(a, b) {
    return (
      a === b ||
      (!!a &&
        !!b &&
        a.intent === b.intent &&
        a.prompt === b.prompt &&
        a.source === b.source &&
        a.priorities.length === b.priorities.length &&
        a.priorities.every((id, index) => id === b.priorities[index]))
    );
  }
  // Read small strategy fields and compare source strings; never assemble a prompt here.
  function refresh() {
    const code = source();
    const available = hasPromptSource(code, emptyAlgorithm);
    $('prompt-include-source').disabled = !available;
    if (!available) $('prompt-include-source').checked = false;
    let input = null,
      problem = '';
    try {
      input = {
        ...normalizeStrategyInput({
          intent: $('prompt-include-source').checked ? 'modify' : 'generate',
          prompt: $('prompt').value,
          priorities: priorities(),
        }),
        source: $('prompt-include-source').checked ? code : undefined,
      };
    } catch (error) {
      problem = error.message;
    }
    if (!sameInput(previousInput, input) || previousProblem !== problem) {
      revision++;
      copyStatus();
    }
    previousInput = input;
    previousProblem = problem;
    const fresh = !!(
      current &&
      contract &&
      current.contract === contract &&
      sameInput(current.input, input)
    );
    $('generate-prompt').disabled = !contract || !input || loading || copying;
    $('copy-prompt').disabled = !fresh || copying || loading;
    $('copy-prompt').setAttribute('aria-busy', String(copying));
    $('copy-prompt-label').textContent = copying
      ? '복사 중…'
      : $('prompt-copy-status').dataset.state === 'copied'
        ? '복사 완료'
        : '복사';
    $('select-prompt').disabled = !fresh || loading;
    $('retry-prompt-contract').disabled = loading;
    $('prompt-preview').dataset.stale = String(!!current && !fresh);
    $('prompt-summary').dataset.state = current && !fresh ? 'stale' : current ? 'ready' : 'empty';
    const summary = current
      ? `${current.includesSource ? '현재 코드 포함 · 수정 요청' : '코드 제외 · 신규 작성'} · ${current.length.toLocaleString('ko-KR')}자`
      : '';
    $('prompt-summary').textContent = current
      ? fresh
        ? summary
        : `${summary} · 입력이 변경되었습니다. 프롬프트를 다시 생성하세요.${problem ? ' ' + problem : ''}`
      : input
        ? '프롬프트 생성을 누르면 아래에 본문이 표시됩니다.'
        : '전략을 선택하거나 추가 요청을 입력하세요.' +
          (problem && problem !== '전략 입력을 확인하세요.' ? ' ' + problem : '');
    $('prompt-size-note').hidden = !current || current.length < 100000;
    return { input, fresh };
  }
  function selectText() {
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
      validatePromptContract(loaded);
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
  $('generate-prompt').onclick = () => {
    if (loading || copying || !contract) return;
    const { input } = refresh();
    if (!input) return;
    try {
      const { source: code, ...strategy } = input;
      current = { ...buildCopyablePrompt(contract, strategy, code), input, contract };
      revision++;
      $('prompt-preview-text').value = current.text;
      copyStatus();
      refresh();
    } catch (error) {
      copyStatus(error.message);
    }
  };
  $('copy-prompt').onclick = async () => {
    if (copying || loading || !refresh().fresh) return;
    const snapshot = current;
    const startedAt = revision;
    const startedDocument = documentEpoch;
    copyStatus();
    copying = true;
    refresh();
    let failed = false;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      // Copy only the generated snapshot shown in the preview, without rebuilding it.
      await navigator.clipboard.writeText(snapshot.text);
    } catch {
      failed = true;
    } finally {
      copying = false;
      refresh();
      if (startedDocument !== documentEpoch) {
        // A previous document's clipboard completion must not update the new document.
      } else if (startedAt !== revision) {
        copyStatus('복사 중 입력이 변경되었습니다. 프롬프트를 다시 생성한 뒤 복사하세요.');
      } else if (failed) {
        selectText();
        copyStatus(
          '자동 복사를 사용할 수 없습니다. 선택된 본문을 Ctrl+C 또는 기기의 복사 메뉴로 복사하세요.',
        );
      } else {
        copyStatus('프롬프트를 복사했습니다. 사용하는 AI에 붙여 넣으세요.', 'copied');
      }
      refresh();
    }
  };
  $('select-prompt').onclick = () => {
    if (loading || !refresh().fresh) return;
    selectText();
    copyStatus('본문을 선택했습니다. Ctrl+C 또는 기기의 복사 메뉴로 복사하세요.');
  };
  $('retry-prompt-contract').onclick = () => {
    void loadContract();
  };
  $('prompt-include-source').onchange = refresh;
  $('prompt').addEventListener('input', refresh);
  $('code').addEventListener('input', refresh);
  document.addEventListener('ai-priorities-changed', refresh);
  void loadContract();
  return {
    refresh,
    reset() {
      documentEpoch++;
      revision++;
      current = null;
      $('prompt-include-source').checked = false;
      $('prompt-preview-text').value = '';
      copyStatus();
      refresh();
    },
  };
}
