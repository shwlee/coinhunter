import { stat, statfs } from 'node:fs/promises';

const reservations = new Map();
const SAFETY_BYTES = 32 * 1024 * 1024;

function reserveBytes(free) {
  return Math.min(512 * 1024 * 1024, Math.max(64 * 1024 * 1024, Math.floor(free / 10)));
}

export function hasUploadSpace(free, device) {
  return free - (reservations.get(device) || 0) >= reserveBytes(free) + SAFETY_BYTES;
}

export function hasCopySpace(free, device, bytes) {
  return free - (reservations.get(device) || 0) >= bytes + reserveBytes(free) + SAFETY_BYTES;
}

export async function diskSpace(directory) {
  const [filesystem, target] = await Promise.all([statfs(directory), stat(directory)]);
  return { free: filesystem.bavail * filesystem.bsize, device: target.dev };
}

export async function withCopySpace(source, directory, copy) {
  const [sourceFile, { free, device }] = await Promise.all([stat(source), diskSpace(directory)]);
  const bytes = sourceFile.size;
  if (!hasCopySpace(free, device, bytes))
    throw Object.assign(new Error('코드 저장 공간이 부족합니다.'), { status: 507 });
  reservations.set(device, (reservations.get(device) || 0) + bytes);
  try {
    return await copy();
  } catch (error) {
    if (error.code === 'ENOSPC')
      throw Object.assign(new Error('코드 저장 공간이 부족합니다.'), { status: 507 });
    throw error;
  } finally {
    const remaining = reservations.get(device) - bytes;
    if (remaining) reservations.set(device, remaining);
    else reservations.delete(device);
  }
}
