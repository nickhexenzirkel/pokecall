/*
 * PokeCall - renderer
 * Cliente de sinalizacao + WebRTC em malha (mesh) com "negociacao perfeita".
 *
 * Cada participante abre uma conexao P2P direta com cada outro participante.
 * A voz (microfone) e o compartilhamento de tela viajam por essas conexoes,
 * sem passar pelo servidor -> alta qualidade e baixa latencia.
 */

'use strict';

/* ======================= CONFIG ======================= */

// Servidores que ajudam a atravessar roteadores/NAT.
// STUN = descoberta de IP publico (gratis). TURN = retransmissao quando o
// P2P direto nao e possivel. Para uso serio, crie seu proprio TURN (veja o README).
const TURN_USER = 'pokecall';
const TURN_PASS = 'OGZnakfLDW6Vi5vLqlDANTM7';
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  // STUN + TURN proprios (VPS centraluniko):
  { urls: 'stun:call.centraluniko.com.br:3478' },
  { urls: 'turn:call.centraluniko.com.br:3478', username: TURN_USER, credential: TURN_PASS },
  { urls: 'turn:call.centraluniko.com.br:3478?transport=tcp', username: TURN_USER, credential: TURN_PASS },
  { urls: 'turns:call.centraluniko.com.br:5349', username: TURN_USER, credential: TURN_PASS },
];

const DEFAULT_SERVER = 'wss://call.centraluniko.com.br';

// Presets de qualidade do compartilhamento de tela.
const QUALITY = {
  '1080p60': { w: 1920, h: 1080, fps: 60, bitrate: 4_000_000 },
  '1440p60': { w: 2560, h: 1440, fps: 60, bitrate: 6_000_000 },
  '1080p30': { w: 1920, h: 1080, fps: 30, bitrate: 2_500_000 },
  'source':  { w: 3840, h: 2160, fps: 60, bitrate: 8_000_000 },
};

/* ======================= ESTADO ======================= */

let ws = null;
let selfId = null;
let selfName = '';
let roomId = '';

let localAudioStream = null;   // microfone
let localScreenStream = null;  // tela (quando compartilhando)
let micEnabled = false;

// peers: Map<peerId, PeerState>
const peers = new Map();

// Metadados (avatar) recebidos antes da conexao do peer existir.
const pendingMeta = new Map();

// Audio: reproducao direta pelo <audio> (confiavel). O WebAudio abaixo serve
// SO para analise (indicador de quem esta falando), nao para tocar o som.
let audioCtx = null;
let masterVolume = parseFloat(localStorage.getItem('pokecall.volume') ?? '1');

function ensureAudio() {
  if (audioCtx) { audioCtx.resume().catch(() => {}); return; }
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    audioCtx.resume().catch(() => {});
  } catch (err) {
    console.warn('AudioContext indisponível', err);
  }
}

/* ======================= ELEMENTOS ======================= */

const $ = (id) => document.getElementById(id);
const lobby = $('lobby');
const callView = $('call');

/* ======================= LOBBY ======================= */

// Personagens disponiveis. Para adicionar mais, coloque o PNG em
// renderer/avatars/<id>.png (rode scripts/make-avatars.cjs) e liste o id aqui.
const AVATARS = ['emolga', 'leafeon', 'sylveon'];

// Salas fixas.
const ROOMS = {
  filmes:    { name: 'Sala de Filmes', icon: 'film' },
  jogos:     { name: 'Sala de Jogos', icon: 'gamepad' },
  conversas: { name: 'Sala de Conversas', icon: 'message' },
};

// ---- Ícones SVG (estilo linha, herdam a cor via currentColor) ----
const SVG = (inner) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
const ICONS = {
  mic: SVG('<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>'),
  micOff: SVG('<line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>'),
  screen: SVG('<rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>'),
  chat: SVG('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>'),
  leave: SVG('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>'),
  film: SVG('<rect x="2" y="2" width="20" height="20" rx="2.5"/><line x1="7" y1="2" x2="7" y2="22"/><line x1="17" y1="2" x2="17" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="2" y1="7" x2="7" y2="7"/><line x1="2" y1="17" x2="7" y2="17"/><line x1="17" y1="17" x2="22" y2="17"/><line x1="17" y1="7" x2="22" y2="7"/>'),
  gamepad: SVG('<line x1="6" y1="11" x2="10" y2="11"/><line x1="8" y1="9" x2="8" y2="13"/><line x1="15" y1="12" x2="15.01" y2="12"/><line x1="18" y1="10" x2="18.01" y2="10"/><rect x="2" y="6" width="20" height="12" rx="4"/>'),
  message: SVG('<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>'),
  back: SVG('<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>'),
  settings: SVG('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'),
  volume: SVG('<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07M19.07 4.93a10 10 0 0 1 0 14.14"/>'),
};

