import test from 'node:test';
import assert from 'node:assert/strict';
import { PlayerProcess } from '../src/runtime/player-process.js';

const wrap = (body) => `module.exports = class {
  initialize(n,c,r) { this.n=n; this.calls=0; }
  getName() { return 'test'; }
  moveNext(map, position, items) { ${body} }
}`;

async function player(t, body) {
  const process = new PlayerProcess();
  t.after(() => process.close());
  await process.initialize(wrap(body), 0, 6, 6);
  return process;
}

test(
  '500ms interruption preserves PID and instance across normal / infinite / normal calls',
  { timeout: 10000 },
  async (t) => {
    const p = await player(
      t,
      `this.calls++; if (this.calls === 2) { this.saved=3; while(true) {} }
    return this.calls === 3 ? this.saved : 0;`,
    );
    const first = await p.move([0], 0);
    const interrupted = await p.move([0], 0);
    const next = await p.move([0], 0);
    assert.equal(first.value, 0);
    assert.equal(interrupted.status, 'timeout');
    assert.equal(interrupted.value, -1);
    assert.ok(interrupted.elapsedMs >= 500);
    assert.equal(next.value, 3);
    assert.equal(next.status, 'ok');
    assert.equal(first.pid, interrupted.pid);
    assert.equal(next.pid, first.pid);
  },
);

test(
  'try/catch/finally cannot evade interruption, next call remains usable',
  { timeout: 10000 },
  async (t) => {
    const p = await player(
      t,
      `this.calls++;
    if (this.calls === 1) { try { while(true) {} } catch(e) { while(true) {} } finally { while(true) {} } }
    return 2;`,
    );
    assert.equal((await p.move([0], 0)).status, 'timeout');
    assert.equal((await p.move([0], 0)).value, 2);
  },
);

test(
  'four independent processes make progress while one player is looping',
  { timeout: 10000 },
  async (t) => {
    const players = await Promise.all([
      player(t, 'while(true) {}'),
      player(t, 'return 1;'),
      player(t, 'return 2;'),
      player(t, 'return 3;'),
    ]);
    const completed = [];
    const results = await Promise.all(
      players.map((p, i) =>
        p.move([0], 0).then((r) => {
          completed.push(i);
          return r;
        }),
      ),
    );
    assert.equal(new Set(results.map((r) => r.pid)).size, 4);
    assert.equal(results[0].status, 'timeout');
    assert.deepEqual(
      results.slice(1).map((r) => r.value),
      [1, 2, 3],
    );
    assert.notEqual(completed[0], 0);
  },
);

test('debug output bounded; map is copied; item positions reach player', async (t) => {
  const p = await player(
    t,
    `for(let i=0;i<100;i++) debug.print('hello', i);
    map[0]=999; return items[0] === 5 ? 2 : -1;`,
  );
  const map = [10, 0];
  const result = await p.move(map, 0, [5, -1, -1, -1]);
  assert.equal(result.value, 2);
  assert.equal(result.logs.length, 30);
  assert.equal(result.droppedLogs, 70);
  assert.equal(map[0], 10);
});

test('host capabilities and dynamic code generation are not exposed', async (t) => {
  const p = await player(
    t,
    `return [typeof process, typeof require, typeof fetch, typeof setTimeout,
    typeof Promise, typeof eval, typeof Function, typeof emit, typeof __load, typeof (()=>{}).constructor].every(x=>x==='undefined') ? 1 : -1;`,
  );
  assert.equal((await p.move([0], 0)).value, 1);
});

test(
  'regular expression built-in interruption preserves the next call',
  { timeout: 15000 },
  async (t) => {
    const p = await player(
      t,
      `this.calls++; if(this.calls===1) /^(a+)+$/.test('a'.repeat(30)+'!'); return 2;`,
    );
    const first = await p.move([0], 0);
    assert.equal(first.status, 'timeout');
    assert.ok(
      first.elapsedMs < 1500,
      'interrupt latency must be measured, not just discard a late result',
    );
    assert.equal((await p.move([0], 0)).value, 2);
  },
);

test(
  'guest allocation limit reports an error without recreating the instance',
  { timeout: 10000 },
  async (t) => {
    const p = await player(
      t,
      `this.calls++; if(this.calls===1) this.data=new Array(100000000).fill(1); return 3;`,
    );
    const first = await p.move([0], 0);
    assert.notEqual(first.status, 'ok');
    const second = await p.move([0], 0);
    assert.equal(second.value, 3);
    assert.equal(second.pid, first.pid);
  },
);

test('invalid result and thrown objects become current-turn errors and recover', async (t) => {
  const p = await player(
    t,
    `this.calls++; if(this.calls===1) return '2';
    if(this.calls===2) throw { get message() { while(true){} } }; return -1;`,
  );
  assert.equal((await p.move([0], 0)).status, 'invalid-result');
  assert.equal((await p.move([0], 0)).status, 'exception');
  const last = await p.move([0], 0);
  assert.equal(last.status, 'ok');
  assert.equal(last.value, -1);
});

test('async and static code rejected before player creation', async (t) => {
  for (const source of [
    wrap('return import("fs");'),
    wrap('return 0;').replace('moveNext(', 'async moveNext('),
    wrap('return 0;').replace('getName()', 'static getName()'),
  ]) {
    const p = new PlayerProcess();
    t.after(() => p.close());
    await assert.rejects(p.initialize(source, 0, 6, 6));
  }
});

test('same player cannot overlap calls; context stays alive until explicit close', async (t) => {
  const p = await player(t, 'this.calls++; if(this.calls===1) while(true){}; return 0;');
  const first = p.move([0], 0);
  await assert.rejects(p.move([0], 0), /이전 턴/);
  await first;
  assert.equal(p.child.connected, true);
  await p.close();
  assert.equal(p.child.connected, false);
});
