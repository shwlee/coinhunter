import { api, accountBar } from './account.js';
import { loadCoins, drawCoinSample } from './coin-renderer.js';
import { COIN_VALUES, starts, placementIndices, applyTile, inspectMap } from './map-editing.js';

const $ = (id) => document.getElementById(id);
let map = null,
  baseline = '',
  undo = [],
  redo = [],
  tool = 'coin',
  busy = false;
let cells = [],
  selected = 0,
  zoom = null,
  savedMaps = [];
const coinImages = new Map();
const snapshot = () =>
  JSON.stringify(
    map && {
      name: map.name,
      description: map.description,
      columns: map.columns,
      rows: map.rows,
      tiles: map.tiles,
    },
  );
const dirty = () => snapshot() !== baseline && !!map;
function feedback(message, error = false) {
  $('map-feedback').textContent = message;
  $('map-feedback').classList.toggle('error', error);
}
function mayReplace() {
  return !dirty() || confirm('저장하지 않은 맵 변경 사항이 있습니다. 버리고 진행할까요?');
}
function updateControls() {
  $('dirty-state').textContent = map
    ? dirty()
      ? '미저장 변경'
      : map.id
        ? '저장됨'
        : '새 게임판'
    : '';
  $('map-identity').textContent = map?.id ? `${map.name} · v${map.revision}` : '새 맵';
  $('save-map').disabled = !map || busy;
  $('tools').disabled = !map || busy;
  $('undo').disabled = !undo.length || busy;
  $('redo').disabled = !redo.length || busy;
  for (const id of ['zoom-out', 'zoom-in', 'fit']) $(id).disabled = !map;
  $('open-maps').disabled = busy;
  for (const element of $('create-map').elements) element.disabled = busy;
  $('coin-value').disabled = !map || tool !== 'coin' || busy;
}
function resizeBoard() {
  if (!map) return;
  const viewport = $('board-viewport');
  const fit = Math.min(
    (viewport.clientWidth - 34) / map.columns,
    (viewport.clientHeight - 34) / map.rows,
    64,
  );
  $('board').style.setProperty('--cell', `${zoom ?? fit}px`);
}
function preview(index) {
  for (const cell of cells) cell.classList.remove('preview', 'blocked');
  if (!map || busy || index === undefined) return;
  const indices = placementIndices(map.columns, map.rows, index, $('symmetry').checked);
  const blocked =
    tool !== 'erase' && indices.some((i) => starts(map.columns, map.rows).includes(i));
  for (const i of indices) {
    cells[i].classList.add('preview');
    cells[i].classList.toggle('blocked', blocked);
  }
}
function renderTiles() {
  const report = inspectMap(map);
  const issues = new Set([...report.asymmetric, ...report.isolated]);
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i],
      value = map.tiles[i];
    cell.classList.toggle('wall', value === -1);
    cell.classList.toggle('issue', $('show-issues').checked && issues.has(i));
    cell.replaceChildren();
    if (value > 0 && coinImages.has(value)) {
      const img = document.createElement('img');
      img.src = coinImages.get(value);
      img.alt = '';
      cell.append(img);
    }
    const label =
      value === -1
        ? '벽'
        : value > 0
          ? `${value}점 코인`
          : cell.classList.contains('start')
            ? '시작 칸'
            : '빈칸';
    cell.setAttribute(
      'aria-label',
      `${(i % map.columns) + 1}열 ${Math.floor(i / map.columns) + 1}행, ${label}`,
    );
    cell.title = label;
    cell.disabled = busy;
  }
  $('map-stats').textContent =
    `코인 ${report.coins}개 · ${report.score.toLocaleString()}점 / 벽 ${report.walls}개`;
  const messages = [];
  if (!report.coins) messages.push('코인을 하나 이상 배치하세요');
  if (report.asymmetric.length) messages.push(`대칭 불일치 ${report.asymmetric.length}칸`);
  if (report.isolated.length)
    messages.push(`시작점과 연결되지 않은 공간 ${report.isolated.length}칸`);
  $('map-validation').textContent = messages.length
    ? `게시 전 확인: ${messages.join(' · ')}. 초안 저장은 가능합니다.`
    : '게시 검사 통과. 저장은 초안으로 이루어집니다.';
  updateControls();
}
function openMap(document, saved = false) {
  map = structuredClone(document);
  undo = [];
  redo = [];
  selected = 0;
  zoom = null;
  baseline = saved ? snapshot() : '';
  $('columns').value = map.columns;
  $('rows').value = map.rows;
  $('board').hidden = false;
  $('board-empty').hidden = true;
  $('board-size').textContent = `${map.columns} × ${map.rows}`;
  $('board').style.setProperty('--columns', map.columns);
  cells = Array.from({ length: map.tiles.length }, (_, index) => {
    const cell = documentElement('button');
    cell.type = 'button';
    cell.className = 'map-cell';
    cell.dataset.index = index;
    cell.tabIndex = index === 0 ? 0 : -1;
    cell.classList.toggle('start', starts(map.columns, map.rows).includes(index));
    return cell;
  });
  $('board').replaceChildren(...cells);
  $('board-viewport').scrollTo(0, 0);
  renderTiles();
  resizeBoard();
}
const documentElement = (tag) => document.createElement(tag);
$('create-map').onsubmit = (event) => {
  event.preventDefault();
  if (busy || !mayReplace()) return;
  const columns = Number($('columns').value),
    rows = Number($('rows').value);
  if (
    !Number.isInteger(columns) ||
    columns < 4 ||
    columns > 40 ||
    !Number.isInteger(rows) ||
    rows < 4 ||
    rows > 30
  )
    return;
  openMap({ columns, rows, tiles: Array(columns * rows).fill(0), name: '', description: '' });
  feedback('빈 게임판을 만들었습니다. 도구를 선택하고 바닥을 클릭하세요.');
};
function selectCell(index) {
  cells[selected].tabIndex = -1;
  selected = index;
  cells[index].tabIndex = 0;
}
$('board').onclick = (event) => {
  const cell = event.target.closest('.map-cell');
  if (!cell || busy) return;
  const index = Number(cell.dataset.index);
  selectCell(index);
  const value = tool === 'wall' ? -1 : tool === 'erase' ? 0 : Number($('coin-value').value);
  if (value !== 0 && starts(map.columns, map.rows).includes(index)) {
    feedback('시작 칸에는 코인이나 벽을 배치할 수 없습니다.', true);
    return;
  }
  const changes = applyTile(map, index, value, $('symmetry').checked);
  if (changes.length) {
    undo.push(changes);
    if (undo.length > 200) undo.shift();
    redo = [];
    renderTiles();
    feedback('');
  }
  preview(index);
};
$('board').onpointerover = (event) => {
  const cell = event.target.closest('.map-cell');
  if (cell) preview(Number(cell.dataset.index));
};
$('board').onpointerleave = () => preview();
$('board').onfocusin = (event) => {
  const cell = event.target.closest('.map-cell');
  if (cell) preview(Number(cell.dataset.index));
};
$('board').onkeydown = (event) => {
  if (!map || busy || !event.target.closest('.map-cell')) return;
  const index = Number(event.target.closest('.map-cell').dataset.index),
    x = index % map.columns;
  const next = {
    ArrowLeft: x > 0 ? index - 1 : index,
    ArrowRight: x < map.columns - 1 ? index + 1 : index,
    ArrowUp: Math.max(0, index - map.columns),
    ArrowDown: Math.min(cells.length - 1, index + map.columns),
  }[event.key];
  if (next !== undefined) {
    event.preventDefault();
    selectCell(next);
    cells[next].focus();
  }
};
for (const button of document.querySelectorAll('[data-tool]'))
  button.onclick = () => {
    tool = button.dataset.tool;
    for (const other of document.querySelectorAll('[data-tool]'))
      other.setAttribute('aria-pressed', String(other === button));
    updateControls();
    preview();
  };
