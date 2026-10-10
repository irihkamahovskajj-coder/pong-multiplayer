'use strict';
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const CLIENT_ORIGINS = (process.env.CLIENT_ORIGIN || '*').split(',').map(s => s.trim());
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: CLIENT_ORIGINS.includes('*') ? '*' : CLIENT_ORIGINS, methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling']
});
app.get('/', (_req, res) => res.json({ name: 'Pong Multiplayer API', status: 'ok' }));
app.get('/health', (_req, res) => res.status(200).send('ok'));

const W = 900, H = 600, MAX_PLAYERS = 4, PADDLE_LEN = 112, PADDLE_THICK = 12;
const rooms = new Map();
const cleanName = value => String(value || 'Player').trim().replace(/[<>\u0000-\u001f]/g, '').slice(0, 16) || 'Player';
const makeCode = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = Array.from({ length: 5 }, () => chars[crypto.randomInt(chars.length)]).join(''); } while (rooms.has(code));
  return code;
};
function playerView(p) {
  return { id: p.id, name: p.name, side: p.side, score: p.score, paddle: p.paddle, ready: p.ready };
}
function publicRoom(room) {
  return { code: room.code, status: room.status, players: [...room.players.values()].map(playerView), maxPlayers: MAX_PLAYERS };
}
function broadcastRoom(room) { io.to(room.code).emit('room:update', publicRoom(room)); }
function assignSides(room) {
  const sides = room.players.size === 2 ? ['left', 'right'] : room.players.size === 3 ? ['left', 'right', 'top'] : ['left', 'right', 'top', 'bottom'];
  [...room.players.values()].forEach((p, i) => { p.side = sides[i]; p.score = 0; p.paddle = 0.5; });
}
function resetBall(room, toward = null) {
  const angle = (Math.random() * 0.8 - 0.4) + (toward === 'left' ? Math.PI : 0);
  room.ball = { x: W / 2, y: H / 2, vx: Math.cos(angle) * 5, vy: Math.sin(angle) * 5 };
  if (Math.random() < 0.5 && toward === null) room.ball.vx *= -1;
}
function startGame(room) {
  if (room.players.size < 2) return false;
  assignSides(room); room.status = 'playing'; room.winner = null; resetBall(room);
  room.lastHit = null; room.lastTick = Date.now(); broadcastRoom(room); return true;
}
function finishRoom(room) {
  if (room.timer) clearInterval(room.timer);
  rooms.delete(room.code);
  io.to(room.code).emit('room:closed', { message: 'Комната закрыта.' });
}
function moveBall(room, dt) {
  const b = room.ball; const speedScale = Math.min(dt / 16.67, 2);
  b.x += b.vx * speedScale; b.y += b.vy * speedScale;
  // Paddle collision; side paddles slide vertically, top/bottom horizontally.
  for (const p of room.players.values()) {
    if (p.side === 'left' && b.vx < 0 && b.x <= 28 && b.x >= 12 && Math.abs(b.y - p.paddle * H) <= PADDLE_LEN / 2 + 7) {
      b.x = 29; b.vx = Math.abs(b.vx) * 1.04; b.vy += (b.y - p.paddle * H) * 0.035; room.lastHit = p.id;
    } else if (p.side === 'right' && b.vx > 0 && b.x >= W - 28 && b.x <= W - 12 && Math.abs(b.y - p.paddle * H) <= PADDLE_LEN / 2 + 7) {
      b.x = W - 29; b.vx = -Math.abs(b.vx) * 1.04; b.vy += (b.y - p.paddle * H) * 0.035; room.lastHit = p.id;
    } else if (p.side === 'top' && b.vy < 0 && b.y <= 28 && b.y >= 12 && Math.abs(b.x - p.paddle * W) <= PADDLE_LEN / 2 + 7) {
      b.y = 29; b.vy = Math.abs(b.vy) * 1.04; b.vx += (b.x - p.paddle * W) * 0.035; room.lastHit = p.id;
    } else if (p.side === 'bottom' && b.vy > 0 && b.y >= H - 28 && b.y <= H - 12 && Math.abs(b.x - p.paddle * W) <= PADDLE_LEN / 2 + 7) {
      b.y = H - 29; b.vy = -Math.abs(b.vy) * 1.04; b.vx += (b.x - p.paddle * W) * 0.035; room.lastHit = p.id;
    }
  }
  const hasSide = side => [...room.players.values()].some(p => p.side === side);
  if (b.x < 0) {
    if (hasSide('left')) scoreMiss(room, 'left'); else { b.x = 1; b.vx = Math.abs(b.vx); }
  } else if (b.x > W) {
    if (hasSide('right')) scoreMiss(room, 'right'); else { b.x = W - 1; b.vx = -Math.abs(b.vx); }
  }
  if (b.y < 0) {
    if (hasSide('top')) scoreMiss(room, 'top'); else { b.y = 1; b.vy = Math.abs(b.vy); }
  } else if (b.y > H) {
    if (hasSide('bottom')) scoreMiss(room, 'bottom'); else { b.y = H - 1; b.vy = -Math.abs(b.vy); }
  }
  const mag = Math.hypot(b.vx, b.vy), max = 10;
  if (mag > max) { b.vx = b.vx / mag * max; b.vy = b.vy / mag * max; }
}
function scoreMiss(room, missedSide) {
  const missed = [...room.players.values()].find(p => p.side === missedSide);
  for (const p of room.players.values()) if (!missed || p.id !== missed.id) p.score++;
  const scores = [...room.players.values()];
  const leader = scores.sort((a, b) => b.score - a.score)[0];
  if (leader && leader.score >= 10) {
    room.status = 'finished'; room.winner = leader.id;
    io.to(room.code).emit('game:over', { winner: playerView(leader), players: [...room.players.values()].map(playerView) });
    broadcastRoom(room);
    return;
  }
  resetBall(room);
  io.to(room.code).emit('game:point', { missed: missed ? missed.name : null, players: [...room.players.values()].map(playerView) });
}
function sendState(room) {
  io.to(room.code).emit('game:state', { ball: room.ball, players: [...room.players.values()].map(playerView), status: room.status, winner: room.winner });
}
function getRoomForSocket(socket) {
  const code = socket.data.roomCode;
  return code ? rooms.get(code) : null;
}
function leaveRoom(socket) {
  const room = getRoomForSocket(socket); if (!room) return;
  room.players.delete(socket.id); socket.leave(room.code); socket.data.roomCode = null;
  if (room.players.size === 0) { finishRoom(room); return; }
  if (room.status === 'playing' || room.status === 'finished') room.status = 'waiting';
  broadcastRoom(room);
}

