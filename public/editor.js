import { api, accountBar } from './account.js';
import { createCodeEditor } from '/code-editor.js';
import { PRIORITY_WEIGHTS, STRATEGY_TEMPLATES, buildTemplateSource } from './strategy-templates.js';
const $ = (id) => document.getElementById(id);
const editor = createCodeEditor($('code'), $('code-editor'), $('cursor'));
const emptyAlgorithm = `module.exports = class Player {
  initialize(myNumber, column, row) {
  }

  getName() {
  }

  moveNext(map, myPosition, items) {
  }
};`;
let documentId = null,
  revision = null,
  documentName = '새 알고리즘',
  documentOrigin = '새 문서 · 아직 저장하지 않음',
  saved = '',
  saving = false,
  candidate = null,
  generation = 0,
  testing = false,
  testReady = false,
  pendingTest = null,
  preparedRequest = null,
  testSource = null,
  testRequestId = 0;
let validationRequestId = 0;
let generating = false;
const templateControls = new Map();
const priorityIds = [];
function refreshTemplates() {
  const count = priorityIds.length;
  $('template-count').textContent = `${count} / 3`;
  for (const [id, { option, checkbox, rank }] of templateControls) {
    const position = priorityIds.indexOf(id);
    const unavailable = count === 3 && !checkbox.checked;
    checkbox.disabled = unavailable;
    option.classList.toggle('selected', checkbox.checked);
    option.classList.toggle('unavailable', unavailable);
    rank.hidden = position < 0;
    rank.textContent = position < 0 ? '' : `${position + 1}순위`;
  }
  const list = $('template-priorities');
  list.replaceChildren();
  list.hidden = count === 0;
  priorityIds.forEach((id, index) => {
    const template = STRATEGY_TEMPLATES.find((item) => item.id === id);
    const label = template.label;
    const row = document.createElement('li');
    row.draggable = true;
    row.dataset.templateId = id;
    row.title = `${template.description} 드래그하여 순서를 바꿀 수 있습니다.`;
    row.setAttribute('aria-label', `${index + 1}순위 ${label}, 드래그 또는 버튼으로 순서 변경`);
    row.addEventListener('dragstart', (event) => {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', id);
      row.classList.add('dragging');
    });
    row.addEventListener('dragend', () => {
      row.classList.remove('dragging');
      for (const item of list.children) item.classList.remove('drag-over');
    });
    row.addEventListener('dragover', (event) => {
      if (!event.dataTransfer.types.includes('text/plain')) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      row.classList.add('drag-over');
    });
    row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
    row.addEventListener('drop', (event) => {
      event.preventDefault();
      const sourceId = event.dataTransfer.getData('text/plain');
      const from = priorityIds.indexOf(sourceId);
      const to = priorityIds.indexOf(id);
      if (from < 0 || to < 0 || from === to) return;
      priorityIds.splice(from, 1);
      priorityIds.splice(to, 0, sourceId);
      invalidateTemplateCandidate();
    });
    const text = document.createElement('span');
    text.textContent = `${index + 1}순위 · ${label}`;
    const weight = document.createElement('small');
    weight.textContent = `자동 가중치 ${PRIORITY_WEIGHTS[index]}`;
    const controls = document.createElement('span');
    controls.className = 'priority-controls';
    for (const [direction, arrow, action] of [
      [-1, '↑', '올리기'],
      [1, '↓', '내리기'],
    ]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = arrow;
      button.setAttribute('aria-label', `${label} 우선순위 ${action}`);
      button.disabled = index + direction < 0 || index + direction >= count;
      button.onclick = () => {
        const next = index + direction;
        [priorityIds[index], priorityIds[next]] = [priorityIds[next], priorityIds[index]];
        invalidateTemplateCandidate();
        const moved = list.children[next].querySelectorAll('button');
        (moved[direction < 0 && next === 0 ? 1 : 0] || moved[0]).focus();
      };
      controls.append(button);
    }
    row.append(text, weight, controls);
    list.append(row);
  });
  $('generate').disabled = generating || count === 0;
}
function invalidateTemplateCandidate() {
  generation++;
  generating = false;
  $('cancel-ai').disabled = true;
  candidate = null;
  $('candidate').hidden = true;
  refreshTemplates();
}
function clearTemplates() {
  priorityIds.length = 0;
  for (const { checkbox } of templateControls.values()) checkbox.checked = false;
  invalidateTemplateCandidate();
}
for (const template of STRATEGY_TEMPLATES) {
  const option = document.createElement('div');
  option.className = 'template-option';
  const pick = document.createElement('label');
  pick.className = 'template-pick';
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.value = template.id;
  checkbox.name = 'strategy-template';
  const name = document.createElement('strong');
  name.textContent = template.label;
  pick.title = template.description;
  pick.append(checkbox, name);
  const rank = document.createElement('span');
  rank.className = 'template-rank';
  option.append(pick, rank);
  $('template-options').append(option);
  templateControls.set(template.id, { option, checkbox, rank });
  checkbox.addEventListener('change', () => {
    if (checkbox.checked) priorityIds.push(template.id);
    else priorityIds.splice(priorityIds.indexOf(template.id), 1);
    invalidateTemplateCandidate();
  });
}
refreshTemplates();
function validationStatus(state, message) {
  $('validation-status').hidden = false;
  $('validation-status').dataset.state = state;
  $('validation-status').textContent = message;
}
function setValidationBusy(busy) {
  const button = $('validate');
  const label = busy ? '코드 검사 중…' : '코드 검사';
  button.disabled = busy;
  button.setAttribute('aria-label', label);
  button.setAttribute('aria-busy', String(busy));
  button.dataset.tooltip = label;
}
const contents = () => JSON.stringify({ name: documentName, source: $('code').value });
const dirty = () => contents() !== saved;
const notice = (text) => {
  $('notice').textContent = text;
};
const refreshState = () => {
  $('save-state').textContent = !documentId ? '미저장' : dirty() ? '미저장 변경 있음' : '저장됨';
  refreshTestCodeState();
};
function setDocumentOrigin(kind, detail = '') {
  documentOrigin =
    kind === 'library'
      ? `내 저장 코드에서 불러옴 · ${detail}`
      : kind === 'file'
        ? `내 PC 파일에서 가져옴 · ${detail}`
        : kind === 'saved'
          ? `내 계정에 저장됨 · ${detail}`
          : '새 문서 · 아직 저장하지 않음';
  $('document-origin').textContent = documentOrigin;
}
function refreshTestCodeState() {
  const changed = testSource !== null && $('code').value !== testSource;
  $('test-code-state').hidden = !changed;
  $('test-code-state').textContent = testing
    ? '현재 편집 코드가 실행 중인 코드와 다릅니다. 변경 사항은 다음 테스트에 적용됩니다.'
    : '현재 편집 코드가 테스트에 전달한 코드와 다릅니다. 편집기에서 플레이 버튼을 눌러 다시 테스트하세요.';
}
const run = (operation) => async () => {
  try {
    await operation();
  } catch (error) {
    notice(error.message);
  }
};
function showPanel(panel) {
  if (panel !== 'writing') setCodeMaximized(false);
  document.body.dataset.panel = panel;
  if (panel === 'writing') editor.refresh();
}
$('back-to-editor').onclick = () => showPanel('writing');
function loadError(message) {
  $('load-error').textContent = message;
  $('load-error').hidden = false;
}
$('load-mode').onclick = async () => {
  $('load-error').hidden = true;
  $('load-panel').showModal();
  try {
    await library();
  } catch (error) {
    loadError(error.message);
  }
};
$('cancel-load').onclick = () => $('load-panel').close();
$('load-panel').addEventListener('close', () => {
  $('import').value = '';
});
$('library').onchange = () => {
  $('load-error').hidden = true;
};
const aiLayout = document.querySelector('.editing-layout');
const aiGripper = $('resize-ai');
const aiWidthStorageKey = 'coinhunter.aiSidebarWidth';
let preferredAiWidth = 376;
try {
  const stored = Number(localStorage.getItem(aiWidthStorageKey));
  if (stored >= 300 && stored <= 720) preferredAiWidth = stored;
} catch {
  // Resizing still works when storage is unavailable.
}
function aiWidthBounds() {
  const max = Math.max(240, Math.min(720, aiLayout.clientWidth - 12 - 340));
  return { min: Math.min(300, max), max };
}
let editorRefreshQueued = false;
function queueEditorRefresh() {
  if (editorRefreshQueued) return;
  editorRefreshQueued = true;
  requestAnimationFrame(() => {
    editorRefreshQueued = false;
    editor.refresh();
  });
}
function applyAiWidth() {
  if (!aiLayout.clientWidth) return;
  const { min, max } = aiWidthBounds();
  const width = Math.round(Math.max(min, Math.min(max, preferredAiWidth)));
  aiLayout.style.setProperty('--ai-sidebar-width', `${width}px`);
  aiGripper.setAttribute('aria-valuemin', String(Math.round(min)));
  aiGripper.setAttribute('aria-valuemax', String(Math.round(max)));
  aiGripper.setAttribute('aria-valuenow', String(width));
  aiGripper.setAttribute('aria-valuetext', `${width}픽셀`);
  queueEditorRefresh();
}
function rememberAiWidth() {
  preferredAiWidth = Number(aiGripper.getAttribute('aria-valuenow'));
  try {
    localStorage.setItem(aiWidthStorageKey, String(Math.round(preferredAiWidth)));
  } catch {
    // Keep the selected width for this page.
  }
}
let resizePointer = null;
aiGripper.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || matchMedia('(max-width: 760px)').matches || $('ai-panel').hidden)
    return;
  event.preventDefault();
  resizePointer = {
    id: event.pointerId,
    x: event.clientX,
    width: $('ai-panel').parentElement.getBoundingClientRect().width,
  };
  aiGripper.setPointerCapture(event.pointerId);
  aiLayout.classList.add('resizing');
});
aiGripper.addEventListener('pointermove', (event) => {
  if (resizePointer?.id !== event.pointerId) return;
  preferredAiWidth = resizePointer.width + resizePointer.x - event.clientX;
  applyAiWidth();
});
function finishAiResize(event) {
  if (resizePointer?.id !== event.pointerId) return;
  resizePointer = null;
  aiLayout.classList.remove('resizing');
  rememberAiWidth();
}
aiGripper.addEventListener('pointerup', finishAiResize);
aiGripper.addEventListener('pointercancel', finishAiResize);
aiGripper.addEventListener('keydown', (event) => {
  if (matchMedia('(max-width: 760px)').matches) return;
  const { min, max } = aiWidthBounds();
  const current = Number(aiGripper.getAttribute('aria-valuenow'));
  if (event.key === 'ArrowLeft') preferredAiWidth = current + 20;
  else if (event.key === 'ArrowRight') preferredAiWidth = current - 20;
  else if (event.key === 'Home') preferredAiWidth = min;
  else if (event.key === 'End') preferredAiWidth = max;
  else return;
  event.preventDefault();
  applyAiWidth();
  rememberAiWidth();
});
function setAiOpen(open) {
  $('ai-panel').hidden = !open;
  aiLayout.classList.toggle('ai-open', open);
  $('toggle-ai').setAttribute('aria-expanded', String(open));
  const label = `AI 스크립팅 사이드바 ${open ? '접기' : '펼치기'}`;
  $('toggle-ai').setAttribute('aria-label', label);
  $('toggle-ai').dataset.tooltip = label;
  $('ai-arrow').textContent = open ? '›' : '‹';
  if (open) applyAiWidth();
  editor.refresh();
}
$('toggle-ai').onclick = () => setAiOpen($('ai-panel').hidden);
function setCodeMaximized(maximized) {
  document.body.classList.toggle('code-maximized', maximized);
  const button = $('maximize-code');
  const label = maximized ? '코드 영역 원래 크기로' : '코드 영역 최대화';
  button.setAttribute('aria-pressed', String(maximized));
  button.setAttribute('aria-label', label);
  button.dataset.tooltip = label;
  button.querySelector('use').setAttribute('href', maximized ? '#icon-collapse' : '#icon-expand');
  queueEditorRefresh();
}
$('maximize-code').onclick = () =>
  setCodeMaximized(!document.body.classList.contains('code-maximized'));
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !document.body.classList.contains('code-maximized')) return;
  if (document.querySelector('dialog[open]')) return;
  setCodeMaximized(false);
});
function replaceCode(text) {
  editor.replace(text);
  refreshState();
}
function reset(item, origin = item?.id ? 'library' : 'new', detail = item?.name || '') {
  validationRequestId++;
  documentId = item?.id || null;
  revision = item?.revision || null;
  documentName = item?.name || '새 알고리즘';
  $('document-title').textContent = documentName;
  setDocumentOrigin(origin, detail);
  $('code').value = item?.source || '';
  $('code-error').hidden = true;
  $('validation-status').hidden = true;
  setValidationBusy(false);
  saved = contents();
  candidate = null;
  $('candidate').hidden = true;
  if (!testing) {
    testSource = null;
    preparedRequest = null;
    pendingTest = null;
  }
  refreshState();
}
async function mayDiscard() {
  if (!dirty()) return true;
  const choice = prompt(
    '미저장 변경이 있습니다. 저장하려면 "저장", 버리려면 "버리기"를 입력하세요. 취소하면 현재 작업을 유지합니다.',
  );
  if (choice === '버리기') return true;
  if (choice === '저장') {
    return (await requestSave()) && !dirty();
  }
  return false;
}
async function library() {
  const previous = $('library').value;
  const { algorithms } = await api('/api/algorithms');
  $('library').replaceChildren(new Option('저장 코드 선택', ''));
  for (const item of algorithms) $('library').add(new Option(item.name, item.id));
  $('library').value = previous;
}
async function save(copy, name) {
  if (saving) return false;
  const source = $('code').value;
  saving = true;
  $('confirm-save').disabled = $('cancel-save').disabled = true;
  try {
    const item = await api(
      documentId && !copy ? `/api/algorithms/${documentId}` : '/api/algorithms',
      {
        method: documentId && !copy ? 'PUT' : 'POST',
        body: JSON.stringify({ name, source, revision }),
      },
    );
    documentId = item.id;
    revision = item.revision;
    documentName = item.name;
    $('document-title').textContent = item.name;
    setDocumentOrigin('saved', item.name);
    saved = JSON.stringify({ name: item.name, source: item.source });
    refreshState();
    try {
      await library();
    } catch {
      notice('저장했습니다. 목록 갱신은 불러오기 화면에서 다시 시도하세요.');
      return true;
    }
    notice('저장했습니다. 다른 창이나 같은 계정에서도 열 수 있습니다.');
    return true;
  } finally {
    saving = false;
    $('confirm-save').disabled = $('cancel-save').disabled = false;
  }
}
let saveOutcome = false;
function requestSave() {
  const dialog = $('save-dialog');
  if (saving || dialog.open) return Promise.resolve(false);
  saveOutcome = false;
  $('name').value = documentName;
  $('save-source').textContent = `현재 코드의 출처: ${documentOrigin}`;
  $('overwrite-label').textContent = `원본 “${documentName}”에 덮어쓰기`;
  $('save-error').hidden = true;
  $('save-feedback').hidden = true;
  $('overwrite-option').hidden = !documentId;
  dialog.querySelector('input[value="overwrite"]').checked = Boolean(documentId);
  dialog.querySelector('input[value="copy"]').checked = !documentId;
  dialog.showModal();
  $('name').focus();
  $('name').select();
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(saveOutcome), { once: true });
  });
}
$('save-form').onsubmit = async (event) => {
  event.preventDefault();
  const name = $('name').value.trim();
  if (!name) {
    $('save-error').textContent = '알고리즘 이름을 입력하세요.';
    $('save-error').hidden = false;
    return;
  }
  try {
    const copy = $('save-form').elements['save-kind'].value === 'copy';
    if (await save(copy, name)) {
      saveOutcome = true;
      $('save-dialog').close();
    }
  } catch (error) {
    $('save-error').textContent = error.message;
    $('save-error').hidden = false;
  }
};
$('cancel-save').onclick = () => $('save-dialog').close();
$('save-dialog').oncancel = (event) => {
  if (saving) event.preventDefault();
};
$('code').oninput = () => {
  $('code-error').hidden = true;
  if (!$('validation-status').hidden)
    validationStatus('changed', '코드가 변경되었습니다. 다시 검사하세요.');
  refreshState();
};
$('code').onkeyup = $('code').onclick = () => {
  $('cursor').textContent =
    `줄 ${$('code').value.slice(0, $('code').selectionStart).split('\n').length} · ${new TextEncoder().encode($('code').value).length} bytes`;
};
$('code').onkeydown = (event) => {
  if (event.key === 'Tab') {
    event.preventDefault();
    document.execCommand('insertText', false, '  ');
  }
};
$('undo').onclick = () => {
  editor.undo();
  refreshState();
};
$('redo').onclick = () => {
  editor.redo();
  refreshState();
};
$('find').onclick = () => {
  const query = $('search').value;
  if (!query) return;
  const text = $('code').value;
  let at = text.indexOf(query, $('code').selectionEnd);
  if (at < 0) at = text.indexOf(query);
  if (at < 0) {
    notice('검색 결과가 없습니다.');
    return;
  }
  $('code').focus();
  $('code').setSelectionRange(at, at + query.length);
};
$('save').onclick = () => requestSave();
$('new').onclick = run(async () => {
  if (saving || !(await mayDiscard())) return;
  clearTemplates();
  $('prompt').value = '';
  $('search').value = '';
  reset({ source: emptyAlgorithm });
  showPanel('writing');
  notice('새 문서를 만들었습니다.');
});
$('open').onclick = async () => {
  if (saving) return;
  if (!$('library').value) {
    loadError('불러올 알고리즘을 선택하세요.');
    return;
  }
  try {
    if (!(await mayDiscard())) return;
    reset(await api(`/api/algorithms/${$('library').value}`));
    $('load-panel').close();
    showPanel('writing');
    notice('저장 코드를 열었습니다.');
  } catch (error) {
    loadError(error.message);
  }
};
$('import').onchange = async () => {
  const file = $('import').files[0];
  if (!file || saving) return;
  $('load-error').hidden = true;
  try {
    if (!(await mayDiscard())) return;
    if (!file.name.endsWith('.js')) throw new Error('.js 파일을 선택하세요.');
    reset({ name: file.name.replace(/\.js$/, ''), source: await file.text() }, 'file', file.name);
    $('load-panel').close();
    showPanel('writing');
  } catch (error) {
    loadError(error.message);
  } finally {
    $('import').value = '';
  }
};
$('export').onclick = () => {
  const url = URL.createObjectURL(new Blob([$('code').value], { type: 'text/javascript' }));
  const link = document.createElement('a');
  link.href = url;
  link.download =
    ($('name').value.trim() || documentName || 'algorithm').replace(/[^\p{L}\p{N}_-]/gu, '_') +
    '.js';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  $('save-feedback').textContent = '현재 편집 코드를 파일로 내보냈습니다.';
  $('save-feedback').hidden = false;
};
async function validateEditorSource() {
  const source = $('code').value;
  const requestId = ++validationRequestId;
  $('code-error').hidden = true;
  setValidationBusy(true);
  validationStatus('pending', '변수·사용 제한과 초기화·이름 조회·이동 실행을 검사하고 있습니다…');
  try {
    editor.clearError();
    await api('/api/algorithms/validate', {
      method: 'POST',
      body: JSON.stringify({ source }),
    });
    if (requestId !== validationRequestId || source !== $('code').value)
      throw new Error('검사 중 코드가 변경되었습니다. 다시 검사하세요.');
    validationStatus(
      'success',
      '실행 전 검사 통과 · 변수·필수 메서드·샘플 이동 24회 확인. 모든 맵과 실행 분기를 보장하지는 않습니다.',
    );
  } catch (error) {
    if (requestId !== validationRequestId) throw error;
    validationStatus(
      'error',
      source === $('code').value
        ? `검사 실패 · ${error.message}`
        : '검사 중 코드가 변경되었습니다. 다시 검사하세요.',
    );
    if (source === $('code').value && error.diagnostic) {
      showPanel('writing');
      editor.showError(error.diagnostic.offset);
      $('code-error').textContent =
        `${error.diagnostic.line}줄 ${error.diagnostic.column}열 · ${error.message}`;
      $('code-error').hidden = false;
    }
    throw error;
  } finally {
    if (requestId === validationRequestId) {
      setValidationBusy(false);
    }
  }
  return source;
}
$('validate').onclick = run(async () => {
  await validateEditorSource();
  notice('실행 전 검사를 통과했습니다. 실제 전략과 장시간 동작은 테스트 플레이에서 확인하세요.');
});
$('generate').onclick = run(async () => {
  const priorities = [...priorityIds];
  if (!priorities.length) return;
  const token = ++generation,
    baseline = contents();
  generating = true;
  refreshTemplates();
  $('cancel-ai').disabled = false;
  candidate = null;
  $('candidate').hidden = true;
  try {
    await api('/api/algorithms');
    const source = buildTemplateSource(priorities);
    await new Promise((resolve) => setTimeout(resolve, 600));
    if (generation !== token) return;
    await api('/api/algorithms/validate', { method: 'POST', body: JSON.stringify({ source }) });
    if (generation !== token) return;
    candidate = { source, baseline };
    $('candidate-code').textContent = source;
    $('candidate').hidden = false;
    $('candidate-info').textContent =
      `템플릿 코드: ${priorities.map((id, index) => `${index + 1}순위 ${STRATEGY_TEMPLATES.find((item) => item.id === id).label}`).join(' · ')}. 자유 입력은 아직 반영되지 않습니다.`;
  } finally {
    if (generation === token) {
      generating = false;
      refreshTemplates();
      $('cancel-ai').disabled = true;
    }
  }
});
$('cancel-ai').onclick = () => {
  generation++;
  generating = false;
  refreshTemplates();
  $('cancel-ai').disabled = true;
  notice('생성을 취소했습니다. 편집 코드는 유지됩니다.');
};
$('apply').onclick = () => {
  if (!candidate) return;
  if (
    candidate.baseline !== contents() &&
    !confirm('요청 이후 편집 내용이 변경되었습니다. 생성 코드로 교체할까요?')
  )
    return;
  replaceCode(candidate.source);
  notice('템플릿 코드를 적용했습니다. 실행 취소로 되돌릴 수 있습니다.');
};
async function prepareTest() {
  if (testing) throw new Error('진행 중인 경기를 종료한 뒤 다시 테스트하세요.');
  const source = await validateEditorSource();
  const payload = {
    type: 'editor-prepare',
    source,
    name: documentName,
    requestId: ++testRequestId,
  };
  preparedRequest = payload;
  showPanel('testing');
  if (testReady) $('game').contentWindow.postMessage(payload, location.origin);
  else {
    pendingTest = payload;
    if (!$('game').hasAttribute('src')) $('game').src = '/game?editor=1';
  }
}
$('testing-view').onclick = run(async () => {
  if (testing) showPanel('testing');
  else await prepareTest();
});
window.addEventListener('message', (event) => {
  if (event.origin !== location.origin || event.source !== $('game').contentWindow) return;
  if (event.data.type === 'editor-state') {
    testing = Boolean(event.data.active);
    const label = testing ? '진행 중 테스트 보기' : '현재 코드로 테스트';
    $('testing-view').setAttribute('aria-label', label);
    $('testing-view').dataset.tooltip = label;
    refreshTestCodeState();
  }
  if (
    event.data.type === 'editor-prepared' &&
    event.data.requestId === preparedRequest?.requestId
  ) {
    testSource = preparedRequest.source;
    preparedRequest = null;
    refreshTestCodeState();
  }
  if (event.data.type === 'editor-ready') {
    testReady = true;
    if (pendingTest) {
      $('game').contentWindow.postMessage(pendingTest, location.origin);
      pendingTest = null;
    }
  }
  if (event.data.type === 'editor-feedback') notice(event.data.message);
});
window.addEventListener('beforeunload', (event) => {
  if (documentId && dirty()) {
    event.preventDefault();
    event.returnValue = '';
  }
});
async function users() {
  const data = await api('/api/admin/users');
  $('users').replaceChildren();
  for (const user of data.users) {
    const row = document.createElement('div');
    row.className = 'user-row';
    const label = document.createElement('span');
    label.textContent = user.email;
    const role = document.createElement('select');
    role.setAttribute('aria-label', `${user.email} 권한`);
    role.add(new Option('사용자', 'user'));
    role.add(new Option('관리자', 'admin'));
    role.value = user.role;
    const status = document.createElement('button');
    status.textContent = user.active ? '이용 중지' : '이용 허용';
    const saveRole = document.createElement('button');
    saveRole.textContent = '권한 저장';
    const update = (active) =>
      run(async () => {
        await api(`/api/admin/users/${user.id}`, {
          method: 'PUT',
          body: JSON.stringify({ active, role: role.value }),
        });
        await users();
        notice('사용자 설정을 변경했습니다.');
      });
    status.onclick = update(!user.active);
    saveRole.onclick = update(user.active);
    row.append(label, role, saveRole, status);
    $('users').append(row);
  }
}
$('refresh-users').onclick = run(users);
try {
  const session = await accountBar();
  if (!session.user) {
    notice('로그인 후 알고리즘을 작성할 수 있습니다. 목업 로그인은 로컬 개발 전용입니다.');
  } else {
    reset({ source: emptyAlgorithm });
    await library();
    if (session.user.role === 'admin') {
      $('admin').hidden = false;
      await users();
    }
    $('workbench').hidden = false;
    applyAiWidth();
    new ResizeObserver(applyAiWidth).observe(aiLayout);
    notice(
      '로컬 작업실 · 로그인은 목업이며 AI 자유 입력은 아직 연결되지 않았습니다. 템플릿 코드 생성, 저장, 테스트 플레이는 실제로 동작합니다.',
    );
  }
} catch (error) {
  notice(error.message);
}
