const $ = (id) => document.getElementById(id);
const colors = ['#b6f36e', '#72bcff', '#ffac86', '#c5a2ff'];
const itemIcons = ['👟', '🔨', '💵', '🎲'];
const effectNames = ['신발', '망치', 'x2', '점프'];
const canvas = $('board');
const ctx = canvas.getContext('2d');
let maps = [],
  source = '',
  game = null,
  matchId = null,
  events = null,
  receivedAt = 0,
  serverAt = 0,
  lastLogKey = '',
  busy = false;

function setError(message) {
  $('error-message').textContent = message;
}
function active() {
  return game && (game.status === 'playing' || game.status === 'hurryup');
}
function controls() {
  $('start-button').disabled = !source || busy || active();
  $('start-button').textContent = busy ? '알고리즘 준비 중…' : '경기 시작 →';
  $('stop-button').hidden = !active();
  for (const id of ['algorithm-file', 'map-select', 'dummy-count', 'black-matter', 'destroy-walls'])
    $(id).disabled = busy || active();
}
async function loadFile(file) {
  if (busy || active() || !file) return;
  source = '';
  if (!file.name.toLowerCase().endsWith('.js') || file.size > 65536) {
    setError('64 KiB 이하의 .js 파일을 선택하세요.');
    controls();
    return;
  }
  source = await file.text();
  $('file-label').textContent = file.name;
  setError('');
  controls();
}
$('algorithm-file').addEventListener('change', (event) => loadFile(event.target.files[0]));
for (const name of ['dragenter', 'dragover'])
  $('drop-zone').addEventListener(name, (event) => {
    event.preventDefault();
    $('drop-zone').classList.add('drag');
  });
for (const name of ['dragleave', 'drop'])
  $('drop-zone').addEventListener(name, (event) => {
    event.preventDefault();
    $('drop-zone').classList.remove('drag');
  });
$('drop-zone').addEventListener('drop', (event) => loadFile(event.dataTransfer.files[0]));
$('map-select').addEventListener('change', preview);

function preview() {
  const map = maps.find((map) => map.id === $('map-select').value);
  if (!map) return;
  game = {
    ...map,
    items: [-1, -1, -1, -1],
    players: [],
    status: 'ready',
    remainingMs: map.settings.runningTimeMs,
  };
  $('arena-title').textContent = map.name;
  $('map-size').textContent = `${map.columns} × ${map.rows}`;
  $('arena-overlay').innerHTML =
    '<div class="overlay-icon">⌘</div><strong>당신의 알고리즘을 기다립니다</strong><p>샘플 파일을 내려받아 첫 경기를 시작해 보세요.</p>';
  renderInfo();
}

$('setup-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!source || busy || active()) return;
  busy = true;
  controls();
  setError('');
  events?.close();
  try {
    const response = await fetch('/api/matches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source,
        mapId: $('map-select').value,
        dummyCount: Number($('dummy-count').value),
        blackMatter: $('black-matter').checked,
        destroyWalls: $('destroy-walls').checked,
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    matchId = data.id;
    sessionStorage.setItem('coinhunter-match', matchId);
    connect();
  } catch (error) {
    setError(error.message);
  } finally {
    busy = false;
    controls();
  }
});

function connect() {
  events?.close();
  events = new EventSource(`/api/matches/${matchId}/events`);
  events.addEventListener('snapshot', (event) => {
    const data = JSON.parse(event.data);
    game = data.game;
    serverAt = game.serverTime;
    receivedAt = performance.now();
    renderInfo();
    renderLogs(data.logs);
    controls();
    if (game.status === 'finished') {
      events.close();
      sessionStorage.removeItem('coinhunter-match');
    }
  });
  events.onopen = () => setError('');
  events.onerror = () => setError('경기 연결을 다시 시도하고 있습니다.');
}
$('stop-button').addEventListener('click', async () => {
  if (!matchId) return;
  $('stop-button').disabled = true;
  try {
    const response = await fetch(`/api/matches/${matchId}`, { method: 'DELETE' });
    if (!response.ok) throw new Error((await response.json()).error);
  } catch (error) {
    setError(error.message);
  } finally {
    $('stop-button').disabled = false;
  }
});

