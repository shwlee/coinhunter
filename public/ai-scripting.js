import { api } from './account.js';
const $ = (id) => document.getElementById(id);
const ended = (state) =>
  ['completed', 'validation_failed', 'failed', 'cancelled', 'expired'].includes(state);
const labels = {
  prepared: '요청 준비 중',
  queued: '생성 대기 중',
  generating: 'OpenAI 응답 대기 중…',
  validating: '생성 코드 실행 검사 중…',
  completed: '생성·검사 완료 · 후보를 확인하고 적용하세요.',
  validation_failed: '실행 검사 실패 · 후보 진단을 확인하세요.',
  cancelled: '생성을 취소했습니다.',
  expired: '후보 보관 시간이 만료되었습니다.',
  failed: 'AI 생성에 실패했습니다.',
};

export function initializeAiScripting({
  contents,
  source,
  priorities,
  onBusy,
  onCandidate,
  notice,
}) {
  let selection = {},
    active = null,
    token = 0,
    busy = false,
    lastRequest = null;
  let progressState = null,
    progressTimer = null,
    progressObservedAt = 0;
  const setStatus = (text) => {
    if ($('ai-generation-status').textContent !== text)
      $('ai-generation-status').textContent = text;
  };
  function renderProgress() {
    if (!progressState) return;
    const value = progressState,
      details = value.progress || {};
    const current =
      value.state === 'validating' || ['completed', 'validation_failed'].includes(value.state)
        ? 2
        : ['receiving', 'generated'].includes(details.phase)
          ? 1
          : 0;
    const activeProgress = !ended(value.state);
    $('ai-generation-progress').hidden = false;
    $('ai-generation-progress').dataset.active = String(activeProgress);
    [...$('ai-generation-progress').querySelectorAll('[data-stage]')].forEach((item, index) => {
      item.classList.toggle('done', index < current || value.state === 'completed');
      if (activeProgress && index === current) item.setAttribute('aria-current', 'step');
      else item.removeAttribute('aria-current');
    });
    const serverTime = activeProgress
      ? (value.serverTime || value.updatedAt) + Math.max(0, Date.now() - progressObservedAt)
      : value.finishedAt || value.updatedAt;
    const elapsed = Math.max(
      0,
      Math.floor((serverTime - (value.startedAt || value.createdAt)) / 1000),
    );
    $('ai-generation-elapsed').textContent = `경과 ${elapsed}초`;
    $('ai-generation-received').textContent =
      `응답 ${(details.receivedChars || 0).toLocaleString('ko-KR')}자 수신`;
    const since = details.lastResponseAt
      ? Math.max(0, Math.floor((serverTime - details.lastResponseAt) / 1000))
      : null;
    $('ai-generation-last-response').textContent =
      value.state === 'validating'
        ? 'AI 응답 수신 완료 · 생성 코드 실행 검사 중'
        : value.state === 'completed'
          ? 'AI 응답 수신·실행 검사 완료'
          : !activeProgress
            ? labels[value.state]
            : since === null
              ? '첫 응답을 기다리고 있습니다.'
              : since >= 15
                ? `마지막 응답 ${since}초 전 · 새 응답을 기다리고 있습니다.`
                : `마지막 응답 ${since}초 전`;
    if (value.state === 'generating')
      setStatus(
        details.phase === 'receiving'
          ? 'OpenAI 응답을 수신하고 있습니다…'
          : details.phase === 'generated'
            ? '코드 생성 완료 · 검사 준비 중…'
            : details.phase === 'accepted'
              ? 'OpenAI 요청 접수 완료 · 응답 대기 중…'
              : labels.generating,
      );
    else setStatus(labels[value.state] || value.state);
  }
  function updateProgress(value) {
    if (progressState?.id === value.id && value.sequence < progressState.sequence) return;
    progressState = value;
    progressObservedAt = Date.now();
    renderProgress();
    if (ended(value.state)) {
      clearInterval(progressTimer);
      progressTimer = null;
    } else if (!progressTimer) progressTimer = setInterval(renderProgress, 1000);
  }
  function clearProgress() {
    clearInterval(progressTimer);
    progressTimer = null;
    progressState = null;
    $('ai-generation-progress').hidden = true;
  }
  function controls() {
    const input = !!$('prompt').value.trim() || priorities().length > 0;
    $('ai-generate').disabled = busy || !selection.ready || !input;
    $('ai-modify').disabled = busy || !selection.ready || !input || !source().trim();
    if (!busy)
      $('ai-generation-status').textContent = !selection.ready
        ? selection.provider && selection.provider !== 'openai'
          ? '현재 실제 코드 생성은 OpenAI 연결에서 사용할 수 있습니다.'
          : 'AI 연결과 모델을 선택하세요.'
        : !input
          ? '전략 템플릿을 선택하거나 추가 요청을 입력하세요.'
          : 'AI 생성 또는 현재 코드 수정을 선택하세요.';
  }
  async function discard(id) {
    if (sessionStorage.getItem('coinhunter.aiRequest') === id)
      sessionStorage.removeItem('coinhunter.aiRequest');
    if (id) await api(`/api/ai/requests/${id}`, { method: 'DELETE' }).catch(() => {});
  }
  function cancel(show = true) {
    token++;
    active?.abort();
    active = null;
    clearProgress();
    void discard(lastRequest);
    lastRequest = null;
    if (busy) {
      busy = false;
      onBusy(false);
    }
    controls();
    if (show)
      notice(
        '생성을 취소했습니다. 편집 코드는 유지됩니다. 이미 처리된 API 비용은 취소되지 않을 수 있습니다.',
      );
  }
  document.addEventListener('ai-selection', (event) => {
    selection = event.detail;
    controls();
  });
  $('prompt').addEventListener('input', controls);
  document.addEventListener('ai-priorities-changed', controls);
  async function run(intent) {
    if (busy || !selection.ready) return;
    const currentToken = ++token,
      baseline = contents(),
      sourceSnapshot = source(),
      picked = { ...selection };
    busy = true;
    active = new AbortController();
    const signal = active.signal;
    onBusy(true);
    onCandidate(null);
    clearProgress();
    $('ai-generation-status').textContent = '요청 준비 중…';
    controls();
    let finalMessage = '';
    try {
      await discard(lastRequest);
      if (currentToken !== token) return;
      lastRequest = null;
      const request = await api('/api/ai/requests', {
        method: 'POST',
        signal,
        body: JSON.stringify({
          connectionId: picked.connectionId,
          modelId: picked.modelId,
          intent,
          prompt: $('prompt').value,
          priorities: priorities(),
        }),
      });
      if (currentToken !== token) {
        await discard(request.id);
        return;
      }
      lastRequest = request.id;
      updateProgress(request);
      sessionStorage.setItem('coinhunter.aiRequest', request.id);
      if (intent === 'modify')
        await api(`/api/ai/requests/${request.id}/source`, {
          method: 'PUT',
          signal,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
          body: sourceSnapshot,
        });
      const started = await api(`/api/ai/requests/${request.id}/start`, {
        method: 'POST',
        signal,
        body: '{}',
      });
      if (currentToken !== token) return;
      updateProgress(started);
      const result = await follow(request.id, signal, (value) => {
        if (currentToken === token) updateProgress(value);
      });
      finalMessage = labels[result.state];
      if (currentToken !== token) return;
      if (!result.candidateAvailable)
        throw new Error(result.error?.message || labels[result.state]);
      const response = await fetch(`/api/ai/requests/${request.id}/source`, { signal });
      if (!response.ok) throw new Error('후보 코드를 가져오지 못했습니다. 다시 생성하세요.');
      const source = await response.text();
      if (currentToken !== token) return;
      onCandidate({
        source,
        baseline,
        requestId: request.id,
        valid: result.state === 'completed',
        explanation: result.explanation,
        validation: result.validation,
        usage: result.usage,
      });
      notice(
        result.state === 'completed'
          ? '실제 OpenAI가 생성한 코드가 실행 검사를 통과했습니다. 후보를 확인하고 적용하세요.'
          : 'AI 후보가 실행 검사를 통과하지 못했습니다. 진단을 확인하고 요청을 수정하세요.',
      );
    } catch (error) {
      if (currentToken === token && !signal.aborted) {
        if (progressState && !ended(progressState.state))
          updateProgress({
            ...progressState,
            state: 'failed',
            sequence: progressState.sequence + 1,
            finishedAt:
              (progressState.serverTime || progressState.updatedAt) +
              Date.now() -
              progressObservedAt,
          });
        finalMessage = error.message;
        $('ai-generation-status').textContent = finalMessage;
        notice(error.message);
      }
      if (currentToken === token) {
        await discard(lastRequest);
        lastRequest = null;
      }
    } finally {
      if (currentToken === token) {
        clearInterval(progressTimer);
        progressTimer = null;
        $('ai-generation-progress').dataset.active = 'false';
        busy = false;
        active = null;
        onBusy(false);
        controls();
        if (finalMessage) $('ai-generation-status').textContent = finalMessage;
      }
    }
  }
  $('ai-generate').onclick = () => {
    void run('generate');
  };
  $('ai-modify').onclick = () => {
    void run('modify');
  };
  async function restore() {
    const id = sessionStorage.getItem('coinhunter.aiRequest');
    if (!id || busy) return;
    const currentToken = ++token;
    busy = true;
    active = new AbortController();
    const signal = active.signal;
    lastRequest = id;
    onBusy(true);
    controls();
    let message = '';
    try {
      let result = await api(`/api/ai/requests/${id}`, { signal });
      if (currentToken !== token) return;
      updateProgress(result);
      if (result.state === 'prepared') {
        await discard(id);
        throw new Error('입력 준비가 끝나지 않은 요청입니다. 다시 생성하세요.');
      }
      if (!ended(result.state))
        result = await follow(id, signal, (value) => {
          if (currentToken === token) updateProgress(value);
        });
      if (currentToken !== token) return;
      if (!result.candidateAvailable)
        throw new Error(result.error?.message || labels[result.state]);
      const response = await fetch(`/api/ai/requests/${id}/source`, { signal });
      if (!response.ok) throw new Error('후보 보관 시간이 만료되었습니다. 다시 생성하세요.');
      const code = await response.text();
      if (currentToken !== token) return;
      onCandidate({
        source: code,
        baseline: null,
        requestId: id,
        valid: result.state === 'completed',
        explanation: result.explanation,
        validation: result.validation,
        usage: result.usage,
      });
      message = '같은 로그인 세션의 AI 후보를 복원했습니다. 적용 전에 현재 코드와 비교하세요.';
      notice(message);
    } catch (error) {
      if (currentToken === token) {
        message = error.message;
        await discard(id);
        lastRequest = null;
      }
    } finally {
      if (currentToken === token) {
        clearInterval(progressTimer);
        progressTimer = null;
        $('ai-generation-progress').dataset.active = 'false';
        busy = false;
        active = null;
        onBusy(false);
        controls();
        if (message) $('ai-generation-status').textContent = message;
      }
    }
  }
  controls();
  return { cancel, discard, restore, refresh: controls, isBusy: () => busy };
}

function follow(id, signal, progress) {
  return new Promise((resolve, reject) => {
    const events = new EventSource(`/api/ai/requests/${id}/events`);
    let finished = false,
      failures = 0;
    const timer = setTimeout(
      () => finish(null, new Error('AI 응답 대기 시간이 초과되었습니다.')),
      660000,
    );
    function finish(value, error) {
      if (finished) return;
      finished = true;
      events.close();
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      if (error) reject(error);
      else resolve(value);
    }
    const cancel = () => finish(null, new DOMException('취소되었습니다.', 'AbortError'));
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    events.addEventListener('state', (event) => {
      try {
        const value = JSON.parse(event.data);
        failures = 0;
        progress(value);
        if (ended(value.state)) finish(value);
      } catch {
        finish(null, new Error('AI 진행 상태를 읽지 못했습니다.'));
      }
    });
    events.onerror = async () => {
      if (finished) return;
      try {
        const value = await api(`/api/ai/requests/${id}`);
        if (finished) return;
        progress(value);
        if (ended(value.state)) finish(value);
        else if (++failures >= 3) finish(null, new Error('AI 진행 상태 연결이 끊겼습니다.'));
      } catch (error) {
        finish(null, error);
      }
    };
  });
}
