import { randomUUID } from 'node:crypto';
import {
  DEFAULT_MAP_SETTINGS,
  MAP_SETTING_LIMITS,
  DEFAULT_HURRY_UP_REMOVAL_INTERVAL_MS,
  validateMapDocument,
} from './game/maps.js';
import { fail } from './persistence/errors.js';

function checkSettings(settings) {
  const allowed = [...Object.keys(MAP_SETTING_LIMITS), 'hurryUpRemovalIntervalMs'];
  if (!settings || typeof settings !== 'object' || Array.isArray(settings))
    throw fail(400, '맵 옵션을 확인하세요.');
  if (Object.keys(settings).some((key) => !allowed.includes(key)))
    throw fail(400, '지원하지 않는 맵 옵션입니다.');
}

export async function adminMapsRoute(request, response, url, user, maps, readJson, json) {
  const path = url.pathname;
  if (path !== '/api/admin/maps' && !path.startsWith('/api/admin/maps/')) return false;
  if (!user) throw fail(401, '로그인이 필요합니다.');
  if (user.role !== 'admin') throw fail(403, '관리자 권한이 필요합니다.');
  if (path === '/api/admin/maps/default-settings' && request.method === 'GET') {
    json(response, 200, { settings: DEFAULT_MAP_SETTINGS, limits: MAP_SETTING_LIMITS });
    return true;
  }
  if (path === '/api/admin/maps/order' && request.method === 'PUT') {
    const input = await readJson(request);
    await maps.reorder(input?.ids, input?.expectedIds);
    json(response, 200, { ok: true });
    return true;
  }
  const copyId = path.match(/^\/api\/admin\/maps\/([a-z0-9][a-z0-9-]{0,63})\/copy$/)?.[1];
  if (copyId && request.method === 'POST') {
    const input = await readJson(request);
    const map = await maps.copy(copyId, input?.name, input?.sourceRevision);
    json(response, 201, { map, state: maps.registry().find((entry) => entry.id === map.id) });
    return true;
  }
  if (path === '/api/admin/maps/validate-json' && request.method === 'POST') {
    const input = await readJson(request);
    try {
      checkSettings(input?.settings);
      validateMapDocument(input, { published: false });
    } catch (error) {
      throw fail(400, error.message);
    }
    // Transfer map content only; visibility and publication are managed separately.
    json(response, 200, {
      map: {
        schemaVersion: 1,
        id: input.id,
        revision: input.revision,
        name: input.name.trim(),
        description: input.description,
        columns: input.columns,
        rows: input.rows,
        tiles: input.tiles,
        settings: input.settings,
      },
    });
    return true;
  }
  if (path === '/api/admin/maps' && request.method === 'GET') {
    const entries = maps
      .registry()
      .filter(
        (entry) => entry.source === 'custom' || url.searchParams.get('includeSamples') === '1',
      );
    json(response, 200, {
      maps: entries.map((entry) => {
        const draft = maps.read(entry, entry.draftRevision ?? entry.publishedRevision, false);
        return {
          ...entry,
          name: draft.name,
          description: draft.description,
          columns: draft.columns,
          rows: draft.rows,
          coins: draft.tiles.filter((tile) => tile > 0).length,
          score: draft.tiles.reduce((sum, tile) => sum + Math.max(0, tile), 0),
          walls: draft.tiles.filter((tile) => tile === -1).length,
        };
      }),
    });
    return true;
  }
  const settingsId = path.match(/^\/api\/admin\/maps\/([a-z0-9][a-z0-9-]{0,63})\/settings$/)?.[1];
  if (settingsId) {
    const entry = maps.registry().find((item) => item.id === settingsId);
    if (!entry) throw fail(404, '맵을 찾을 수 없습니다.');
    const draft = maps.read(entry, entry.draftRevision ?? entry.publishedRevision, false);
    const result = (document) => ({
      map: {
        id: document.id,
        name: document.name,
        revision: document.revision,
        settings: {
          ...document.settings,
          hurryUpRemovalIntervalMs: {
            ...DEFAULT_HURRY_UP_REMOVAL_INTERVAL_MS,
            ...document.settings.hurryUpRemovalIntervalMs,
          },
        },
      },
      state: maps.registry().find((item) => item.id === settingsId),
      limits: MAP_SETTING_LIMITS,
    });
    if (request.method === 'GET') {
      json(response, 200, result(draft));
      return true;
    }
    if (request.method === 'PUT') {
      if (entry.source === 'sample') throw fail(403, '기본 샘플은 읽기 전용입니다.');
      const input = await readJson(request);
      if (
        !input ||
        !Number.isSafeInteger(input.expectedRevision) ||
        input.expectedRevision < 1 ||
        !input.settings ||
        typeof input.settings !== 'object' ||
        Array.isArray(input.settings)
      )
        throw fail(400, '맵 옵션과 이전 저장 버전을 확인하세요.');
      checkSettings(input.settings);
      const saved = await maps.saveDraft(
        { ...draft, settings: structuredClone(input.settings) },
        { expectedRevision: input.expectedRevision },
      );
      json(response, 200, result(saved));
      return true;
    }
    throw fail(404, '지원하지 않는 맵 옵션 요청입니다.');
  }
  const action = path.match(
    /^\/api\/admin\/maps\/([a-z0-9][a-z0-9-]{0,63})\/(preview|publish|visibility)$/,
  );
  if (action) {
    const [, mapId, operation] = action;
    const entry = maps.registry().find((item) => item.id === mapId);
    if (!entry) throw fail(404, '맵을 찾을 수 없습니다.');
    if (operation === 'preview' && request.method === 'GET') {
      const revision = Number(url.searchParams.get('revision'));
      if (
        !Number.isSafeInteger(revision) ||
        revision < 1 ||
        revision > (entry.draftRevision ?? entry.publishedRevision) ||
        (entry.source === 'sample' && revision !== entry.publishedRevision)
      )
        throw fail(400, '미리보기 버전을 확인하세요.');
      const document = maps.read(entry, revision, false);
      json(response, 200, {
        map: {
          id: document.id,
          revision: document.revision,
          columns: document.columns,
          rows: document.rows,
          tiles: document.tiles,
        },
      });
      return true;
    }
    if (
      (operation === 'publish' && request.method === 'POST') ||
      (operation === 'visibility' && request.method === 'PUT')
    ) {
      if (entry.source === 'sample') throw fail(403, '기본 샘플은 읽기 전용입니다.');
      const input = await readJson(request);
      if (!input || typeof input !== 'object' || !Object.hasOwn(input, 'expected'))
        throw fail(400, '맵의 이전 상태가 필요합니다.');
      if (operation === 'publish') await maps.publish(mapId, input.revision, input.expected);
      else await maps.setEnabled(mapId, input.enabled, undefined, input.expected);
      json(response, 200, { state: maps.registry().find((item) => item.id === mapId) });
      return true;
    }
    throw fail(404, '지원하지 않는 맵 관리 요청입니다.');
  }
  const id = path.match(/^\/api\/admin\/maps\/([a-z0-9][a-z0-9-]{0,63})\/draft$/)?.[1];
  const draft = id ? maps.getDraft(id) : null;
  if (id && !draft) throw fail(404, '저장된 맵을 찾을 수 없습니다.');
  if (id && request.method === 'GET') {
    json(response, 200, { map: draft, state: maps.registry().find((entry) => entry.id === id) });
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
    if (Object.hasOwn(input, 'settings')) checkSettings(input.settings);
    const document = {
      id: id || `map-${randomUUID()}`,
      name: typeof input.name === 'string' ? input.name.trim() : input.name,
      description: input.description ?? '',
      columns: input.columns,
      rows: input.rows,
      tiles: input.tiles,
      settings: structuredClone(input.settings ?? draft?.settings ?? DEFAULT_MAP_SETTINGS),
    };
    const saved = await maps.saveDraft(document, {
      expectedRevision: id ? input.expectedRevision : 0,
    });
    json(response, id ? 200 : 201, {
      map: saved,
      state: maps.registry().find((entry) => entry.id === saved.id),
    });
    return true;
  }
  throw fail(404, '지원하지 않는 맵 관리 요청입니다.');
}
