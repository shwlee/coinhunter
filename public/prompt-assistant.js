import { api } from './account.js';
import { buildCopyablePrompt, hasPromptSource, validatePromptContract } from './prompt-builder.js';
import { normalizeStrategyInput } from './algorithm-strategy.js';

export function initializePromptAssistant({ source, priorities, emptyAlgorithm }) {
  const $ = (id) => document.getElementById(id);
  let contract = null,
    lastContentVersion = null,
    loading = false,
    copying = false,
    current = null,
    previousInput = null,
    previousProblem = '',
    revision = 0,
    documentEpoch = 0;
  const conversationMode = () => ($('prompt-mode-continue').checked ? 'continue' : 'new');
  function setConversationMode(mode) {
    $('prompt-mode-new').checked = mode === 'new';
    $('prompt-mode-continue').checked = mode === 'continue';
  }
  function contextNotice(message = '') {
    $('prompt-context-notice').textContent = message;
    $('prompt-context-notice').hidden = !message;
  }
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
        a.conversationMode === b.conversationMode &&
        a.contentVersion === b.contentVersion &&
        a.prompt === b.prompt &&
        a.source === b.source &&
        a.priorities.length === b.priorities.length &&
        a.priorities.every((id, index) => id === b.priorities[index]))
    );
  }
  // Read small strategy fields and compare source strings; never assemble a prompt here.
  function refresh() {
    const code = source();
    const mode = conversationMode();
    const intent = $('prompt-purpose').value;
    const available = hasPromptSource(code, emptyAlgorithm);
    $('prompt-include-source').disabled = !available || intent === 'generate';
    if ($('prompt-include-source').disabled) $('prompt-include-source').checked = false;
    $('prompt-mode-help').textContent =
      mode === 'new'
        ? '새 대화·다른 AI에서는 전체 규약을 전달합니다.'
        : '전체 규약·예제를 생략합니다. 규약을 이미 전달한 같은 AI 대화에서 사용하세요.';
    $('prompt-source-help').textContent =
      intent === 'generate'
        ? '기존 코드를 사용하려면 작업 목적에서 기존 코드 수정을 선택하세요.'
        : $('prompt-include-source').checked
          ? '첨부한 현재 코드를 기준으로 수정합니다.'
          : mode === 'continue'
            ? '이전 대화의 코드를 기준으로 수정합니다. 게임에서 코드를 바꿨다면 현재 코드를 포함하세요.'
            : '새 대화에서 수정하려면 대상 코드를 작성하거나 불러오고 현재 코드 포함을 선택하세요.';
    let input = null,
      problem = '';
    try {
      const strategy = normalizeStrategyInput({
        intent,
        prompt: $('prompt').value,
        priorities: priorities(),
      });
      if (intent === 'modify' && mode === 'new' && !$('prompt-include-source').checked)
        throw new Error(
          '새 대화에서 기존 코드를 수정하려면 대상 코드를 준비하고 현재 코드 포함을 선택하세요.',
        );
      input = {
        ...strategy,
        source: $('prompt-include-source').checked ? code : undefined,
        conversationMode: mode,
        contentVersion: contract?.contentVersion ?? null,
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
      current.contentVersion === contract.contentVersion &&
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
    $('retry-prompt-contract').setAttribute('aria-busy', String(loading));
    $('prompt-preview').dataset.stale = String(!!current && !fresh);
    $('prompt-summary').dataset.state = current && !fresh ? 'stale' : current ? 'ready' : 'empty';
    const summary = current
      ? `${current.conversationMode === 'new' ? '새 대화' : '후속 요청'} · ${current.includesFullRules ? '전체 규약' : '규약 요약'} · ${current.includesSource ? '현재 코드 포함' : current.intent === 'modify' ? '이전 대화 코드 사용' : '코드 제외'}${current.includesExample ? ' · 기본 골격 포함' : ''} · ${current.length.toLocaleString('ko-KR')}자`
      : '';
    $('prompt-summary').textContent = current
      ? loading
        ? `${summary} · 게임 규약을 확인하고 있습니다.`
        : !contract
          ? `${summary} · 게임 규약을 확인한 뒤 복사할 수 있습니다.`
          : fresh
            ? summary
            : `${summary} · 입력이 변경되었습니다. 프롬프트를 다시 생성하세요.${problem ? ' ' + problem : ''}`
      : input
        ? '프롬프트 생성을 누르면 아래에 본문이 표시됩니다.'
        : problem && problem !== '전략 입력을 확인하세요.'
          ? problem
          : '전략을 선택하거나 추가 요청을 입력하세요.';
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
    $('prompt-contract-status').textContent = '게임 규약을 준비하고 있습니다…';
    refresh();
    try {
      const loaded = await api('/api/algorithm-assistant/contract');
      validatePromptContract(loaded);
      if (lastContentVersion && lastContentVersion !== loaded.contentVersion) {
        setConversationMode('new');
        contextNotice(
          '게임 규약이 변경되어 새 대화 모드로 돌아왔습니다. 프롬프트를 다시 생성해 전체 규약을 전달하세요.',
        );
      }
      contract = loaded;
      lastContentVersion = loaded.contentVersion;
      $('prompt-contract-status').textContent = '';
    } catch (error) {
      contract = null;
      $('prompt-contract-status').textContent = `규약을 준비하지 못했습니다. ${error.message}`;
    } finally {
      loading = false;
      $('retry-prompt-contract').hidden = false;
      refresh();
    }
  }
  $('generate-prompt').onclick = () => {
    if (loading || copying || !contract) return;
    const { input } = refresh();
    if (!input) return;
    try {
      const strategy = { intent: input.intent, prompt: input.prompt, priorities: input.priorities };
      current = {
        ...buildCopyablePrompt(contract, strategy, input.source, {
          conversationMode: input.conversationMode,
        }),
        input,
      };
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
  $('prompt-purpose').disabled = false;
  $('prompt-purpose').value = 'generate';
  $('prompt-purpose').onchange = refresh;
  for (const id of ['prompt-mode-new', 'prompt-mode-continue']) {
    $(id).disabled = false;
    $(id).onchange = () => {
      contextNotice();
      refresh();
    };
  }
  $('prompt').addEventListener('input', refresh);
  $('code').addEventListener('input', refresh);
  document.addEventListener('ai-priorities-changed', refresh);
  setConversationMode('new');
  void loadContract();
  return {
    refresh,
    reset() {
      documentEpoch++;
      revision++;
      current = null;
      $('prompt-purpose').value = 'generate';
      setConversationMode('new');
      contextNotice();
      $('prompt-include-source').checked = false;
      $('prompt-preview-text').value = '';
      copyStatus();
      refresh();
    },
  };
}
