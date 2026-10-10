'use strict';
// IMPORTANT: replace this with your deployed Render service URL, without a trailing slash.
const SERVER_URL = 'https://YOUR-RENDER-SERVICE.onrender.com';
const socket = io(SERVER_URL, { transports: ['websocket', 'polling'], reconnection: true, timeout: 20000 });
const $ = id => document.getElementById(id);
const views = { lobby: $('lobby'), room: $('roomPanel'), game: $('gamePanel') };
let currentRoom = null, gameState = null, overlayMode = 'start', lastPointerSent = 0, lastPointMessage = '';
const canvas = $('gameCanvas'), ctx = canvas.getContext('2d');
function showView(name) { Object.entries(views).forEach(([key, el]) => el.classList.toggle('hidden', key !== name)); }
function nameValue() { return $('playerName').value.trim() || 'Player'; }
function setMessage(id, text, ok = false) { const el = $(id); el.textContent = text || ''; el.style.color = ok ? '#63f5e3' : '#ffb4d8'; }
function request(event, payload = {}) { return new Promise(resolve => socket.emit(event, payload, resolve)); }
function updateConnection(online, text) { $('connectionDot').parentElement.classList.toggle('online', online); $('connectionText').textContent = text; }
socket.on('connect', () => updateConnection(true, 'На связи'));
socket.on('disconnect', () => updateConnection(false, 'Переподключение…'));
socket.on('connect_error', () => updateConnection(false, 'Нет соединения'));
socket.on('room:update', room => {
  currentRoom = room; $('roomCodeLabel').textContent = room.code; $('inviteCode').textContent = room.code; $('gameRoomCode').textContent = room.code;
  $('playerCount').textContent = `${room.players.length} / ${room.maxPlayers}`;
  $('playersList').innerHTML = '';
  room.players.forEach((p, i) => {
    const row = document.createElement('div'); row.className = 'player-row';
    const avatar = document.createElement('div'); avatar.className = 'player-avatar'; avatar.textContent = p.name.slice(0, 1).toUpperCase();
    const details = document.createElement('div'); details.className = 'player-details';
    const strong = document.createElement('strong'); strong.textContent = p.name + (p.id === socket.id ? ' (ты)' : '');
    const small = document.createElement('small'); small.textContent = p.side ? `Позиция: ${sideRu(p.side)}` : (i === 0 ? 'Создатель комнаты' : 'Готов к игре');
    details.append(strong, small); const status = document.createElement('div'); status.className = 'player-status'; status.textContent = i === 0 ? 'HOST' : 'READY';
    row.append(avatar, details, status); $('playersList').appendChild(row);
  });
  for (let i = room.players.length; i < 4; i++) { const slot = document.createElement('div'); slot.className = 'empty-slot'; slot.textContent = '+ Ожидаем игрока'; $('playersList').appendChild(slot); }
  $('startBtn').disabled = room.players.length < 2; $('startBtn').style.opacity = room.players.length < 2 ? '.55' : '1';
  if (room.status === 'waiting') { showView('room'); hideOverlay(); }
  if (room.status === 'playing') { showView('game'); }
  if (room.status === 'finished') { showView('game'); }
});
socket.on('game:state', state => { gameState = state; renderGame(); renderScores(state.players); });
socket.on('game:point', data => {
  gameState = { ...(gameState || {}), players: data.players };
  const me = data.players.find(p => p.id === socket.id);
  lastPointMessage = data.missed ? `${data.missed} не отбил мяч. ${me ? `Твой счёт: ${me.score}` : ''}` : 'Очко!';
  setMessage('gameMessage', lastPointMessage, true); renderScores(data.players);
});
socket.on('game:over', data => {
  gameState = { ...(gameState || {}), players: data.players, status: 'finished', winner: data.winner.id };
  showOverlay(data.winner.id === socket.id ? 'Ты победил! 🎉' : `Победитель: ${data.winner.name}`, 'Матч завершён. Можно начать реванш из лобби.', 'В лобби', 'lobby'); renderScores(data.players);
});
socket.on('room:closed', data => { currentRoom = null; gameState = null; showView('lobby'); setMessage('lobbyMessage', data.message || 'Комната закрыта.'); });
function sideRu(side) { return ({ left: 'слева', right: 'справа', top: 'сверху', bottom: 'снизу' })[side] || 'назначится при старте'; }
$('createBtn').addEventListener('click', async () => { setMessage('lobbyMessage', ''); if (!socket.connected) return setMessage('lobbyMessage', 'Сервер пока недоступен. Подожди немного и попробуй снова.'); const res = await request('room:create', { name: nameValue() }); if (res && res.ok) { currentRoom = res.room; showView('room'); } else setMessage('lobbyMessage', res?.error || 'Не удалось создать комнату.'); });
$('joinBtn').addEventListener('click', async () => { setMessage('lobbyMessage', ''); const code = $('roomCode').value.trim().toUpperCase(); if (code.length < 4) return setMessage('lobbyMessage', 'Введи код комнаты.'); if (!socket.connected) return setMessage('lobbyMessage', 'Сервер пока недоступен.'); const res = await request('room:join', { code, name: nameValue() }); if (res && res.ok) { currentRoom = res.room; showView('room'); } else setMessage('lobbyMessage', res?.error || 'Не удалось войти.'); });
$('roomCode').addEventListener('input', e => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5); });
$('startBtn').addEventListener('click', async () => { setMessage('roomMessage', ''); const res = await request('game:start'); if (!res?.ok) setMessage('roomMessage', res?.error || 'Не удалось начать игру.'); else { showView('game'); hideOverlay(); } });
$('leaveBtn').addEventListener('click', leaveRoom);
$('backToRoomBtn').addEventListener('click', () => { if (currentRoom) { socket.emit('room:leave'); currentRoom = null; gameState = null; } hideOverlay(); showView('lobby'); });
$('copyBtn').addEventListener('click', async () => { if (!currentRoom) return; try { await navigator.clipboard.writeText(currentRoom.code); $('copyBtn').textContent = 'Скопировано ✓'; setTimeout(() => $('copyBtn').textContent = 'Копировать код', 1500); } catch { setMessage('roomMessage', `Код комнаты: ${currentRoom.code}`, true); } });
async function leaveRoom() { socket.emit('room:leave'); currentRoom = null; gameState = null; hideOverlay(); showView('lobby'); setMessage('lobbyMessage', 'Ты вышел из комнаты.', true); }
function showOverlay(title, text, buttonText, mode) { overlayMode = mode; $('overlayTitle').textContent = title; $('overlayText').textContent = text; $('overlayButton').textContent = buttonText; $('gameOverlay').classList.remove('hidden'); }
function hideOverlay() { $('gameOverlay').classList.add('hidden'); }
$('overlayButton').addEventListener('click', async () => { if (overlayMode === 'lobby') { hideOverlay(); showView('lobby'); } else if (overlayMode === 'start') { const res = await request('game:start'); if (res?.ok) hideOverlay(); else $('overlayText').textContent = res?.error || 'Не удалось начать матч.'; } });
function sendPosition(clientX, clientY) {
  if (!currentRoom || !gameState || gameState.status === 'finished') return;
  const me = gameState.players?.find(p => p.id === socket.id); if (!me?.side) return;
  const rect = canvas.getBoundingClientRect(); let position;
  if (me.side === 'left' || me.side === 'right') position = ((clientY - rect.top) / rect.height);
  else position = ((clientX - rect.left) / rect.width);
  const now = performance.now(); if (now - lastPointerSent < 16) return; lastPointerSent = now;
  socket.emit('game:input', { position });
}
canvas.addEventListener('pointermove', e => sendPosition(e.clientX, e.clientY));
canvas.addEventListener('pointerdown', e => { canvas.setPointerCapture?.(e.pointerId); sendPosition(e.clientX, e.clientY); });
window.addEventListener('keydown', e => {
  if (!gameState || gameState.status !== 'playing') return;
  const me = gameState.players?.find(p => p.id === socket.id); if (!me?.side) return;
  const keys = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'w', 'a', 's', 'd']; if (!keys.includes(e.key)) return; e.preventDefault();
  const vertical = me.side === 'left' || me.side === 'right'; const up = vertical ? ['ArrowUp', 'w'] : ['ArrowLeft', 'a']; const down = vertical ? ['ArrowDown', 's'] : ['ArrowRight', 'd'];
  const delta = up.includes(e.key) ? -.045 : down.includes(e.key) ? .045 : 0; if (delta) socket.emit('game:input', { position: Math.max(.1, Math.min(.9, me.paddle + delta)) });
});
function renderScores(players = []) {
  $('scoreboard').innerHTML = '';
  players.forEach(p => { const chip = document.createElement('div'); chip.className = 'score-chip'; const name = document.createElement('span'); name.textContent = p.name + (p.id === socket.id ? ' •' : ''); const score = document.createElement('strong'); score.textContent = p.score; chip.append(name, score); $('scoreboard').appendChild(chip); });
}
function roundRect(x, y, w, h, r) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); }
function renderGame() {
  const w = canvas.width, h = canvas.height; ctx.clearRect(0, 0, w, h);
  const bg = ctx.createLinearGradient(0, 0, w, h); bg.addColorStop(0, '#0c1529'); bg.addColorStop(1, '#080d1a'); ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = 'rgba(130,160,210,.08)'; ctx.lineWidth = 1;
  for (let x = 30; x < w; x += 30) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
  for (let y = 30; y < h; y += 30) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
  ctx.strokeStyle = 'rgba(130,160,210,.3)'; ctx.setLineDash([8, 10]); ctx.beginPath(); ctx.moveTo(w/2, 0); ctx.lineTo(w/2, h); ctx.stroke(); ctx.setLineDash([]);
  const players = gameState?.players || [];
  players.forEach(p => {
    const me = p.id === socket.id; ctx.fillStyle = me ? '#63f5e3' : '#a58bff'; ctx.shadowColor = ctx.fillStyle; ctx.shadowBlur = me ? 17 : 9;
    if (p.side === 'left') roundRect(13, p.paddle*h - 56, 12, 112, 6);
    else if (p.side === 'right') roundRect(w-25, p.paddle*h - 56, 12, 112, 6);
    else if (p.side === 'top') roundRect(p.paddle*w - 56, 13, 112, 12, 6);
    else if (p.side === 'bottom') roundRect(p.paddle*w - 56, h-25, 112, 12, 6);
    ctx.fill(); ctx.shadowBlur = 0;
  });
  if (gameState?.ball) { const b = gameState.ball; ctx.beginPath(); ctx.arc(b.x, b.y, 8, 0, Math.PI*2); ctx.fillStyle = '#fff'; ctx.shadowColor = '#63f5e3'; ctx.shadowBlur = 22; ctx.fill(); ctx.shadowBlur = 0; }
  if (!gameState || gameState.status !== 'playing') { ctx.fillStyle = 'rgba(180,200,240,.6)'; ctx.font = '14px DM Mono, monospace'; ctx.textAlign = 'center'; ctx.fillText('WAITING FOR MATCH…', w/2, h/2+55); }
}
function animationLoop() { if (!views.game.classList.contains('hidden')) renderGame(); requestAnimationFrame(animationLoop); }
requestAnimationFrame(animationLoop);
