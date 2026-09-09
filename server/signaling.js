/*
 * PokeCall - Servidor de sinalizacao WebRTC
 * -----------------------------------------
 * Este servidor NAO transporta audio nem video. Ele so serve para os
 * participantes de uma "sala" se descobrirem e trocarem as mensagens de
 * negociacao do WebRTC (SDP offer/answer e candidatos ICE). Depois disso,
 * a midia (voz e tela) vai direto de um amigo para o outro (P2P).
 *
 * Rode com:  npm install  &&  npm start
 * Porta padrao: 8080  (mude com a variavel de ambiente PORT)
 */

const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;

// Um servidor HTTP simples so para health-check (util em hospedagem como Render/Railway).
const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('PokeCall signaling OK');
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server });

// rooms: Map<roomId, Map<peerId, { ws, name }>>
const rooms = new Map();

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function getRoom(roomId) {
  if (!rooms.has(roomId)) rooms.set(roomId, new Map());
  return rooms.get(roomId);
}

// Conexoes que estao "observando o lobby" (querem saber quem esta em cada sala).
const lobbyWatchers = new Set();

function lobbySnapshot() {
  const out = {};
  for (const [roomId, room] of rooms) {
    out[roomId] = [];
    for (const [, peer] of room) {
      out[roomId].push({ name: peer.name, avatar: peer.avatar || null });
    }
  }
  return out;
}

function broadcastLobby() {
  const payload = { type: 'lobby', rooms: lobbySnapshot() };
  for (const w of lobbyWatchers) send(w, payload);
}

function leaveRoom(ws) {
  const { roomId, peerId } = ws.meta || {};
  if (!roomId || !peerId) return;
  const room = rooms.get(roomId);
  if (!room) return;
  room.delete(peerId);
  // Avisa os outros que este peer saiu.
  for (const [, peer] of room) {
    send(peer.ws, { type: 'peer-left', id: peerId });
  }
  if (room.size === 0) rooms.delete(roomId);
  console.log(`[${roomId}] ${peerId} saiu. Restam: ${room.size}`);
  broadcastLobby();
}

wss.on('connection', (ws) => {
  ws.meta = {};

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (msg.type) {
      case 'watch-lobby': {
        // Cliente no lobby: quer receber quem esta em cada sala, ao vivo.
        ws.isLobbyWatcher = true;
        lobbyWatchers.add(ws);
        send(ws, { type: 'lobby', rooms: lobbySnapshot() });
        break;
      }

      case 'join': {
        const roomId = String(msg.room || 'lobby').slice(0, 64);
        const name = String(msg.name || 'Treinador').slice(0, 32);
        const avatar = String(msg.avatar || '').slice(0, 32);
        const peerId = crypto.randomUUID();
        ws.meta = { roomId, peerId, name };

        const room = getRoom(roomId);

        // Manda para quem acabou de entrar a lista de quem ja esta na sala.
        const peers = [];
        for (const [id, peer] of room) {
          peers.push({ id, name: peer.name, avatar: peer.avatar || null });
        }
        room.set(peerId, { ws, name, avatar });

        send(ws, { type: 'welcome', selfId: peerId, peers });

        // Avisa os outros que chegou gente nova.
        for (const [id, peer] of room) {
          if (id === peerId) continue;
          send(peer.ws, { type: 'peer-joined', id: peerId, name, avatar });
        }
        console.log(`[${roomId}] ${name} (${peerId}) entrou. Total: ${room.size}`);
        broadcastLobby();
        break;
      }

      case 'signal': {
        // Repassa uma mensagem de negociacao para um peer especifico da mesma sala.
        const { roomId, peerId } = ws.meta;
        const room = rooms.get(roomId);
        if (!room) return;
        const target = room.get(msg.to);
        if (!target) return;
        send(target.ws, { type: 'signal', from: peerId, data: msg.data });
        break;
      }

      case 'chat': {
        const { roomId, peerId, name } = ws.meta;
        const room = rooms.get(roomId);
        if (!room) return;
        const text = String(msg.text || '').slice(0, 2000);
        for (const [, peer] of room) {
          send(peer.ws, { type: 'chat', from: peerId, name, text, ts: Date.now() });
        }
        break;
      }

      default:
        break;
    }
  });

  const cleanup = () => {
    if (ws.isLobbyWatcher) {
      lobbyWatchers.delete(ws);
      ws.isLobbyWatcher = false;
    }
    leaveRoom(ws);
  };
  ws.on('close', cleanup);
  ws.on('error', cleanup);
});

server.listen(PORT, () => {
  console.log(`PokeCall signaling rodando na porta ${PORT}`);
});
