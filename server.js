const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const WORDS = require('./words');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ── Game State ──────────────────────────────────────────────
const rooms = new Map(); // roomCode -> roomState

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return rooms.has(code) ? generateRoomCode() : code;
}

function createRoom(hostSocket, hostName) {
  const code = generateRoomCode();
  const room = {
    code,
    hostId: hostSocket.id,
    players: new Map(), // socketId -> { name, ready }
    state: 'lobby', // lobby | playing | reveal
    settings: {
      imposterCount: 1,
      hintsEnabled: true
    },
    currentRound: null, // { category, wordEntry, imposters: Set<socketId> }
    roundHistory: []
  };
  room.players.set(hostSocket.id, { name: hostName, ready: false });
  rooms.set(code, room);
  return room;
}

function getPlayerList(room) {
  const list = [];
  for (const [id, p] of room.players) {
    list.push({ id, name: p.name, isHost: id === room.hostId, ready: p.ready });
  }
  return list;
}

function getCategories() {
  return Object.keys(WORDS);
}

function startRound(room, categories) {
  // Accept a single category string or an array of categories
  const catArray = Array.isArray(categories) ? categories : [categories];

  // Build combined word pool from all selected categories
  const pool = [];
  for (const cat of catArray) {
    if (WORDS[cat]) {
      for (const entry of WORDS[cat]) pool.push({ ...entry, category: cat });
    }
  }
  if (pool.length === 0) return null;

  const wordEntry = pool[Math.floor(Math.random() * pool.length)];
  const playerIds = Array.from(room.players.keys());

  // Shuffle and pick imposters
  const shuffled = [...playerIds].sort(() => Math.random() - 0.5);
  const imposterCount = Math.min(room.settings.imposterCount, Math.floor(playerIds.length / 2));
  const imposters = new Set(shuffled.slice(0, imposterCount));

  room.currentRound = { category: wordEntry.category, wordEntry, imposters };
  room.state = 'playing';

  // Reset ready states
  for (const [, p] of room.players) p.ready = false;

  return { category: wordEntry.category, wordEntry, imposters };
}

