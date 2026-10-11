import { randomUUID } from 'node:crypto';
import { AiJsonStore, assertScope, identifier } from './storage.js';
import { validateConnectionMetadata, validModelId } from './contracts.js';
import { fail } from '../persistence/errors.js';

const missing = () => fail(404, 'AI 연결을 찾을 수 없습니다.');
const clone = (item) => structuredClone(item);
export class FileAiConnectionRepository {
  #temporary = new Map();
  #selections = new Map();
  constructor({
    file = 'data/ai/connections.json',
    guard = () => {},
    now = () => new Date().toISOString(),
    maxConnectionsPerUser = 20,
  } = {}) {
    this.store = new AiJsonStore(file);
    this.guard = guard;
    this.now = now;
    this.maxConnectionsPerUser = maxConnectionsPerUser;
  }
  #scope(scope) {
    assertScope(scope);
    this.guard(scope);
  }
  #transaction(scope, operation, write = false) {
    this.#scope(scope);
    const commits = [];
    return this.store
      .transaction((data) => operation(data, (commit) => commits.push(commit)), {
        write,
        guard: () => this.#scope(scope),
      })
      .then((result) => {
        if (commits.length) this.#scope(scope);
        for (const commit of commits) commit();
        return result;
      });
  }
  #find(data, scope, id) {
    const item = this.#temporary.get(id) || data.connections.find((c) => c.id === id);
    if (
      !item ||
      item.ownerId !== scope.ownerId ||
      (item.credentialMode === 'session' && item.sessionId !== scope.sessionId)
    )
      throw missing();
    return item;
  }
  list(scope) {
    return this.#transaction(scope, (data) =>
      clone(
        [...data.connections, ...this.#temporary.values()].filter(
          (item) =>
            item.ownerId === scope.ownerId &&
            (item.credentialMode === 'stored' || item.sessionId === scope.sessionId),
        ),
      ),
    );
  }
  get(scope, id) {
    return this.#transaction(scope, (data) => clone(this.#find(data, scope, id)));
  }
  create(scope, input) {
    const { credentialRef, checkStatus = 'unchecked', checkedAt = null, ...metadata } = input;
    if (
      !['unchecked', 'ready'].includes(checkStatus) ||
      (checkStatus === 'ready' && !Number.isFinite(Date.parse(checkedAt)))
    )
      throw fail(400, 'AI 확인 상태를 확인하세요.');
    const validated = validateConnectionMetadata(metadata);
    if (!identifier(credentialRef)) throw fail(400, 'AI 자격 증명 참조를 확인하세요.');
    return this.#transaction(
      scope,
      (data, commit) => {
        if (
          [...data.connections, ...this.#temporary.values()].filter(
            (item) => item.ownerId === scope.ownerId,
          ).length >= this.maxConnectionsPerUser
        )
          throw fail(429, '계정의 AI 연결 수 한도에 도달했습니다. 기존 연결을 정리하세요.');
        const time = this.now();
        const item = {
          id: randomUUID(),
          ownerId: scope.ownerId,
          ...validated,
          credentialRef,
          revision: 1,
          createdAt: time,
          updatedAt: time,
          checkStatus,
          checkedAt,
        };
        if (item.credentialMode === 'session') {
          item.sessionId = scope.sessionId;
          commit(() => this.#temporary.set(item.id, item));
        } else data.connections.push(item);
        return clone(item);
      },
      validated.credentialMode === 'stored',
    );
  }
  update(scope, id, revision, input) {
    // Internal API: mode/provider are immutable; replacing either creates a new connection.
    const allowed = ['name', 'defaultModelId', 'credentialRef', 'checkStatus', 'checkedAt'];
    if (
      !input ||
      Object.keys(input).some((key) => !allowed.includes(key)) ||
      (input.credentialRef !== undefined && !identifier(input.credentialRef)) ||
      (input.checkStatus !== undefined &&
        !['unchecked', 'ready', 'credential_invalid', 'network_error', 'unavailable'].includes(
          input.checkStatus,
        )) ||
      (input.checkedAt !== undefined &&
        input.checkedAt !== null &&
        (typeof input.checkedAt !== 'string' || !Number.isFinite(Date.parse(input.checkedAt))))
    )
      throw fail(400, 'AI 연결 변경 입력을 확인하세요.');
    return this.#transaction(
      scope,
      (data, commit) => {
        const item = this.#find(data, scope, id);
        if (!Number.isSafeInteger(revision) || item.revision !== revision)
          throw fail(409, 'AI 연결이 변경되었습니다. 다시 불러오세요.');
        const validated = validateConnectionMetadata({
          name: input.name ?? item.name,
          provider: item.provider,
          credentialMode: item.credentialMode,
          defaultModelId: Object.hasOwn(input, 'defaultModelId')
            ? input.defaultModelId
            : item.defaultModelId,
        });
        const next = {
          ...item,
          name: validated.name,
          defaultModelId: validated.defaultModelId,
          ...input,
          revision: item.revision + 1,
          updatedAt: this.now(),
        };
        next.name = validated.name;
        if (input.credentialRef && input.credentialRef !== item.credentialRef) {
          next.defaultModelId = null;
          data.preferences = data.preferences.filter((selection) => selection.connectionId !== id);
          commit(() => {
            for (const [session, selection] of this.#selections)
              if (selection.connectionId === id) this.#selections.delete(session);
          });
        }
        if (
          input.credentialRef &&
          input.credentialRef !== item.credentialRef &&
          !input.checkStatus
        ) {
          next.checkStatus = 'unchecked';
          next.checkedAt = null;
        }
        if (item.credentialMode === 'session') commit(() => this.#temporary.set(id, next));
        else data.connections[data.connections.indexOf(item)] = next;
        return clone(next);
      },
      true,
    );
  }
  delete(scope, id, revision) {
    return this.#transaction(
      scope,
      (data, commit) => {
        const item = this.#find(data, scope, id);
        if (item.revision !== revision)
          throw fail(409, 'AI 연결이 변경되었습니다. 다시 불러오세요.');
        if (item.credentialMode === 'session') commit(() => this.#temporary.delete(id));
        else data.connections = data.connections.filter((c) => c.id !== id);
        data.preferences = data.preferences.filter((p) => p.connectionId !== id);
        commit(() => {
          for (const [session, selection] of this.#selections)
            if (selection.connectionId === id) this.#selections.delete(session);
        });
      },
      true,
    );
  }
  preference(scope) {
    return this.#transaction(scope, (data, commit) => {
      const selection =
        this.#selections.get(scope.sessionId) ||
        data.preferences.find((p) => p.ownerId === scope.ownerId);
      if (!selection) return { connectionId: null, modelId: null };
      this.#find(data, scope, selection.connectionId);
      return { connectionId: selection.connectionId, modelId: selection.modelId };
    });
  }
  setPreference(scope, selection, revision) {
    if (
      !selection ||
      Object.keys(selection).some((key) => !['connectionId', 'modelId'].includes(key))
    )
      throw fail(400, 'AI 선택 정보를 확인하세요.');
    return this.#transaction(
      scope,
      (data, commit) => {
        if (selection.connectionId === null && selection.modelId === null) {
          commit(() => this.#selections.delete(scope.sessionId));
          data.preferences = data.preferences.filter((p) => p.ownerId !== scope.ownerId);
          return;
        }
        if (!validModelId(selection.modelId)) throw fail(400, 'AI 모델을 선택하세요.');
        const item = this.#find(data, scope, selection.connectionId);
        if (revision !== undefined && item.revision !== revision)
          throw fail(409, 'AI 연결이 변경되었습니다. 모델을 다시 선택하세요.');
        if (item.credentialMode === 'session')
          commit(() =>
            this.#selections.set(scope.sessionId, { ...selection, ownerId: scope.ownerId }),
          );
        else {
          commit(() => this.#selections.delete(scope.sessionId));
          data.preferences = data.preferences.filter((p) => p.ownerId !== scope.ownerId);
          data.preferences.push({ ...selection, ownerId: scope.ownerId });
        }
      },
      true,
    );
  }
  deleteSession(sessionId) {
    for (const [id, item] of this.#temporary)
      if (item.sessionId === sessionId) this.#temporary.delete(id);
    this.#selections.delete(sessionId);
  }
  deleteOwner(ownerId) {
    if (!identifier(ownerId)) throw missing();
    return this.store
      .transaction(
        (data) => {
          data.connections = data.connections.filter((c) => c.ownerId !== ownerId);
          data.preferences = data.preferences.filter((p) => p.ownerId !== ownerId);
        },
        { write: true },
      )
      .then(() => {
        for (const [id, item] of this.#temporary)
          if (item.ownerId === ownerId) this.#temporary.delete(id);
        for (const [session, item] of this.#selections)
          if (item.ownerId === ownerId) this.#selections.delete(session);
      });
  }
  clear() {
    this.#temporary.clear();
    this.#selections.clear();
  }
}
