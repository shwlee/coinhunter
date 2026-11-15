import { resolve, join } from 'node:path';
import { FileCredentialStore } from './credential-store.js';
import { FileAiConnectionRepository } from './connection-repository.js';
import { validateConnectionMetadata, publicConnection } from './contracts.js';
import { assertScope } from './storage.js';
import { fail } from '../persistence/errors.js';

// No provider transport in stage 2. API layer must obtain scope from authentication.scope().
export function createAiStorage({
  sessions,
  config,
  env = process.env,
  repository,
  credentials,
  beforeConnectionChange = async () => {},
} = {}) {
  let closed = false;
  const guard = (scope) => {
    assertScope(scope);
    if (closed || !sessions.isActive(scope)) throw fail(401, '로그인 세션이 만료되었습니다.');
  };
  const directory = resolve(env.AI_DATA_DIR || 'data/ai');
  const vault =
    credentials ||
    new FileCredentialStore({
      directory: join(directory, 'credentials'),
      key: env.AI_CREDENTIAL_KEY,
      keyId: env.AI_CREDENTIAL_KEY_ID,
      allowStored: config.allowStoredCredentials,
      guard,
    });
  const connections =
    repository ||
    new FileAiConnectionRepository({
      file: join(directory, 'connections.json'),
      guard,
      maxConnectionsPerUser: config.maxConnectionsPerUser,
    });
  const detach = sessions.onRemoved(({ sessionId }) => {
    connections.deleteSession(sessionId);
    vault.deleteSession(sessionId);
  });
  let queue = Promise.resolve();
  const mutate = (scope, operation) => {
    const job = queue.then(() => {
      guard(scope);
      return operation();
    });
    queue = job.catch(() => {});
    return job;
  };
  const clean = async (ownerId, reference) => {
    try {
      await vault.discard(ownerId, reference);
    } catch {
      throw fail(503, 'AI 비밀 파일 정리가 필요합니다. 운영자에게 문의하세요.');
    }
  };
  return {
    storedAvailable: vault.storedAvailable,
    async list(scope) {
      guard(scope);
      return (await connections.list(scope)).map(publicConnection);
    },
    async get(scope, id) {
      guard(scope);
      return publicConnection(await connections.get(scope, id));
    },
    create(scope, metadata, secret, verification = {}) {
      const input = validateConnectionMetadata(metadata);
      if (!config.allowedProviders.includes(input.provider))
        throw fail(403, '허용되지 않은 AI 제공자입니다.');
      return mutate(scope, async () => {
        const reference = await vault.put(scope, input.credentialMode, secret);
        try {
          return publicConnection(
            await connections.create(scope, {
              ...input,
              credentialRef: reference,
              ...verification,
            }),
          );
        } catch (error) {
          await clean(scope.ownerId, reference);
          throw error;
        }
      });
    },
    update(scope, id, revision, input) {
      if (!input || Object.keys(input).some((key) => !['name', 'defaultModelId'].includes(key)))
        throw fail(400, 'AI 연결 변경 입력을 확인하세요.');
      return mutate(scope, async () => {
        const previous = await connections.get(scope, id);
        if (previous.revision !== revision) throw fail(409, 'AI 연결이 변경되었습니다.');
        const validated = validateConnectionMetadata({
          name: Object.hasOwn(input, 'name') ? input.name : previous.name,
          provider: previous.provider,
          credentialMode: previous.credentialMode,
          defaultModelId: Object.hasOwn(input, 'defaultModelId')
            ? input.defaultModelId
            : previous.defaultModelId,
        });
        await beforeConnectionChange(id);
        const changes = Object.fromEntries(Object.keys(input).map((key) => [key, validated[key]]));
        return publicConnection(await connections.update(scope, id, revision, changes));
      });
    },
    replaceCredential(scope, id, revision, secret, check = async () => {}, verification = {}) {
      return mutate(scope, async () => {
        const previous = await connections.get(scope, id);
        if (previous.revision !== revision) throw fail(409, 'AI 연결이 변경되었습니다.');
        const reference = await vault.put(scope, previous.credentialMode, secret);
        let next;
        try {
          // Step 3 supplies provider validation here; it runs outside the file lock.
          await check(await vault.resolve(scope, reference), previous.provider);
          guard(scope);
          await beforeConnectionChange(id);
          next = await connections.update(scope, id, revision, {
            credentialRef: reference,
            ...verification,
          });
        } catch (error) {
          await clean(scope.ownerId, reference);
          throw error;
        }
        // A cleanup failure after commit must not be reported as a failed key replacement.
        await clean(scope.ownerId, previous.credentialRef).catch(() => {
          console.error('AI 이전 비밀 파일 정리 실패. 운영자 점검이 필요합니다.');
        });
        return publicConnection(next);
      });
    },
    delete(scope, id, revision) {
      return mutate(scope, async () => {
        const previous = await connections.get(scope, id);
        if (previous.revision !== revision) throw fail(409, 'AI 연결이 변경되었습니다.');
        await beforeConnectionChange(id);
        await connections.delete(scope, id, revision);
        await clean(scope.ownerId, previous.credentialRef);
      });
    },
    async credential(scope, id) {
      const item = await connections.get(scope, id);
      const secret = await vault.resolve(scope, item.credentialRef);
      const current = await connections.get(scope, id);
      if (current.revision !== item.revision) throw fail(409, 'AI 연결이 변경되었습니다.');
      return { secret, connection: item }; // Server-only; never serialize in HTTP responses.
    },
    preference: (scope) => connections.preference(scope),
    recordCheck(scope, id, revision, status, checkedAt) {
      return mutate(scope, async () =>
        publicConnection(
          await connections.update(scope, id, revision, { checkStatus: status, checkedAt }),
        ),
      );
    },
    setPreference: (scope, selection, revision) =>
      connections.setPreference(scope, selection, revision),
    // Account deletion implementation is deferred; callers first revoke all owner sessions.
    deleteOwner(ownerId) {
      const job = queue.then(async () => {
        await connections.deleteOwner(ownerId);
        await vault.deleteOwner(ownerId);
      });
      queue = job.catch(() => {});
      return job;
    },
    async close() {
      closed = true;
      detach();
      connections.clear();
      vault.clear();
      await queue;
      connections.clear();
      vault.clear();
    },
  };
}