function history(back) {
  if (!map || busy) return;
  const from = back ? undo : redo,
    to = back ? redo : undo;
  const changes = from.pop();
  if (!changes) return;
  for (const change of changes) map.tiles[change.index] = back ? change.before : change.after;
  to.push(changes);
  renderTiles();
  preview();
}
$('undo').onclick = () => history(true);
$('redo').onclick = () => history(false);
document.addEventListener('keydown', (event) => {
  if (
    $('save-dialog').open ||
    $('load-dialog').open ||
    event.target.matches('input, textarea, select')
  )
    return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    history(!event.shiftKey);
  }
});
$('symmetry').onchange = () => preview();
$('show-issues').onchange = () => {
  if (map) renderTiles();
};
$('fit').onclick = () => {
  zoom = null;
  resizeBoard();
};
for (const [id, multiplier] of [
  ['zoom-out', 0.8],
  ['zoom-in', 1.25],
])
  $(id).onclick = () => {
    zoom = Math.max(
      8,
      Math.min(96, parseFloat($('board').style.getPropertyValue('--cell')) * multiplier),
    );
    resizeBoard();
  };
new ResizeObserver(resizeBoard).observe($('board-viewport'));
window.addEventListener('beforeunload', (event) => {
  if (dirty()) {
    event.preventDefault();
    event.returnValue = '';
  }
});
for (const button of document.querySelectorAll('[data-close]'))
  button.onclick = () => {
    if (!busy) $(button.dataset.close).close();
  };
