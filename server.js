'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_PLAYERS = 8;
const MIN_PLAYERS = 2;
const STARTING_DICE = 5;
const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const ROOM_IDLE_MS = 45 * 60 * 1000; // sweep rooms idle (all disconnected) this long
const NEXT_ROUND_DELAY_MS = 5000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

/** @type {Map<string, Room>} */
const rooms = new Map();

function randomCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += ROOM_CODE_CHARS[crypto.randomInt(ROOM_CODE_CHARS.length)];
  } while (rooms.has(code));
  return code;
}

function rank(face) { return face === 1 ? 7 : face; }
function faceLabel(face) { return face === 1 ? 'As (fou)' : String(face); }

function countFace(allDice, face) {
  if (face === 1) return allDice.filter((d) => d === 1).length;
  return allDice.filter((d) => d === face || d === 1).length;
}

function rollDice(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(1 + crypto.randomInt(6));
  return out;
}

class Room {
  constructor(code) {
    this.code = code;
    /** @type {Map<string, Player>} token -> player */
    this.players = new Map();
    this.order = []; // tokens, join order (fixed membership order)
    this.hostToken = null;
    this.phase = 'lobby'; // lobby | round | reveal | ended
    this.currentBid = null; // {qty, face, byToken}
    this.turnToken = null;
    this.roundNum = 0;
    this.log = [];
    this.chat = [];
    this.winnerToken = null;
    this.createdAt = Date.now();
    this.roundTimer = null;
  }

  aliveTokens() {
    return this.order.filter((t) => {
      const p = this.players.get(t);
      return p && p.diceCount > 0;
    });
  }

  nextAliveAfter(token) {
    const alive = this.aliveTokens();
    if (alive.length === 0) return null;
    const idx = alive.indexOf(token);
    if (idx === -1) return alive[0];
    return alive[(idx + 1) % alive.length];
  }

  addLog(text) {
    this.log.push({ text, t: Date.now() });
    if (this.log.length > 60) this.log.shift();
  }

  addChat(id, name, text) {
    this.chat.push({ id, name, text, t: Date.now() });
    if (this.chat.length > 50) this.chat.shift();
  }

  everyoneDisconnected() {
    for (const p of this.players.values()) if (p.connected) return false;
    return true;
  }

  publicState() {
    return {
      code: this.code,
      phase: this.phase,
      hostId: this.hostToken,
      roundNum: this.roundNum,
      turnId: this.turnToken,
      currentBid: this.currentBid
        ? { qty: this.currentBid.qty, face: this.currentBid.face, byId: this.currentBid.byToken }
        : null,
      log: this.log.slice(-40).map((l) => l.text),
      chat: this.chat.slice(-50).map((c) => ({ id: c.id, name: c.name, text: c.text })),
      winnerId: this.winnerToken,
      players: this.order.map((t) => {
        const p = this.players.get(t);
        return {
          id: t,
          name: p.name,
          diceCount: p.diceCount,
          connected: p.connected,
          eliminated: p.diceCount === 0 && this.phase !== 'lobby',
        };
      }),
    };
  }
}

class Player {
  constructor(token, name) {
    this.token = token;
    this.name = name;
    this.diceCount = STARTING_DICE;
    this.dice = [];
    this.connected = true;
    this.ws = null;
  }
}

function send(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) {
    try { ws.send(JSON.stringify(msg)); } catch (_) { /* ignore */ }
  }
}

function broadcastState(room) {
  const state = room.publicState();
  for (const p of room.players.values()) send(p.ws, { type: 'roomState', state });
  broadcastLobbyList();
}

function sendYourDice(room, player) {
  send(player.ws, { type: 'yourDice', dice: player.dice, diceCount: player.diceCount });
}

function sendError(ws, message) {
  send(ws, { type: 'error', message });
}

function openRoomList() {
  const list = [];
  for (const room of rooms.values()) {
    if (room.phase === 'lobby' && room.order.length < MAX_PLAYERS) {
      const host = room.players.get(room.hostToken);
      list.push({
        code: room.code,
        hostName: host ? host.name : '?',
        playerCount: room.order.length,
        maxPlayers: MAX_PLAYERS,
      });
    }
  }
  return list;
}

function broadcastLobbyList() {
  const list = openRoomList();
  for (const ws of wss.clients) {
    if (!ws.roomCode) send(ws, { type: 'roomList', rooms: list });
  }
}

function startRound(room, starterToken) {
  room.roundNum += 1;
  room.currentBid = null;
  room.phase = 'round';
  for (const p of room.players.values()) {
    if (p.diceCount > 0) p.dice = rollDice(p.diceCount);
    else p.dice = [];
  }
  const alive = room.aliveTokens();
  room.turnToken = alive.includes(starterToken) ? starterToken : alive[0];
  room.addLog(`— Manche ${room.roundNum} : ${room.players.get(room.turnToken).name} ouvre les enchères —`);
  for (const p of room.players.values()) sendYourDice(room, p);
  broadcastState(room);
}

