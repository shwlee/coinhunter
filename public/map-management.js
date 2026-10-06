import { api, accountBar } from './account.js';
import { mapStatus } from './map-status.js';
const $ = (id) => document.getElementById(id);
let entries = [],
  busy = false,
  pending = null,
  previews;
const cache = new Map();
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
    );
    const controls = node('div', '', 'map-buttons');
    if (entry.source === 'sample') controls.append(node('p', '기본 샘플 · 읽기 전용'));
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