// ── Socket Events ───────────────────────────────────────────
io.on('connection', (socket) => {

  // CREATE ROOM
  socket.on('create-room', (name, callback) => {
    const room = createRoom(socket, name.trim());
    socket.join(room.code);
    callback({ success: true, roomCode: room.code, playerId: socket.id });
    io.to(room.code).emit('player-list', getPlayerList(room));
  });

  // JOIN ROOM
  socket.on('join-room', (data, callback) => {
    const code = (data.code || '').toUpperCase().trim();
    const name = (data.name || '').trim();
    const room = rooms.get(code);

    if (!room) return callback({ success: false, error: 'Room not found. Check the code and try again.' });
    if (room.players.size >= 15) return callback({ success: false, error: 'Room is full (15 players max).' });
    if (room.state !== 'lobby') return callback({ success: false, error: 'Game already in progress.' });

    // Check duplicate name
    for (const [, p] of room.players) {
      if (p.name.toLowerCase() === name.toLowerCase()) {
        return callback({ success: false, error: 'That name is already taken in this room.' });
      }
    }

    room.players.set(socket.id, { name, ready: false });
    socket.join(code);
    callback({ success: true, roomCode: code, playerId: socket.id, isHost: false });
    io.to(code).emit('player-list', getPlayerList(room));
    io.to(code).emit('player-joined', { name });
  });

  // UPDATE SETTINGS (host only)
  socket.on('update-settings', (data) => {
    const room = findRoomBySocket(socket.id);
    if (!room || room.hostId !== socket.id) return;
    if (data.imposterCount !== undefined) {
      room.settings.imposterCount = Math.max(1, Math.min(3, data.imposterCount));
    }
    if (data.hintsEnabled !== undefined) {
      room.settings.hintsEnabled = !!data.hintsEnabled;
    }
    io.to(room.code).emit('settings-updated', room.settings);
  });

  // GET CATEGORIES
  socket.on('get-categories', (callback) => {
    callback(getCategories());
  });

  // GET WORD (single-device mode — no room needed)
  socket.on('get-word', (categories, callback) => {
    const catArray = Array.isArray(categories) ? categories : [categories];
    const pool = [];
    for (const cat of catArray) {
      if (WORDS[cat]) {
        for (const entry of WORDS[cat]) pool.push({ ...entry, category: cat });
      }
    }
    if (pool.length === 0) return callback({ success: false, error: 'No words found.' });
    const wordEntry = pool[Math.floor(Math.random() * pool.length)];
    callback({ success: true, word: wordEntry.word, category: wordEntry.category, hint: wordEntry.hint });
  });

  // START ROUND (host only)
  socket.on('start-round', (category, callback) => {
    const room = findRoomBySocket(socket.id);
    if (!room || room.hostId !== socket.id) return callback({ success: false, error: 'Only the host can start rounds.' });
    if (room.players.size < 3) return callback({ success: false, error: 'Need at least 3 players to start.' });

    const round = startRound(room, category);
    if (!round) return callback({ success: false, error: 'Invalid category.' });

    // In single-device mode the client passes singleDevice:true and needs the word back in the callback
    callback({ success: true, word: round.wordEntry.word, category: round.category, hint: round.wordEntry.hint });

    // Send each player their role
    for (const [id, player] of room.players) {
      const isImposter = round.imposters.has(id);
      io.to(id).emit('round-started', {
        category: round.category,
        isImposter,
        word: isImposter ? null : round.wordEntry.word,
        hint: (isImposter && room.settings.hintsEnabled) ? round.wordEntry.hint : null,
        imposterCount: round.imposters.size,
        playerCount: room.players.size
      });
    }
  });

  // PLAYER READY (acknowledged word)
  socket.on('player-ready', () => {
    const room = findRoomBySocket(socket.id);
    if (!room) return;
    const player = room.players.get(socket.id);
    if (player) player.ready = true;
    io.to(room.code).emit('player-list', getPlayerList(room));
  });

  // REVEAL (host ends the round, shows who was imposter)
  socket.on('reveal', (callback) => {
    const room = findRoomBySocket(socket.id);
    if (!room || room.hostId !== socket.id || !room.currentRound) return;

    room.state = 'reveal';
    const round = room.currentRound;
    const imposterNames = [];
    for (const id of round.imposters) {
      const p = room.players.get(id);
      if (p) imposterNames.push(p.name);
    }

    io.to(room.code).emit('round-reveal', {
      word: round.wordEntry.word,
      category: round.category,
      imposters: imposterNames
    });

    room.roundHistory.push({
      category: round.category,
      word: round.wordEntry.word,
      imposters: imposterNames
    });

    callback({ success: true });
  });

  // BACK TO LOBBY
  socket.on('back-to-lobby', () => {
    const room = findRoomBySocket(socket.id);
    if (!room || room.hostId !== socket.id) return;
    room.state = 'lobby';
    room.currentRound = null;
    for (const [, p] of room.players) p.ready = false;
    io.to(room.code).emit('back-to-lobby');
    io.to(room.code).emit('player-list', getPlayerList(room));
    io.to(room.code).emit('settings-updated', room.settings);
  });

  // DISCONNECT
  socket.on('disconnect', () => {
    const room = findRoomBySocket(socket.id);
    if (!room) return;

    const player = room.players.get(socket.id);
    room.players.delete(socket.id);

    if (room.players.size === 0) {
      rooms.delete(room.code);
      return;
    }

    // If host left, transfer host
    if (room.hostId === socket.id) {
      const newHostId = room.players.keys().next().value;
      room.hostId = newHostId;
      io.to(newHostId).emit('you-are-host');
    }

    io.to(room.code).emit('player-list', getPlayerList(room));
    if (player) io.to(room.code).emit('player-left', { name: player.name });
  });
});

function findRoomBySocket(socketId) {
  for (const [, room] of rooms) {
    if (room.players.has(socketId)) return room;
  }
  return null;
}

// ── Start Server ────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Imposter Game running on http://localhost:${PORT}`);
});