function checkWinner(room) {
  const alive = room.aliveTokens();
  if (alive.length <= 1) {
    room.phase = 'ended';
    room.winnerToken = alive[0] || null;
    room.currentBid = null;
    room.turnToken = null;
    broadcastState(room);
    return true;
  }
  return false;
}

function scheduleNextRound(room, starterToken) {
  room.phase = 'reveal';
  broadcastState(room);
  clearTimeout(room.roundTimer);
  room.roundTimer = setTimeout(() => {
    if (room.phase !== 'reveal') return;
    if (checkWinner(room)) return;
    startRound(room, starterToken);
  }, NEXT_ROUND_DELAY_MS);
}

function loseDie(room, token) {
  const p = room.players.get(token);
  if (!p || p.diceCount <= 0) return;
  p.diceCount -= 1;
  room.addLog(`${p.name} perd un dé (il lui en reste ${p.diceCount}).`);
}

function handleChallenge(room, callerToken, kind) {
  const bid = room.currentBid;
  if (!bid) return;
  const allDice = [];
  const revealDice = {};
  for (const p of room.players.values()) {
    if (p.diceCount > 0) {
      revealDice[p.token] = p.dice;
      allDice.push(...p.dice);
    }
  }
  const actual = countFace(allDice, bid.face);
  const bidText = `${bid.qty} × ${faceLabel(bid.face)}`;
  const caller = room.players.get(callerToken);
  let starter;
  let resultText;

  if (kind === 'liar') {
    room.addLog(`${caller.name} crie Menteur ! sur ${bidText}.`);
    const bidderLost = actual < bid.qty;
    const loserToken = bidderLost ? bid.byToken : callerToken;
    resultText = `Décompte réel : ${actual}. ${bidderLost ? 'La mise était un bluff !' : 'Le compte est bon.'}`;
    room.addLog(resultText);
    loseDie(room, loserToken);
    starter = loserToken;
  } else {
    room.addLog(`${caller.name} tente Dans le mille ! ${bidText}.`);
    const correct = actual === bid.qty;
    resultText = `Décompte réel : ${actual}. ${correct ? 'En plein dans le mille !' : 'Pas tout à fait.'}`;
    room.addLog(resultText);
    if (correct) {
      for (const t of room.order) {
        if (t !== callerToken) loseDie(room, t);
      }
      starter = callerToken;
    } else {
      loseDie(room, callerToken);
      starter = callerToken;
    }
  }

  send_reveal(room, bid, revealDice, actual, resultText);
  scheduleNextRound(room, starter);
}

function send_reveal(room, bid, revealDice, actual, resultText) {
  const msg = {
    type: 'reveal',
    bid: { qty: bid.qty, face: bid.face, byId: bid.byToken },
    dice: revealDice,
    actual,
    resultText,
  };
  for (const p of room.players.values()) send(p.ws, msg);
}

function isValidRaise(room, qty, face, current) {
  const total = room.order.reduce((s, t) => s + room.players.get(t).diceCount, 0);
  if (!Number.isInteger(qty) || !Number.isInteger(face) || face < 1 || face > 6) return false;
  if (qty < 1 || qty > total) return false;
  if (!current) return true;
  if (qty > current.qty) return true;
  if (qty === current.qty && rank(face) > rank(current.face)) return true;
  return false;
}

function createRoom() {
  const code = randomCode();
  const room = new Room(code);
  rooms.set(code, room);
  return room;
}

function handleJoin(ws, msg) {
  let room;
  let token = typeof msg.token === 'string' ? msg.token : null;
  const name = (typeof msg.name === 'string' ? msg.name : '').trim().slice(0, 24) || 'Marin';

  if (msg.create) {
    room = createRoom();
    token = crypto.randomUUID();
    const player = new Player(token, name);
    player.ws = ws;
    room.players.set(token, player);
    room.order.push(token);
    room.hostToken = token;
    ws.roomCode = room.code;
    ws.token = token;
    send(ws, { type: 'joined', roomCode: room.code, token, youId: token });
    broadcastState(room);
    return;
  }

  const roomCode = (typeof msg.roomCode === 'string' ? msg.roomCode : '').toUpperCase().trim();
  room = rooms.get(roomCode);
  if (!room) { sendError(ws, "Aucun équipage trouvé avec ce code."); return; }

  if (token && room.players.has(token)) {
    const player = room.players.get(token);
    player.connected = true;
    player.ws = ws;
    if (name) player.name = name;
    ws.roomCode = room.code;
    ws.token = token;
    send(ws, { type: 'joined', roomCode: room.code, token, youId: token });
    room.addLog(`${player.name} est de retour à bord.`);
    if (room.phase !== 'lobby') sendYourDice(room, player);
    broadcastState(room);
    return;
  }

  if (room.phase !== 'lobby') { sendError(ws, "Cet équipage a déjà pris la mer — partie en cours."); return; }
  if (room.order.length >= MAX_PLAYERS) { sendError(ws, "Cet équipage est au complet."); return; }

  token = crypto.randomUUID();
  const player = new Player(token, name);
  player.ws = ws;
  room.players.set(token, player);
  room.order.push(token);
  ws.roomCode = room.code;
  ws.token = token;
  send(ws, { type: 'joined', roomCode: room.code, token, youId: token });
  room.addLog(`${player.name} rejoint l'équipage.`);
  broadcastState(room);
}

