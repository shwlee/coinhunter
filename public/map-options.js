import { api } from './account.js';
const $ = (id) => document.getElementById(id);
const groups = [
  [
    '경기',
    [
      ['actionMs', '캐릭터 액션 시간', 'ms'],
      ['runningTimeMs', 'Hurry Up 전환 시간', 'ms'],
    ],
  ],
  [
    '아이템',
    [
      ['itemFirstMs', '최초 출현 시간', 'ms'],
      ['itemIntervalMs', '재출현 주기', 'ms'],
      ['itemDuration', '효과 지속량', '턴 / 회'],
    ],
  ],
  [
    '랜덤 기믹',
    [
      ['blackMatterIntervalMs', 'BlackMatter 생성 주기', 'ms'],
      ['destroyWallIntervalMs', '벽 파괴 주기', 'ms'],
    ],
  ],
];
let selected = null,
  model = null,
  busy = false,
  baseline = '',
  afterSave,
  adapter = null;
function settings() {
  const result = {};
  for (const [, fields] of groups)
    for (const [key] of fields) result[key] = Number($(`option-${key}`).value);
  result.hurryUpRemovalIntervalMs = Object.fromEntries(
    [10, 30, 100, 200, 500].map((score) => [score, Number($(`option-removal-${score}`).value)]),
  );
  return result;
}
const dirty = () =>
  model && selected.source !== 'sample' && JSON.stringify(settings()) !== baseline;
window.addEventListener('beforeunload', (event) => {
  if ($('options-dialog').open && dirty()) {
    event.preventDefault();
    event.returnValue = '';
  }
});
function controls() {
  const readonly = selected?.source === 'sample';
  $('save-options').hidden = readonly;
  $('save-options').disabled = busy || !model;
  $('close-options').disabled = busy;
  $('reload-options').disabled = busy;
  for (const input of $('options-fields').querySelectorAll('input'))
    input.disabled = busy || readonly;
}
function addField(parent, key, label, unit, value, range) {
  const field = document.createElement('label');
  const text = document.createElement('span');
  text.textContent = `${label} (${unit})`;
  const input = document.createElement('input');
  input.type = 'number';
  input.id = `option-${key}`;
  input.min = range[0];
  input.max = range[1];
  input.step = 1;
  input.required = true;
  input.value = value;
  const help = document.createElement('small');
  help.textContent = `${range[0].toLocaleString()} ~ ${range[1].toLocaleString()} ${unit}`;
  field.append(text, input, help);
  parent.append(field);
}
function render() {
  $('options-fields').replaceChildren();
  $('options-map').textContent = `${model.map.name} · 초안 v${model.map.revision}`;
  if (selected.source === 'sample')
    $('options-map').textContent =
      `${model.map.name} · 기본 샘플 v${model.map.revision} (읽기 전용)`;
  $('options-note').textContent =
    selected.source === 'sample'
      ? '기본 샘플의 설정을 확인할 수 있습니다. 원본 변경은 지원하지 않습니다.'
      : adapter
        ? '적용한 옵션은 맵 저장 시 배치와 함께 초안으로 저장됩니다. 게시 갱신 후 새 경기에 적용됩니다.'
        : '옵션은 초안으로 저장됩니다. 게시 버전 갱신 후 새 경기에 적용됩니다.';
  $('save-options').textContent = adapter ? '옵션 적용' : '초안 저장';
  $('reload-options').textContent = adapter ? '변경 전 옵션 불러오기' : '최신 옵션 불러오기';
  for (const [title, fields] of groups) {
    const group = document.createElement('fieldset'),
      legend = document.createElement('legend');
    legend.textContent = title;
    group.append(legend);
    for (const [key, label, unit] of fields)
      addField(group, key, label, unit, model.map.settings[key], model.limits[key]);
    const note = document.createElement('p');
    note.textContent =
      title === '경기'
        ? '1,000ms = 1초. 액션 시간은 이동·제자리·벽 파괴에 공통 적용됩니다.'
        : title === '아이템'
          ? '지속량은 신발·점프의 턴 수, 망치의 벽 파괴 횟수, 두배의 코인 횟수입니다. 재출현은 기존 아이템이 모두 사라진 후에 가능합니다.'
          : '발동 여부는 게임 시작 시 사용자가 선택합니다. 여기에서는 주기만 조정합니다.';
    group.append(note);
    $('options-fields').append(group);
  }
  const removal = document.createElement('fieldset'),
    legend = document.createElement('legend');
  legend.textContent = 'Hurry Up · 점수별 코인 소멸 간격';
  removal.append(legend);
  for (const score of [10, 30, 100, 200, 500])
    addField(
      removal,
      `removal-${score}`,
      `${score}점 코인`,
      'ms',
      model.map.settings.hurryUpRemovalIntervalMs[score],
      [100, 60000],
    );
  const note = document.createElement('p');
  note.textContent =
    '제거한 코인의 점수에 지정된 간격만큼 기다린 뒤 다음 코인을 제거합니다. 낮은 점수부터 제거하는 순서는 유지됩니다.';
  removal.append(note);
  $('options-fields').append(removal);
  baseline = JSON.stringify(settings());
  controls();
}
async function load() {
  busy = true;
  controls();
  $('options-error').textContent = '';
  try {
    model = adapter ? await adapter.load() : await api(`/api/admin/maps/${selected.id}/settings`);
    render();
  } catch (error) {
    $('options-error').textContent = error.message;
  } finally {
    busy = false;
    controls();
  }
}
export function installMapOptions(onSaved, localAdapter = null) {
  afterSave = onSaved;
  adapter = localAdapter;
  return async (entry) => {
    if (busy) return;
    selected = entry;
    model = null;
    baseline = '';
    $('options-map').textContent = `${entry.name} · 옵션을 불러오고 있습니다…`;
    $('options-fields').replaceChildren();
    $('options-dialog').showModal();
    await load();
  };
}
function mayDiscard() {
  return !dirty() || confirm('저장하지 않은 옵션 변경 사항을 버릴까요?');
}
$('close-options').onclick = () => {
  if (!busy && mayDiscard()) $('options-dialog').close();
};
$('options-dialog').addEventListener('cancel', (event) => {
  if (busy || !mayDiscard()) event.preventDefault();
});
$('reload-options').onclick = () => {
  if (!busy && mayDiscard()) void load();
};
$('options-form').onsubmit = async (event) => {
  event.preventDefault();
  if (busy || !model || selected.source === 'sample') return;
  if (!dirty()) {
    $('options-dialog').close();
    return;
  }
  const input = { settings: settings(), expectedRevision: model.map.revision };
  busy = true;
  controls();
  $('options-error').textContent = '';
  try {
    const result = adapter
      ? await adapter.save(input.settings)
      : await api(`/api/admin/maps/${selected.id}/settings`, {
          method: 'PUT',
          body: JSON.stringify(input),
        });
    model = result;
    baseline = JSON.stringify(input.settings);
    $('options-dialog').close();
    await afterSave(selected);
  } catch (error) {
    $('options-error').textContent = error.message;
  } finally {
    busy = false;
    controls();
  }
};
