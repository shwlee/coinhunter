import { api, accountBar } from './account.js';
import { createCodeEditor } from '/code-editor.js';
const $ = (id) => document.getElementById(id);
const editor = createCodeEditor($('code'), $('code-editor'), $('cursor'));
$('writing-view').onclick = () => {
  document.body.dataset.panel = 'writing';
  editor.refresh();
};
$('testing-view').onclick = () => {
  document.body.dataset.panel = 'testing';
};
let documentId = null,
  revision = null,
  saved = '',
  saving = false,
  candidate = null,
  generation = 0,
  testing = false;
const contents = () => JSON.stringify({ name: $('name').value, source: $('code').value });
const dirty = () => contents() !== saved;
const notice = (text) => {
  $('notice').textContent = text;
};
const refreshState = () => {
  $('save-state').textContent = dirty() ? '미저장 변경 있음' : '저장됨';
};
const run = (operation) => async () => {
  try {
    await operation();
  } catch (error) {
    notice(error.message);
  }
};
function codeTab() {
  $('ai-panel').hidden = true;
  $('code-panel').hidden = false;
  $('ai-tab').setAttribute('aria-pressed', 'false');
  $('code-tab').setAttribute('aria-pressed', 'true');
  editor.refresh();
}
function replaceCode(text) {
  codeTab();
  editor.replace(text);
  refreshState();
}
function reset(item) {
  documentId = item?.id || null;
  revision = item?.revision || null;
  $('name').value = item?.name || '새 알고리즘';
  $('code').value = item?.source || '';
  saved = item?.id ? contents() : '';
  candidate = null;
  $('candidate').hidden = true;
  refreshState();
}
async function mayDiscard() {
  if (!dirty()) return true;
  const choice = prompt(
    '미저장 변경이 있습니다. 저장하려면 "저장", 버리려면 "버리기"를 입력하세요. 취소하면 현재 작업을 유지합니다.',
  );
  if (choice === '버리기') return true;
  if (choice === '저장') {
    await save(false);
    return !dirty();
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
async function save(copy) {
  if (saving) return;
  let name = $('name').value;
  if (copy) {
    name = prompt('새 알고리즘 이름', name + ' 복사본');
    if (name === null) return;
  }
  const source = $('code').value;
  const before = contents();
  saving = true;
  $('save').disabled = $('save-as').disabled = true;
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
    if (contents() === before) $('name').value = item.name;
    saved = JSON.stringify({ name: item.name, source: item.source });
    refreshState();
    await library();
    notice('저장했습니다. 다른 창이나 같은 계정에서도 열 수 있습니다.');
  } finally {
    saving = false;
    $('save').disabled = $('save-as').disabled = false;
  }
}
$('name').oninput = $('code').oninput = refreshState;
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
$('code-tab').onclick = codeTab;
$('ai-tab').onclick = () => {
  $('ai-panel').hidden = false;
  $('code-panel').hidden = true;
  $('ai-tab').setAttribute('aria-pressed', 'true');
  $('code-tab').setAttribute('aria-pressed', 'false');
};
$('save').onclick = run(() => save(false));
$('save-as').onclick = run(() => save(true));
$('new').onclick = run(async () => {
  if (saving || !(await mayDiscard())) return;
  reset({ source: await (await fetch('/api/example')).text() });
  notice('새 문서를 만들었습니다.');
});
$('open').onclick = run(async () => {
  if (saving || !$('library').value || !(await mayDiscard())) return;
  reset(await api(`/api/algorithms/${$('library').value}`));
  notice('저장 코드를 열었습니다.');
});
$('import').onchange = run(async () => {
  const file = $('import').files[0];
  if (!file || saving || !(await mayDiscard())) return;
  if (!file.name.endsWith('.js') || file.size > 65536)
    throw new Error('64 KiB 이하의 .js 파일을 선택하세요.');
  reset({ name: file.name.replace(/\.js$/, ''), source: await file.text() });
  codeTab();
});
$('export').onclick = () => {
  const url = URL.createObjectURL(new Blob([$('code').value], { type: 'text/javascript' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = ($('name').value || 'algorithm').replace(/[^\p{L}\p{N}_-]/gu, '_') + '.js';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
$('validate').onclick = run(async () => {
  await api('/api/algorithms/validate', {
    method: 'POST',
    body: JSON.stringify({ source: $('code').value }),
  });
  notice(
    '구문과 금지 구문 검사를 통과했습니다. 메서드 형식과 동작은 테스트 플레이에서 확인하세요.',
  );
});
$('generate').onclick = run(async () => {
  const token = ++generation,
    baseline = contents();
  $('generate').disabled = true;
  $('cancel-ai').disabled = false;
  candidate = null;
  $('candidate').hidden = true;
  try {
    await api('/api/algorithms');
    const source = await (await fetch('/api/example')).text();
    await new Promise((resolve) => setTimeout(resolve, 600));
    if (generation !== token) return;
    await api('/api/algorithms/validate', { method: 'POST', body: JSON.stringify({ source }) });
    if (generation !== token) return;
    candidate = { source, baseline };
    $('candidate-code').textContent = source;
    $('candidate').hidden = false;
    $('candidate-info').textContent =
      '목업 결과: 가까운 코인 탐색 샘플입니다. 입력한 전략은 아직 AI에 전송되지 않습니다.';
  } finally {
    if (generation === token) {
      $('generate').disabled = false;
      $('cancel-ai').disabled = true;
    }
  }
});
$('cancel-ai').onclick = () => {
  generation++;
  $('generate').disabled = false;
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
  notice('목업 코드를 적용했습니다. 실행 취소로 되돌릴 수 있습니다.');
};
$('test').onclick = run(async () => {
  if (testing) throw new Error('게임 패널에서 진행 중 경기를 종료한 뒤 다시 준비하세요.');
  await api('/api/algorithms/validate', {
    method: 'POST',
    body: JSON.stringify({ source: $('code').value }),
  });
  $('game').contentWindow.postMessage(
    { type: 'editor-prepare', source: $('code').value, name: $('name').value },
    location.origin,
  );
});
window.addEventListener('message', (event) => {
  if (event.origin !== location.origin || event.source !== $('game').contentWindow) return;
  if (event.data.type === 'editor-state') testing = event.data.active;
  if (event.data.type === 'editor-ready') $('test').disabled = false;
  if (event.data.type === 'editor-feedback') notice(event.data.message);
});
window.addEventListener('beforeunload', (event) => {
  if (dirty() || testing) {
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
    reset({ source: await (await fetch('/api/example')).text() });
    await library();
    if (session.user.role === 'admin') {
      $('admin').hidden = false;
      await users();
    }
    $('workbench').hidden = false;
    notice(
      '로컬 작업실 · 로그인은 목업이며 AI는 샘플 응답입니다. 저장 및 테스트 플레이는 실제로 동작합니다.',
    );
  }
} catch (error) {
  notice(error.message);
}
