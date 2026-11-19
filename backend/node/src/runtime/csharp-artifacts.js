import { isDeepStrictEqual } from 'node:util';
import { JavaScriptArtifacts } from './javascript-artifacts.js';
import { assertPreparedArtifact, RunnerFault } from './contracts/validation.js';

// Session-local capability table. Build keys and pipe credentials are private;
// only public artifact metadata enters the runner/recording contracts.
export class CandidateArtifacts {
  #csharp = new Map();
  javascript = new JavaScriptArtifacts();
  async register(source, reference, language = 'javascript') {
    if (language === 'javascript') return this.javascript.register(source, reference);
    if (language !== 'csharp' || !source?.csharp)
      throw new RunnerFault('preparation-failed', 'prepare');
    const descriptor = structuredClone(source.csharp);
    const artifact = assertPreparedArtifact(descriptor.artifact);
    if (artifact.language !== 'csharp' || !isDeepStrictEqual(artifact.source, reference))
      throw new RunnerFault('preparation-failed', 'prepare');
    this.#csharp.set(artifact.artifactId, descriptor);
    return structuredClone(artifact);
  }
  resolveCSharp = (artifact) => {
    const descriptor = this.#csharp.get(artifact.artifactId);
    if (!descriptor || !isDeepStrictEqual(descriptor.artifact, artifact))
      throw new RunnerFault('unavailable', 'initialize');
    return structuredClone(descriptor);
  };
  clear() {
    this.javascript.clear();
    this.#csharp.clear();
  }
}