function renderInfo() {
  $('game-status').textContent = {
    ready: '준비',
    playing: '진행 중',
    hurryup: 'HURRY UP',
    finished: '경기 종료',
  }[game.status];
  $('live-dot').classList.toggle('active', active());
  $('timer').classList.toggle('hurry', game.status === 'hurryup');
  const seconds = Math.ceil(game.remainingMs / 1000);
  $('timer').textContent =
    `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  const overlay = $('arena-overlay');
  overlay.hidden = active();
  if (game.status === 'finished') {
    const highest = Math.max(...game.players.map((p) => p.score));
    const winners = game.players
      .filter((p) => p.score === highest)
      .map((p) => p.name)
      .join(' · ');
    overlay.replaceChildren();
    const icon = document.createElement('div');
    icon.className = 'overlay-icon';
    icon.textContent = '✦';
    const title = document.createElement('strong');
    title.textContent =
      game.reason === 'user-stopped'
        ? '경기를 종료했습니다'
        : `${winners} · ${highest.toLocaleString()}점`;
    const detail = document.createElement('p');
    detail.textContent =
      game.reason === 'runtime-failure'
        ? '실행 환경 오류로 경기가 종료되었습니다.'
        : '알고리즘을 바꾸고 새로운 전략에 도전하세요.';
    overlay.append(icon, title, detail);
  }
  const players = game.players.length
    ? game.players
    : Array.from({ length: 4 }, (_, id) => ({
        id,
        name: id ? '더미 ' + id : '내 알고리즘',
        score: 0,
        turn: 0,
      }));
  for (let i = 0; i < players.length; i++) {
    let card = $('scoreboard').children[i];
    if (!card) {
      card = document.createElement('div');
      card.className = 'score-card';
      card.innerHTML =
        '<div class="name"><i class="player-marker"></i><span></span></div><div class="score"></div><div class="detail"></div>';
      $('scoreboard').append(card);
    }
    const player = players[i];
    card.querySelector('.name span').textContent = player.name;
    card.querySelector('.player-marker').style.backgroundColor = colors[player.id];
    card.querySelector('.score').textContent = player.score.toLocaleString();
    card.querySelector('.detail').textContent = player.effect
      ? `${effectNames[player.effect.type]} · ${player.effect.remaining} 남음`
      : `TURN ${String(player.turn).padStart(3, '0')}`;
  }
  while ($('scoreboard').children.length > players.length) $('scoreboard').lastChild.remove();
}
function renderLogs(logs) {
  const key = JSON.stringify(logs);
  if (key === lastLogKey) return;
  lastLogKey = key;
  $('log-count').textContent = `${logs.length} EVENTS`;
  $('debug-output').textContent = logs.length
    ? logs
        .map((log) => {
          const title = `[P${log.player + 1} / ${log.turn}턴 / ${log.elapsedMs}ms] ${log.status}${log.direction === -1 ? ' · 제자리 패널티' : ''}`;
          return (
            title +
            (log.lines.length ? '\n  ' + log.lines.join('\n  ') : '') +
            (log.dropped ? `\n  … ${log.dropped}개 출력 생략` : '')
          );
        })
        .join('\n')
    : '알고리즘 실행 중 · debug.print로 전략을 확인하세요.';
  $('debug-output').scrollTop = $('debug-output').scrollHeight;
}

function roundRect(x, y, w, h, r, fill) {
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fill();
}
function draw() {
  requestAnimationFrame(draw);
  if (!game) return;
  const cell = 64,
    pad = 24;
  const width = game.columns * cell + pad * 2,
    height = game.rows * cell + pad * 2;
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  ctx.fillStyle = '#0c1420';
  ctx.fillRect(0, 0, width, height);
  const now = serverAt + (performance.now() - receivedAt);
  for (let y = 0; y < game.rows; y++)
    for (let x = 0; x < game.columns; x++) {
      const px = pad + x * cell,
        py = pad + y * cell,
        index = y * game.columns + x,
        tile = game.tiles[index];
      roundRect(px + 1, py + 1, cell - 2, cell - 2, 4, (x + y) % 2 ? '#162333' : '#182638');
      if (tile === -1) {
        roundRect(px + 5, py + 8, cell - 10, cell - 12, 5, '#334759');
        roundRect(px + 5, py + 5, cell - 10, cell - 15, 5, '#4b6577');
        ctx.fillStyle = '#668293';
        ctx.fillRect(px + 10, py + 10, cell - 20, 3);
        ctx.fillStyle = '#344b5e';
        ctx.fillRect(px + 9, py + 30, cell - 18, 3);
        ctx.fillRect(px + 31, py + 11, 3, 20);
      } else if (tile > 0) {
        const color = {
          10: '#ce956b',
          30: '#c8d8e4',
          100: '#f6cc67',
          200: '#79e8ef',
          500: '#c19aff',
        }[tile];
        const size = tile >= 100 ? 13 : 9;
        ctx.shadowColor = color;
        ctx.shadowBlur = tile >= 100 ? 10 : 0;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(px + cell / 2, py + cell / 2, size, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.strokeStyle = '#ffffff55';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(px + cell / 2, py + cell / 2, size - 3, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = '#29314388';
        ctx.fillRect(px + cell / 2 - 1, py + cell / 2 - 5, 2, 10);
      }
      const item = game.items.indexOf(index);
      if (item >= 0) {
        roundRect(px + 11, py + 11, 42, 42, 10, '#285646');
        ctx.font = '28px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(itemIcons[item], px + 32, py + 42);
      }
    }
  for (const player of game.players) {
    let x = player.position % game.columns,
      y = Math.floor(player.position / game.columns);
    const action = player.action;
    let progress = 0;
    if (action) {
      progress = Math.max(
        0,
        Math.min(1, (now - action.startedAt) / (action.endsAt - action.startedAt)),
      );
      if (action.type === 'move') {
        x += ((action.to % game.columns) - x) * progress;
        y += (Math.floor(action.to / game.columns) - y) * progress;
      }
      if (action.type === 'jump' && progress > 0.5) {
        x = action.to % game.columns;
        y = Math.floor(action.to / game.columns);
      }
    }
    const px = pad + x * cell + cell / 2,
      py = pad + y * cell + cell / 2;
    ctx.save();
    ctx.translate(px, py);
    if (action?.type === 'jump') {
      const scale = 0.5 + Math.abs(progress - 0.5);
      ctx.scale(scale, scale);
    }
    if (['confused', 'penalty', 'jump-failed'].includes(action?.type))
      ctx.rotate(Math.sin(progress * Math.PI * 3) * 0.12);
    if (player.effect?.type === 0 && action?.type === 'move') {
      ctx.globalAlpha = 0.18;
      roundRect(-30, -13, 34, 31, 8, colors[player.id]);
      ctx.globalAlpha = 1;
    }
    ctx.fillStyle = '#00000055';
    ctx.beginPath();
    ctx.ellipse(0, 19, 20, 8, 0, 0, Math.PI * 2);
    ctx.fill();
    roundRect(-19, -18, 38, 37, 9, colors[player.id]);
    roundRect(-13, -10, 26, 16, 5, '#152130');
    ctx.fillStyle = '#fff';
    ctx.fillRect(-8, -5, 4, 5);
    ctx.fillRect(4, -5, 4, 5);
    roundRect(-14, 16, 10, 8, 3, colors[player.id]);
    roundRect(4, 16, 10, 8, 3, colors[player.id]);
    ctx.textAlign = 'center';
    ctx.font = 'bold 11px monospace';
    ctx.fillStyle = '#0c1420';
    ctx.fillText(String(player.id + 1), 0, 15);
    if (player.effect) {
      ctx.font = '22px sans-serif';
      ctx.fillText(itemIcons[player.effect.type], 0, -26);
    }
    if (player.effect?.type === 1) {
      roundRect(-21, -21, 42, 8, 3, '#f6cc67');
      roundRect(-14, -28, 28, 11, 6, '#f6cc67');
    }
    if (action?.type === 'break') {
      ctx.font = '24px sans-serif';
      ctx.fillText('🔨', 23, Math.sin(progress * 10) * 8);
    }
    if (['confused', 'penalty'].includes(action?.type)) {
      ctx.font = 'bold 25px monospace';
      ctx.fillStyle = '#fff';
      ctx.fillText('?', 24, -20);
    }
    if (action?.type === 'jump-failed') {
      ctx.font = '20px sans-serif';
      ctx.fillText('✧', 20 + progress * 15, -30 + progress * 12);
    }
    if (player.coinBurstAt && now - player.coinBurstAt < 250 && player.coinBurstBoosted) {
      ctx.fillStyle = '#f6cc67';
      for (let i = 0; i < 5; i++) {
        ctx.beginPath();
        ctx.arc(Math.cos(i * 1.3) * 26, Math.sin(i * 1.3) * 26 - 10, 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }
}

try {
  const response = await fetch('/api/maps');
  const data = await response.json();
  maps = data.maps;
  for (const map of maps) {
    const option = document.createElement('option');
    option.value = map.id;
    option.textContent = map.name;
    $('map-select').append(option);
  }
  preview();
  const previous = sessionStorage.getItem('coinhunter-match');
  if (previous) {
    const result = await fetch(`/api/matches/${previous}`);
    if (result.ok) {
      matchId = previous;
      connect();
    } else sessionStorage.removeItem('coinhunter-match');
  }
} catch {
  setError('서버 연결을 확인한 후 새로고침하세요.');
}
controls();
draw();