io.on('connection', socket => {
  socket.on('room:create', (payload = {}, callback = () => {}) => {
    if (getRoomForSocket(socket)) leaveRoom(socket);
    const code = makeCode();
    const room = { code, status: 'waiting', players: new Map(), ball: { x: W/2, y: H/2, vx: 5, vy: 3 }, winner: null, lastHit: null, timer: null, lastTick: Date.now() };
    room.players.set(socket.id, { id: socket.id, name: cleanName(payload.name), side: null, score: 0, paddle: 0.5, ready: true });
    rooms.set(code, room); socket.join(code); socket.data.roomCode = code;
    callback({ ok: true, room: publicRoom(room) }); broadcastRoom(room);
  });
  socket.on('room:join', (payload = {}, callback = () => {}) => {
    const code = String(payload.code || '').trim().toUpperCase(); const room = rooms.get(code);
    if (!room) return callback({ ok: false, error: 'Комната не найдена. Проверь код.' });
    if (room.players.size >= MAX_PLAYERS) return callback({ ok: false, error: 'Комната уже заполнена (4 игрока).' });
    if (room.status === 'playing') return callback({ ok: false, error: 'Игра уже началась.' });
    if (getRoomForSocket(socket)) leaveRoom(socket);
    room.players.set(socket.id, { id: socket.id, name: cleanName(payload.name), side: null, score: 0, paddle: 0.5, ready: true });
    socket.join(code); socket.data.roomCode = code;
    callback({ ok: true, room: publicRoom(room) }); broadcastRoom(room);
  });
  socket.on('game:start', (_payload, callback = () => {}) => {
    const room = getRoomForSocket(socket);
    if (!room) return callback({ ok: false, error: 'Сначала войди в комнату.' });
    if (room.players.size < 2) return callback({ ok: false, error: 'Нужно минимум 2 игрока.' });
    if (room.status === 'playing') return callback({ ok: false, error: 'Игра уже идёт.' });
    startGame(room); callback({ ok: true });
    if (room.timer) clearInterval(room.timer);
    room.timer = setInterval(() => {
      if (room.status !== 'playing') return;
      const now = Date.now(); const dt = Math.min(now - room.lastTick, 40); room.lastTick = now;
      moveBall(room, dt); sendState(room);
    }, 1000 / 60);
  });
  socket.on('game:input', payload => {
    const room = getRoomForSocket(socket); if (!room || room.status !== 'playing') return;
    const p = room.players.get(socket.id); if (!p) return;
    const value = Number(payload && payload.position);
    if (Number.isFinite(value)) p.paddle = Math.max(0.1, Math.min(0.9, value));
  });
  socket.on('room:leave', () => leaveRoom(socket));
  socket.on('disconnect', () => leaveRoom(socket));
});
server.listen(PORT, '0.0.0.0', () => console.log(`Pong server listening on ${PORT}`));