// Preenche todos os elementos com data-icon="nome".
function populateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((el) => {
    el.innerHTML = ICONS[el.dataset.icon] || '';
  });
}
populateIcons();

let selectedAvatar = localStorage.getItem('pokecall.avatar');
if (!AVATARS.includes(selectedAvatar)) selectedAvatar = AVATARS[0];

function avatarSrc(id) { return `avatars/${id}.png`; }

// Monta o seletor de personagem.
(function buildAvatarPicker() {
  const picker = $('avatar-picker');
  for (const id of AVATARS) {
    const btn = document.createElement('button');
    btn.className = 'avatar-opt' + (id === selectedAvatar ? ' selected' : '');
    const img = document.createElement('img');
    img.src = avatarSrc(id);
    img.alt = id;
    btn.appendChild(img);
    btn.addEventListener('click', () => {
      selectedAvatar = id;
      localStorage.setItem('pokecall.avatar', id);
      picker.querySelectorAll('.avatar-opt').forEach((b) => b.classList.toggle('selected', b === btn));
    });
    picker.appendChild(btn);
  }
})();

$('inp-name').value = localStorage.getItem('pokecall.name') || '';

// Etapa 1 (nome + personagem) -> Etapa 2 (escolher sala)
function goToRoomStep() {
  const name = $('inp-name').value.trim();
  if (!name) {
    setLobbyStatus('Digite seu nome primeiro.', true);
    $('inp-name').focus();
    return;
  }
  setLobbyStatus('');
  localStorage.setItem('pokecall.name', name);
  $('hello-name').textContent = name;
  $('step-name').classList.add('hidden');
  $('step-room').classList.remove('hidden');
  $('lobby-tagline').textContent = 'Escolha uma sala para entrar.';
}
$('btn-continue').addEventListener('click', goToRoomStep);
$('inp-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') goToRoomStep(); });

// Voltar para a etapa 1
$('btn-back').addEventListener('click', () => {
  $('step-room').classList.add('hidden');
  $('step-name').classList.remove('hidden');
  $('lobby-tagline').textContent = 'Como você quer ser chamado?';
  setLobbyStatus('');
});

// Clicar num card de sala entra naquela sala.
document.querySelectorAll('.room-card').forEach((card) =>
  card.addEventListener('click', () => join(card.dataset.room))
);

// Botoes da barra de titulo personalizada.
$('tb-min').addEventListener('click', () => window.pokecall.win.minimize());
$('tb-max').addEventListener('click', () => window.pokecall.win.maximize());
$('tb-close').addEventListener('click', () => window.pokecall.win.close());

// Atualização automática (avisos do processo principal).
function showUpdateToast(text, ready) {
  $('update-toast-text').textContent = text;
  $('update-restart').classList.toggle('hidden', !ready);
  $('update-toast').classList.remove('hidden');
}
if (window.pokecall.updates) {
  window.pokecall.updates.onAvailable((v) =>
    showUpdateToast(`Baixando atualização${v ? ' v' + v : ''}…`, false)
  );
  window.pokecall.updates.onDownloaded((v) =>
    showUpdateToast(`Atualização${v ? ' v' + v : ''} pronta para instalar!`, true)
  );
  $('update-restart').addEventListener('click', () => window.pokecall.updates.restart());
}

function setLobbyStatus(text, isError = false) {
  const el = $('lobby-status');
  el.textContent = text;
  el.classList.toggle('error', isError);
}

async function join(room) {
  const name = $('inp-name').value.trim();
  const server = DEFAULT_SERVER;

  if (!name) return setLobbyStatus('Digite seu nome primeiro.', true);
  if (!ROOMS[room]) return;

  localStorage.setItem('pokecall.name', name);

  selfName = name;
  roomId = room;

  // Prepara o áudio (precisa de um gesto do usuário — o clique na sala serve).
  ensureAudio();

  // Pede o microfone antes de entrar.
  setLobbyStatus('Acessando microfone…');
  const savedInput = localStorage.getItem('pokecall.input');
  try {
    localAudioStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: savedInput ? { exact: savedInput } : undefined,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
    micEnabled = true;
  } catch (err) {
    console.warn('Sem microfone:', err);
    localAudioStream = new MediaStream(); // entra sem microfone
    micEnabled = false;
  }

  setLobbyStatus('Conectando ao servidor…');
  connectSignaling(server);
}

