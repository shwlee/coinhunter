import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, rmdir, unlink, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fail } from './errors.js';

const ownerName = /^([1-9]\d*)-([a-f0-9-]{36})\.owner$/;
const host = hostname();

async function removeDirectory(directory) {
  // On Windows an unlinked owner file may remain pending deletion until a competing read closes.
  // Never remove recursively: a directory containing another owner's file must remain locked.
  for (let attempt = 0; ; attempt++) {
    try {
      await rmdir(directory);
      return;
    } catch (error) {
      if (!['ENOTEMPTY', 'EPERM', 'EBUSY'].includes(error.code) || attempt >= 50) throw error;
      await delay(10);
    }
  }
}

function dead(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error.code === 'ESRCH';
  }
}

async function owner(directory) {
  try {
    const entries = await readdir(directory);
    if (entries.length !== 1) return null;
    const match = entries[0].match(ownerName);
    if (!match || !Number.isSafeInteger(Number(match[1]))) return null;
    const data = JSON.parse(await readFile(join(directory, entries[0]), 'utf8'));
    if (typeof data.host !== 'string') return null;
    return { name: entries[0], pid: Number(match[1]), host: data.host };
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function recover(directory) {
  const observed = await owner(directory);
  if (!observed || observed.host !== host || !dead(observed.pid)) return;
  // Only one collector may inspect/remove a dead owner's directory. Never use age-based eviction.
  const guard = directory + '-recovery';
  try {
    await mkdir(guard);
  } catch (error) {
    if (error.code === 'EEXIST') return;
    throw error;
  }
  try {
    const current = await owner(directory);
    if (!current || current.host !== host || !dead(current.pid)) return;
    await unlink(join(directory, current.name));
    await removeDirectory(directory);
  } finally {
    await removeDirectory(guard);
  }
}

async function acquire(file, timeoutMs) {
  const absolute = resolve(file);
  await mkdir(dirname(absolute), { recursive: true });
  // Directory aliases must share a lock, including Windows junctions and relative paths.
  const directory = join(await realpath(dirname(absolute)), basename(absolute) + '.lock');
  const name = `${process.pid}-${randomUUID()}.owner`;
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    try {
      await mkdir(directory);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      await recover(directory);
      if (performance.now() >= deadline)
        throw fail(
          503,
          '계정 저장소가 사용 중이거나 잠금 복구가 필요합니다. 잠시 후 다시 시도하세요.',
        );
      await delay(20 + Math.floor(Math.random() * 20));
      continue;
    }
    try {
      await writeFile(join(directory, name), JSON.stringify({ host }), { flag: 'wx' });
    } catch (error) {
      await unlink(join(directory, name)).catch(() => {});
      await rmdir(directory).catch(() => {});
      throw error;
    }
    const assertOwned = async () => {
      const current = await owner(directory);
      if (!current || current.name !== name || current.host !== host)
        throw fail(503, '계정 저장소 잠금 소유권이 변경되어 저장을 중단했습니다.');
    };
    return {
      assertOwned,
      async release() {
        await assertOwned();
        await unlink(join(directory, name));
        await removeDirectory(directory);
      },
    };
  }
}

// A single local host only. A live holder is never evicted even if an operation is slow.
// Unknown/partially initialized locks fail closed; an operator must recover them with all writers stopped.
export async function withFileLock(file, operation, { timeoutMs = 10000 } = {}) {
  const lease = await acquire(file, timeoutMs);
  try {
    return await operation(lease);
  } finally {
    try {
      await lease.release();
    } catch (error) {
      // Do not turn a committed write into a rejected save: callers would delete the committed source file.
      console.error(
        '계정 저장소 잠금 해제 실패. 다음 요청이 차단될 수 있습니다:',
        error.code || error.status || 'unknown',
      );
    }
  }
}
