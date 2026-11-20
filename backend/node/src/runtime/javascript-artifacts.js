import { randomUUID, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import {
  assertPreparedArtifact,
  assertSourceReference,
  RunnerFault,
} from './contracts/validation.js';

export const JAVASCRIPT_RUNTIME = Object.freeze({
  name: 'quickjs-emscripten',
  version: createRequire(import.meta.url)('quickjs-emscripten/package.json').version,
});
export const JAVASCRIPT_ADAPTER_VERSION = '2';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const optionsHash = sha256(
  'coinhunter-js-source-v2:user-call500ms:separate-input:32MiB:stack512KiB',
);

// Session-local bindings, not the stage-5 disk/compiler cache.
export class JavaScriptArtifacts {
  #entries = new Map();
  async register(source, reference) {
    try {
      if (typeof source !== 'string' && (!source || typeof source.path !== 'string'))
        throw new Error();
      const bytes =
        typeof source === 'string' ? Buffer.from(source, 'utf8') : await readFile(source.path);
      const actual = {
        sourceKey: reference?.sourceKey || randomUUID(),
        sha256: sha256(bytes),
        byteLength: bytes.length,
      };
      if (reference) {
        assertSourceReference(reference);
        if (reference.sha256 !== actual.sha256 || reference.byteLength !== actual.byteLength)
          throw new Error();
      }
      const artifact = assertPreparedArtifact({
        contractVersion: 1,
        artifactId: randomUUID(),
        language: 'javascript',
        source: actual,
        content: {
          artifactKey: actual.sourceKey,
          sha256: actual.sha256,
          byteLength: actual.byteLength,
        },
        format: 'javascript-source',
        profileId: 'default-js',
        toolchain: { name: 'source-reference', version: '1' },
        runtime: { ...JAVASCRIPT_RUNTIME },
        adapterVersion: JAVASCRIPT_ADAPTER_VERSION,
        target: { os: process.platform, architecture: process.arch },
        optionsHash,
      });
      this.#entries.set(artifact.artifactId, {
        artifact: structuredClone(artifact),
        source: typeof source === 'string' ? source : Object.freeze({ path: source.path }),
      });
      return artifact;
    } catch {
      throw new RunnerFault('preparation-failed', 'prepare');
    }
  }
  resolve = (artifact) => {
    const entry = this.#entries.get(artifact.artifactId);
    if (!entry || !isDeepStrictEqual(entry.artifact, artifact))
      throw new RunnerFault('unavailable', 'initialize');
    return entry.source;
  };
  clear() {
    this.#entries.clear();
  }
}
