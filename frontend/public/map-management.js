import { api, accountBar } from './account.js';
import { mapStatus } from './map-status.js';
import { installMapOptions } from './map-options.js';
const $ = (id) => document.getElementById(id);
let entries = [],
  busy = false,
  pending = null,
  copyPending = null,
  previews;
const cache = new Map();
const openOptions = installMapOptions(async (entry) => {
  try {
    await load();
    feedback(`“${entry.name}” 옵션을 초안으로 저장했습니다. 게시 버전 갱신 후 적용됩니다.`);
  } catch (error) {
    feedback(`옵션은 저장됐지만 목록 조회에 실패했습니다. ${error.message}`, true);
  }
});
const node = (tag, text, className) => {
  const element = document.createElement(tag);
  if (text) element.textContent = text;
  if (className) element.className = className;
  return element;
};
function feedback(message, error = false) {
  $('feedback').textContent = message;
  $('feedback').classList.toggle('error', error);
}
function matches(entry) {
  if (!entry.name.toLowerCase().includes($('search').value.trim().toLowerCase())) return false;
  switch ($('filter').value) {
    case 'draft':
      return entry.publishedRevision === null;
    case 'visible':
      return entry.publishedRevision !== null && entry.enabled;
    case 'hidden':
      return entry.publishedRevision !== null && !entry.enabled;
    case 'changed':
      return (
        entry.publishedRevision !== null &&
        entry.draftRevision !== undefined &&
        entry.draftRevision !== entry.publishedRevision
      );
    default:
      return true;
  }
}
function drawPreview(host, map) {
  const canvas = node('canvas');
  canvas.width = 180;
  canvas.height = 140;
  canvas.setAttribute('aria-label', `${map.columns} × ${map.rows} 맵 미리보기`);
  canvas.setAttribute('role', 'img');
  const ctx = canvas.getContext('2d'),
    size = Math.min(172 / map.columns, 132 / map.rows),
    left = (180 - size * map.columns) / 2,
    top = (140 - size * map.rows) / 2;
  map.tiles.forEach((tile, i) => {
    const x = left + (i % map.columns) * size,
      y = top + Math.floor(i / map.columns) * size;
    ctx.fillStyle = tile === -1 ? '#344b5e' : '#92a99d';
    ctx.fillRect(x, y, size, size);
    if (tile > 0) {
      ctx.fillStyle = {
        10: '#e4a06d',
        30: '#d8e8ff',
        100: '#ffd563',
        200: '#7edbff',
        500: '#c39aff',
      }[tile];
      ctx.beginPath();
      ctx.arc(x + size / 2, y + size / 2, size * 0.28, 0, Math.PI * 2);
      ctx.fill();
    }
  });
  host.replaceChildren(canvas);
}
async function preview(host) {
  const id = host.dataset.id,
    revision = host.dataset.revision,
    key = `${id}:${revision}`;
  try {
    let promise = cache.get(key);
    if (!promise) {
      promise = api(`/api/admin/maps/${id}/preview?revision=${revision}`);
      cache.set(key, promise);
    }
    const { map } = await promise;
    if (host.isConnected) drawPreview(host, map);
  } catch {
    cache.delete(key);
    if (host.isConnected) host.textContent = '미리보기 조회 실패';
  }
}
function render() {
  previews?.disconnect();
  previews = new IntersectionObserver(
    (items) => {
      for (const item of items)
        if (item.isIntersecting) {
          previews.unobserve(item.target);
          void preview(item.target);
        }
    },
    { rootMargin: '100px' },
  );
  $('maps').replaceChildren();
  const visible = entries.filter(matches);
  $('count').textContent = `전체 ${entries.length}개 · 표시 ${visible.length}개`;
  $('empty').hidden = visible.length !== 0;
  $('empty').textContent = entries.length
    ? '조건에 맞는 맵이 없습니다.'
    : '저장된 맵이 없습니다. 새 맵을 만들어보세요.';
  $('refresh').disabled = busy;
  $('maps').setAttribute('aria-busy', String(busy));
  for (const entry of visible) {
    const card = node('article', '', 'map-card');
    card.dataset.id = entry.id;
    card.dataset.source = entry.source;
    card.setAttribute('role', 'listitem');
    const thumb = node('div', '미리보기 준비 중…', 'map-preview');
    thumb.dataset.id = entry.id;
    thumb.dataset.revision = entry.draftRevision ?? entry.publishedRevision;
    const info = node('div', '', 'map-info');
    info.append(
      node('h2', entry.name),
      node('span', mapStatus(entry), 'map-status'),
      node(
        'p',
        `${entry.columns} × ${entry.rows} · 코인 ${entry.coins}개 / ${entry.score.toLocaleString()}점 · 벽 ${entry.walls}개`,
      ),
      node(
        'p',
        `${entry.source === 'sample' ? '기본 샘플' : `초안 v${entry.draftRevision}`} · ${entry.publishedRevision === null ? '게시 버전 없음' : `게시 v${entry.publishedRevision}`}`,
      ),
      node('p', `목록 순서 ${entries.indexOf(entry) + 1}`),
    );
    const controls = node('div', '', 'map-buttons');
    const options = node('button', entry.source === 'sample' ? '옵션 보기' : '게임 옵션');
    options.type = 'button';
    options.dataset.action = 'settings';
    options.disabled = busy;
    options.onclick = () => openOptions(entry);
    controls.append(options);
    const copy = node('button', entry.source === 'sample' ? '샘플 복사' : '복제');
    copy.type = 'button';
    copy.dataset.action = 'copy';
    copy.disabled = busy;
    copy.onclick = () => openCopy(entry);
    controls.append(copy);
    const ordering = node('div', '', 'map-order-actions');
    for (const [direction, label, offset] of [
      ['up', '위로', -1],
      ['down', '아래로', 1],
    ]) {
      const move = node('button', offset === -1 ? '↑' : '↓');
      move.type = 'button';
      move.dataset.action = direction;
      move.setAttribute('aria-label', `${entry.name} 순서 ${label}`);
      const filtered = $('search').value.trim() || $('filter').value !== 'all';
      move.title = filtered
        ? '검색·필터를 해제한 전체 목록에서 순서를 조정하세요.'
        : `목록 순서 ${label}`;
      const index = entries.indexOf(entry);
      move.disabled = busy || !!filtered || index + offset < 0 || index + offset >= entries.length;
      move.onclick = () => void moveMap(entry, offset);
      ordering.append(move);
    }
    controls.append(ordering);
    if (entry.source === 'sample') controls.append(node('p', '원본 편집은 복사 후 가능합니다.'));
    else {
      const edit = node('a', '편집');
      edit.href = `/admin/maps/editor?mapId=${encodeURIComponent(entry.id)}`;
      controls.append(edit);
      for (const action of ['publish', 'visibility']) {
        if (action === 'publish' && entry.draftRevision === entry.publishedRevision) continue;
        if (action === 'visibility' && entry.publishedRevision === null) continue;
        const button = node(
          'button',
          action === 'publish'
            ? entry.publishedRevision === null
              ? '게시'
              : '게시 버전 갱신'
            : entry.enabled
              ? '숨기기'
              : '다시 노출',
        );
        button.type = 'button';
        button.dataset.action = action;
        button.disabled = busy;
        button.onclick = () => confirmAction(entry, action);
        controls.append(button);
      }
    }
    card.append(thumb, info, controls);
    $('maps').append(card);
    previews.observe(thumb);
  }
}
async function load() {
  entries = (await api('/api/admin/maps?includeSamples=1')).maps;
  render();
}
const normalizedName = (name) => name.trim().normalize('NFC').toLowerCase();
function suggestedCopyName(entry) {
  const names = new Set(entries.map((item) => normalizedName(item.name)));
  for (let number = 1; ; number++) {
    const suffix = number === 1 ? ' 복사본' : ` 복사본 (${number})`;
    const name = entry.name.slice(0, 100 - suffix.length) + suffix;
    if (!names.has(normalizedName(name))) return name;
  }
}
function openCopy(entry) {
  if (busy) return;
  copyPending = entry;
  $('copy-title').textContent = entry.source === 'sample' ? '기본 샘플 복사' : '맵 복제';
  $('copy-description').textContent =
    `“${entry.name}”의 ${entry.source === 'sample' ? '기본 샘플' : '최신 초안'} 배치와 옵션을 새 맵으로 복사합니다. 원본과 게시 상태는 유지되며 복사본은 미게시 초안입니다.`;
  $('copy-name').value = suggestedCopyName(entry);
  $('copy-error').textContent = '';
  $('confirm-copy').disabled = false;
  $('copy-dialog').showModal();
}
$('cancel-copy').onclick = () => {
  if (!busy) $('copy-dialog').close();
};
$('copy-dialog').addEventListener('cancel', (event) => {
  if (busy) event.preventDefault();
});
$('copy-name').oninput = () => {
  $('copy-error').textContent = '';
};
$('copy-form').onsubmit = async (event) => {
  event.preventDefault();
  if (busy || !copyPending) return;
  const name = $('copy-name').value.trim();
  if (!name) {
    $('copy-error').textContent = '새 맵 이름을 입력하세요.';
    return;
  }
  if (entries.some((entry) => normalizedName(entry.name) === normalizedName(name))) {
    $('copy-error').textContent = '이미 사용 중인 맵 이름입니다. 다른 이름을 입력하세요.';
    $('copy-name').focus();
    return;
  }
  busy = true;
  $('confirm-copy').disabled = $('cancel-copy').disabled = true;
  $('copy-error').textContent = '';
  render();
  let saved = false;
  try {
    await api(`/api/admin/maps/${copyPending.id}/copy`, {
      method: 'POST',
      body: JSON.stringify({
        name,
        sourceRevision: copyPending.draftRevision ?? copyPending.publishedRevision,
      }),
    });
    saved = true;
    copyPending = null;
    $('copy-dialog').close();
    $('search').value = '';
    $('filter').value = 'all';
    await load();
    feedback(`“${name}”을 새 초안으로 만들었습니다. 편집 후 게시할 수 있습니다.`);
  } catch (error) {
    if (saved) feedback(`복사본은 저장됐지만 목록 조회에 실패했습니다. ${error.message}`, true);
    else $('copy-error').textContent = error.message;
  } finally {
    busy = false;
    $('confirm-copy').disabled = !copyPending;
    $('cancel-copy').disabled = false;
    render();
  }
};
async function moveMap(entry, offset) {
  if (busy || $('search').value.trim() || $('filter').value !== 'all') return;
  const index = entries.indexOf(entry),
    next = index + offset;
  if (index < 0 || next < 0 || next >= entries.length) return;
  const expectedIds = entries.map((item) => item.id),
    ids = [...expectedIds];
  [ids[index], ids[next]] = [ids[next], ids[index]];
  busy = true;
  render();
  let saved = false;
  try {
    await api('/api/admin/maps/order', {
      method: 'PUT',
      body: JSON.stringify({ ids, expectedIds }),
    });
    saved = true;
    await load();
    feedback('맵 표시 순서를 저장했습니다. 사용자 맵 선택 목록에 바로 적용됩니다.');
  } catch (error) {
    await load().catch(() => {});
    feedback(
      `${saved ? '순서는 저장됐지만 목록 조회에 실패했습니다. ' : ''}${error.message}`,
      true,
    );
  } finally {
    busy = false;
    render();
  }
}
function confirmAction(entry, action) {
  if (busy) return;
  pending = { entry, action };
  $('confirm').disabled = false;
  $('confirm-title').textContent =
    action === 'publish'
      ? entry.publishedRevision === null
        ? '맵 게시'
        : '게시 버전 갱신'
      : entry.enabled
        ? '맵 숨기기'
        : '맵 다시 노출';
  $('confirm-description').textContent =
    action === 'publish'
      ? `“${entry.name}”의 저장된 초안 v${entry.draftRevision}을 게시합니다. ${entry.publishedRevision === null || entry.enabled ? '사용자 맵 목록에 노출됩니다.' : '비노출 상태를 유지합니다.'}`
      : entry.enabled
        ? `“${entry.name}”를 사용자 맵 목록에서 숨깁니다. 저장된 버전과 진행 중 경기는 유지됩니다.`
        : `“${entry.name}”의 기존 게시 v${entry.publishedRevision}을 다시 노출합니다. 미게시 수정본은 적용하지 않습니다.`;
  $('action-error').textContent = '';
  $('confirm-dialog').showModal();
}
$('cancel').onclick = () => {
  if (!busy) $('confirm-dialog').close();
};
$('confirm-dialog').addEventListener('cancel', (event) => {
  if (busy) event.preventDefault();
});
$('confirm').onclick = async () => {
  if (busy || !pending) return;
  const { entry, action } = pending;
  busy = true;
  $('confirm').disabled = $('cancel').disabled = true;
  render();
  const expected = {
    draftRevision: entry.draftRevision,
    publishedRevision: entry.publishedRevision,
    enabled: entry.enabled,
  };
  let changed = false;
  try {
    await api(`/api/admin/maps/${entry.id}/${action}`, {
      method: action === 'publish' ? 'POST' : 'PUT',
      body: JSON.stringify({
        expected,
        ...(action === 'publish' ? { revision: entry.draftRevision } : { enabled: !entry.enabled }),
      }),
    });
    changed = true;
    $('confirm-dialog').close();
    await load();
    feedback(`“${entry.name}” 맵 설정을 변경했습니다.`);
  } catch (error) {
    if (changed)
      feedback(
        `변경은 저장됐으나 목록을 불러오지 못했습니다. 새로고침해주세요. ${error.message}`,
        true,
      );
    else {
      await load().catch(() => {});
      $('action-error').textContent = `${error.message} 목록을 확인한 뒤 다시 실행하세요.`;
      pending = null;
    }
  } finally {
    busy = false;
    $('confirm').disabled = !pending;
    $('cancel').disabled = false;
    render();
  }
};
$('refresh').onclick = async () => {
  if (busy) return;
  busy = true;
  render();
  try {
    await load();
    feedback('맵 목록을 새로고침했습니다.');
  } catch (error) {
    feedback(error.message, true);
  } finally {
    busy = false;
    render();
  }
};
$('search').oninput = $('filter').onchange = render;
try {
  const session = await accountBar();
  if (!session.user || session.user.role !== 'admin') location.replace('/admin');
  else {
    busy = true;
    render();
    try {
      await load();
    } finally {
      busy = false;
      render();
    }
  }
} catch (error) {
  feedback(error.message, true);
}
