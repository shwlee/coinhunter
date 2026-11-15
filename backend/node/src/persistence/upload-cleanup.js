import { mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const ownedFile = new RegExp(`^(\\d+)-${uuid}\\.js$`);
const legacyFile = new RegExp(`^${uuid}\\.js$`);
const LEGACY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

export async function cleanupOrphanUploads(directory, isAlive = processIsAlive) {
  const root = resolve(directory);
  await mkdir(root, { recursive: true });
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const owned = entry.name.match(ownedFile);
    const legacy = !owned && legacyFile.test(entry.name);
    if (!owned && !legacy) continue;
    const path = join(root, entry.name);
    if (owned && isAlive(Number(owned[1]))) continue;
    if (legacy) {
      let details;
      try {
        details = await stat(path);
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      if (Date.now() - details.mtimeMs < LEGACY_MAX_AGE_MS) continue;
    }
    await unlink(path).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}
