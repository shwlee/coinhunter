import { randomUUID } from 'node:crypto';
import { DEFAULT_MAP_SETTINGS } from './game/maps.js';
import { fail } from './persistence/errors.js';

export async function adminMapsRoute(request, response, url, user, maps, readJson, json) {
  const path = url.pathname;
  if (path !== '/api/admin/maps' && !path.startsWith('/api/admin/maps/')) return false;
  if (!user) throw fail(401, '로그인이 필요합니다.');
  if (user.role !== 'admin') throw fail(403, '관리자 권한이 필요합니다.');
  if (path === '/api/admin/maps' && request.method === 'GET') {
    const entries = maps.registry().filter((entry) => entry.source === 'custom');
    json(response, 200, {
      maps: entries.map((entry) => {
        const draft = maps.getDraft(entry.id);
        return {
          ...entry,
          name: draft.name,
          description: draft.description,
          columns: draft.columns,
          rows: draft.rows,
        };
      }),
    });
    return true;
  }
  const id = path.match(/^\/api\/admin\/maps\/([a-z0-9][a-z0-9-]{0,63})\/draft$/)?.[1];
  const draft = id ? maps.getDraft(id) : null;
  if (id && !draft) throw fail(404, '저장된 맵을 찾을 수 없습니다.');
  if (id && request.method === 'GET') {
    json(response, 200, { map: draft });
    return true;
  }
  if (
    (path === '/api/admin/maps' && request.method === 'POST') ||
    (id && request.method === 'PUT')
  ) {
    const input = await readJson(request);
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw fail(400, '맵 정보를 확인하세요.');
    if (id && (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1))
      throw fail(400, '맵의 저장 버전을 확인하세요.');
    const document = {
      id: id || `map-${randomUUID()}`,
      name: typeof input.name === 'string' ? input.name.trim() : input.name,
      description: input.description ?? '',
      columns: input.columns,
      rows: input.rows,
      tiles: input.tiles,
      settings: structuredClone(draft?.settings || DEFAULT_MAP_SETTINGS),
    };
    const saved = await maps.saveDraft(document, {
      expectedRevision: id ? input.expectedRevision : 0,
    });
    json(response, id ? 200 : 201, { map: saved });
    return true;
  }
  throw fail(404, '지원하지 않는 맵 관리 요청입니다.');
}
