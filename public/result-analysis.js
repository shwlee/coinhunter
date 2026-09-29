import { rankPlayers } from './podium.js';
import { characterFor } from './characters.js';

export function renderResultAnalysis(container, players) {
  container.replaceChildren();
  const ranked = rankPlayers(players);
  const note = document.createElement('p');
  note.className = 'analysis-note';
  note.textContent =
    '이동·아이템 사용은 완료된 액션 기준입니다. 평균 계산 시간에는 시간 초과·오류가 포함되며, 알고리즘을 호출하지 않는 랜덤점프는 제외됩니다.';
  const table = document.createElement('table');
  const caption = document.createElement('caption');
  caption.textContent = '플레이어별 경기 결과 분석';
  table.append(caption);
  const head = document.createElement('thead'),
    header = document.createElement('tr');
  const corner = document.createElement('th');
  corner.textContent = '지표';
  corner.scope = 'col';
  header.append(corner);
  for (const player of ranked) {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = `${player.rank}위 · P${player.id + 1} ${characterFor(player.characterId).name}${player.id === 0 ? ' (나)' : ''} / ${player.name}`;
    if (player.id === 0) th.className = 'analysis-self';
    header.append(th);
  }
  head.append(header);
  table.append(head);
  const body = document.createElement('tbody');
  const row = (label, read) => {
    const tr = document.createElement('tr'),
      th = document.createElement('th');
    th.scope = 'row';
    th.textContent = label;
    tr.append(th);
    for (const p of ranked) {
      const td = document.createElement('td');
      td.textContent = p.stats ? String(read(p, p.stats)) : '—';
      if (p.id === 0) td.className = 'analysis-self';
      tr.append(td);
    }
    body.append(tr);
  };
  const group = (label) => {
    const tr = document.createElement('tr'),
      th = document.createElement('th');
    th.colSpan = ranked.length + 1;
    th.textContent = label;
    th.className = 'analysis-group';
    tr.append(th);
    body.append(tr);
  };
  group('점수와 코인');
  row('최종 점수', (p) => p.score.toLocaleString());
  row('획득 코인 합계', (_, s) => Object.values(s.coins).reduce((a, b) => a + b, 0) + '개');
  for (const score of [10, 30, 100, 200, 500])
    row(`${score}점 코인`, (_, s) => s.coins[score] + '개');
  row('x2 추가 점수', (_, s) => s.bonusScore.toLocaleString() + '점');
  group('이동과 액션');
  for (const [label, key] of [
    ['완료한 턴', 'completedTurns'],
    ['일반 이동', 'moves'],
    ['벽·경계 충돌', 'wallCollisions'],
    ['제자리 패널티', 'penalties'],
    ['파괴한 벽', 'wallsBroken'],
    ['점프 성공', 'jumps'],
    ['점프 실패', 'jumpFailures'],
  ])
    row(label, (_, s) => s[key] + '회');
  group('알고리즘 실행');
  row('완료된 호출', (_, s) => s.algorithmCalls + '회');
  row('평균 계산 시간', (_, s) =>
    s.algorithmCalls ? (s.algorithmTotalMs / s.algorithmCalls).toFixed(2) + 'ms' : '—',
  );
  row('최대 계산 시간', (_, s) => (s.algorithmCalls ? s.algorithmMaxMs.toFixed(2) + 'ms' : '—'));
  for (const [label, key] of [
    ['시간 초과', 'timeouts'],
    ['실행 예외', 'exceptions'],
    ['잘못된 반환값', 'invalidResults'],
  ])
    row(label, (_, s) => s[key] + '회');
  group('아이템 획득 / 사용');
  for (const [i, label, unit] of [
    [0, '신발', '적용 턴'],
    [1, '망치', '벽 파괴'],
    [2, 'x2', '코인 획득'],
    [3, '랜덤점프', '시도'],
  ])
    row(label, (_, s) => `${s.itemsAcquired[i]}회 획득 / ${s.itemsUsed[i]}회 ${unit}`);
  table.append(body);
  container.append(note, table);
}
