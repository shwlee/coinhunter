// Tab selection changes presentation only: never cancel or restart an AI request.
export function initializeAssistantPanel({ openConnections }) {
  const $ = (id) => document.getElementById(id);
  const tabs = ['prompt', 'api'];
  let selected = 'prompt',
    connectionSetup = null,
    apiBusy = false,
    apiCandidate = false;
  function activity() {
    $('assistant-activity').hidden = selected === 'api' || (!apiBusy && !apiCandidate);
    $('assistant-activity-text').textContent = apiBusy
      ? 'AI 연결에서 코드 생성·검사를 진행하고 있습니다.'
      : 'AI 연결의 후보 코드가 준비되었습니다.';
    $('assistant-api-tab').classList.toggle('has-activity', apiBusy || apiCandidate);
  }
  function select(value, focus = false) {
    if (!tabs.includes(value)) return;
    selected = value;
    for (const tab of tabs) {
      const button = $(`assistant-${tab}-tab`);
      button.setAttribute('aria-selected', String(tab === selected));
      button.tabIndex = tab === selected ? 0 : -1;
      $(`assistant-${tab}-panel`).hidden = tab !== selected;
    }
    activity();
    if (focus) $(`assistant-${selected}-tab`).focus();
    // Share the first initialization across rapid tab changes; retain choices afterwards.
    if (selected === 'api' && !connectionSetup) {
      connectionSetup = Promise.resolve()
        .then(openConnections)
        .catch(() => {
          $('ai-connection-status').textContent =
            'AI 연결을 준비하지 못했습니다. 화면을 새로고침한 뒤 다시 시도하세요.';
        });
    }
  }
  for (const tab of tabs) {
    const button = $(`assistant-${tab}-tab`);
    button.disabled = false;
    button.onclick = () => select(tab);
    button.onkeydown = (event) => {
      let next;
      if (['ArrowLeft', 'ArrowRight'].includes(event.key))
        next = tab === 'prompt' ? 'api' : 'prompt';
      else if (event.key === 'Home') next = 'prompt';
      else if (event.key === 'End') next = 'api';
      else return;
      event.preventDefault();
      select(next, true);
    };
  }
  $('assistant-show-api').onclick = () => select('api', true);
  select('prompt');
  return {
    setApiBusy(value) {
      apiBusy = value;
      activity();
    },
    setApiCandidate(value) {
      apiCandidate = value;
      activity();
    },
  };
}
