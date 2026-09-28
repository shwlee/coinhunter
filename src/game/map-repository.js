import { readFileSync } from 'node:fs';
import { mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { validateMapDocument } from './maps.js';

const sampleRoot = fileURLToPath(new URL('../../maps/', import.meta.url));
const dataRoot = fileURLToPath(new URL('../../data/maps/', import.meta.url));
const validId = (id) => typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(id);
const validRevision = (revision) => Number.isSafeInteger(revision) && revision > 0;

function readRegistry(path, optional = false) {
  let registry;
  try {
    registry = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if (optional && error.code === 'ENOENT') return { schemaVersion: 1, maps: [] };
    throw error;
  }
  if (registry.schemaVersion !== 1 || !Array.isArray(registry.maps))
    throw new Error('잘못된 맵 등록 파일');
  const ids = new Set();
  for (const entry of registry.maps) {
    if (
      !validId(entry.id) ||
      ids.has(entry.id) ||
      typeof entry.enabled !== 'boolean' ||
      !Number.isSafeInteger(entry.order) ||
      (entry.publishedRevision !== null && !validRevision(entry.publishedRevision)) ||
      (entry.draftRevision !== undefined && !validRevision(entry.draftRevision))
    )
      throw new Error('잘못된 맵 등록 정보');
    ids.add(entry.id);
  }
  return registry;
}

async function atomicJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

// One repository instance per host serializes writes. Files remain the source of truth.
export class MapRepository {
  constructor({
    samplesDirectory = sampleRoot,
    dataDirectory = process.env.COINHUNTER_MAP_DIR || dataRoot,
  } = {}) {
    this.samplesDirectory = resolve(samplesDirectory);
    this.dataDirectory = resolve(dataDirectory);
    this.pending = Promise.resolve();
  }
  registry() {
    const samples = readRegistry(join(this.samplesDirectory, 'registry.json')).maps.map(
      (entry) => ({ ...entry, source: 'sample' }),
    );
    const custom = readRegistry(join(this.dataDirectory, 'registry.json'), true).maps.map(
      (entry) => ({ ...entry, source: 'custom' }),
    );
    const entries = [...samples, ...custom];
    if (new Set(entries.map((entry) => entry.id)).size !== entries.length)
      throw new Error('중복된 맵 ID');
    return entries.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  }
  read(entry, revision, published = true) {
    if (!validId(entry.id) || !validRevision(revision)) throw new Error('잘못된 맵 ID 또는 버전');
    const path =
      entry.source === 'sample'
        ? join(this.samplesDirectory, 'samples', `${entry.id}.json`)
        : join(this.dataDirectory, entry.id, `${revision}.json`);
    const map = JSON.parse(readFileSync(path, 'utf8'));
    validateMapDocument(map, { published });
    if (map.id !== entry.id || map.revision !== revision)
      throw new Error('맵 등록 정보와 파일이 일치하지 않습니다.');
    return map;
  }
  listPublished() {
    return this.registry()
      .filter((entry) => entry.enabled && entry.publishedRevision !== null)
      .map((entry) => this.read(entry, entry.publishedRevision));
  }
  getPublished(id) {
    const entry = this.registry().find(
      (entry) => entry.id === id && entry.enabled && entry.publishedRevision !== null,
    );
    return entry ? this.read(entry, entry.publishedRevision) : null;
  }
  getDraft(id) {
    const entry = this.registry().find((entry) => entry.id === id && entry.source === 'custom');
    return entry?.draftRevision ? this.read(entry, entry.draftRevision, false) : null;
  }
  change(operation) {
    const result = this.pending.then(operation);
    this.pending = result.catch(() => {});
    return result;
  }
  saveDraft(document, { expectedRevision = 0 } = {}) {
    const input = structuredClone(document);
    return this.change(async () => {
      if (!validId(input.id)) throw new Error('잘못된 맵 ID');
      const existing = this.registry().find((entry) => entry.id === input.id);
      if (existing?.source === 'sample') throw new Error('샘플맵은 새 ID로 복사해서 편집하세요.');
      const latest = existing?.draftRevision ?? 0;
      if (expectedRevision !== latest)
        throw new Error('맵이 변경되었습니다. 최신 버전을 다시 불러오세요.');
      const revision = latest + 1;
      const map = { ...input, schemaVersion: 1, revision };
      validateMapDocument(map, { published: false });
      const directory = join(this.dataDirectory, map.id);
      await mkdir(directory, { recursive: true });
      // Orphan revisions after an interrupted registry update are safe to replace:
      // no published/draft pointer references them yet.
      await atomicJson(join(directory, `${revision}.json`), map);
      const registry = readRegistry(join(this.dataDirectory, 'registry.json'), true);
      const entry = registry.maps.find((entry) => entry.id === map.id);
      if (entry) entry.draftRevision = revision;
      else
        registry.maps.push({
          id: map.id,
          draftRevision: revision,
          publishedRevision: null,
          enabled: false,
          order: registry.maps.length + 1,
        });
      await atomicJson(join(this.dataDirectory, 'registry.json'), registry);
      return map;
    });
  }
  publish(id, revision) {
    return this.change(async () => {
      const entry = this.registry().find((entry) => entry.id === id && entry.source === 'custom');
      if (!entry || entry.draftRevision !== revision)
        throw new Error('최신 임시 저장 버전만 게시할 수 있습니다.');
      this.read(entry, revision);
      const registry = readRegistry(join(this.dataDirectory, 'registry.json'));
      Object.assign(
        registry.maps.find((entry) => entry.id === id),
        { publishedRevision: revision, enabled: true },
      );
      await atomicJson(join(this.dataDirectory, 'registry.json'), registry);
    });
  }
  setEnabled(id, enabled, order) {
    return this.change(async () => {
      if (typeof enabled !== 'boolean' || (order !== undefined && !Number.isSafeInteger(order)))
        throw new Error('잘못된 표시 설정');
      const registry = readRegistry(join(this.dataDirectory, 'registry.json'));
      const entry = registry.maps.find((entry) => entry.id === id);
      if (!entry || (enabled && entry.publishedRevision === null))
        throw new Error('게시된 사용자 맵을 선택하세요.');
      entry.enabled = enabled;
      if (order !== undefined) entry.order = order;
      await atomicJson(join(this.dataDirectory, 'registry.json'), registry);
    });
  }
}

export const mapRepository = new MapRepository();
export const MAPS = mapRepository.listPublished();
