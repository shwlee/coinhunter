import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
process.env.COINHUNTER_BUILD_ROOT = 'artifacts/csharp-review-fixes-build';
process.env.Backend__Languages__CSharpBetaEnabled = 'true';
process.env.Backend__CSharpValidation__Enabled = 'true';
process.env.Backend__CSharpValidation__HostAssembly = resolve(
  'artifacts/csharp-review-fixes-build/bin/CoinHunter.CSharp.Host/debug/CoinHunter.CSharp.Host.dll',
);
const { launchSplit, request } = await import('./backend-integration.js');
const { dotnetEnvironment } = await import('./backend-tools.js');
const app = await launchSplit();
const user = app.client();
const json = (value) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(value),
});
const expect = (value, status) => {
  assert.equal(value.status, status, value.text);
  return value.body;
};
const proof = {
  at: new Date().toISOString(),
  baseCommit: '4c93ec3',
  fixesApplied: true,
  directory: app.directory,
  checks: {},
};
const store = async () =>
  JSON.parse(await readFile(join(app.directory, 'operations/accounts/store.json'), 'utf8'));
const login = async () =>
  expect(await user('/api/auth/mock', json({ email: 'admin@company.test' })), 200);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
try {
  await login();
  const caps = expect(await user('/api/languages'), 200);
  assert.equal(caps.languages.find((l) => l.id === 'csharp').enabled, true);
  const source = await readFile('backend/samples/csharp/nearest-coin.cs', 'utf8');
  const saved = expect(
    await user('/api/algorithms?name=review-csharp&language=csharp', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: source,
    }),
    201,
  );
  let metadata;
  for (let i = 0; i < 200; i++) {
    metadata = expect(await user(`/api/algorithms/${saved.id}?metadata=1`), 200);
    if (metadata.validation?.state !== 'pending') break;
    await sleep(100);
  }
  assert.equal(metadata.validation.state, 'passed', JSON.stringify(metadata));
  const maps = expect(await user('/api/maps'), 200).maps;
  const options = {
    mapId: maps[0].id,
    mode: 'practice',
    dummyCount: 0,
    blackMatter: false,
    destroyWalls: false,
    startSlot: 0,
    characterId: 'pengko',
  };
  const match = expect(
    await user('/api/matches', json({ ...options, algorithmId: saved.id, language: 'csharp' })),
    201,
  );
  const snapshot = expect(await user('/api/matches/' + match.id), 200);
  proof.checks.actualPublicCSharp = {
    created: true,
    status: snapshot.game.status,
    language: metadata.language,
    matchId: match.id,
  };
  const other = app.client();
  expect(await other('/api/auth/mock', json({ email: 'tester@company.test' })), 200);
  const stay =
    "module.exports=class{initialize(){}getName(){return 'review-js';}moveNext(){return -1;}}";
  const jsMatch = expect(
    await other('/api/matches', json({ ...options, source: stay, language: 'javascript' })),
    201,
  );
  console.log('Actual public C# save/preflight/start works. Reviewing disable/recovery.');
  await app.stopHost(app.operations);
  await app.stopHost(app.execution);
  dotnetEnvironment.Backend__Languages__CSharpBetaEnabled = 'false';
  await app.launch('CoinHunter.Execution.Host', app.execution.port);
  const restartedOperations = await app.launch('CoinHunter.Operations.Api', app.operations.port);
  await login();
  await sleep(1300);
  const disabled = expect(await user('/api/languages'), 200);
  const engine = await request(app.execution.port, '/internal/v1/matches/' + match.id, {
    headers: { authorization: 'Bearer ' + app.key },
  });
  const state = await store();
  const matchRow = state.matches.find((item) => item.id === match.id);
  const jsSource = await readFile('backend/node/examples/nearest-coin.js', 'utf8');
  const blocked = await user(
    '/api/matches',
    json({ ...options, source: jsSource, language: 'javascript' }),
  );
  expect(await other('/api/auth/mock', json({ email: 'tester@company.test' })), 200);
  const otherRow = (await store()).matches.find((item) => item.id === jsMatch.id);
  const otherEngine = await request(app.execution.port, '/internal/v1/matches/' + jsMatch.id, {
    headers: { authorization: 'Bearer ' + app.key },
  });
  const otherBlocked = await other(
    '/api/matches',
    json({ ...options, source: stay, language: 'javascript' }),
  );
  proof.checks.disabledRecovery = {
    csharpEnabled: disabled.languages.find((l) => l.id === 'csharp').enabled,
    executionState: engine.body?.state,
    executionHasResult: Boolean(engine.body?.result),
    operationsCompleted: matchRow.completed,
    operationsApplied: matchRow.applied,
    javaScriptCreateStatus: blocked.status,
    javaScriptCreateError: blocked.body?.error,
    unrelatedJavaScriptUser: {
      executionState: otherEngine.body?.state,
      executionHasResult: Boolean(otherEngine.body?.result),
      operationsCompleted: otherRow.completed,
      createStatus: otherBlocked.status,
    },
  };
  assert.equal(engine.status, 200);
  assert.ok(engine.body.result);
  assert.equal(matchRow.completed, true);
  assert.equal(blocked.status, 201);
  assert.equal(otherRow.completed, true);
  assert.ok(otherEngine.body.result);
  assert.equal(otherBlocked.status, 201);
  expect(await user('/api/matches/' + blocked.body.id, { method: 'DELETE' }), 200);
  expect(await other('/api/matches/' + otherBlocked.body.id, { method: 'DELETE' }), 200);
  console.log('PASS: disabled beta recovers both owners and permits subsequent JS.');
  expect(await user('/api/matches/' + match.id, { method: 'DELETE' }), 200);
  expect(await other('/api/matches/' + jsMatch.id, { method: 'DELETE' }), 200);
  await app.stopHost(restartedOperations);
  dotnetEnvironment.Backend__Languages__CSharpBetaEnabled = 'true';
  await app.launch('CoinHunter.Operations.Api', app.operations.port);
  await login();
  const mismatchedCaps = expect(await user('/api/languages'), 200);
  const denied = await user(
    '/api/matches',
    json({ ...options, algorithmId: saved.id, language: 'csharp' }),
  );
  assert.equal(denied.status, 503);
  assert.equal(denied.body.code, 'execution_admission_rejected');
  const orphan = (await store()).matches.find((item) => !item.completed);
  assert.equal(orphan, undefined);
  const next = expect(
    await user('/api/matches', json({ ...options, source: jsSource, language: 'javascript' })),
    201,
  );
  expect(await user('/api/matches/' + next.id, { method: 'DELETE' }), 200);
  proof.checks.mismatchedAdmission = {
    csharpEnabled: mismatchedCaps.languages.find((l) => l.id === 'csharp').enabled,
    createStatus: denied.status,
    rejectionCode: denied.body.code,
    pendingOrphan: false,
    nextJavaScriptStatus: 201,
  };
  const original = structuredClone(
    (await store()).matches.find((item) => item.id === match.id).request,
  );
  original.matchId = randomUUID();
  original.requestId = randomUUID();
  const internal = (path, body) =>
    request(app.execution.port, path, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + app.key, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  expect(
    await internal('/internal/v1/matches/' + original.matchId + '/stop', {
      requestId: randomUUID(),
      reason: 'user-stopped',
      execution: original,
    }),
    200,
  );
  const late = expect(await internal('/internal/v1/matches', original), 202);
  assert.equal(late.state, 'closed');
  assert.equal(late.enginePid, null);
  assert.equal(late.result.outcome, 'aborted');
  const conflicting = await internal('/internal/v1/matches', {
    ...original,
    requestId: randomUUID(),
  });
  assert.equal(conflicting.status, 409);
  proof.checks.cancellationFence = {
    lateAdmissionState: late.state,
    enginePid: late.enginePid,
    outcome: late.result.outcome,
    conflictStatus: conflicting.status,
  };
  console.log(
    'PASS: confirmed rejection rolls back; unknown cancellation prevents late execution.',
  );
} finally {
  await writeFile('artifacts/csharp-recovery-fixes-api.json', JSON.stringify(proof, null, 2));
  await app.close({ keep: true });
}
