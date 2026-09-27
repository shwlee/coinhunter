import { CHARACTERS, DEFAULT_CHARACTER, characterFor, isPlayableCharacter } from './characters.js';
import { loadCharacters, drawCharacter } from './character-renderer.js';
const $ = (id) => document.getElementById(id);
let selectedCharacter = DEFAULT_CHARACTER;
let charactersReady = false;
let setupStep = 'file';
const setupSteps = ['file', 'settings', 'character', 'position'];
const stepTitles = [
  '알고리즘 파일을 선택하세요',
  '맵과 경기 옵션을 설정하세요',
  '함께할 캐릭터를 선택하세요',
  '시작 위치를 선택하세요',
];
let selectedStartSlot = 0;
const startNames = ['왼쪽 위', '오른쪽 위', '왼쪽 아래', '오른쪽 아래'];
try {
  const saved = localStorage.getItem('coinhunter-character');
  if (isPlayableCharacter(saved)) selectedCharacter = saved;
} catch {
  /* Browser storage can be disabled. */
}
for (const character of CHARACTERS.filter((c) => c.playable)) {
  const label = document.createElement('label');
  label.className = `character-card ${character.id}`;
  label.innerHTML = `<input type="radio" name="character" value="${character.id}" aria-label="${character.name}"><span class="character-art"><canvas width="180" height="200" aria-hidden="true"></canvas></span><span class="character-name">${character.name}<span class="selection-mark" aria-hidden="true">✓</span></span><span class="character-description">${character.description}</span>`;
  const input = label.querySelector('input');
  input.checked = character.id === selectedCharacter;
  input.addEventListener('change', () => {
    selectedCharacter = character.id;
    try {
      localStorage.setItem('coinhunter-character', selectedCharacter);
    } catch {
      /* Optional preference. */
    }
    if (game?.status === 'ready') renderInfo();
  });
  $('character-options').append(label);
}
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
  $('start-button').disabled =
    !source || !charactersReady || setupStep !== 'position' || busy || active();
  $('start-button').textContent = busy ? '알고리즘 준비 중…' : '경기 시작 →';
  $('stop-button').hidden = !active();
  for (const id of ['algorithm-file', 'map-select', 'dummy-count', 'black-matter', 'destroy-walls'])
    $(id).disabled = busy || active();
  $('character-options').disabled = busy || active();
  $('position-options').disabled = busy || active();
  $('position-next').disabled = !charactersReady || busy || active();
  $('character-back').disabled = busy || active();
  $('file-next').disabled = !source || busy || active();
  $('settings-next').disabled = !source || !maps.length || !charactersReady || busy || active();
  for (const id of ['file-back', 'settings-back']) $(id).disabled = busy || active();
}
function showSetupStep(step) {
  if (busy || active()) return;
  if (step !== 'file' && !source) step = 'file';
  setupStep = step;
  $('setup-form').hidden = false;
  $('setup-progress').hidden = false;
  $('play-again').hidden = true;
  for (const name of setupSteps) $(`${name}-step`).hidden = name !== step;
  $('setup-progress').textContent =
    `${setupSteps.indexOf(step) + 1} / 4 · 알고리즘 → 경기 설정 → 캐릭터 → 시작 위치`;
  $('position-summary').textContent =
    `${characterFor(selectedCharacter).name} · ${startNames[selectedStartSlot]}에서 시작`;
  $('arena-message').querySelector('strong').textContent = stepTitles[setupSteps.indexOf(step)];
  $('arena-message').querySelector('p').textContent =
    step === 'file'
      ? '샘플 파일을 내려받거나 자신의 .js 파일을 올리세요.'
      : '선택한 값은 이전 단계로 돌아가도 유지됩니다.';
  controls();
}
$('play-again').addEventListener('click', () => {
  if (busy || active()) return;
  showSetupStep('file');
  $('algorithm-file').focus();
});
for (const [id, step] of [
  ['file-next', 'settings'],
  ['file-back', 'file'],
  ['settings-next', 'character'],
  ['settings-back', 'settings'],
]) {
  $(id).addEventListener('click', () => {
    showSetupStep(step);
    $(`${step}-step`).querySelector('input,select,button').focus();
  });
}
$('position-next').addEventListener('click', () => {
  showSetupStep('position');
  document.querySelector('input[name="start-slot"]:checked').focus();
});
$('character-back').addEventListener('click', () => {
  showSetupStep('character');
  document.querySelector('input[name="character"]:checked').focus();
});
for (const input of document.querySelectorAll('input[name="start-slot"]')) {
  input.addEventListener('change', () => {
    selectedStartSlot = Number(input.value);
    showSetupStep('position');
  });
}
async function loadFile(file) {
  if (busy || active() || !file) return;
  source = '';
  controls();
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
  $('arena-message').innerHTML =
    '<strong>함께할 캐릭터를 선택하세요</strong><p>알고리즘을 업로드한 뒤 경기를 시작하세요.</p>';
  renderInfo();
  showSetupStep(setupStep);
}

