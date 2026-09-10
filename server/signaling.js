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
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const music = require('./music');

const PORT = process.env.PORT || 8080;

// Um servidor HTTP simples: health-check + entrega do audio das musicas.
const server = http.createServer((req, res) => {
  const url = (req.url || '').split('?')[0];

  if (url === '/health' || url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('PokeCall signaling OK');
    return;
  }

  // Pagina do tocador. O app abre isso escondido, num iframe, so para o
  // player do YouTube ter um endereco https de verdade (o embed nao aceita
  // uma pagina aberta de arquivo local).
  if (url === '/player.html') {
    try {
      const html = fs.readFileSync(path.join(__dirname, 'player.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(html);
    } catch {
      res.writeHead(500);
      res.end('player.html nao encontrado');
    }
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
  if (room.size === 0) {
    rooms.delete(roomId);
    // Sala vazia: o DJ NAO para. A musica segue tocando (e a fila andando)
    // por um tempo, entao quem voltar cai no mesmo ponto. So depois disso
    // e que a sala e esquecida de vez.
    agendarEsquecerMusica(roomId);
  }
  console.log(`[${roomId}] ${peerId} saiu. Restam: ${room.size}`);
  broadcastLobby();
}

/* ======================= MUSICA (fila por sala) ======================= *
 * O servidor e o "Robo de Musica": guarda a fila, decide o que esta tocando
 * e em que segundo. Cada app toca o mesmo video do YouTube escondido (so o
 * audio) e se ajusta pela posicao que o servidor manda - entao todo mundo
 * ouve a mesma coisa, ao mesmo tempo, e ninguem gasta upload.             */

// musicRooms: Map<roomId, { queue, current, startedAt, paused, pausedPos, timer }>
const musicRooms = new Map();

function getMusic(roomId) {
  if (!musicRooms.has(roomId)) {
    musicRooms.set(roomId, { queue: [], current: null, startedAt: 0, paused: false, pausedPos: 0, timer: null });
  }
  return musicRooms.get(roomId);
}

// Quanto tempo a musica continua tocando numa sala que ficou vazia.
const ESQUECER_MUSICA_MS = 5 * 60 * 1000;

// Sala vazia: marca para esquecer daqui a pouco (mas continua tocando).
function agendarEsquecerMusica(roomId) {
  const m = musicRooms.get(roomId);
  if (!m || (!m.current && !m.queue.length)) {
    if (m && m.timer) clearTimeout(m.timer);
    musicRooms.delete(roomId);
    return;
  }
  if (m.esquecer) clearTimeout(m.esquecer);
  m.esquecer = setTimeout(() => {
    const atual = musicRooms.get(roomId);
    if (!atual) return;
    if (atual.timer) clearTimeout(atual.timer);
    musicRooms.delete(roomId);
    console.log(`[${roomId}] sala vazia faz tempo — o DJ desligou.`);
  }, ESQUECER_MUSICA_MS);
}

// Alguem voltou: cancela o "esquecer".
function cancelarEsquecerMusica(roomId) {
  const m = musicRooms.get(roomId);
  if (m && m.esquecer) { clearTimeout(m.esquecer); m.esquecer = null; }
}

// Posicao atual da musica, em milissegundos.
function musicPos(m) {
  if (!m.current) return 0;
  if (m.paused) return m.pausedPos;
  return Math.max(0, Date.now() - m.startedAt);
}

function musicView(roomId) {
  const m = getMusic(roomId);
  return {
    type: 'music',
    current: m.current,
    queue: m.queue,
    paused: m.paused,
    posMs: musicPos(m),
    serverNow: Date.now(),
  };
}

function broadcastMusic(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  const payload = musicView(roomId);
  for (const [, peer] of room) send(peer.ws, payload);
}

function musicNotice(roomId, text, kind, dj) {
  const room = rooms.get(roomId);
  if (!room) return;
  const payload = { type: 'music-notice', text, kind: kind || 'info' };
  if (dj) payload.dj = dj;           // { act, who, title, artist, count }
  for (const [, peer] of room) send(peer.ws, payload);
}

// Agenda a troca automatica para quando a musica atual acabar.
// (Os apps tambem avisam quando o video termina; o que chegar primeiro vale.)
function armMusicTimer(roomId) {
  const m = getMusic(roomId);
  if (m.timer) { clearTimeout(m.timer); m.timer = null; }
  if (!m.current || m.paused) return;
  const total = (m.current.duration || 0) * 1000;
  if (!total) return; // duracao ainda desconhecida
  m.timer = setTimeout(() => playNext(roomId, true), Math.max(500, total - musicPos(m) + 1500));
}

// anunciar = o DJ avisa no chat qual musica entrou (usado quando a proxima
// da fila comeca sozinha, ou depois de pular). Quando alguem acabou de pedir
// a musica, quem avisa e o enqueue, com a frase da pessoa.
function playNext(roomId, anunciar) {
  const m = getMusic(roomId);
  if (m.timer) { clearTimeout(m.timer); m.timer = null; }
  m.current = m.queue.shift() || null;
  m.paused = false;
  m.pausedPos = 0;
  m.startedAt = Date.now();
  if (m.current) armMusicTimer(roomId);
  broadcastMusic(roomId);

  if (anunciar && m.current) {
    musicNotice(roomId, `Tocando agora: "${m.current.title}".`, 'ok', {
      act: 'now', title: m.current.title, artist: m.current.artist, who: m.current.by,
    });
  }
}

function stopMusic(roomId) {
  const m = getMusic(roomId);
  if (m.timer) { clearTimeout(m.timer); m.timer = null; }
  m.current = null;
  m.paused = false;
  m.pausedPos = 0;
  m.queue = [];
  broadcastMusic(roomId);
}

// Coloca musicas na fila.
function enqueue(roomId, tracks, byName) {
  const m = getMusic(roomId);
  const aceitas = [];

  for (const t of tracks) {
    if (m.queue.some((q) => q.id === t.id)) {
      musicNotice(roomId, `"${t.title}" já está na fila.`, 'erro');
      continue;
    }
    aceitas.push({ ...t, by: byName });
  }
  if (!aceitas.length) return;

  for (const t of aceitas) m.queue.push(t);

  if (!m.current) {
    playNext(roomId);
    musicNotice(roomId, `${byName} colocou "${aceitas[0].title}" para tocar.`, 'ok', {
      act: 'play', who: byName, title: aceitas[0].title, artist: aceitas[0].artist,
    });
  } else {
    broadcastMusic(roomId);
    musicNotice(
      roomId,
      aceitas.length > 1
        ? `${byName} adicionou ${aceitas.length} músicas na fila.`
        : `${byName} adicionou "${aceitas[0].title}" na fila.`,
      'ok',
      { act: 'queue', who: byName, title: aceitas[0].title, artist: aceitas[0].artist, count: aceitas.length }
    );
  }
}

async function handleMusic(ws, msg) {
  const { roomId, name } = ws.meta || {};
  if (!roomId || !rooms.has(roomId)) return;
  const m = getMusic(roomId);

  switch (msg.action) {
    case 'sync':
      send(ws, musicView(roomId));
      break;

    case 'search': {
      const q = String(msg.query || '').slice(0, 200);
      try {
        send(ws, { type: 'music-results', query: q, results: await music.search(q, 6) });
      } catch (err) {
        send(ws, { type: 'music-notice', kind: 'erro', text: 'Busca falhou: ' + err.message });
      }
      break;
    }

    case 'add': {
      const q = String(msg.query || '').slice(0, 500);
      musicNotice(roomId, `Procurando "${q}"…`);
      try {
        const { tracks, note } = await music.resolve(q);
        if (note) musicNotice(roomId, note);
        enqueue(roomId, tracks, name);
      } catch (err) {
        musicNotice(roomId, 'Não deu certo: ' + err.message, 'erro');
      }
      break;
    }

    case 'add-track': {
      // Veio da lista de resultados da busca: so confiamos no id.
      const t = msg.track || {};
      const id = String(t.id || '').replace(/[^\w-]/g, '');
      if (!id) return;
      enqueue(
        roomId,
        [{
          id,
          title: String(t.title || 'sem nome').slice(0, 200),
          artist: String(t.artist || '').slice(0, 120),
          duration: Math.max(0, Math.round(Number(t.duration) || 0)),
          thumb: 'https://i.ytimg.com/vi/' + id + '/mqdefault.jpg',
        }],
        name
      );
      break;
    }

    case 'pause':
      if (!m.current || m.paused) return;
      m.pausedPos = musicPos(m);
      m.paused = true;
      if (m.timer) { clearTimeout(m.timer); m.timer = null; }
      broadcastMusic(roomId);
      break;

    case 'resume':
      if (!m.current || !m.paused) return;
      m.startedAt = Date.now() - m.pausedPos;
      m.paused = false;
      armMusicTimer(roomId);
      broadcastMusic(roomId);
      break;

    case 'seek': {
      if (!m.current) return;
      const total = (m.current.duration || 0) * 1000;
      let pos = Math.max(0, Math.round(Number(msg.posMs) || 0));
      if (total) pos = Math.min(pos, Math.max(0, total - 1000));
      if (m.paused) m.pausedPos = pos;
      else m.startedAt = Date.now() - pos;
      armMusicTimer(roomId);
      broadcastMusic(roomId);
      break;
    }

    case 'skip':
      if (!m.current && !m.queue.length) return;
      musicNotice(roomId, `${name} pulou a música.`, 'ok', { act: 'skip', who: name });
      playNext(roomId, true);
      break;

    // O app avisa a duracao assim que o player carrega o video.
    case 'duration': {
      const secs = Math.round(Number(msg.seconds) || 0);
      if (!m.current || msg.id !== m.current.id || !secs || m.current.duration === secs) return;
      m.current.duration = secs;
      armMusicTimer(roomId);
      broadcastMusic(roomId);
      break;
    }

    // O video acabou no app de alguem: passa para a proxima.
    case 'ended':
      if (m.current && msg.id === m.current.id && !m.paused) playNext(roomId, true);
      break;

    // O video nao pode ser tocado fora do YouTube (ou sumiu): pula sozinho.
    case 'failed':
      if (!m.current || msg.id !== m.current.id) return;
      musicNotice(roomId, `"${m.current.title}" não pode tocar fora do YouTube — pulando.`, 'erro', {
        act: 'blocked', title: m.current.title,
      });
      playNext(roomId, true);
      break;

    // Arrastar uma música para outro lugar da fila.
    // Vem pelo id (e nao pela posicao) para nao embaralhar se duas pessoas
    // mexerem na fila ao mesmo tempo.
    case 'move': {
      const de = m.queue.findIndex((t) => t.id === msg.id);
      let para = Math.round(Number(msg.to));
      if (de < 0 || isNaN(para)) return;
      para = Math.max(0, Math.min(m.queue.length - 1, para));
      if (de === para) return;
      const [movida] = m.queue.splice(de, 1);
      m.queue.splice(para, 0, movida);
      broadcastMusic(roomId);
      break;
    }

    case 'remove': {
      const i = Math.round(Number(msg.index));
      if (i >= 0 && i < m.queue.length) {
        const [out] = m.queue.splice(i, 1);
        musicNotice(roomId, `${name} tirou "${out.title}" da fila.`, 'ok', {
          act: 'remove', who: name, title: out.title,
        });
        broadcastMusic(roomId);
      }
      break;
    }

    case 'stop':
      if (!m.current && !m.queue.length) return;
      musicNotice(roomId, `${name} parou a música.`, 'ok', { act: 'stop', who: name });
      stopMusic(roomId);
      break;

    default:
      break;
  }
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
        // Se ja tem musica tocando na sala, quem chegou entra no mesmo ponto
        // (inclusive se a sala tinha ficado vazia por alguns minutos).
        cancelarEsquecerMusica(roomId);
        send(ws, musicView(roomId));

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

      case 'music': {
        handleMusic(ws, msg).catch((err) => console.warn('[musica]', err.message));
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