/* ======================= SINALIZACAO (WebSocket) ======================= */

function connectSignaling(server) {
  try {
    ws = new WebSocket(server);
  } catch (err) {
    return setLobbyStatus('URL de servidor inválida.', true);
  }

  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ type: 'join', room: roomId, name: selfName, avatar: selectedAvatar }));
  });

  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handleSignal(msg);
  });

  ws.addEventListener('close', () => {
    if (selfId) {
      setBadge('bad', 'desconectado');
      addSystemChat('Você foi desconectado do servidor.');
    } else {
      setLobbyStatus('Não foi possível conectar ao servidor. Ele está rodando?', true);
    }
  });

  ws.addEventListener('error', () => {
    if (!selfId) setLobbyStatus('Erro ao conectar. Confira a URL do servidor.', true);
  });
}

function handleSignal(msg) {
  switch (msg.type) {
    case 'welcome':
      selfId = msg.selfId;
      enterCall();
      // Cria conexao com cada peer que ja estava na sala.
      for (const p of msg.peers) createPeer(p.id, p.name, p.avatar);
      break;

    case 'peer-joined':
      addSystemChat(`${msg.name} entrou na call.`);
      createPeer(msg.id, msg.name, msg.avatar);
      updatePeerCount();
      updateConnBadge();
      break;

    case 'peer-left': {
      const st = peers.get(msg.id);
      if (st) {
        addSystemChat(`${st.name} saiu da call.`);
        closePeer(msg.id);
      }
      updatePeerCount();
      updateConnBadge();
      break;
    }

    case 'signal':
      onPeerSignal(msg.from, msg.data);
      break;

    case 'chat':
      if (msg.from !== selfId) addChat(msg.name, msg.text, peers.get(msg.from)?.avatar);
      break;
  }
}

function sendSignal(to, data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'signal', to, data }));
  }
}

/* ======================= WEBRTC (por peer) ======================= */

function createPeer(peerId, name, avatar) {
  if (peers.has(peerId)) return;

  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS, bundlePolicy: 'max-bundle' });

  const state = {
    id: peerId,
    name,
    avatar: avatar || pendingMeta.get(peerId)?.avatar || null,
    pc,
    polite: selfId < peerId,   // desempate deterministico p/ negociacao perfeita
    makingOffer: false,
    ignoreOffer: false,
    audioStream: new MediaStream(),
    videoStream: new MediaStream(),
    screenSender: null,
    tile: null,
    volume: 1, // volume local desta pessoa (só para mim)
  };
  pendingMeta.delete(peerId);
  peers.set(peerId, state);
  createTile(state);

  // Envia nosso personagem (avatar) para este peer.
  sendSignal(peerId, { meta: { avatar: selectedAvatar } });

  // Adiciona nossos tracks atuais (microfone + tela, se estiver compartilhando).
  for (const track of localAudioStream.getAudioTracks()) {
    pc.addTrack(track, localAudioStream);
  }
  if (localScreenStream) {
    for (const track of localScreenStream.getVideoTracks()) {
      state.screenSender = pc.addTrack(track, localScreenStream);
      applyScreenEncoding(state.screenSender);
    }
  }

  // ---- Negociacao perfeita ----
  pc.onnegotiationneeded = async () => {
    try {
      state.makingOffer = true;
      await pc.setLocalDescription();
      sendSignal(peerId, { description: pc.localDescription });
    } catch (err) {
      console.error('negotiationneeded', err);
    } finally {
      state.makingOffer = false;
    }
  };

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) sendSignal(peerId, { candidate });
  };

  pc.onconnectionstatechange = () => {
    console.log(`[peer ${name}] conexão: ${pc.connectionState}`);
    if (pc.connectionState === 'connected') logSelectedCandidate(pc, name);
    if (pc.connectionState === 'failed') {
      try { pc.restartIce(); } catch {}
    }
    updateConnBadge();
  };
  pc.oniceconnectionstatechange = () =>
    console.log(`[peer ${name}] ice: ${pc.iceConnectionState}`);

  pc.ontrack = (ev) => {
    const track = ev.track;
    if (track.kind === 'audio') {
      state.audioStream.addTrack(track);
      attachAudio(state);
    } else {
      state.videoStream.addTrack(track);
      showVideo(state);
      // Só esconde quando o compartilhamento realmente termina.
      track.addEventListener('ended', () => {
        state.videoStream.removeTrack(track);
        if (state.videoStream.getVideoTracks().length === 0) hideVideo(state);
      });
      // Se começar "mudo" (sem quadros ainda), remostra quando os quadros chegam.
      track.addEventListener('unmute', () => showVideo(state));
    }
  };
}