$('setup-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!source || !charactersReady || setupStep !== 'position' || busy || active()) return;
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
        characterId: selectedCharacter,
        startSlot: selectedStartSlot,
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
    selectedStartSlot = game.players[0]?.startSlot ?? 0;
    for (const input of document.querySelectorAll('input[name="start-slot"]'))
      input.checked = Number(input.value) === selectedStartSlot;
    const characterId = game.players[0]?.characterId;
    if (isPlayableCharacter(characterId)) {
      selectedCharacter = characterId;
      for (const input of document.querySelectorAll('input[name="character"]'))
        input.checked = input.value === characterId;
    }
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
    $('setup-form').hidden = true;
    $('setup-progress').hidden = true;
    $('play-again').hidden = false;
    const highest = Math.max(...game.players.map((p) => p.score));
    const winners = game.players
      .filter((p) => p.score === highest)
      .map((p) => p.name)
      .join(' · ');
    const message = $('arena-message');
    message.replaceChildren();
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
    message.append(title, detail);
  }
  const players = game.players.length
    ? game.players
    : Array.from({ length: 4 }, (_, id) => ({
        id,
        name: id ? '더미 ' + id : '내 알고리즘',
        characterId: id ? 'kobi' : selectedCharacter,
        score: 0,
        turn: 0,
      }));
  for (let i = 0; i < players.length; i++) {
    let card = $('scoreboard').children[i];
    if (!card) {
      card = document.createElement('div');
      card.className = 'score-card';
      card.innerHTML =
        '<canvas class="score-portrait" width="64" height="80" aria-hidden="true"></canvas><div class="character-caption"></div><div class="name"><i class="player-marker"></i><span></span></div><div class="score"></div><div class="detail"></div>';
      $('scoreboard').append(card);
    }
    const player = players[i];
    card.dataset.character = player.characterId;
    card.querySelector('.character-caption').textContent = characterFor(player.characterId).name;
    const portrait = card.querySelector('canvas');
    const portraitContext = portrait.getContext('2d');
    portraitContext.clearRect(0, 0, portrait.width, portrait.height);
    drawCharacter(portraitContext, player.characterId, 32, 80, 80);
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
      const trailX = Math.sign((action.to % game.columns) - (action.from % game.columns)) * -14;
      const trailY =
        Math.sign(Math.floor(action.to / game.columns) - Math.floor(action.from / game.columns)) *
        -14;
      drawCharacter(ctx, player.characterId, trailX, 27 + trailY, 72, 1, trailX > 0);
      ctx.globalAlpha = 1;
    }
    ctx.fillStyle = '#00000055';
    ctx.beginPath();
    ctx.ellipse(0, 19, 20, 8, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = colors[player.id];
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(0, 21, 21, 7, 0, 0, Math.PI * 2);
    ctx.stroke();
    const walking = action?.type === 'move';
    const bob = walking
      ? Math.sin(progress * Math.PI * 2) * 3
      : Math.sin(now / 350 + player.id) * 0.7;
    const flip = walking && action.to % game.columns < action.from % game.columns;
    drawCharacter(
      ctx,
      player.characterId,
      0,
      27 + bob,
      72,
      walking && progress > 0.15 && progress < 0.8 ? 1 : 0,
      flip,
    );
    ctx.textAlign = 'center';
    ctx.font = 'bold 11px monospace';
    ctx.fillStyle = colors[player.id];
    ctx.fillText(`P${player.id + 1}`, 0, 34);
    if (player.effect) {
      ctx.font = '22px sans-serif';
      ctx.fillText(itemIcons[player.effect.type], 0, -42);
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
  await loadCharacters();
  charactersReady = true;
  $('character-load-status').textContent = '';
  for (const card of document.querySelectorAll('.character-card')) {
    const portrait = card.querySelector('canvas');
    drawCharacter(portrait.getContext('2d'), card.querySelector('input').value, 90, 198, 200);
  }
  drawCharacter($('dummy-portrait').getContext('2d'), 'kobi', 40, 100, 100);
} catch {
  $('character-load-status').textContent =
    '캐릭터 이미지를 불러오지 못했습니다. 새로고침해 주세요.';
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
