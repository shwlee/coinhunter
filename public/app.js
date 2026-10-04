import { CHARACTERS, DEFAULT_CHARACTER, characterFor, isPlayableCharacter } from './characters.js';
import { rivalCharacterFor } from './characters.js';
import { loadCharacters, drawCharacter, drawDirectionalCharacter } from './character-renderer.js';
import { renderPodium } from './podium.js';
import { api, accountBar } from './account.js';
import { renderResultAnalysis } from './result-analysis.js';
import { renderLeaderboard } from './leaderboard.js';
import { loadCoins, drawCoin, drawCoinPickup, drawCoinSample } from './coin-renderer.js';
const $ = (id) => document.getElementById(id);
const testMode =
  window.parent !== window && new URLSearchParams(location.search).get('editor') === '1';
const matchStorageKey = testMode ? 'coinhunter-test-match' : 'coinhunter-match';
if (testMode) {
  document.body.classList.add('test-game', 'embedded-game');
  $('dummy-count').value = '0';
}
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
let finishStage = null;
let finishTimer = null;
let analysisOpen = false;
let hurryAnnounced = false;
let hurryTimer = null;
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
  historyId = '',
  history = [],
  loggedIn = false,
  refreshHistory = async () => {},
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
const isDuel = () => $('match-mode').value === 'duel';
const filesReady = () => Boolean(source && (!isDuel() || (loggedIn && historyId)));
function controls() {
  if (window.parent !== window)
    window.parent.postMessage(
      { type: 'editor-state', active: Boolean(busy || active()) },
      location.origin,
    );
  $('start-button').disabled =
    !filesReady() || !charactersReady || setupStep !== 'position' || busy || active();
  $('start-button').textContent = busy ? '준비 중…' : testMode ? '테스트 시작 →' : '게임 시작 →';
  $('stop-button').hidden = !active();
  for (const id of [
    'match-mode',
    'history-select',
    'history-refresh',
    'algorithm-file',
    'map-select',
    'dummy-count',
    'black-matter',
    'destroy-walls',
  ])
    $(id).disabled = busy || active();
  $('character-options').disabled = busy || active();
  $('position-options').disabled = busy || active();
  $('position-next').disabled = !charactersReady || busy || active();
  $('character-back').disabled = busy || active();
  $('file-next').disabled = !filesReady() || busy || active();
  const missingSelection = !testMode && isDuel() && !filesReady() && !busy && !active();
  $('file-next-reason').hidden = !missingSelection;
  $('file-next-reason').textContent = missingSelection
    ? !history.length
      ? '완료한 경기 기록이 없습니다. 로그인 상태에서 게임을 한 번 진행한 뒤 다시 선택하세요.'
      : !source
        ? '현재 알고리즘 파일이나 저장 코드를 먼저 선택하세요.'
        : '대결할 이전 경기 기록을 선택하면 다음으로 진행할 수 있습니다.'
    : '';
  $('settings-next').disabled =
    !filesReady() || !maps.length || !charactersReady || busy || active();
  for (const id of ['file-back', 'settings-back']) $(id).disabled = busy || active();
}
function showSetupStep(step) {
  if (busy || active()) return;
  if (testMode) step = 'position';
  else if (step !== 'file' && !filesReady()) step = 'file';
  setupStep = step;
  $('setup-form').hidden = false;
  $('setup-progress').hidden = false;
  $('play-again').hidden = true;
  $('replay-hint').hidden = true;
  $('result-podium').hidden = true;
  $('result-actions').hidden = true;
  $('result-analysis').hidden = true;
  analysisOpen = false;
  $('arena-overlay').classList.remove('show-results');
  for (const name of setupSteps) $(`${name}-step`).hidden = name !== step;
  $('setup-progress').textContent =
    `${setupSteps.indexOf(step) + 1} / 4 · 알고리즘 → 경기 설정 → 캐릭터 → 시작 위치`;
  $('position-summary').textContent =
    `${characterFor(selectedCharacter).name} · ${startNames[selectedStartSlot]}에서 시작` +
    (isDuel() ? ` / 이전 코드: ${startNames[3 - selectedStartSlot]}` : '');
  $('arena-message').querySelector('strong').textContent = stepTitles[setupSteps.indexOf(step)];
  $('arena-message').querySelector('p').hidden = false;
  $('arena-message').querySelector('p').textContent =
    step === 'file'
      ? '샘플 파일을 내려받거나 자신의 .js 파일을 올리세요.'
      : '선택한 값은 이전 단계로 돌아가도 유지됩니다.';
  if (testMode) {
    $('settings-step').hidden = false;
    $('setup-progress').hidden = true;
    $('arena-message').querySelector('strong').textContent = '테스트 설정';
    $('arena-message').querySelector('p').textContent = source
      ? '맵과 시작 위치를 선택하세요.'
      : '작업실에서 현재 코드를 전달해 주세요.';
    $('position-summary').textContent = `${startNames[selectedStartSlot]} · 캐릭터 자동 배정`;
  }
  controls();
}
$('play-again').addEventListener('click', () => {
  if (busy || active()) return;
  events?.close();
  events = null;
  matchId = null;
  sessionStorage.removeItem(matchStorageKey);
  setError('');
  renderLogs([]);
  setupStep = 'file';
  preview();
  if (loggedIn) refreshHistory().catch((error) => setError(error.message));
  $('algorithm-file').focus();
});
$('analysis-toggle').addEventListener('click', () => {
  if (game?.status !== 'finished' || finishStage !== 'results') return;
  analysisOpen = !analysisOpen;
  renderInfo();
  if (analysisOpen) $('result-analysis').focus();
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
  if (!file.name.toLowerCase().endsWith('.js')) {
    setError('.js 파일을 선택하세요.');
    controls();
    return;
  }
  source = await file.text();
  $('file-label').textContent = file.name;
  setError('');
  controls();
}
$('algorithm-file').addEventListener('change', (event) => loadFile(event.target.files[0]));
$('history-select').addEventListener('change', () => {
  historyId = $('history-select').value;
  controls();
});
$('match-mode').addEventListener('change', () => {
  const duel = isDuel();
  $('opponent-history').hidden = !duel;
  $('file-step').classList.toggle('duel-files', duel);
  $('dummy-count').parentElement.hidden = duel;
  document.querySelector('.dummy-note').hidden = duel;
  $('duel-note').hidden = !duel;
  setError('');
  controls();
  if (game?.status === 'ready') renderInfo();
});
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
$('dummy-count').addEventListener('change', () => {
  if (game?.status === 'ready') renderInfo();
});

function preview() {
  const map = maps.find((map) => map.id === $('map-select').value);
  if (!map) return;
  clearTimeout(finishTimer);
  finishTimer = null;
  finishStage = null;
  hurryAnnounced = false;
  $('game-over').hidden = true;
  $('arena-overlay').classList.remove('show-game-over');
  game = {
    ...map,
    items: [-1, -1, -1, -1],
    players: [],
    status: 'ready',
    remainingMs: map.settings.runningTimeMs,
  };
  serverAt = 0;
  receivedAt = performance.now();
  $('arena-title').textContent = map.name;
  $('map-size').textContent = `${map.columns} × ${map.rows}`;
  $('arena-message').innerHTML =
    '<strong>함께할 캐릭터를 선택하세요</strong><p>알고리즘을 업로드한 뒤 경기를 시작하세요.</p>';
  renderInfo();
  showSetupStep(setupStep);
}

$('setup-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!filesReady() || !charactersReady || setupStep !== 'position' || busy || active()) return;
  busy = true;
  if (testMode) {
    const playable = CHARACTERS.filter((character) => character.playable);
    selectedCharacter = playable[Math.floor(Math.random() * playable.length)].id;
  }
  controls();
  setError('');
  events?.close();
  try {
    if (!testMode) {
      $('arena-overlay').classList.add('counting-down');
      drawBoard();
    }
    $('start-countdown').hidden = testMode;
    for (const number of testMode ? [] : [3, 2, 1]) {
      $('countdown-number').textContent = String(number);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    $('countdown-number').textContent = '시작!';
    if (!testMode) await new Promise((resolve) => setTimeout(resolve, 1000));
    const response = await fetch('/api/matches', {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'X-Coinhunter-Options': JSON.stringify({
          characterId: selectedCharacter,
          startSlot: selectedStartSlot,
          mapId: $('map-select').value,
          mode: !testMode && isDuel() ? 'duel' : 'practice',
          opponentHistoryId: !testMode && isDuel() ? historyId : undefined,
          dummyCount: testMode || isDuel() ? 0 : Number($('dummy-count').value),
          blackMatter: !testMode && $('black-matter').checked,
          destroyWalls: !testMode && $('destroy-walls').checked,
        }),
      },
      body: source,
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    matchId = data.id;
    sessionStorage.setItem(matchStorageKey, matchId);
    connect();
  } catch (error) {
    setError(error.message);
  } finally {
    $('start-countdown').hidden = true;
    $('arena-overlay').classList.remove('counting-down');
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
      sessionStorage.removeItem(matchStorageKey);
      if (loggedIn) refreshHistory().catch((error) => setError(error.message));
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
  const hurry = game.status === 'hurryup';
  document.querySelector('.arena').classList.toggle('hurry-phase', hurry);
  if (hurry && !hurryAnnounced) {
    hurryAnnounced = true;
    $('hurry-banner').hidden = false;
    hurryTimer = setTimeout(() => {
      $('hurry-banner').hidden = true;
      hurryTimer = null;
    }, 1000);
  } else if (!hurry) {
    clearTimeout(hurryTimer);
    hurryTimer = null;
    $('hurry-banner').hidden = true;
  }
  $('rank-heading').textContent =
    game.status === 'ready'
      ? '참가자 준비'
      : game.status === 'finished'
        ? '최종 순위'
        : '실시간 순위';
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
  if (testMode) {
    if (game.status === 'finished') {
      showSetupStep('position');
      $('arena-message').querySelector('strong').textContent = '테스트 종료';
      $('arena-message').querySelector('p').textContent =
        `${game.players[0]?.score ?? 0}점 · 코드를 수정하거나 설정을 바꿔 다시 실행하세요.`;
    }
    return;
  }
  if (game.status === 'finished') {
    if (finishStage === null) {
      finishStage = 'message';
      finishTimer = setTimeout(() => {
        finishTimer = null;
        if (game?.status !== 'finished' || finishStage !== 'message') return;
        finishStage = 'results';
        renderInfo();
      }, 3000);
    }
    const showingMessage = finishStage === 'message';
    $('game-over').hidden = !showingMessage;
    $('result-podium').hidden = showingMessage || analysisOpen;
    $('result-analysis').hidden = showingMessage || !analysisOpen;
    $('result-actions').hidden = showingMessage;
    $('analysis-toggle').textContent = analysisOpen ? '포디엄 보기' : '결과 분석';
    $('analysis-toggle').setAttribute('aria-expanded', String(analysisOpen));
    overlay.classList.toggle('show-game-over', showingMessage);
    overlay.classList.toggle('show-results', !showingMessage);
    if (!showingMessage) {
      if (analysisOpen) renderResultAnalysis($('result-analysis'), game.players);
      else renderPodium($('result-podium'), game.players);
    }
    $('setup-form').hidden = true;
    $('setup-progress').hidden = true;
    $('play-again').hidden = showingMessage;
    $('replay-hint').hidden = showingMessage;
    const message = $('arena-message');
    message.replaceChildren();
    const title = document.createElement('strong');
    title.textContent = game.reason === 'user-stopped' ? '경기를 종료했습니다' : '최종 경기 결과';
    const detail = document.createElement('p');
    detail.textContent =
      game.reason === 'runtime-failure' ? '실행 환경 오류로 경기가 종료되었습니다.' : '';
    detail.hidden = game.reason !== 'runtime-failure';
    message.append(title, detail);
  }
  const players = game.players.length
    ? game.players
    : Array.from({ length: isDuel() ? 2 : Number($('dummy-count').value) + 1 }, (_, id) => ({
        id,
        name: isDuel()
          ? id
            ? '이전 알고리즘'
            : '현재 알고리즘'
          : id
            ? '더미 ' + id
            : '내 알고리즘',
        characterId: id
          ? isDuel()
            ? rivalCharacterFor(selectedCharacter)
            : 'kobi'
          : selectedCharacter,
        score: 0,
        turn: 0,
      }));
  renderLeaderboard($('scoreboard'), players, {
    colors,
    effectNames,
    reset: game.status === 'ready',
  });
}
let latestLogs = [];
let logMatchId;
const clearedTurns = new Map();
$('clear-logs').addEventListener('click', () => {
  for (const log of latestLogs)
    clearedTurns.set(log.player, Math.max(clearedTurns.get(log.player) ?? -1, log.turn));
  lastLogKey = '';
  renderLogs(latestLogs);
});
$('log-autoscroll').addEventListener('change', () => {
  if ($('log-autoscroll').checked) $('debug-output').scrollTop = $('debug-output').scrollHeight;
});
function renderLogs(logs) {
  if (logMatchId !== matchId) {
    logMatchId = matchId;
    clearedTurns.clear();
    lastLogKey = '';
  }
  latestLogs = logs;
  logs = logs.filter((log) => log.turn > (clearedTurns.get(log.player) ?? -1));
  const key = JSON.stringify(logs);
  if (key === lastLogKey) return;
  lastLogKey = key;
  $('log-count').textContent = `${logs.length} EVENTS`;
  const scrollTop = $('debug-output').scrollTop;
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
    : '표시할 출력이 없습니다. debug.print로 전략을 확인하세요.';
  $('debug-output').scrollTop = $('log-autoscroll').checked
    ? $('debug-output').scrollHeight
    : scrollTop;
}

function roundRect(x, y, w, h, r, fill) {
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fill();
}
function draw() {
  requestAnimationFrame(draw);
  drawBoard();
}
function drawBoard() {
  if (!game) return;
  // Preparation fully covers the board. Avoid animating hidden tiles and coins.
  if (game.status === 'ready' && !$('arena-overlay').classList.contains('counting-down')) return;
  const cell = 64,
    pad = 24;
  const width = game.columns * cell + pad * 2,
    height = game.rows * cell + pad * 2;
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#92a99d';
  ctx.fillRect(pad, pad, game.columns * cell, game.rows * cell);
  const now = game.status === 'finished' ? serverAt : serverAt + (performance.now() - receivedAt);
  for (let y = 0; y < game.rows; y++)
    for (let x = 0; x < game.columns; x++) {
      const px = pad + x * cell,
        py = pad + y * cell,
        index = y * game.columns + x,
        tile = game.tiles[index];
      roundRect(px + 1, py + 1, cell - 2, cell - 2, 4, (x + y) % 2 ? '#c7d3bf' : '#b7cbb0');
      if (tile === -1) {
        roundRect(px + 5, py + 8, cell - 10, cell - 12, 5, '#334759');
        roundRect(px + 5, py + 5, cell - 10, cell - 15, 5, '#4b6577');
        ctx.fillStyle = '#668293';
        ctx.fillRect(px + 10, py + 10, cell - 20, 3);
        ctx.fillStyle = '#344b5e';
        ctx.fillRect(px + 9, py + 30, cell - 18, 3);
        ctx.fillRect(px + 31, py + 11, 3, 20);
      } else if (tile > 0) {
        drawCoin(
          ctx,
          tile,
          px + cell / 2,
          py + cell / 2,
          now,
          index,
          game.coinAppearances?.[index],
        );
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
      drawDirectionalCharacter(ctx, player.characterId, trailX, 27 + trailY, 72, player.facing, 1);
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
      ? -Math.sin(progress * Math.PI) * 1.5
      : Math.sin(now / 350 + player.id) * 0.7;
    drawDirectionalCharacter(
      ctx,
      player.characterId,
      0,
      27 + bob,
      72,
      player.facing,
      walking && progress > 0.15 && progress < 0.8 ? 1 : 0,
      player.effect?.type === 1,
    );
    ctx.textAlign = 'center';
    ctx.font = 'bold 11px monospace';
    ctx.fillStyle = colors[player.id];
    ctx.strokeStyle = '#172331';
    ctx.lineWidth = 3;
    ctx.strokeText(`P${player.id + 1}`, 0, 34);
    ctx.fillText(`P${player.id + 1}`, 0, 34);
    if (player.effect) {
      ctx.font = '22px sans-serif';
      ctx.fillText(itemIcons[player.effect.type], 0, -42);
    }
    if (action?.type === 'break') {
      ctx.font = '24px sans-serif';
      const [hammerX, hammerY] = [
        [-23, 0],
        [0, -30],
        [23, 0],
        [0, 15],
      ][player.facing ?? 3];
      ctx.fillText('🔨', hammerX, hammerY + Math.sin(progress * 10) * 8);
    }
    if (['confused', 'penalty'].includes(action?.type)) {
      ctx.font = 'bold 25px monospace';
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = '#172331';
      ctx.lineWidth = 3;
      ctx.strokeText('?', 24, -20);
      ctx.fillText('?', 24, -20);
    }
    if (action?.type === 'jump-failed') {
      ctx.font = '20px sans-serif';
      ctx.fillText('✧', 20 + progress * 15, -30 + progress * 12);
    }
    ctx.restore();
  }
  for (const player of game.players) drawCoinPickup(ctx, player, now, game.columns, cell, pad);
}

try {
  await Promise.all([loadCharacters(), loadCoins()]);
  for (const sample of document.querySelectorAll('.coin-sample'))
    drawCoinSample(sample.getContext('2d'), Number(sample.dataset.value));
  charactersReady = true;
  $('character-load-status').textContent = '';
  for (const card of document.querySelectorAll('.character-card')) {
    const portrait = card.querySelector('canvas');
    drawCharacter(portrait.getContext('2d'), card.querySelector('input').value, 90, 198, 200);
  }
  drawCharacter($('dummy-portrait').getContext('2d'), 'kobi', 40, 100, 100);
} catch {
  $('character-load-status').textContent = '게임 이미지를 불러오지 못했습니다. 새로고침해 주세요.';
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
  const previous = sessionStorage.getItem(matchStorageKey);
  if (previous) {
    const result = await fetch(`/api/matches/${previous}`);
    if (result.ok) {
      matchId = previous;
      connect();
    } else sessionStorage.removeItem(matchStorageKey);
  }
} catch {
  setError('서버 연결을 확인한 후 새로고침하세요.');
}
controls();
draw();

try {
  const session = testMode ? null : await accountBar();
  if (session?.user) {
    loggedIn = true;
    const duelOption = $('match-mode').querySelector('option[value="duel"]');
    duelOption.hidden = false;
    duelOption.disabled = false;
    $('saved-algorithms').hidden = false;
    const updateHistory = async () => {
      history = (await api('/api/history')).history;
      const selected = historyId;
      $('history-select').replaceChildren(new Option('경기 기록을 선택하세요', ''));
      for (const entry of history) {
        const playedAt = new Date(entry.playedAt).toLocaleString('ko-KR');
        $('history-select').add(
          new Option(
            `${playedAt} · ${entry.mapName} · ${entry.algorithmName} · ${entry.score}점`,
            entry.id,
          ),
        );
      }
      $('history-select').value = history.some((entry) => entry.id === selected) ? selected : '';
      historyId = $('history-select').value;
      controls();
    };
    refreshHistory = updateHistory;
    await updateHistory();
    $('history-refresh').addEventListener('click', () =>
      updateHistory().catch((error) => setError(error.message)),
    );
    const updateLibrary = async () => {
      const data = await api('/api/algorithms');
      for (const id of ['saved-current']) {
        $(id).replaceChildren(new Option('현재 코드 불러오기', ''));
        for (const item of data.algorithms) $(id).add(new Option(item.name, item.id));
      }
    };
    await updateLibrary();
    controls();
    $('refresh-library').addEventListener('click', () => {
      if (!busy && !active()) updateLibrary().catch((error) => setError(error.message));
    });
    for (const id of ['saved-current']) {
      $(id).addEventListener('change', async () => {
        if (!$(id).value || busy || active()) return;
        try {
          const item = await api(`/api/algorithms/${$(id).value}`);
          if (busy || active()) return;
          await loadFile(new File([item.source], item.name + '.js'));
          controls();
        } catch (error) {
          setError(error.message);
        }
      });
    }
  }
} catch (error) {
  setError(error.message);
}
window.addEventListener('message', async (event) => {
  if (
    event.origin !== location.origin ||
    event.source !== window.parent ||
    window.parent === window ||
    event.data?.type !== 'editor-prepare'
  )
    return;
  const feedback = (message) =>
    window.parent.postMessage({ type: 'editor-feedback', message }, location.origin);
  try {
    if (busy || active()) throw new Error('진행 중인 경기를 먼저 종료하세요.');
    if (!(await api('/api/session')).user) throw new Error('로그인이 필요합니다.');
    if (typeof event.data.source !== 'string') throw new Error('코드가 필요합니다.');
    events?.close();
    matchId = null;
    sessionStorage.removeItem(matchStorageKey);
    renderLogs([]);
    setupStep = 'file';
    preview();
    await loadFile(new File([event.data.source], '편집 중 코드.js'));
    showSetupStep('settings');
    window.parent.postMessage(
      { type: 'editor-prepared', requestId: event.data.requestId },
      location.origin,
    );
    feedback('코드를 전달했습니다. 맵과 시작 위치를 선택한 뒤 테스트를 시작하세요.');
  } catch (error) {
    feedback(error.message);
  }
});
if (window.parent !== window) {
  document.body.classList.add('embedded-game');
  window.parent.postMessage({ type: 'editor-ready' }, location.origin);
}