// Diagnóstico: mostra por onde a mídia está passando (host/srflx/relay=TURN).
async function logSelectedCandidate(pc, name) {
  try {
    const stats = await pc.getStats();
    let pair = null;
    stats.forEach((r) => {
      if (r.type === 'candidate-pair' && (r.nominated || r.selected) && r.state === 'succeeded') pair = r;
    });
    if (pair) {
      const loc = stats.get(pair.localCandidateId);
      const rem = stats.get(pair.remoteCandidateId);
      console.log(`[peer ${name}] mídia via local=${loc?.candidateType} remoto=${rem?.candidateType}`);
    }
  } catch {}
}

// Atualiza o selo de conexão com base no estado real das conexões.
function updateConnBadge() {
  let real = 0, connected = 0, failed = 0;
  for (const [, st] of peers) {
    if (!st.pc) continue;
    real++;
    const s = st.pc.connectionState;
    if (s === 'connected') connected++;
    if (s === 'failed' || s === 'disconnected') failed++;
  }
  if (real === 0) setBadge('', 'na sala');
  else if (connected > 0) setBadge('ok', 'conectado');
  else if (failed > 0) setBadge('bad', 'reconectando…');
  else setBadge('', 'conectando…');
}

async function onPeerSignal(peerId, data) {
  // Troca de "meta" (personagem/avatar) — pode chegar antes da conexao existir.
  if (data.meta) {
    const st = peers.get(peerId);
    if (st) {
      st.avatar = data.meta.avatar || st.avatar;
      renderTileAvatar(st);
    } else {
      pendingMeta.set(peerId, data.meta);
    }
    return;
  }

  const state = peers.get(peerId);
  if (!state) return;
  const pc = state.pc;

  try {
    if (data.description) {
      const offerCollision =
        data.description.type === 'offer' &&
        (state.makingOffer || pc.signalingState !== 'stable');

      state.ignoreOffer = !state.polite && offerCollision;
      if (state.ignoreOffer) return;

      await pc.setRemoteDescription(data.description);
      if (data.description.type === 'offer') {
        await pc.setLocalDescription();
        sendSignal(peerId, { description: pc.localDescription });
      }
    } else if (data.candidate) {
      try {
        await pc.addIceCandidate(data.candidate);
      } catch (err) {
        if (!state.ignoreOffer) throw err;
      }
    }
  } catch (err) {
    console.error('onPeerSignal', err);
  }
}

function closePeer(peerId) {
  const state = peers.get(peerId);
  if (!state) return;
  try { state.pc.close(); } catch {}
  if (state.tile) state.tile.root.remove();
  peers.delete(peerId);
}

/* ======================= MICROFONE ======================= */

$('btn-mic').addEventListener('click', toggleMic);

function toggleMic() {
  const tracks = localAudioStream.getAudioTracks();
  if (tracks.length === 0) {
    addSystemChat('Nenhum microfone disponível.');
    return;
  }
  micEnabled = !micEnabled;
  tracks.forEach((t) => (t.enabled = micEnabled));
  updateMicButton();
}

function updateMicButton() {
  const btn = $('btn-mic');
  btn.classList.toggle('active', micEnabled);
  btn.querySelector('.ctrl-icon').innerHTML = micEnabled ? ICONS.mic : ICONS.micOff;
  btn.querySelector('.ctrl-label').textContent = micEnabled ? 'Ligado' : 'Mudo';
}

/* ======================= COMPARTILHAR TELA ======================= */

$('btn-screen').addEventListener('click', () => {
  if (localScreenStream) stopScreenShare();
  else openSourcePicker();
});