$('save-dialog').addEventListener('cancel', (event) => {
  if (busy) event.preventDefault();
});
$('save-map').onclick = () => {
  $('map-name').value = map.name;
  $('map-description').value = map.description;
  $('save-error').textContent = '';
  $('save-dialog').showModal();
};
$('save-form').onsubmit = async (event) => {
  event.preventDefault();
  if (busy) return;
  const name = $('map-name').value.trim();
  if (!name) {
    $('save-error').textContent = '맵 이름을 입력하세요.';
    return;
  }
  busy = true;
  renderTiles();
  $('confirm-save').disabled = true;
  const input = {
    name,
    description: $('map-description').value,
    columns: map.columns,
    rows: map.rows,
    tiles: [...map.tiles],
    expectedRevision: map.revision,
  };
  try {
    const result = await api(map.id ? `/api/admin/maps/${map.id}/draft` : '/api/admin/maps', {
      method: map.id ? 'PUT' : 'POST',
      body: JSON.stringify(input),
    });
    map = result.map;
    baseline = snapshot();
    $('save-dialog').close();
    feedback('맵을 초안으로 저장했습니다.');
  } catch (error) {
    $('save-error').textContent = error.message;
  } finally {
    busy = false;
    $('confirm-save').disabled = false;
    renderTiles();
  }
};
function renderList() {
  const query = $('map-search').value.trim().toLowerCase();
  const visible = savedMaps.filter((entry) => entry.name.toLowerCase().includes(query));
  $('saved-maps').replaceChildren();
  for (const entry of visible) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'saved-map';
    button.disabled = busy;
    const title = document.createElement('strong');
    title.textContent = entry.name;
    const subtitle = document.createElement('small');
    subtitle.textContent = `${entry.columns} × ${entry.rows} · 초안 v${entry.draftRevision} · ${entry.publishedRevision === null ? '미게시' : entry.enabled ? '노출 중' : '비노출'}${entry.publishedRevision !== null ? ` (게시 v${entry.publishedRevision})` : ''}`;
    button.append(title, subtitle);
    button.onclick = async () => {
      if (busy || !mayReplace()) return;
      busy = true;
      renderList();
      updateControls();
      let failure = '';
      try {
        const result = await api(`/api/admin/maps/${entry.id}/draft`);
        openMap(result.map, true);
        $('load-dialog').close();
        feedback('저장된 맵을 불러왔습니다.');
      } catch (error) {
        failure = error.message;
      } finally {
        busy = false;
        renderList();
        if (failure) $('load-status').textContent = failure;
        updateControls();
        if (map) renderTiles();
      }
    };
    $('saved-maps').append(button);
  }
  if (!visible.length)
    $('load-status').textContent = savedMaps.length
      ? '검색 조건에 맞는 맵이 없습니다.'
      : '저장된 맵이 없습니다.';
  else $('load-status').textContent = `${visible.length}개의 맵`;
}
$('map-search').oninput = renderList;
$('load-dialog').addEventListener('cancel', (event) => {
  if (busy) event.preventDefault();
});
$('open-maps').onclick = async () => {
  $('load-dialog').showModal();
  $('map-search').value = '';
  $('load-status').textContent = '목록을 불러오고 있습니다…';
  $('saved-maps').replaceChildren();
  busy = true;
  updateControls();
  try {
    savedMaps = (await api('/api/admin/maps')).maps;
    savedMaps.sort((a, b) => a.name.localeCompare(b.name));
    busy = false;
    renderList();
  } catch (error) {
    $('load-status').textContent = error.message;
  } finally {
    busy = false;
    updateControls();
  }
};
try {
  const session = await accountBar();
  if (!session.user || session.user.role !== 'admin') location.replace('/admin');
  else {
    await loadCoins();
    for (const value of COIN_VALUES) {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 64;
      drawCoinSample(canvas.getContext('2d'), value);
      coinImages.set(value, canvas.toDataURL());
    }
    if (map) renderTiles();
  }
} catch (error) {
  feedback(error.message, true);
}
