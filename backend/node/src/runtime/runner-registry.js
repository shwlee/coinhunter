import { assertRunnerContext, RunnerFault } from './contracts/validation.js';
import { JavaScriptRunner } from './javascript-runner.js';

export class RunnerRegistry {
  #factories;
  constructor(entries) {
    this.#factories = new Map(entries);
  }
  get supportedLanguages() {
    return Object.freeze([...this.#factories.keys()]);
  }
  create(context) {
    assertRunnerContext(context);
    const factory = this.#factories.get(context.language);
    if (!factory) throw new RunnerFault('unavailable', 'initialize');
    return factory(context);
  }
}
export function createJavaScriptRegistry(options) {
  return new RunnerRegistry([['javascript', (context) => new JavaScriptRunner(context, options)]]);
}