async function openSourcePicker() {
  const picker = $('source-picker');
  const list = $('source-list');
  list.innerHTML = '<div style="color:#80848e;padding:20px">Carregando telas…</div>';
  picker.classList.remove('hidden');

  let sources;
  try {
    sources = await window.pokecall.getSources();
  } catch (err) {
    list.innerHTML = '<div style="color:#f04747;padding:20px">Erro ao listar telas.</div>';
    return;
  }

  list.innerHTML = '';
  for (const src of sources) {
    const item = document.createElement('div');
    item.className = 'source-item';
    const img = document.createElement('img');
    img.src = src.thumbnail;
    const label = document.createElement('div');
    label.className = 'src-name';
    label.textContent = src.name;
    item.append(img, label);
    item.addEventListener('click', () => {
      picker.classList.add('hidden');
      startScreenShare(src.id);
    });
    list.appendChild(item);
  }
}

$('picker-close').addEventListener('click', () => $('source-picker').classList.add('hidden'));

async function startScreenShare(sourceId) {
  const q = QUALITY[$('quality-select').value] || QUALITY['1080p60'];
  const shareAudio = $('share-audio').checked;
  const hint = $('hint-select').value; // 'motion' ou 'detail'

  const videoConstraints = {
    mandatory: {
      chromeMediaSource: 'desktop',
      chromeMediaSourceId: sourceId,
      maxWidth: q.w,
      maxHeight: q.h,
      maxFrameRate: q.fps,
    },
  };

  let stream;
  try {
    // Tenta capturar tela + audio do sistema juntos.
    stream = await navigator.mediaDevices.getUserMedia({
      audio: shareAudio ? { mandatory: { chromeMediaSource: 'desktop' } } : false,
      video: videoConstraints,
    });
  } catch (err) {
    // Se o audio do sistema falhar, tenta so o video.
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: videoConstraints });
    } catch (err2) {
      console.error('startScreenShare', err2);
      addSystemChat('Não foi possível capturar a tela.');
      return;
    }
  }

  localScreenStream = stream;
  const videoTrack = stream.getVideoTracks()[0];
  videoTrack.contentHint = hint;

  // Se o usuario parar pela barra do sistema, encerramos.
  videoTrack.addEventListener('ended', () => stopScreenShare());

  // Mostra a propria tela na nossa telha (preview) primeiro.
  showSelfPreview(stream);

  // Adiciona a tela (e o audio dela) em cada conexao P2P real.
  for (const state of peers.values()) {
    if (!state.pc) continue; // pula a ficha "self-ui" (sem conexao)
    for (const t of stream.getVideoTracks()) {
      state.screenSender = state.pc.addTrack(t, stream);
      applyScreenEncoding(state.screenSender, q, hint);
    }
    for (const t of stream.getAudioTracks()) {
      state.pc.addTrack(t, stream);
    }
  }

  const btn = $('btn-screen');
  btn.classList.add('active');
  btn.querySelector('.ctrl-label').textContent = 'Parar';
}

function stopScreenShare() {
  if (!localScreenStream) return;

  for (const state of peers.values()) {
    if (!state.pc) continue; // pula a ficha "self-ui" (sem conexao)
    if (state.screenSender) {
      try { state.pc.removeTrack(state.screenSender); } catch {}
      state.screenSender = null;
    }
    // remove tambem o track de audio da tela, se houver
    for (const sender of state.pc.getSenders()) {
      if (sender.track && localScreenStream.getAudioTracks().includes(sender.track)) {
        try { state.pc.removeTrack(sender); } catch {}
      }
    }
  }

  localScreenStream.getTracks().forEach((t) => t.stop());
  localScreenStream = null;

  hideSelfPreview();

  const btn = $('btn-screen');
  btn.classList.remove('active');
  btn.querySelector('.ctrl-label').textContent = 'Tela';
}

// Define bitrate alto, framerate e como degradar sob rede ruim.
async function applyScreenEncoding(sender, q, hint) {
  if (!sender) return;
  q = q || QUALITY[$('quality-select').value] || QUALITY['1080p60'];
  hint = hint || $('hint-select').value;
  try {
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
    params.encodings[0].maxBitrate = q.bitrate;
    params.encodings[0].maxFramerate = q.fps;
    // 'motion' = prioriza fluidez; 'detail' = prioriza resolucao/nitidez.
    params.degradationPreference = hint === 'detail' ? 'maintain-resolution' : 'maintain-framerate';
    await sender.setParameters(params);
  } catch (err) {
    console.warn('applyScreenEncoding', err);
  }
}

/* ======================= UI: TELHAS (TILES) ======================= */

function initials(name) {
  return name.trim().slice(0, 2).toUpperCase() || '?';
}

