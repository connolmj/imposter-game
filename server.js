const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const WORDS = require('./words');

const app = express();
const server = http.createServer(app);

// Tune ping/pong to survive mobile browser backgrounding
const io = new Server(server, {
  pingTimeout: 60000,    // wait 60s for a pong before considering dead
  pingInterval: 25000,   // send a ping every 25s
  connectTimeout: 45000
});

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
    disconnectedPlayers: new Map(), // name -> { prevSocketId, wasHost, roundData, ready, timeout }
    state: 'lobby', // lobby | playing | reveal
    settings: {
      imposterCount: 1,
      hintsEnabled: true
    },
    currentRound: null, // { category, wordEntry, imposters: Set<socketId> }
    playerRoundData: new Map(), // socketId -> { isImposter, word, category, hint, ... }
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
  // Show disconnected players too (greyed out on client)
  for (const [name] of room.disconnectedPlayers) {
    list.push({ id: null, name, isHost: false, ready: false, disconnected: true });
  }
  return list;
}

function getCategories() {
  return Object.keys(WORDS);
}

function startRound(room, categories) {
  const catArray = Array.isArray(categories) ? categories : [categories];

  // Build pool, excluding words already used this session
  const usedWords = new Set(room.roundHistory.map(r => r.word));
  let pool = [];
  for (const cat of catArray) {
    if (WORDS[cat]) {
      for (const entry of WORDS[cat]) pool.push({ ...entry, category: cat });
    }
  }
  // Filter out used words; fall back to full pool if all have been played
  const freshPool = pool.filter(e => !usedWords.has(e.word));
  if (freshPool.length > 0) pool = freshPool;
  if (pool.length === 0) return null;

  const wordEntry = pool[Math.floor(Math.random() * pool.length)];
  const playerIds = Array.from(room.players.keys());

  const shuffled = [...playerIds].sort(() => Math.random() - 0.5);
  const imposterCount = Math.min(room.settings.imposterCount, Math.floor(playerIds.length / 2));
  const imposters = new Set(shuffled.slice(0, imposterCount));

  // Pick a random non-imposter to give the first hint
  const nonImposters = playerIds.filter(id => !imposters.has(id));
  const firstHintId = nonImposters[Math.floor(Math.random() * nonImposters.length)];
  const firstHintName = room.players.get(firstHintId)?.name || '';

  room.currentRound = { category: wordEntry.category, wordEntry, imposters, firstHintName };
  room.state = 'playing';
  room.playerRoundData = new Map();

  // Reset ready states and cache per-player round data
  for (const [id, p] of room.players) {
    p.ready = false;
    const isImposter = imposters.has(id);
    room.playerRoundData.set(id, {
      isImposter,
      word: isImposter ? null : wordEntry.word,
      category: wordEntry.category,
      hint: (isImposter && room.settings.hintsEnabled) ? wordEntry.hint : null,
      imposterCount: imposters.size,
      playerCount: room.players.size,
      firstHintName
    });
  }

  return { category: wordEntry.category, wordEntry, imposters, firstHintName };
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

  // REJOIN ROOM (after disconnect/reconnect)
  socket.on('rejoin-room', (data, callback) => {
    const code = (data.code || '').toUpperCase().trim();
    const name = (data.name || '').trim();
    const room = rooms.get(code);

    if (!room) return callback({ success: false, error: 'Room no longer exists.' });

    const disconnected = room.disconnectedPlayers.get(name);
    if (!disconnected) {
      // Check if they're still active (double-connect scenario)
      for (const [id, p] of room.players) {
        if (p.name.toLowerCase() === name.toLowerCase()) {
          // Transfer session to new socket
          const oldPlayer = room.players.get(id);
          room.players.delete(id);
          room.players.set(socket.id, { name: oldPlayer.name, ready: oldPlayer.ready });
          if (room.hostId === id) room.hostId = socket.id;
          socket.join(code);
          const rd = room.playerRoundData.get(id);
          room.playerRoundData.delete(id);
          if (rd) room.playerRoundData.set(socket.id, rd);
          io.to(room.code).emit('player-list', getPlayerList(room));
          return callback({
            success: true, roomCode: code, playerId: socket.id,
            isHost: room.hostId === socket.id, gameState: room.state,
            roundData: rd || null
          });
        }
      }
      return callback({ success: false, error: 'Reconnect window expired. Please rejoin.' });
    }

    // Restore from disconnected list
    clearTimeout(disconnected.timeout);
    room.disconnectedPlayers.delete(name);

    room.players.set(socket.id, { name, ready: disconnected.ready });
    if (disconnected.wasHost) room.hostId = socket.id;

    // Restore round data mapping
    let roundData = disconnected.roundData;
    if (roundData) room.playerRoundData.set(socket.id, roundData);

    socket.join(code);
    callback({
      success: true,
      roomCode: code,
      playerId: socket.id,
      isHost: disconnected.wasHost || room.hostId === socket.id,
      gameState: room.state,
      roundData
    });

    io.to(room.code).emit('player-list', getPlayerList(room));
    io.to(room.code).emit('player-rejoined', { name });
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
  // data: { categories: [...], usedWords: [...] }  OR legacy: just categories array
  socket.on('get-word', (data, callback) => {
    let catArray, usedWords;
    if (Array.isArray(data)) {
      catArray = data; usedWords = [];
    } else {
      catArray = Array.isArray(data.categories) ? data.categories : [data.categories];
      usedWords = Array.isArray(data.usedWords) ? data.usedWords : [];
    }
    const usedSet = new Set(usedWords);
    let pool = [];
    for (const cat of catArray) {
      if (WORDS[cat]) {
        for (const entry of WORDS[cat]) pool.push({ ...entry, category: cat });
      }
    }
    if (pool.length === 0) return callback({ success: false, error: 'No words found.' });
    // Prefer unused words; fall back to full pool if all exhausted
    const freshPool = pool.filter(e => !usedSet.has(e.word));
    if (freshPool.length > 0) pool = freshPool;
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

    callback({ success: true, word: round.wordEntry.word, category: round.category, hint: round.wordEntry.hint });

    // Send each player their role
    for (const [id] of room.players) {
      const rd = room.playerRoundData.get(id);
      if (rd) io.to(id).emit('round-started', rd);
    }
  });

  // PLAYER READY
  socket.on('player-ready', () => {
    const room = findRoomBySocket(socket.id);
    if (!room) return;
    const player = room.players.get(socket.id);
    if (player) player.ready = true;
    io.to(room.code).emit('player-list', getPlayerList(room));

    // Check if everyone is now ready
    const allReady = [...room.players.values()].every(p => p.ready);
    if (allReady && room.state === 'playing') {
      io.to(room.code).emit('all-players-ready', {
        firstHintName: room.currentRound?.firstHintName || ''
      });
    }
  });

  // REVEAL
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

    if (callback) callback({ success: true });
  });

  // BACK TO LOBBY
  socket.on('back-to-lobby', () => {
    const room = findRoomBySocket(socket.id);
    if (!room || room.hostId !== socket.id) return;
    room.state = 'lobby';
    room.currentRound = null;
    room.playerRoundData = new Map();
    for (const [, p] of room.players) p.ready = false;
    io.to(room.code).emit('back-to-lobby');
    io.to(room.code).emit('player-list', getPlayerList(room));
    io.to(room.code).emit('settings-updated', room.settings);
  });

  // DISCONNECT — grace period before removing player
  socket.on('disconnect', () => {
    const room = findRoomBySocket(socket.id);
    if (!room) return;

    const player = room.players.get(socket.id);
    if (!player) return;

    const wasHost = room.hostId === socket.id;
    const roundData = room.playerRoundData.get(socket.id) || null;

    room.players.delete(socket.id);
    room.playerRoundData.delete(socket.id);

    // Notify others immediately (shown as "disconnected", not removed yet)
    io.to(room.code).emit('player-disconnected', { name: player.name });
    io.to(room.code).emit('player-list', getPlayerList(room));

    // Grace period — 45 seconds to reconnect
    const timeout = setTimeout(() => {
      room.disconnectedPlayers.delete(player.name);

      if (room.players.size === 0 && room.disconnectedPlayers.size === 0) {
        rooms.delete(room.code);
        return;
      }

      // Transfer host if needed
      if (wasHost && room.players.size > 0) {
        const newHostId = room.players.keys().next().value;
        room.hostId = newHostId;
        io.to(newHostId).emit('you-are-host');
      }

      io.to(room.code).emit('player-list', getPlayerList(room));
      io.to(room.code).emit('player-left', { name: player.name });
    }, 45000);

    room.disconnectedPlayers.set(player.name, {
      prevSocketId: socket.id,
      wasHost,
      roundData,
      ready: player.ready,
      timeout
    });
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
