import { api } from './account.js';
import { AI_PROVIDER_GUIDES, AI_CONNECTION_ERROR_HELP } from './ai-provider-guides.js';

const $ = (id) => document.getElementById(id);
const option = (label, value) => new Option(label, value);

export async function initializeAiConnections() {
  let policy,
    connections = [],
    selected = '',
    preferredModel = '',
    selectionSequence = 0,
    busy = false,
    managedId = '',
    modelReady = false;
  let wizard = false,
    step = 1;
  let preferenceQueue = Promise.resolve();
  const dialog = $('ai-dialog');
  // Keep navigation visible while long provider instructions scroll independently.
  dialog.insertBefore($('ai-wizard-actions'), $('ai-close-dialog').parentElement);
  const status = (message) => {
    $('ai-connection-status').textContent = message;
  };
  const feedback = (message = '', error = false) => {
    $('ai-dialog-status').textContent = message;
    $('ai-dialog-status').dataset.error = String(error);
    $('ai-error-help').hidden = true;
  };
  const managed = () => connections.find((item) => item.id === managedId);
  const controls = () => {
    $('ai-connection').disabled = busy || !connections.length;
    $('ai-model').disabled = busy || !modelReady || $('ai-model').options.length < 2;
    $('ai-refresh-models').disabled = busy || !selected;
  };
  function setBusy(value) {
    busy = value;
    for (const node of dialog.querySelectorAll('button, input, select')) node.disabled = value;
    $('ai-provider').disabled = value || !!managedId;
    $('ai-setup-finish').disabled = value || !$('ai-setup-model').value;
    controls();
  }
  function rememberSelection(connectionId, modelId) {
    const seq = selectionSequence;
    preferenceQueue = preferenceQueue
      .catch(() => {})
      .then(async () => {
        if (seq !== selectionSequence) return;
        await api('/api/ai/preferences', {
          method: 'PUT',
          body: JSON.stringify({ connectionId, modelId }),
        });
      })
      .catch((error) => {
        if (seq === selectionSequence) status(`선택 저장 실패: ${error.message}`);
      });
    return preferenceQueue;
  }
  function renderConnections() {
    $('ai-connection').replaceChildren(
      option('AI 연결 선택', ''),
      ...connections.map((item) =>
        option(
          `${item.name} · ${policy.providers.find((p) => p.id === item.provider)?.name || item.provider}`,
          item.id,
        ),
      ),
    );
    $('ai-managed-connection').replaceChildren(
      option('새 연결', ''),
      ...connections.map((item) => option(item.name, item.id)),
    );
    if (!connections.some((item) => item.id === selected)) selected = '';
    $('ai-connection').value = selected;
    $('ai-managed-connection').value = managedId;
    controls();
  }
  async function reload() {
    const data = await api('/api/ai/connections');
    connections = data.connections;
    renderConnections();
    return data;
  }
  function renderModels(result, desired = '') {
    modelReady = result.state === 'ready';
    $('ai-model').replaceChildren(
      option('모델 선택', ''),
      ...result.models.map((item) => option(item.name, item.id)),
    );
    if (result.models.some((item) => item.id === desired)) $('ai-model').value = desired;
    controls();
    if (result.state !== 'ready') {
      $('ai-model').disabled = true;
      status(
        result.state === 'stale'
          ? '목록 갱신에 실패했습니다. 다시 새로고침하세요.'
          : '모델 목록 새로고침을 눌러 사용 가능한 모델을 확인하세요.',
      );
    } else {
      status(
        result.models.length
          ? '모델 조회 완료 · 실제 코드 생성은 다음 단계에서 연결됩니다.'
          : '조회는 성공했지만 선택 가능한 모델이 없습니다.',
      );
    }
  }
  async function choose(id, desired = '', result) {
    selected = id;
    modelReady = false;
    preferredModel = desired;
    const seq = ++selectionSequence;
    $('ai-connection').value = id;
    $('ai-model').replaceChildren(option('모델 선택', ''));
    controls();
    if (!id) {
      status('AI 연결을 추가하거나 선택하세요.');
      return;
    }
    try {
      const data = result || (await api(`/api/ai/connections/${id}/models`));
      if (seq !== selectionSequence || selected !== id) return;
      renderModels(data, desired);
    } catch (error) {
      if (seq === selectionSequence) status(error.message);
    }
  }
  function guide() {
    const data = AI_PROVIDER_GUIDES[$('ai-provider').value];
    $('ai-provider-guide').href = data.documentationUrl;
    $('ai-key-console').href = data.consoleUrl;
    $('ai-billing-guide').href = data.billingUrl;
    $('ai-guide-title').textContent = `${data.name} API 키 발급하기`;
    $('ai-guide-preparation').textContent = data.preparation;
    $('ai-guide-trouble').textContent = data.trouble;
    $('ai-guide-instructions').replaceChildren(
      ...data.steps.map((text) => {
        const item = document.createElement('li');
        item.textContent = text;
        return item;
      }),
    );
  }
  function showStep(value) {
    step = value;
    $('ai-setup-progress').hidden = !wizard;
    for (const [index, node] of [...$('ai-setup-progress').children].entries()) {
      if (index === step - 1) node.setAttribute('aria-current', 'step');
      else node.removeAttribute('aria-current');
    }
    $('ai-provider-step').hidden = wizard && step !== 1;
    $('ai-guide-step').hidden = !wizard || step !== 2;
    $('ai-credential-step').hidden = wizard && step !== 3;
    $('ai-model-step').hidden = !wizard || step !== 4;
    $('ai-connection-name').required = !wizard || step === 3;
    $('ai-api-key').required = wizard && step === 3;
    $('ai-submit-connection').hidden = wizard && step !== 3;
    $('ai-wizard-actions').hidden = !wizard;
    $('ai-setup-next').hidden = step >= 3;
    $('ai-setup-next').textContent = step === 2 ? '키를 준비했어요' : '다음';
    $('ai-setup-back').hidden = step === 1 || step === 4;
    $('ai-setup-finish').hidden = step !== 4;
    $('ai-setup-finish').disabled = busy || !$('ai-setup-model').value;
    $('ai-dialog-title').textContent = wizard ? '새 AI 연결' : 'AI 연결 관리';
    $('ai-managed-connection').parentElement.hidden = wizard;
    for (const id of ['ai-save-name', 'ai-check-connection', 'ai-delete-connection'])
      $(id).hidden = wizard || !managedId;
    $('ai-connection-form').scrollTop = 0;
  }
  function edit(id = '') {
    managedId = id;
    const item = managed();
    wizard = !item;
    $('ai-connection-form').reset();
    $('ai-managed-connection').value = id;
    $('ai-provider').value = item?.provider || policy.providers[0].id;
    $('ai-provider').disabled = !!item;
    $('ai-connection-name').value = item?.name || '';
    $('ai-api-key').required = !item;
    $('ai-key-label').textContent = item ? '새 API 키 (교체할 때만 입력)' : 'API 키';
    $('ai-storage-options').hidden = !!item;
    $('ai-credential-mode').querySelector('[value="stored"]').disabled = !policy.storedAvailable;
    $('ai-storage-help').textContent = policy.storedAvailable
      ? '계정에 저장하면 다른 PC의 로그인에서도 사용할 수 있습니다.'
      : '현재 서버의 암호화 저장 설정이 준비되지 않아 임시 보관만 가능합니다.';
    for (const id of ['ai-save-name', 'ai-check-connection', 'ai-delete-connection'])
      $(id).hidden = !item;
    $('ai-submit-connection').textContent = item ? '확인 후 키 교체' : '확인 후 추가';
    guide();
    feedback();
    showStep(1);
  }
  async function action(operation, refreshAfterError = false) {
    if (busy) return;
    setBusy(true);
    feedback('처리 중입니다…');
    try {
      await operation();
    } catch (error) {
      feedback(error.message, true);
      $('ai-error-help').textContent =
        AI_CONNECTION_ERROR_HELP[error.code] ||
        '입력과 제공자 계정 상태를 확인하세요. 반복되면 운영자에게 문의하세요.';
      $('ai-error-help').hidden = false;
      if (refreshAfterError && selected) await choose(selected, preferredModel);
      status(error.message);
    } finally {
      $('ai-api-key').value = '';
      setBusy(false);
    }
  }
  try {
    policy = await api('/api/ai/providers');
    if (!policy.enabled) {
      status(
        '서버에서 AI 연결을 아직 활성화하지 않았습니다. 템플릿 코드 생성은 사용할 수 있습니다.',
      );
      return;
    }
    $('ai-provider').replaceChildren(...policy.providers.map((item) => option(item.name, item.id)));
    const data = await reload();
    $('ai-manage').disabled = false;
    await choose(data.preference.connectionId || '', data.preference.modelId || '');
    $('ai-manage').onclick = async () => {
      try {
        await reload();
        edit(selected);
        dialog.showModal();
      } catch (error) {
        status(error.message);
      }
    };
    $('ai-close-dialog').onclick = () => {
      if (!busy) dialog.close();
    };
    dialog.addEventListener('cancel', (event) => {
      if (busy) event.preventDefault();
    });
    dialog.addEventListener('close', () => {
      $('ai-api-key').value = '';
      feedback();
    });
    $('ai-provider').onchange = () => {
      $('ai-api-key').value = '';
      guide();
    };
    $('ai-setup-next').onclick = () => {
      if (busy || step >= 3) return;
      guide();
      feedback();
      showStep(step + 1);
    };
    $('ai-setup-back').onclick = () => {
      if (busy || step === 4) return;
      $('ai-api-key').value = '';
      feedback();
      showStep(step - 1);
    };
    $('ai-setup-model').onchange = () => {
      $('ai-setup-finish').disabled = busy || !$('ai-setup-model').value;
    };
    $('ai-setup-finish').onclick = () =>
      action(async () => {
        const modelId = $('ai-setup-model').value,
          item = managed();
        if (!item || !modelId) return;
        await preferenceQueue;
        await api('/api/ai/preferences', {
          method: 'PUT',
          body: JSON.stringify({ connectionId: item.id, modelId }),
        });
        await choose(item.id, modelId);
        feedback('모델 선택을 완료했습니다.');
        dialog.close();
      });
    $('ai-setup-refresh').onclick = () =>
      action(async () => {
        const item = managed();
        const result = await api(`/api/ai/connections/${item.id}/models/refresh`, {
          method: 'POST',
          body: '{}',
        });
        await reload();
        $('ai-setup-model').replaceChildren(
          option('모델 선택', ''),
          ...result.catalog.models.map((model) => option(model.name, model.id)),
        );
        await choose(item.id, '', result.catalog);
        feedback('모델 목록을 다시 확인했습니다. 사용할 모델을 선택하세요.');
      });
    $('ai-managed-connection').onchange = () => edit($('ai-managed-connection').value);
    $('ai-add-connection').onclick = () => edit();
    $('ai-connection').onchange = async () => {
      await choose($('ai-connection').value);
      if (!selected) await rememberSelection(null, null);
    };
    $('ai-model').onchange = async () => {
      const model = $('ai-model').value;
      preferredModel = model;
      if (selected && model) await rememberSelection(selected, model);
      else await rememberSelection(null, null);
    };
    $('ai-refresh-models').onclick = () =>
      action(async () => {
        const id = selected,
          seq = selectionSequence;
        const result = await api(`/api/ai/connections/${id}/models/refresh`, {
          method: 'POST',
          body: '{}',
        });
        await reload();
        if (id === selected && seq === selectionSequence)
          renderModels(result.catalog, preferredModel);
        feedback('모델 목록을 갱신했습니다.');
      }, true);
    $('ai-connection-form').onsubmit = (event) => {
      event.preventDefault();
      if (wizard && step !== 3) return;
      const item = managed(),
        key = $('ai-api-key').value;
      if (!key) {
        feedback('API 키를 입력하세요.', true);
        return;
      }
      const payload = item
        ? { revision: item.revision, apiKey: key }
        : {
            name: $('ai-connection-name').value,
            provider: $('ai-provider').value,
            credentialMode: $('ai-credential-mode').value,
            apiKey: key,
          };
      $('ai-api-key').value = '';
      void action(async () => {
        const result = await api(item ? `/api/ai/connections/${item.id}` : '/api/ai/connections', {
          method: item ? 'PATCH' : 'POST',
          body: JSON.stringify(payload),
        });
        await reload();
        await choose(result.connection.id, '', result.catalog);
        edit(result.connection.id);
        if (!item) {
          wizard = true;
          $('ai-setup-model').replaceChildren(
            option('모델 선택', ''),
            ...result.catalog.models.map((model) => option(model.name, model.id)),
          );
          showStep(4);
          feedback(
            result.catalog.models.length
              ? '연결 확인을 마쳤습니다. 사용할 모델을 선택하세요.'
              : '연결은 저장했지만 선택 가능한 모델이 없습니다. 권한과 서버 허용 모델을 확인하세요.',
          );
        } else feedback('연결 확인을 마쳤습니다. 닫은 뒤 사용할 모델을 선택하세요.');
      });
    };
    $('ai-save-name').onclick = () =>
      action(async () => {
        const item = managed();
        const result = await api(`/api/ai/connections/${item.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ revision: item.revision, name: $('ai-connection-name').value }),
        });
        await reload();
        edit(result.connection.id);
        feedback('연결 이름을 저장했습니다.');
      });
    $('ai-check-connection').onclick = () =>
      action(async () => {
        const item = managed();
        const result = await api(`/api/ai/connections/${item.id}/check`, {
          method: 'POST',
          body: '{}',
        });
        await reload();
        if (selected === item.id) await choose(item.id, preferredModel, result.catalog);
        edit(item.id);
        feedback('연결 확인과 모델 목록 조회를 마쳤습니다.');
      }, true);
    $('ai-delete-connection').onclick = () => {
      const item = managed();
      if (!confirm(`“${item.name}” 연결과 보관된 API 키를 삭제할까요?`)) return;
      void action(async () => {
        await api(`/api/ai/connections/${item.id}`, {
          method: 'DELETE',
          body: JSON.stringify({ revision: item.revision }),
        });
        await reload();
        if (!selected) await choose('');
        edit();
        feedback('연결과 API 키를 삭제했습니다.');
      });
    };
  } catch (error) {
    status(`AI 연결 준비 실패: ${error.message}`);
  }
}