// Cria a telha do proprio usuario ao entrar.
function enterCall() {
  lobby.classList.add('hidden');
  callView.classList.remove('hidden');
  const info = ROOMS[roomId] || { name: roomId, icon: 'chat' };
  $('room-name').textContent = info.name;
  $('room-badge').innerHTML = ICONS[info.icon] || '';
  updateMicButton();

  const selfState = {
    id: 'self',
    name: selfName + ' (você)',
    avatar: selectedAvatar,
    tile: null,
  };
  createTile(selfState);
  peers.set('self-ui', selfState);
  setupSelfAnalyser(selfState);
  updatePeerCount();
  updateConnBadge();
}

function createTile(state) {
  const root = document.createElement('div');
  root.className = 'tile';

  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  video.muted = state.id === 'self' || state.id === 'self-ui'; // nunca ouvir a si mesmo

  const avatar = document.createElement('div');
  avatar.className = 'tile-avatar';

  const nameTag = document.createElement('div');
  nameTag.className = 'tile-name';
  nameTag.textContent = state.name;

  root.append(video, avatar, nameTag);
  $('grid').appendChild(root);

  state.tile = { root, video, avatar, nameTag };
  renderTileAvatar(state);

  // Botão direito na telha de um participante -> ajustar o volume dele (só para mim).
  if (state.pc) {
    root.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showPeerMenu(state, e.clientX, e.clientY);
    });
  }
}

// Desenha a foto de perfil (ou iniciais, se ainda nao chegou o avatar) na telha.
function renderTileAvatar(state) {
  const t = state.tile;
  if (!t) return;
  t.avatar.innerHTML = '';
  if (state.avatar && AVATARS.includes(state.avatar)) {
    const img = document.createElement('img');
    img.src = avatarSrc(state.avatar);
    img.alt = '';
    t.avatar.appendChild(img);
  } else {
    t.avatar.textContent = initials(state.name);
  }
}

function showVideo(state) {
  const t = state.tile;
  if (!t) return;
  const v = t.video;
  if (v.srcObject !== state.videoStream) v.srcObject = state.videoStream;
  t.root.classList.add('has-video');
  // Garante a reprodução assim que os metadados/quadros chegam (evita tela preta).
  const tryPlay = () => v.play().catch(() => {});
  tryPlay();
  v.onloadedmetadata = tryPlay;
  if (!t.root.querySelector('.tile-badge-share')) {
    const b = document.createElement('div');
    b.className = 'tile-badge-share';
    b.textContent = 'AO VIVO';
    t.root.appendChild(b);
  }
}

function hideVideo(state) {
  const t = state.tile;
  if (!t) return;
  t.root.classList.remove('has-video');
  t.video.srcObject = null;
  const b = t.root.querySelector('.tile-badge-share');
  if (b) b.remove();
}

function attachAudio(state) {
  // Reproducao DIRETA pelo elemento <audio> (caminho confiavel).
  if (!state.audioEl) {
    state.audioEl = document.createElement('audio');
    state.audioEl.autoplay = true;
    document.body.appendChild(state.audioEl);
  }
  state.audioEl.srcObject = state.audioStream;
  applyPeerVolume(state);
  const out = localStorage.getItem('pokecall.output');
  if (out && state.audioEl.setSinkId) state.audioEl.setSinkId(out).catch(() => {});
  state.audioEl.play().catch(() => {});

  // Analisador só para o indicador de "falando" (não toca som, não interfere).
  ensureAudio();
  if (audioCtx && !state.analyser) {
    try {
      const src = audioCtx.createMediaStreamSource(state.audioStream);
      state.analyser = audioCtx.createAnalyser();
      state.analyser.fftSize = 512;
      src.connect(state.analyser);
      startSpeakingLoop();
    } catch (err) {
      console.warn('analisador', err);
    }
  }
}

// volume final = volume da pessoa (0..1) x volume geral (0..1)
function applyPeerVolume(state) {
  if (state.audioEl) {
    state.audioEl.volume = Math.max(0, Math.min(1, (state.volume ?? 1) * masterVolume));
  }
}

// Ajusta o volume local de uma pessoa. Só afeta o que EU ouço.
function setPeerVolume(state, v) {
  state.volume = v;
  applyPeerVolume(state);
}

function setMasterVolume(v) {
  masterVolume = v;
  localStorage.setItem('pokecall.volume', String(v));
  for (const [, st] of peers) applyPeerVolume(st);
}