function handleStart(ws) {
  const room = rooms.get(ws.roomCode);
  if (!room || ws.token !== room.hostToken) return;
  if (room.phase !== 'lobby' && room.phase !== 'ended') return;
  if (room.order.length < MIN_PLAYERS) { sendError(ws, `Il faut au moins ${MIN_PLAYERS} marins pour commencer.`); return; }
  for (const p of room.players.values()) p.diceCount = STARTING_DICE;
  room.roundNum = 0;
  room.winnerToken = null;
  startRound(room, room.order[0]);
}

function handleKick(ws, msg) {
  const room = rooms.get(ws.roomCode);
  if (!room || ws.token !== room.hostToken) return;
  if (room.phase !== 'lobby') return;
  const target = msg.playerId;
  if (!room.players.has(target) || target === room.hostToken) return;
  room.players.delete(target);
  room.order = room.order.filter((t) => t !== target);
  broadcastState(room);
}

function handleBid(ws, msg) {
  const room = rooms.get(ws.roomCode);
  if (!room || room.phase !== 'round' || room.turnToken !== ws.token) return;
  const qty = Math.trunc(msg.qty);
  const face = Math.trunc(msg.face);
  if (!isValidRaise(room, qty, face, room.currentBid)) { sendError(ws, "Ça ne relance rien, moussaillon — mise plus haut."); return; }
  room.currentBid = { qty, face, byToken: ws.token };
  const player = room.players.get(ws.token);
  room.addLog(`${player.name} mise ${qty} × ${faceLabel(face)}.`);
  room.turnToken = room.nextAliveAfter(ws.token);
  broadcastState(room);
}

function handleChallengeMsg(ws, kind) {
  const room = rooms.get(ws.roomCode);
  if (!room || room.phase !== 'round' || room.turnToken !== ws.token || !room.currentBid) return;
  handleChallenge(room, ws.token, kind);
}

function handleLeave(ws) {
  const room = rooms.get(ws.roomCode);
  if (room) {
    const player = room.players.get(ws.token);
    if (player) {
      player.connected = false;
      player.ws = null;
      room.addLog(`${player.name} descend sous le pont.`);
      broadcastState(room);
    }
  }
  ws.roomCode = null;
  ws.token = null;
  send(ws, { type: 'roomList', rooms: openRoomList() });
}

function handleListRooms(ws) {
  send(ws, { type: 'roomList', rooms: openRoomList() });
}

function handleChat(ws, msg) {
  const room = rooms.get(ws.roomCode);
  if (!room) return;
  const player = room.players.get(ws.token);
  if (!player) return;
  const text = (typeof msg.text === 'string' ? msg.text : '').trim().slice(0, 200);
  if (!text) return;
  room.addChat(ws.token, player.name, text);
  broadcastState(room);
}

const server = http.createServer((req, res) => {
  let reqPath = decodeURIComponent(req.url.split('?')[0]);
  if (reqPath === '/') reqPath = '/index.html';
  const filePath = path.join(PUBLIC_DIR, reqPath);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
    if (!msg || typeof msg.type !== 'string') return;
    try {
      switch (msg.type) {
        case 'join': handleJoin(ws, msg); break;
        case 'start': handleStart(ws); break;
        case 'kick': handleKick(ws, msg); break;
        case 'bid': handleBid(ws, msg); break;
        case 'liar': handleChallengeMsg(ws, 'liar'); break;
        case 'spoton': handleChallengeMsg(ws, 'spoton'); break;
        case 'leave': handleLeave(ws); break;
        case 'chat': handleChat(ws, msg); break;
        case 'listRooms': handleListRooms(ws); break;
        default: break;
      }
    } catch (e) {
      sendError(ws, 'Quelque chose a mal tourné sur le pont.');
    }
  });

  ws.on('close', () => {
    if (!ws.roomCode) return;
    const room = rooms.get(ws.roomCode);
    if (!room) return;
    const player = room.players.get(ws.token);
    if (player && player.ws === ws) {
      player.connected = false;
      player.ws = null;
      room.addLog(`${player.name} perd la connexion.`);
      broadcastState(room);
    }
  });
});

const pingInterval = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);
wss.on('close', () => clearInterval(pingInterval));

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.createdAt > ROOM_IDLE_MS && room.everyoneDisconnected()) {
      clearTimeout(room.roundTimer);
      rooms.delete(code);
    }
  }
}, 5 * 60 * 1000);

server.listen(PORT, () => {
  console.log(`Dead Man's Dice listening on :${PORT}`);
});
