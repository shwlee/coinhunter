import { FileAccountRepository } from './file-account-repository.js';

/**
 * Account storage contract. A database adapter must preserve these operations and their
 * behavior: owner-scoped reads, atomic saves, revision conflicts, disabled users, and
 * history snapshots. Source text is kept in a separate file store, never in
 * account or history metadata. list() and history() return metadata without
 * source code or file keys; get() and historyEntry() return source after
 * checking the owner. File path methods are server-only and never exposed to clients.
 *
 * @typedef {object} AccountRepository
 * @property {(email: string) => Promise<object>} bootstrapAdmin
 * @property {(email: string) => Promise<object>} login
 * @property {(id: string) => Promise<object | undefined>} user
 * @property {() => Promise<object[]>} listUsers
 * @property {(id: string, input: object) => Promise<object>} updateUser
 * @property {(ownerId: string) => Promise<object[]>} list
 * @property {(ownerId: string, id: string) => Promise<object>} get
 * @property {(ownerId: string, id: string) => Promise<object>} metadata
 * @property {(ownerId: string, id: string) => Promise<string>} sourcePath
 * @property {(ownerId: string, id: string) => Promise<{metadata: object, handle: import('node:fs/promises').FileHandle, release: () => Promise<void>}>} openSource
 * @property {(ownerId: string, id: string, destination: string) => Promise<string>} snapshotSource
 * @property {(ownerId: string, id: string | null, input: object, sourcePath?: string) => Promise<object>} save
 * @property {(ownerId: string) => Promise<object[]>} history
 * @property {(ownerId: string, id: string) => Promise<object>} historyEntry
 * @property {(ownerId: string, id: string) => Promise<string>} historySourcePath
 * @property {(ownerId: string, entry: object) => Promise<object>} recordMatch
 */

/** @returns {AccountRepository} */
export function createAccountRepository() {
  const adapter = process.env.ACCOUNT_STORE_ADAPTER || 'file';
  if (adapter === 'file') return new FileAccountRepository();
  throw new Error(`지원하지 않는 계정 저장 어댑터: ${adapter}`);
}