// ---- Indicador de "falando" (borda no ícone, estilo Discord) ----
let speakingLoopOn = false;
function startSpeakingLoop() {
  if (speakingLoopOn) return;
  speakingLoopOn = true;
  const buf = new Uint8Array(256);
  const tick = () => {
    for (const [, st] of peers) {
      if (!st.analyser || !st.tile) continue;
      st.analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) {
        const x = (buf[i] - 128) / 128;
        sum += x * x;
      }
      const rms = Math.sqrt(sum / buf.length);
      // suavização com decaimento para não piscar
      const now = rms > 0.045;
      st._spk = now ? 1 : Math.max(0, (st._spk ?? 0) - 0.06);
      const speaking = now || st._spk > 0.15;
      if (st.tile) st.tile.root.classList.toggle('speaking', speaking);
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// Cria o analisador da PRÓPRIA voz (para mostrar quando EU estou falando).
function setupSelfAnalyser(selfState) {
  ensureAudio();
  if (!audioCtx || !localAudioStream.getAudioTracks().length) return;
  try {
    const src = audioCtx.createMediaStreamSource(localAudioStream);
    selfState.analyser = audioCtx.createAnalyser();
    selfState.analyser.fftSize = 512;
    src.connect(selfState.analyser);
    startSpeakingLoop();
  } catch (err) {
    console.warn('analisador próprio', err);
  }
}

function showSelfPreview(stream) {
  const self = peers.get('self-ui');
  if (!self) return;
  self.videoStream = stream;
  showVideo(self);
  self.tile.video.srcObject = stream;
  self.tile.video.muted = true;
}

function hideSelfPreview() {
  const self = peers.get('self-ui');
  if (self) hideVideo(self);
}

function setBadge(kind, text) {
  const badge = $('conn-badge');
  badge.className = 'badge' + (kind ? ' ' + kind : '');
  badge.textContent = text;
}

function updatePeerCount() {
  // conta conexoes reais (exclui as entradas de UI)
  let n = 1; // eu
  for (const [id] of peers) {
    if (id !== 'self-ui' && id !== 'self') n++;
  }
  $('peer-count').textContent = n === 1 ? '1 na call' : `${n} na call`;
}

/* ======================= CHAT ======================= */

$('chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('chat-input');
  const text = input.value.trim();
  if (!text) return;
  ws.send(JSON.stringify({ type: 'chat', room: roomId, text }));
  addChat(selfName, text, selectedAvatar);
  input.value = '';
});

$('btn-chat').addEventListener('click', () => {
  $('chat-panel').classList.toggle('hidden-panel');
  $('btn-chat').classList.toggle('active');
});

function addChat(who, text, avatar) {
  const el = document.createElement('div');
  el.className = 'chat-msg';

  const av = document.createElement('span');
  av.className = 'chat-av';
  if (avatar && AVATARS.includes(avatar)) {
    const img = document.createElement('img');
    img.src = avatarSrc(avatar);
    img.alt = '';
    av.appendChild(img);
  } else {
    av.textContent = initials(who);
  }

  const body = document.createElement('div');
  body.className = 'chat-body';
  const whoEl = document.createElement('span');
  whoEl.className = 'who';
  whoEl.textContent = who;
  const txt = document.createElement('span');
  txt.className = 'chat-text';
  txt.textContent = text;
  body.append(whoEl, txt);

  el.append(av, body);
  const box = $('chat-messages');
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
}

function addSystemChat(text) {
  const el = document.createElement('div');
  el.className = 'chat-msg system';
  el.textContent = text;
  const box = $('chat-messages');
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
}

/* ======================= VOLUME POR PESSOA (botão direito) ======================= */

let ctxMenuState = null;

function showPeerMenu(state, x, y) {
  ctxMenuState = state;
  const menu = $('ctx-menu');
  $('ctx-name').textContent = state.name;
  const vol = $('ctx-vol');
  vol.value = Math.round((state.volume ?? 1) * 100);
  $('ctx-vol-val').textContent = vol.value + '%';

  // Mostra primeiro (para medir) e reposiciona dentro da janela.
  menu.classList.remove('hidden');
  const rect = menu.getBoundingClientRect();
  const px = Math.min(x, window.innerWidth - rect.width - 8);
  const py = Math.min(y, window.innerHeight - rect.height - 8);
  menu.style.left = px + 'px';
  menu.style.top = py + 'px';
}

function hidePeerMenu() {
  $('ctx-menu').classList.add('hidden');
  ctxMenuState = null;
}

$('ctx-vol').addEventListener('input', (e) => {
  const pct = parseInt(e.target.value, 10);
  $('ctx-vol-val').textContent = pct + '%';
  if (ctxMenuState) setPeerVolume(ctxMenuState, pct / 100);
});

// Fecha o menu ao clicar fora, rolar ou apertar Esc.
document.addEventListener('mousedown', (e) => {
  const menu = $('ctx-menu');
  if (!menu.classList.contains('hidden') && !menu.contains(e.target)) hidePeerMenu();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hidePeerMenu(); });
window.addEventListener('blur', hidePeerMenu);

/* ======================= CONFIGURAÇÕES (dispositivos) ======================= */

$('btn-settings').addEventListener('click', openSettings);
$('settings-close').addEventListener('click', () => $('settings-modal').classList.add('hidden'));

async function openSettings() {
  ensureAudio();
  const modal = $('settings-modal');
  modal.classList.remove('hidden');

  // Lista os dispositivos (os rótulos só aparecem após permissão do microfone).
  let devices = [];
  try { devices = await navigator.mediaDevices.enumerateDevices(); } catch {}

  const inputSel = $('set-input');
  const outputSel = $('set-output');
  inputSel.innerHTML = '';
  outputSel.innerHTML = '';

  const savedIn = localStorage.getItem('pokecall.input') || '';
  const savedOut = localStorage.getItem('pokecall.output') || '';

  const addOpt = (sel, value, label, selected) => {
    const o = document.createElement('option');
    o.value = value; o.textContent = label; o.selected = selected;
    sel.appendChild(o);
  };

  addOpt(inputSel, '', 'Padrão do sistema', !savedIn);
  addOpt(outputSel, '', 'Padrão do sistema', !savedOut);

  let mics = 0, spks = 0;
  for (const d of devices) {
    if (d.kind === 'audioinput') {
      addOpt(inputSel, d.deviceId, d.label || `Microfone ${++mics}`, d.deviceId === savedIn);
    } else if (d.kind === 'audiooutput') {
      addOpt(outputSel, d.deviceId, d.label || `Alto-falante ${++spks}`, d.deviceId === savedOut);
    }
  }

  // Se o navegador não permitir escolher a saída, desabilita o seletor.
  outputSel.disabled = !('setSinkId' in HTMLMediaElement.prototype);

  const volPct = Math.round(parseFloat(localStorage.getItem('pokecall.volume') ?? '1') * 100);
  $('set-volume').value = volPct;
  $('vol-label').textContent = volPct + '%';
}

$('set-input').addEventListener('change', (e) => setInputDevice(e.target.value));
$('set-output').addEventListener('change', (e) => setOutputDevice(e.target.value));
$('set-volume').addEventListener('input', (e) => {
  const pct = parseInt(e.target.value, 10);
  $('vol-label').textContent = pct + '%';
  setMasterVolume(pct / 100);
});

async function setInputDevice(deviceId) {
  localStorage.setItem('pokecall.input', deviceId || '');
  try {
    const newStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: true, noiseSuppression: true, autoGainControl: true,
      },
      video: false,
    });
    const newTrack = newStream.getAudioTracks()[0];
    newTrack.enabled = micEnabled;

    // Substitui o microfone em todas as conexões, sem reconectar.
    for (const st of peers.values()) {
      if (!st.pc) continue;
      const sender = st.pc.getSenders().find((s) => s.track && s.track.kind === 'audio');
      if (sender) await sender.replaceTrack(newTrack);
    }
    if (localAudioStream) localAudioStream.getAudioTracks().forEach((t) => t.stop());
    localAudioStream = newStream;
  } catch (err) {
    console.error('setInputDevice', err);
    addSystemChat('Não foi possível trocar o microfone.');
  }
}

async function setOutputDevice(deviceId) {
  localStorage.setItem('pokecall.output', deviceId || '');
  for (const [, st] of peers) {
    if (st.audioEl && st.audioEl.setSinkId) {
      try { await st.audioEl.setSinkId(deviceId || ''); } catch (err) { console.warn('setSinkId', err); }
    }
  }
}

/* ======================= SAIR ======================= */

$('btn-leave').addEventListener('click', leave);

function leave() {
  for (const [id] of peers) {
    if (id !== 'self-ui' && id !== 'self') closePeer(id);
  }
  if (localScreenStream) localScreenStream.getTracks().forEach((t) => t.stop());
  if (localAudioStream) localAudioStream.getTracks().forEach((t) => t.stop());
  if (ws) ws.close();

  // Recarrega para voltar ao lobby limpo.
  window.location.reload();
}
