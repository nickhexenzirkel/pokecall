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
// ultra = nitidez acima de tudo: bitrate alto, codec VP9 e NUNCA reduzir a
// resolução (prefere perder quadros a borrar a imagem). Exige rede boa.
const QUALITY = {
  '1080p60': { w: 1920, h: 1080, fps: 60, bitrate: 4_000_000 },
  '1440p60': { w: 2560, h: 1440, fps: 60, bitrate: 6_000_000 },
  '1080p30': { w: 1920, h: 1080, fps: 30, bitrate: 2_500_000 },
  'source':  { w: 3840, h: 2160, fps: 60, bitrate: 8_000_000 },
  '1440p-ultra': { w: 2560, h: 1440, fps: 60, bitrate: 25_000_000, ultra: true },
  '2160p-ultra': { w: 3840, h: 2160, fps: 60, bitrate: 50_000_000, ultra: true },
};

// Codecs preferidos no modo ultra (VP9 aguenta 2K/4K muito melhor que VP8).
const ULTRA_CODECS = ['video/VP9', 'video/AV1', 'video/H264'];

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

// Presenca (quem esta online) e convites. Declarado AQUI EM CIMA de proposito:
// o app chama startPresence() logo no inicio quando ja tem um nome salvo, e
// um "let" la no fim do arquivo ainda nao existiria nessa hora.
let presenceWs = null;
let presenceId = null;
let peopleOnline = [];
let presenceRetry = null;
let convitePendente = null;

// Audio: o som dos participantes sai por WebAudio (masterGain -> destino).
// Esse caminho NÃO é capturado pela gravação de "áudio do sistema", então
// quem compartilha a tela com áudio não devolve as vozes (sem eco).
let audioCtx = null;
let masterGain = null;
let masterVolume = parseFloat(localStorage.getItem('pokecall.volume') ?? '1');

function ensureAudio() {
  if (audioCtx) { audioCtx.resume().catch(() => {}); return; }
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    masterGain = audioCtx.createGain();
    masterGain.gain.value = masterVolume;
    masterGain.connect(audioCtx.destination);
    const out = localStorage.getItem('pokecall.output');
    if (out && audioCtx.setSinkId) audioCtx.setSinkId(out).catch(() => {});
    audioCtx.resume().catch(() => {});
  } catch (err) {
    console.warn('AudioContext indisponível', err);
  }
}

// Segurança: se o áudio ficar suspenso, qualquer clique/tecla retoma (garante som).
const resumeAudio = () => { if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {}); };
document.addEventListener('click', resumeAudio);
document.addEventListener('keydown', resumeAudio);

/* ======================= EFEITOS SONOROS ======================= *
 * Sons curtinhos gerados na hora (sem arquivos): entrar/sair da sala e
 * inicio/fim de compartilhamento. Nada de som para mensagens de chat.  */

let sfxGain = null;
let sfxEnabled = localStorage.getItem('pokecall.sfx') !== '0';
let lastSfxAt = 0;

function setSfxEnabled(on) {
  sfxEnabled = !!on;
  localStorage.setItem('pokecall.sfx', on ? '1' : '0');
}

function ensureSfx() {
  ensureAudio();
  if (!audioCtx) return null;
  if (!sfxGain) {
    sfxGain = audioCtx.createGain();
    sfxGain.gain.value = 0.3;           // discreto de proposito
    sfxGain.connect(audioCtx.destination); // fora do masterGain: nao entra na captura
  }
  return sfxGain;
}

// notes: [{ f, to?, at?, dur?, vol?, type? }] — f em Hz, at/dur em segundos.
function playTone(notes, gain = 1) {
  if (!sfxEnabled) return;
  const out = ensureSfx();
  if (!out) return;
  const now = performance.now();
  if (now - lastSfxAt < 60) return;   // evita empilhar sons no mesmo instante
  lastSfxAt = now;

  const t0 = audioCtx.currentTime + 0.02;
  for (const n of notes) {
    const start = t0 + (n.at || 0);
    const dur = n.dur || 0.16;
    const osc = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    osc.type = n.type || 'sine';
    osc.frequency.setValueAtTime(n.f, start);
    if (n.to) osc.frequency.exponentialRampToValueAtTime(n.to, start + dur);
    const peak = Math.max(0.001, (n.vol == null ? 1 : n.vol) * gain);
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(peak, start + 0.014);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    osc.connect(g);
    g.connect(out);
    osc.start(start);
    osc.stop(start + dur + 0.05);
  }
}

const SFX = {
  // Voce entrou na sala: acorde subindo, alegre.
  enterRoom: () => playTone([
    { f: 523.25, at: 0.00, dur: 0.14, vol: 0.5 },
    { f: 659.25, at: 0.09, dur: 0.14, vol: 0.5 },
    { f: 783.99, at: 0.18, dur: 0.26, vol: 0.45 },
  ]),
  // Alguem chegou: dois toques subindo, curtinhos.
  peerJoin: () => playTone([
    { f: 587.33, at: 0.00, dur: 0.12, vol: 0.4 },
    { f: 880.00, at: 0.08, dur: 0.18, vol: 0.35 },
  ]),
  // Alguem saiu: dois toques descendo.
  peerLeave: () => playTone([
    { f: 659.25, at: 0.00, dur: 0.12, vol: 0.35 },
    { f: 440.00, at: 0.08, dur: 0.20, vol: 0.3 },
  ]),
  // Alguem começou a compartilhar: "swoosh" subindo + brilho.
  shareStart: () => playTone([
    { f: 330, to: 880, at: 0.00, dur: 0.22, vol: 0.28, type: 'triangle' },
    { f: 1046.5, at: 0.16, dur: 0.22, vol: 0.3 },
  ]),
  // Compartilhamento acabou: descendo, mais discreto.
  shareStop: () => playTone([
    { f: 740, to: 330, at: 0.00, dur: 0.24, vol: 0.22, type: 'triangle' },
  ]),
  // Voce começou a compartilhar: confirmacao suave.
  shareSelf: () => playTone([
    { f: 660, at: 0.00, dur: 0.12, vol: 0.3, type: 'triangle' },
    { f: 990, at: 0.07, dur: 0.18, vol: 0.25, type: 'triangle' },
  ]),
  // Caiu a conexao com o servidor.
  disconnect: () => playTone([
    { f: 440, at: 0.00, dur: 0.16, vol: 0.35, type: 'triangle' },
    { f: 293.66, at: 0.12, dur: 0.30, vol: 0.35, type: 'triangle' },
  ]),
};

/* ======================= ELEMENTOS ======================= */

const $ = (id) => document.getElementById(id);
const lobby = $('lobby');
const callView = $('call');

/* ======================= LOBBY ======================= */

// Personagens disponiveis. Para adicionar mais, coloque o PNG em
// renderer/avatars/<id>.png (rode scripts/make-avatars.cjs) e liste o id aqui.
const AVATARS = ['emolga', 'leafeon', 'sylveon', 'glaceon', 'jigglypuff', 'gengar', 'meowth'];

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
  expand: SVG('<path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/>'),
  close: SVG('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'),
  smile: SVG('<circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/>'),
  attach: SVG('<path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>'),
  send: SVG('<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>'),
  theater: SVG('<polyline points="14 4 20 4 20 10"/><polyline points="10 20 4 20 4 14"/><line x1="20" y1="4" x2="13.5" y2="10.5"/><line x1="4" y1="20" x2="10.5" y2="13.5"/>'),
  pin: SVG('<line x1="12" y1="17" x2="12" y2="22"/><path d="M9 3h6l-1 6 3.5 3.5a1 1 0 0 1-.7 1.7H6.2a1 1 0 0 1-.7-1.7L9 9z"/>'),
  music: SVG('<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>'),
  people: SVG('<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'),
  lock: SVG('<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>'),
};

// Emotes do chat (arquivos em renderer/emotes/). GIFs animam sozinhos em <img>.
const EMOTES = {
  pikashock: 'pikashock.gif',
  pikachuhello: 'pikachuhello.gif',
  pikaluv: 'pikaluv.png',
  leafeongiggle: 'leafeongiggle.gif',
  leafeonmoney: 'leafeonmoney.gif',
  meowthmoney: 'meowthmoney.gif',
  bulbasaurroll: 'bulbasaurroll.gif',
  spindawat: 'spindawat.png',
  jigglywow: 'jigglywow.png',
  jigglyangry: 'jigglyangry.png',
  espeonpout: 'espeonpout.png',
  espeonlove: 'espeonlove.png',
  espeongg: 'espeongg.png',
  emolgasweat: 'emolgasweat.png',
  haunterok: 'haunterok.png',
  sylveonsmug: 'sylveonsmug.png',
  gengarcool: 'gengarcool.png',
  gamblingschool: 'gamblingschool.gif',
  masho1: 'masho1.webp',
  masho2: 'masho2.webp',
  masho3: 'masho3.webp',
  masho4: 'masho4.webp',
};
function emoteSrc(id) { return `emotes/${EMOTES[id]}`; }

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
  startLobbyWatch(DEFAULT_SERVER); // mostra quem está em cada sala, ao vivo
  startPresence();                 // e me coloca na lista de quem está online
}
$('btn-continue').addEventListener('click', goToRoomStep);
$('inp-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') goToRoomStep(); });

// Voltar para a etapa 1
$('btn-back').addEventListener('click', () => {
  $('step-room').classList.add('hidden');
  $('step-name').classList.remove('hidden');
  $('lobby-tagline').textContent = 'Como você quer ser chamado?';
  setLobbyStatus('');
  stopLobbyWatch();
});

// ---- Observador do lobby: quem está em cada sala ----
let lobbyWs = null;

function startLobbyWatch(server) {
  stopLobbyWatch();
  try {
    lobbyWs = new WebSocket(server);
  } catch {
    return;
  }
  lobbyWs.addEventListener('open', () => lobbyWs.send(JSON.stringify({ type: 'watch-lobby' })));
  lobbyWs.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'lobby') renderRoomOccupancy(msg.rooms);
  });
}

function stopLobbyWatch() {
  if (lobbyWs) {
    try { lobbyWs.close(); } catch {}
    lobbyWs = null;
  }
}

function renderRoomOccupancy(roomsData) {
  for (const id of Object.keys(ROOMS)) {
    const el = document.querySelector(`[data-people="${id}"]`);
    if (!el) continue;
    const list = (roomsData && roomsData[id]) || [];
    el.innerHTML = '';
    if (list.length === 0) {
      const empty = document.createElement('span');
      empty.className = 'room-empty';
      empty.textContent = 'ninguém ainda';
      el.appendChild(empty);
      continue;
    }
    const shown = list.slice(0, 4);
    for (const p of shown) {
      const chip = document.createElement('span');
      chip.className = 'people-chip';
      if (p.avatar && AVATARS.includes(p.avatar)) {
        const img = document.createElement('img');
        img.src = avatarSrc(p.avatar);
        img.alt = '';
        chip.appendChild(img);
      }
      const nm = document.createElement('span');
      nm.className = 'people-name';
      nm.textContent = p.name;
      chip.appendChild(nm);
      el.appendChild(chip);
    }
    if (list.length > shown.length) {
      const more = document.createElement('span');
      more.className = 'people-more';
      more.textContent = `+${list.length - shown.length}`;
      el.appendChild(more);
    }
  }
}

// Clicar num card de sala entra naquela sala.
document.querySelectorAll('.room-card').forEach((card) =>
  card.addEventListener('click', () => join(card.dataset.room))
);

// ---- Sala privada (id secreto derivado de nome + senha) ----
async function roomHash(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function joinPrivate() {
  const rn = $('priv-name').value.trim();
  const pw = $('priv-pass').value;
  if (!rn) return setLobbyStatus('Dê um nome à sala privada.', true);
  if (!pw) return setLobbyStatus('Defina uma senha para a sala.', true);
  const id = 'priv-' + (await roomHash(rn.toLowerCase() + '::' + pw));
  join(id, { name: rn, icon: 'lock' });
}
$('btn-priv').addEventListener('click', joinPrivate);
$('priv-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinPrivate(); });

// Se já tem nome salvo de antes, pula a etapa 1 e vai direto para as salas.
if (($('inp-name').value || '').trim()) {
  goToRoomStep();
}

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
let updateReady = false;
if (window.pokecall.updates) {
  const dl = $('tb-download');
  window.pokecall.updates.onAvailable((v) => {
    showUpdateToast(`Baixando atualização${v ? ' v' + v : ''}…`, false);
    dl.classList.remove('hidden', 'ready');
    dl.title = 'Baixando atualização…';
  });
  window.pokecall.updates.onDownloaded((v) => {
    showUpdateToast(`Atualização${v ? ' v' + v : ''} pronta para instalar!`, true);
    updateReady = true;
    dl.classList.remove('hidden');
    dl.classList.add('ready');
    dl.title = 'Atualização pronta — clique para instalar';
  });
  dl.addEventListener('click', () => { if (updateReady) window.pokecall.updates.restart(); });
  $('update-restart').addEventListener('click', () => window.pokecall.updates.restart());
}

function setLobbyStatus(text, isError = false) {
  const el = $('lobby-status');
  el.textContent = text;
  el.classList.toggle('error', isError);
}

let roomDisplayName = '';
let roomIcon = 'chat';

async function join(room, display) {
  const name = $('inp-name').value.trim();
  const server = DEFAULT_SERVER;

  if (!name) return setLobbyStatus('Digite seu nome primeiro.', true);

  if (display) {
    roomDisplayName = display.name;
    roomIcon = display.icon || 'chat';
  } else if (ROOMS[room]) {
    roomDisplayName = ROOMS[room].name;
    roomIcon = ROOMS[room].icon;
  } else {
    return; // sala desconhecida
  }

  localStorage.setItem('pokecall.name', name);

  selfName = name;
  roomId = room;

  stopLobbyWatch(); // a conexão da sala assume a partir daqui
  startPresence();  // continua anunciando que estou online
  presenceSend({ type: 'presence-room', room, roomName: roomDisplayName });

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
      SFX.disconnect();
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
      SFX.peerJoin();
      createPeer(msg.id, msg.name, msg.avatar);
      updatePeerCount();
      updateConnBadge();
      break;

    case 'peer-left': {
      const st = peers.get(msg.id);
      if (st) {
        addSystemChat(`${st.name} saiu da call.`);
        SFX.peerLeave();
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
      if (msg.from !== selfId) {
        addChat(msg.name, msg.text, peers.get(msg.from)?.avatar);
      }
      break;

    // ---- Música da sala ----
    case 'music':
      applyMusic(msg);
      break;

    case 'music-notice':
      showMusicNotice(msg.text, msg.kind);
      // Nada de texto cinza: quem fala no chat é o DJ Emolga.
      if (msg.dj || msg.kind === 'erro') addDjChat(msg.dj, msg.text, msg.kind);
      break;

    case 'music-results':
      renderMusicResults(msg.results || []);
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
    micOn: pendingMeta.get(peerId)?.mic !== false, // até dizerem o contrário, ligado
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

  // Envia nosso personagem (avatar) e o estado do microfone para este peer.
  sendSignal(peerId, { meta: { avatar: selectedAvatar, mic: micEnabled } });

  // Adiciona nossos tracks atuais (microfone + tela, se estiver compartilhando).
  for (const track of localAudioStream.getAudioTracks()) {
    pc.addTrack(track, localAudioStream);
  }
  if (localScreenStream) {
    for (const track of localScreenStream.getVideoTracks()) {
      state.screenSender = pc.addTrack(track, localScreenStream);
      applyScreenEncoding(state.screenSender, null, null, pc);
    }
    // Também envia o ÁUDIO da tela (senão quem entra depois vê mas não ouve).
    for (const track of localScreenStream.getAudioTracks()) {
      pc.addTrack(track, localScreenStream);
    }
  }

  // ---- Canal de dados (envio de fotos/vídeos P2P) ----
  // Um lado cria, o outro escuta (evita canal duplicado). É bidirecional.
  if (!state.polite) {
    setupDataChannel(state, pc.createDataChannel('files'));
  }
  pc.ondatachannel = (ev) => setupDataChannel(state, ev.channel);

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
      addPeerAudioTrack(state, track);
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
  pushOverlayState();
}

async function onPeerSignal(peerId, data) {
  // Troca de "meta" (personagem/avatar) — pode chegar antes da conexao existir.
  if (data.meta) {
    const st = peers.get(peerId);
    if (st) {
      st.avatar = data.meta.avatar || st.avatar;
      if (typeof data.meta.mic === 'boolean') st.micOn = data.meta.mic;
      renderTileAvatar(st);
      renderTileMic(st);
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

/* =============== JANELA SUSPENSA (OVERLAY) ===============
 * Janelinha sempre no topo para falar/comentar sem sair do que se está
 * assistindo. Ela só desenha; o estado e as mensagens saem daqui.
 */
const overlayApi = window.pokecall && window.pokecall.overlay;
let overlayOn = false;

$('btn-overlay').addEventListener('click', () => overlayApi && overlayApi.toggle());

if (overlayApi) {
  overlayApi.onVisible((visible) => {
    overlayOn = !!visible;
    $('btn-overlay').classList.toggle('active', overlayOn);
    if (overlayOn) pushOverlayState();
  });

  overlayApi.onAction((a) => {
    if (!a) return;
    if (a.type === 'ready') {
      pushOverlayState();
    } else if (a.type === 'mic') {
      toggleMic();
    } else if (a.type === 'chat' && a.text) {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: 'chat', room: roomId, text: a.text }));
      addChat(selfName, a.text, selectedAvatar);
    }
  });
}

// Estado (microfone, conexão, quem transmite) -> janelinha.
function pushOverlayState() {
  if (!overlayApi || !overlayOn) return;
  let sharing = null;
  for (const [, st] of peers) {
    if (st.videoStream && st.name) { sharing = st.name; break; }
  }
  if (!sharing && localScreenStream) sharing = 'Você';
  overlayApi.push({
    type: 'state',
    mic: micEnabled,
    sharing,
    room: roomDisplayName || (ROOMS[roomId] && ROOMS[roomId].name) || 'PokeCall',
    connected: !!(ws && ws.readyState === WebSocket.OPEN),
  });
}

// Mensagem nova -> janelinha. Manda o texto já quebrado em pedaços para o
// overlay não precisar conhecer a lista de emotes.
function pushOverlayMessage(name, text, avatar) {
  if (!overlayApi || !overlayOn) return;
  const parts = [];
  for (const part of String(text).split(/(:[a-z0-9_]+:)/i)) {
    if (!part) continue;
    const m = part.match(/^:([a-z0-9_]+):$/i);
    const id = m && m[1].toLowerCase();
    if (id && EMOTES[id]) parts.push({ t: 'emote', v: emoteSrc(id) });
    else parts.push({ t: 'text', v: part });
  }
  overlayApi.push({
    type: 'msg',
    name,
    avatarSrc: avatar && AVATARS.includes(avatar) ? avatarSrc(avatar) : null,
    parts,
  });
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

// Conta para todos que meu microfone ligou/desligou (estilo Discord: quem
// está mudo aparece com o ícone de microfone cortado na telha).
function broadcastMicState() {
  for (const [peerId, st] of peers) {
    if (!st.pc) continue; // pula a ficha "self-ui"
    sendSignal(peerId, { meta: { avatar: selectedAvatar, mic: micEnabled } });
  }
  const self = peers.get('self-ui');
  if (self) {
    self.micOn = micEnabled;
    renderTileMic(self);
  }
}

function updateMicButton() {
  const btn = $('btn-mic');
  btn.classList.toggle('active', micEnabled);
  btn.querySelector('.ctrl-icon').innerHTML = micEnabled ? ICONS.mic : ICONS.micOff;
  btn.querySelector('.ctrl-label').textContent = micEnabled ? 'Ligado' : 'Mudo';
  pushOverlayState();
  broadcastMicState();
  // Botão de microfone do modo tela cheia (vídeo).
  const vmic = $('viewer-mic');
  if (vmic) {
    vmic.classList.toggle('active', micEnabled);
    vmic.querySelector('.ctrl-icon').innerHTML = micEnabled ? ICONS.mic : ICONS.micOff;
  }
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

  const screens = sources.filter((s) => s.id.startsWith('screen:'));
  const windows = sources.filter((s) => !s.id.startsWith('screen:'));

  const addGroup = (title, items) => {
    if (items.length === 0) return;
    const h = document.createElement('div');
    h.className = 'source-group-title';
    h.textContent = title;
    list.appendChild(h);
    const grid = document.createElement('div');
    grid.className = 'source-grid';
    for (const src of items) {
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
      grid.appendChild(item);
    }
    list.appendChild(grid);
  };

  addGroup('Telas inteiras — recomendado (mostra tudo e o cursor)', screens);
  addGroup('Janelas — só um programa (não mostra o cursor)', windows);
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
      applyScreenEncoding(state.screenSender, q, hint, state.pc);
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

  // Se era "assistir arquivo", para o player.
  const movieEl = $('movie-el');
  if (movieEl) { try { movieEl.pause(); } catch {} movieEl.removeAttribute('src'); movieEl.load(); }
  $('movie-player').classList.add('hidden');
  $('grid').classList.remove('hidden'); // volta a mostrar as telhas

  hideSelfPreview();

  const btn = $('btn-screen');
  btn.classList.remove('active');
  btn.querySelector('.ctrl-label').textContent = 'Tela';
}

/* ======================= ASSISTIR ARQUIVO DE VÍDEO JUNTO (sem eco) ======================= */

$('btn-watch-file').addEventListener('click', () => $('video-file-input').click());
$('btn-watch').addEventListener('click', () => {
  if (localScreenStream) stopScreenShare(); // se já está compartilhando algo, para
  $('video-file-input').click();
});
$('video-file-input').addEventListener('change', (e) => {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';
  if (f) shareVideoFile(f);
});
$('movie-close').addEventListener('click', stopScreenShare);

async function shareVideoFile(file) {
  $('source-picker').classList.add('hidden');
  if (localScreenStream) stopScreenShare();

  const movieEl = $('movie-el');
  movieEl.src = URL.createObjectURL(file);
  $('grid').classList.add('hidden');            // player ocupa o palco (área grande)
  $('theater').classList.add('hidden');
  $('movie-player').classList.remove('hidden');
  try { await movieEl.play(); } catch {}

  // captureStream = transmite o vídeo E o áudio do filme diretamente (sem passar
  // pela captura do sistema) -> só o áudio do filme, sem as vozes da call -> sem eco.
  const capture = movieEl.captureStream || movieEl.mozCaptureStream;
  if (!capture) { addSystemChat('Seu sistema não suporta transmitir arquivo de vídeo.'); return; }
  const stream = capture.call(movieEl);
  localScreenStream = stream;

  const q = QUALITY[$('quality-select').value] || QUALITY['1080p60'];
  const hint = $('hint-select').value;
  for (const state of peers.values()) {
    if (!state.pc) continue;
    for (const t of stream.getVideoTracks()) {
      t.contentHint = hint;
      state.screenSender = state.pc.addTrack(t, stream);
      applyScreenEncoding(state.screenSender, q, hint, state.pc);
    }
    for (const t of stream.getAudioTracks()) {
      state.pc.addTrack(t, stream);
    }
  }

  showSelfPreview(stream);
  const btn = $('btn-screen');
  btn.classList.add('active');
  btn.querySelector('.ctrl-label').textContent = 'Parar';
}

// Define bitrate alto, framerate e como degradar sob rede ruim.
async function applyScreenEncoding(sender, q, hint, pc) {
  if (!sender) return;
  q = q || QUALITY[$('quality-select').value] || QUALITY['1080p60'];
  hint = hint || $('hint-select').value;
  if (q.ultra) preferUltraCodec(pc, sender);
  try {
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
    params.encodings[0].maxBitrate = q.bitrate;
    params.encodings[0].maxFramerate = q.fps;
    if (q.ultra) {
      // Manda a imagem em tamanho cheio, com prioridade de rede maxima.
      params.encodings[0].scaleResolutionDownBy = 1;
      params.encodings[0].networkPriority = 'high';
      params.encodings[0].priority = 'high';
    }
    // 'motion' = prioriza fluidez; 'detail' = prioriza resolucao/nitidez.
    // No ultra a resolucao nunca cai (perde quadros antes de borrar).
    params.degradationPreference =
      q.ultra || hint === 'detail' ? 'maintain-resolution' : 'maintain-framerate';
    await sender.setParameters(params);
  } catch (err) {
    console.warn('applyScreenEncoding', err);
  }
}

// No modo ultra, pede VP9/AV1 para o transceiver da tela. VP8 (padrao) borra
// muito em 2K/4K mesmo com bitrate alto. Vale para a proxima negociacao.
function preferUltraCodec(pc, sender) {
  if (!pc || !sender || !RTCRtpSender.getCapabilities) return;
  try {
    const tr = pc.getTransceivers().find((t) => t.sender === sender);
    if (!tr || !tr.setCodecPreferences) return;
    const codecs = RTCRtpSender.getCapabilities('video').codecs;
    const rank = (c) => {
      const i = ULTRA_CODECS.indexOf(c.mimeType);
      return i === -1 ? ULTRA_CODECS.length : i;
    };
    tr.setCodecPreferences([...codecs].sort((a, b) => rank(a) - rank(b)));
  } catch (err) {
    console.warn('preferUltraCodec', err);
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
  $('room-name').textContent = roomDisplayName || roomId;
  $('room-badge').innerHTML = ICONS[roomIcon] || ICONS.chat;
  updateMicButton();

  const selfState = {
    id: 'self',
    name: selfName + ' (você)',
    avatar: selectedAvatar,
    micOn: micEnabled,
    tile: null,
  };
  createTile(selfState);
  peers.set('self-ui', selfState);
  setupSelfAnalyser(selfState);
  updatePeerCount();
  updateConnBadge();
  renderPeople();   // some com a abinha do lobby e atualiza os botões
  SFX.enterRoom();
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
  renderTileMic(state);

  // Botão direito na telha de um participante -> ajustar o volume dele (só para mim).
  if (state.pc) {
    root.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showPeerMenu(state, e.clientX, e.clientY);
    });
  }

  // Duplo-clique numa telha com vídeo -> modo Expandido.
  root.addEventListener('dblclick', () => {
    if (root.classList.contains('has-video')) openTheater(state);
  });
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

// Ícone de microfone cortado ao lado do nome, quando a pessoa está muda.
function renderTileMic(state) {
  const t = state.tile;
  if (!t) return;
  const has = t.nameTag.querySelector('.tile-mic-off');
  if (state.micOn === false) {
    if (has) return;
    const ic = document.createElement('span');
    ic.className = 'tile-mic-off';
    ic.title = 'Microfone desligado';
    ic.innerHTML = ICONS.micOff;
    t.nameTag.appendChild(ic);
  } else if (has) {
    has.remove();
  }
}

function showVideo(state) {
  const t = state.tile;
  if (!t) return;
  const v = t.video;
  const jaEstava = t.root.classList.contains('has-video');
  if (v.srcObject !== state.videoStream) v.srcObject = state.videoStream;
  t.root.classList.add('has-video');
  if (!jaEstava) (state.id === 'self-ui' ? SFX.shareSelf : SFX.shareStart)();
  pushOverlayState();
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
  if (!t.root.querySelector('.tile-actions')) {
    const acts = document.createElement('div');
    acts.className = 'tile-actions';

    const th = document.createElement('button');
    th.className = 'tile-btn';
    th.title = 'Expandir (mantém chat e controles)';
    th.innerHTML = ICONS.theater;
    th.addEventListener('click', (e) => { e.stopPropagation(); openTheater(state); });

    const fs = document.createElement('button');
    fs.className = 'tile-btn';
    fs.title = 'Tela cheia';
    fs.innerHTML = ICONS.expand;
    fs.addEventListener('click', (e) => { e.stopPropagation(); openViewer(state); });

    acts.append(th, fs);
    t.root.appendChild(acts);
  }
}

function hideVideo(state) {
  const t = state.tile;
  if (!t) return;
  if (t.root.classList.contains('has-video') && state.id !== 'self-ui') SFX.shareStop();
  t.root.classList.remove('has-video');
  pushOverlayState();
  t.video.srcObject = null;
  const b = t.root.querySelector('.tile-badge-share');
  if (b) b.remove();
  const acts = t.root.querySelector('.tile-actions');
  if (acts) acts.remove();
  // Se estava mostrando esta pessoa em tela cheia ou expandido, fecha.
  if (viewerState === state) closeViewer();
  if (theaterState === state) closeTheater();
}

/* ======================= VISUALIZADOR (tela cheia) ======================= */

let viewerState = null;
let theaterState = null;

// ---- Modo EXPANDIDO (preenche o palco, mantém chat e controles) ----
function openTheater(state) {
  if (!state) return;
  // Se estava em tela cheia, sai dela primeiro.
  if (!$('viewer').classList.contains('hidden')) closeViewer();
  theaterState = state;
  const v = $('theater-video');
  v.srcObject = state.videoStream;
  v.muted = true;
  $('theater-name').textContent = state.name;
  $('grid').classList.add('hidden');
  $('theater').classList.remove('hidden');
  v.play().catch(() => {});
}

function closeTheater() {
  $('theater').classList.add('hidden');
  $('grid').classList.remove('hidden');
  const v = $('theater-video');
  try { v.pause(); } catch {}
  v.srcObject = null;
  theaterState = null;
}

$('theater-close').addEventListener('click', closeTheater);
$('theater-fs').addEventListener('click', () => { if (theaterState) openViewer(theaterState); });

function openViewer(state) {
  if (!state) return;
  viewerState = state;
  const v = $('viewer-video');
  const img = document.getElementById('viewer-img');
  if (img) img.style.display = 'none';
  v.style.display = '';
  v.removeAttribute('src');
  v.controls = false;
  v.srcObject = state.videoStream;
  v.muted = true; // o áudio já toca pelos alto-falantes; evita eco/duplicado
  $('viewer-name').textContent = state.name;
  $('viewer').classList.remove('hidden');
  v.play().catch(() => {});
}

// Abre um VÍDEO de arquivo (do chat) em tela cheia, com controles.
function openVideoViewer(url) {
  const img = document.getElementById('viewer-img');
  if (img) img.style.display = 'none';
  const v = $('viewer-video');
  v.style.display = '';
  v.srcObject = null;
  v.src = url;
  v.muted = false;
  v.controls = true;
  $('viewer-name').textContent = 'Vídeo';
  $('viewer').classList.remove('hidden');
  v.play().catch(() => {});
}

// Abre uma imagem do chat em tela cheia.
function openImageViewer(url) {
  const v = $('viewer-video');
  v.style.display = 'none';
  v.srcObject = null;
  let img = document.getElementById('viewer-img');
  if (!img) {
    img = document.createElement('img');
    img.id = 'viewer-img';
    $('viewer').insertBefore(img, $('viewer').firstChild);
  }
  img.style.display = '';
  img.src = url;
  $('viewer-name').textContent = 'Imagem';
  $('viewer').classList.remove('hidden');
}

function closeViewer() {
  $('viewer').classList.add('hidden');
  const v = $('viewer-video');
  try { v.pause(); } catch {}
  v.srcObject = null;
  v.removeAttribute('src');
  v.controls = false;
  v.load();
  v.style.display = '';
  const img = document.getElementById('viewer-img');
  if (img) { img.style.display = 'none'; img.src = ''; }
  // Recolhe o chat flutuante ao sair da tela cheia.
  $('chat-panel').classList.remove('floating');
  $('viewer-chat-toggle').classList.remove('active');
  viewerState = null;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

$('viewer-close').addEventListener('click', closeViewer);
$('viewer-fs').addEventListener('click', () => {
  const el = $('viewer');
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else el.requestFullscreen().catch(() => {});
});

// Abrir/ocultar o chat (barra lateral flutuante) dentro da tela cheia.
$('viewer-chat-toggle').addEventListener('click', () => {
  const chat = $('chat-panel');
  const floating = chat.classList.toggle('floating');
  chat.classList.remove('hidden-panel');
  $('viewer-chat-toggle').classList.toggle('active', floating);
  if (floating) $('chat-input').focus();
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || $('viewer').classList.contains('hidden')) return;
  // Se estiver digitando um comentário, Esc só sai do campo (não fecha o vídeo).
  if (document.activeElement === $('viewer-chat-input')) { $('viewer-chat-input').blur(); return; }
  closeViewer();
});

// ---- Modo comentário dentro do vídeo em tela cheia ----
$('viewer-mic').addEventListener('click', toggleMic);

$('viewer-chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('viewer-chat-input');
  const text = input.value.trim();
  if (!text) return;
  ws.send(JSON.stringify({ type: 'chat', room: roomId, text }));
  addChat(selfName, text, selectedAvatar);
  input.value = '';
});

// Notificações empilhadas (uma sobre a outra), só enquanto o vídeo está aberto.
// Mesmo visual do chat/pop-up: foto da pessoa + nome + mensagem.
function notifyViewer(name, text, avatar) {
  const box = $('viewer-toast');
  if (!box || $('viewer').classList.contains('hidden')) return;
  box.classList.remove('hidden');

  const el = document.createElement('div');
  el.className = 'viewer-msg';

  const av = document.createElement('span');
  av.className = 'chat-av';
  if (avatar && AVATARS.includes(avatar)) {
    const img = document.createElement('img');
    img.src = avatarSrc(avatar);
    img.alt = '';
    av.appendChild(img);
  } else {
    av.textContent = initials(name);
  }

  const body = document.createElement('div');
  body.className = 'chat-body';
  const who = document.createElement('span');
  who.className = 'who';
  who.textContent = name;
  const txt = document.createElement('span');
  txt.className = 'chat-text';
  renderMessageContent(txt, text); // mostra emotes também
  body.append(who, txt);

  el.append(av, body);
  box.appendChild(el);
  while (box.children.length > 10) box.removeChild(box.firstChild);

  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 600);
  }, 10000);
}

// Toca UMA faixa de áudio de um participante. Chamado para CADA faixa
// (microfone e áudio da tela chegam como faixas separadas). Tocar cada uma
// pelo WebAudio garante que o áudio da tela também sai, e sem eco.
function addPeerAudioTrack(state, track) {
  ensureAudio();

  // Elemento MUDO só mantém o pipeline do WebRTC vivo (bug do Chromium).
  // Mudo = não sai som por ele, então NÃO é capturado pelo "áudio do sistema".
  if (!state.audioEl) {
    state.audioEl = document.createElement('audio');
    state.audioEl.autoplay = true;
    state.audioEl.muted = true;
    document.body.appendChild(state.audioEl);
    state.audioEl.srcObject = state.audioStream;
    state.audioEl.play().catch(() => {});
  }

  if (audioCtx && masterGain) {
    // Ganho por pessoa (uma vez): -> alto-falantes.
    if (!state.gain) {
      state.gain = audioCtx.createGain();
      state.gain.gain.value = state.volume ?? 1;
      state.gain.connect(masterGain);
    }
    try {
      const src = audioCtx.createMediaStreamSource(new MediaStream([track]));
      src.connect(state.gain);
      // O indicador de "falando" usa só a 1ª faixa (o microfone).
      if (!state.analyser) {
        state.analyser = audioCtx.createAnalyser();
        state.analyser.fftSize = 512;
        src.connect(state.analyser);
        startSpeakingLoop();
      }
    } catch (err) {
      console.warn('grafo de áudio', err);
      state.audioEl.muted = false; // fallback: toca pelo elemento (pode ecoar)
    }
  } else {
    state.audioEl.muted = false;
  }
}

// Ajusta o volume local de uma pessoa (0..2). Só afeta o que EU ouço.
function setPeerVolume(state, v) {
  state.volume = v;
  if (state.gain) state.gain.gain.value = v;
  else if (state.audioEl) { state.audioEl.muted = false; state.audioEl.volume = Math.min(1, v); }
}

function setMasterVolume(v) {
  masterVolume = v;
  localStorage.setItem('pokecall.volume', String(v));
  if (masterGain) masterGain.gain.value = v;
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
  const panel = $('chat-panel');
  panel.classList.toggle('hidden-panel');
  $('btn-chat').classList.toggle('active');
  if (!panel.classList.contains('hidden-panel')) $('chat-input').focus();
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
  renderMessageContent(txt, text);
  body.append(whoEl, txt);

  el.append(av, body);
  const box = $('chat-messages');
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;

  notifyViewer(who, text, avatar);   // notificação dentro do vídeo em tela cheia
  pushOverlayMessage(who, text, avatar); // janelinha sempre no topo
}

function addSystemChat(text) {
  const el = document.createElement('div');
  el.className = 'chat-msg system';
  el.textContent = text;
  const box = $('chat-messages');
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
}

// Converte texto em nós: emotes (:id:) viram imagens, o resto vira texto (seguro).
function renderMessageContent(el, text) {
  const parts = text.split(/(:[a-z0-9_]+:)/i);
  let emotes = 0, hasText = false;
  for (const part of parts) {
    if (!part) continue;
    const m = part.match(/^:([a-z0-9_]+):$/i);
    const id = m && m[1].toLowerCase();
    if (id && EMOTES[id]) {
      const img = document.createElement('img');
      img.className = 'chat-emote';
      img.src = emoteSrc(id);
      img.alt = part;
      el.appendChild(img);
      emotes++;
    } else {
      el.appendChild(document.createTextNode(part));
      if (part.trim()) hasText = true;
    }
  }
  // Se a mensagem for só emote(s), mostra grande (estilo Discord).
  if (emotes > 0 && !hasText) el.classList.add('only-emotes');
}

/* ======================= EMOTES (seletor) ======================= */

(function buildEmotePicker() {
  const panel = $('emote-panel');
  for (const id of Object.keys(EMOTES)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'emote-opt';
    b.title = id;
    const img = document.createElement('img');
    img.src = emoteSrc(id);
    img.alt = id;
    img.loading = 'lazy';
    b.appendChild(img);
    b.addEventListener('click', () => sendEmote(id));
    panel.appendChild(b);
  }
})();

function sendEmote(id) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const token = `:${id}:`;
  ws.send(JSON.stringify({ type: 'chat', room: roomId, text: token }));
  addChat(selfName, token, selectedAvatar);
}

$('btn-emote').addEventListener('click', (e) => {
  e.stopPropagation();
  $('emote-panel').classList.toggle('hidden');
});
document.addEventListener('mousedown', (e) => {
  const panel = $('emote-panel');
  const btn = $('btn-emote');
  if (!panel.classList.contains('hidden') && !panel.contains(e.target) && !btn.contains(e.target)) {
    panel.classList.add('hidden');
  }
});

/* ======================= FOTOS E VÍDEOS NO CHAT (P2P) ======================= */

const FILE_MAX = 50 * 1024 * 1024; // 50 MB
const FILE_CHUNK = 16 * 1024;

function setupDataChannel(state, ch) {
  state.dc = ch;
  ch.binaryType = 'arraybuffer';
  ch.onmessage = (e) => onDataMessage(state, e.data);
}

function onDataMessage(state, data) {
  if (typeof data === 'string') {
    let msg; try { msg = JSON.parse(data); } catch { return; }
    if (msg.t === 'meta') {
      state.rx = { name: msg.name, mime: msg.mime, from: msg.from, avatar: msg.avatar, chunks: [] };
    } else if (msg.t === 'end' && state.rx) {
      const blob = new Blob(state.rx.chunks, { type: state.rx.mime || 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      addFileMessage(state.rx.from || state.name, state.rx.avatar || state.avatar, { url, mime: state.rx.mime, name: state.rx.name });
      state.rx = null;
    }
  } else if (state.rx) {
    state.rx.chunks.push(data);
  }
}

$('btn-attach').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', (e) => {
  for (const f of e.target.files) sendFile(f);
  e.target.value = '';
});

// Impede o Electron de abrir o arquivo ao soltar fora da área certa.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

// Arrastar e soltar fotos/vídeos no chat.
const chatPanelEl = $('chat-panel');
['dragenter', 'dragover'].forEach((ev) =>
  chatPanelEl.addEventListener(ev, (e) => {
    e.preventDefault();
    e.stopPropagation();
    chatPanelEl.classList.add('drag-over');
  })
);
['dragleave', 'drop'].forEach((ev) =>
  chatPanelEl.addEventListener(ev, (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (ev === 'dragleave' && chatPanelEl.contains(e.relatedTarget)) return;
    chatPanelEl.classList.remove('drag-over');
  })
);
chatPanelEl.addEventListener('drop', (e) => {
  const files = e.dataTransfer && e.dataTransfer.files;
  if (files) for (const f of files) sendFile(f);
});

// Colar (Ctrl+V) foto/vídeo direto no chat (ex: print de tela).
document.addEventListener('paste', (e) => {
  if (callView.classList.contains('hidden')) return; // só dentro da call
  const files = e.clipboardData && e.clipboardData.files;
  if (files && files.length) {
    e.preventDefault();
    for (const f of files) sendFile(f);
  }
});

async function sendFile(file) {
  if (file.size > FILE_MAX) {
    addSystemChat(`"${file.name}" é grande demais (máx 50 MB).`);
    return;
  }
  const buf = await file.arrayBuffer();
  const meta = JSON.stringify({
    t: 'meta', name: file.name, mime: file.type, from: selfName, avatar: selectedAvatar,
  });

  let sent = 0;
  for (const [, st] of peers) {
    const dc = st.dc;
    if (!dc || dc.readyState !== 'open') continue;
    try {
      dc.send(meta);
      await sendChunks(dc, buf);
      dc.send(JSON.stringify({ t: 'end' }));
      sent++;
    } catch (err) {
      console.warn('envio de arquivo falhou', err);
    }
  }

  // Mostra para mim mesmo.
  addFileMessage(selfName, selectedAvatar, { url: URL.createObjectURL(file), mime: file.type, name: file.name });
  if (sent === 0) addSystemChat('Ninguém conectado para receber o arquivo ainda.');
}

function sendChunks(dc, buf) {
  return new Promise((resolve) => {
    const HIGH = 1024 * 1024; // segura em 1 MB de buffer
    let offset = 0;
    dc.bufferedAmountLowThreshold = 256 * 1024;
    const pump = () => {
      while (offset < buf.byteLength) {
        if (dc.bufferedAmount > HIGH) {
          dc.onbufferedamountlow = () => { dc.onbufferedamountlow = null; pump(); };
          return;
        }
        const end = Math.min(offset + FILE_CHUNK, buf.byteLength);
        dc.send(buf.slice(offset, end));
        offset = end;
      }
      resolve();
    };
    pump();
  });
}

function addFileMessage(who, avatar, file) {
  const el = document.createElement('div');
  el.className = 'chat-msg';

  const av = document.createElement('span');
  av.className = 'chat-av';
  if (avatar && AVATARS.includes(avatar)) {
    const img = document.createElement('img');
    img.src = avatarSrc(avatar);
    av.appendChild(img);
  } else {
    av.textContent = initials(who);
  }

  const body = document.createElement('div');
  body.className = 'chat-body';
  const whoEl = document.createElement('span');
  whoEl.className = 'who';
  whoEl.textContent = who;
  body.appendChild(whoEl);

  const mime = file.mime || '';
  if (mime.startsWith('image/')) {
    const img = document.createElement('img');
    img.className = 'chat-media';
    img.src = file.url;
    img.addEventListener('click', () => openImageViewer(file.url));
    body.appendChild(img);
  } else if (mime.startsWith('video/')) {
    const wrap = document.createElement('div');
    wrap.className = 'chat-video-wrap';
    const vid = document.createElement('video');
    vid.className = 'chat-media';
    vid.src = file.url;
    vid.muted = true;
    vid.preload = 'metadata';
    const play = document.createElement('span');
    play.className = 'chat-play';
    play.innerHTML = '<svg viewBox="0 0 24 24" fill="#fff"><polygon points="7 4 20 12 7 20"/></svg>';
    wrap.append(vid, play);
    wrap.addEventListener('click', () => openVideoViewer(file.url));
    body.appendChild(wrap);
  } else {
    const a = document.createElement('a');
    a.className = 'chat-file-link';
    a.href = file.url;
    a.download = file.name || 'arquivo';
    a.textContent = file.name || 'arquivo';
    body.appendChild(a);
  }

  el.append(av, body);
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
  outputSel.disabled = !(audioCtx && typeof audioCtx.setSinkId === 'function');

  const volPct = Math.round(parseFloat(localStorage.getItem('pokecall.volume') ?? '1') * 100);
  $('set-volume').value = volPct;
  $('vol-label').textContent = volPct + '%';
  $('set-sfx').checked = sfxEnabled;
  if (window.pokecall.startup) {
    window.pokecall.startup.get().then((v) => { $('set-startup').checked = !!v; }).catch(() => {});
  }
}

$('set-input').addEventListener('change', (e) => setInputDevice(e.target.value));
$('set-output').addEventListener('change', (e) => setOutputDevice(e.target.value));
$('set-volume').addEventListener('input', (e) => {
  const pct = parseInt(e.target.value, 10);
  $('vol-label').textContent = pct + '%';
  setMasterVolume(pct / 100);
});
$('set-startup').addEventListener('change', (e) => {
  if (!window.pokecall.startup) return;
  window.pokecall.startup.set(e.target.checked).then((v) => { $('set-startup').checked = !!v; }).catch(() => {});
});
if (window.pokecall.startup && window.pokecall.startup.onChanged) {
  window.pokecall.startup.onChanged((v) => { $('set-startup').checked = !!v; });
}

$('set-sfx').addEventListener('change', (e) => {
  setSfxEnabled(e.target.checked);
  if (e.target.checked) SFX.peerJoin(); // previa do som
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
  if (audioCtx && audioCtx.setSinkId) {
    try { await audioCtx.setSinkId(deviceId || ''); } catch (err) { console.warn('setSinkId', err); }
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

/* ======================= MÚSICA DA SALA (Robô de Música) ======================= *
 * Um "robô" entra na call e toca música para todo mundo. Ele não manda áudio
 * pela internet: cada app abre o mesmo vídeo do YouTube ESCONDIDO (só o som) e
 * o servidor diz o que está tocando e em que segundo — então todos ouvem a
 * mesma coisa, ao mesmo tempo, sem gastar upload de ninguém.                   */

const MUSIC_HTTP = DEFAULT_SERVER.replace(/^ws/, 'http');
const musicFrame = $('music-frame');

let musicVolume = parseFloat(localStorage.getItem('pokecall.musicVolume') ?? '0.6');
let musicState = { current: null, queue: [], paused: false };
let musicAnchor = null;    // onde o servidor diz que a música está
let musicPlayerMs = 0;     // onde o player daqui realmente está
let musicPlayerAt = 0;
let musicPlayerPronto = false;
let musicUiTimer = null;
let musicDragging = false;
let musicBot = null;       // telha do robô na grade

function sendMusic(action, extra) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'music', action, ...(extra || {}) }));
  }
}

function toPlayer(cmd, extra) {
  if (!musicFrame.contentWindow) return;
  musicFrame.contentWindow.postMessage({ cmd, ...(extra || {}) }, '*');
}

// A página escondida do tocador só é carregada quando alguém põe música.
function ensurePlayer() {
  if (musicFrame.src) return;
  musicFrame.src = MUSIC_HTTP + '/player.html';
}

/* ---- Recados do tocador escondido ---- */

window.addEventListener('message', (ev) => {
  const msg = ev.data;
  if (!msg || typeof msg !== 'object' || !msg.pc) return;

  switch (msg.ev) {
    case 'ready':
      musicPlayerPronto = true;
      toPlayer('volume', { v: Math.round(musicVolume * 100) });
      if (musicState.current) aplicarNoPlayer(true);
      break;

    case 'time':
      musicPlayerMs = msg.ms;
      musicPlayerAt = performance.now();
      corrigirAtraso();
      break;

    case 'duration':
      sendMusic('duration', { id: msg.id, seconds: msg.seconds });
      break;

    case 'ended':
      sendMusic('ended', { id: msg.id });
      break;

    case 'error':
      sendMusic('failed', { id: msg.id, code: msg.code });
      break;
  }
});

/* ---- Sincronia ---- */

// Onde a música DEVERIA estar agora, segundo o servidor.
function expectedMusicMs() {
  if (!musicAnchor) return 0;
  if (musicAnchor.paused) return musicAnchor.posMs;
  return musicAnchor.posMs + (performance.now() - musicAnchor.at);
}

// Se o tocador daqui ficou para trás (ou na frente), acerta o ponto.
function corrigirAtraso() {
  if (!musicState.current || musicState.paused) return;
  const aqui = musicPlayerMs + (performance.now() - musicPlayerAt);
  if (Math.abs(aqui - expectedMusicMs()) > 2500) {
    toPlayer('seek', { ms: expectedMusicMs() });
  }
}

function aplicarNoPlayer(trocouDeMusica) {
  const cur = musicState.current;

  if (!cur) {
    toPlayer('stop');
    return;
  }

  ensurePlayer();
  if (!musicPlayerPronto) return; // assim que ficar pronto ele se ajusta sozinho

  if (trocouDeMusica) {
    musicPlayerMs = expectedMusicMs();
    musicPlayerAt = performance.now();
    toPlayer('load', { id: cur.id, posMs: expectedMusicMs(), paused: musicState.paused });
    return;
  }

  if (musicState.paused) toPlayer('pause');
  else { toPlayer('seek', { ms: expectedMusicMs() }); toPlayer('play'); }
}

function applyMusic(msg) {
  const antes = musicState.current && musicState.current.id;
  musicState = { current: msg.current || null, queue: msg.queue || [], paused: !!msg.paused };
  musicAnchor = { posMs: msg.posMs || 0, at: performance.now(), paused: !!msg.paused };

  const trocou = antes !== (msg.current && msg.current.id);
  if (msg.current) ensurePlayer();
  aplicarNoPlayer(trocou);
  renderMusicBot();
  renderMusic();
}

// Confere o atraso de vez em quando, mesmo sem recado do tocador.
setInterval(corrigirAtraso, 8000);

function setMusicVolume(v) {
  musicVolume = v;
  localStorage.setItem('pokecall.musicVolume', String(v));
  toPlayer('volume', { v: Math.round(v * 100) });
}

/* ---- O DJ Emolga: telha na grade + vinil no topo do chat ---- */

const DJ_NOME = 'DJ Emolga';
const DJ_FOTO = 'dj-emolga.png';

function renderMusicBot() {
  const cur = musicState.current;

  if (!cur) {
    if (musicBot && musicBot.tile) {
      musicBot.tile.root.remove();
      musicBot = null;
    }
    $('btn-music').classList.remove('active');
    updateNowPlaying();
    return;
  }

  if (!musicBot) {
    musicBot = { id: 'music-bot', name: DJ_NOME, avatar: null, tile: null };
    createTile(musicBot);
    musicBot.tile.root.classList.add('tile-bot');
    const foto = document.createElement('img');
    foto.src = DJ_FOTO;
    foto.alt = '';
    musicBot.tile.avatar.innerHTML = '';
    musicBot.tile.avatar.appendChild(foto);
    musicBot.tile.root.addEventListener('click', openMusic);
    musicBot.tile.root.title = 'Clique para ver a fila de músicas';
  }

  musicBot.tile.nameTag.textContent = DJ_NOME;
  musicBot.tile.root.classList.toggle('speaking', !musicState.paused);
  $('btn-music').classList.toggle('active', !musicState.paused);
  updateNowPlaying();
}

// A "capa do disco" girando no topo do chat.
function updateNowPlaying() {
  const bar = $('np-bar');
  const cur = musicState.current;

  if (!cur) { bar.classList.add('hidden'); return; }

  bar.classList.remove('hidden');
  bar.classList.toggle('parado', musicState.paused);
  $('np-eyebrow').textContent = musicState.paused ? 'Pausado' : 'Tocando agora';
  $('np-title').textContent = cur.title;
  $('np-artist').textContent = cur.artist || '';
  $('np-label').style.backgroundImage = cur.thumb ? `url("${cur.thumb}")` : '';
}

$('np-bar').addEventListener('click', openMusic);

/* ---- Mensagens do DJ Emolga no chat ---- */

// Cor fixa por pessoa (a mesma sempre, tipo Discord).
const CORES_NOME = ['#f6c945', '#7cc4ff', '#77dd77', '#ff9ecd', '#c39bff', '#ffb26b', '#5ce1e6'];
function corDoNome(nome) {
  let h = 0;
  for (let i = 0; i < nome.length; i++) h = (h * 31 + nome.charCodeAt(i)) >>> 0;
  return CORES_NOME[h % CORES_NOME.length];
}

function pedaco(texto, classe, cor) {
  const s = document.createElement('span');
  if (classe) s.className = classe;
  if (cor) s.style.color = cor;
  s.textContent = texto;
  return s;
}

// Monta o miolo da mensagem conforme o que aconteceu.
function corpoDoDj(dj, textoCru) {
  const partes = [];
  const quem = dj && dj.who ? pedaco(dj.who, 'dj-quem', corDoNome(dj.who)) : null;
  const musica = dj && dj.title ? pedaco(dj.title, 'dj-musica') : null;

  switch (dj && dj.act) {
    case 'play':
      partes.push(quem, pedaco(' mandou tocar '), musica);
      if (dj.artist) partes.push(pedaco(' · ' + dj.artist, 'dj-artista'));
      break;

    case 'queue':
      partes.push(quem, pedaco(' botou na fila '), musica);
      if (dj.artist) partes.push(pedaco(' · ' + dj.artist, 'dj-artista'));
      if (dj.count > 1) partes.push(pedaco(' e mais ' + (dj.count - 1), 'dj-artista'));
      break;

    case 'clear':
      partes.push(quem, pedaco(' limpou a fila'), pedaco(' · ' + dj.count + ' músicas', 'dj-artista'));
      break;

    case 'list':
      partes.push(quem, pedaco(' mandou a ' + (dj.origem || 'playlist') + ' '), musica);
      partes.push(pedaco(' · ' + dj.count + ' músicas — procurando cada uma…', 'dj-artista'));
      break;

    case 'list-done':
      partes.push(pedaco('Fila pronta: '), musica);
      partes.push(pedaco(' · ' + dj.count + ' de ' + dj.total + ' músicas', 'dj-artista'));
      break;

    case 'now':
      partes.push(pedaco('Tocando agora '), musica);
      if (dj.artist) partes.push(pedaco(' · ' + dj.artist, 'dj-artista'));
      if (dj.who) {
        partes.push(pedaco(' — pedida por '), pedaco(dj.who, 'dj-quem', corDoNome(dj.who)));
      }
      break;

    case 'skip':
      partes.push(quem, pedaco(' pulou a música'));
      break;

    case 'stop':
      partes.push(quem, pedaco(' parou o som'));
      break;

    case 'remove':
      partes.push(quem, pedaco(' tirou '), musica, pedaco(' da fila'));
      break;

    case 'blocked':
      partes.push(musica, pedaco(' não pode tocar fora do YouTube — pulei essa'));
      break;

    default:
      partes.push(pedaco(textoCru || ''));
  }
  return partes.filter(Boolean);
}

function addDjChat(dj, texto, kind) {
  const el = document.createElement('div');
  el.className = 'chat-msg dj' + (kind === 'erro' ? ' dj-erro' : '');

  const av = document.createElement('span');
  av.className = 'chat-av dj-av';
  const foto = document.createElement('img');
  foto.src = DJ_FOTO;
  foto.alt = '';
  av.appendChild(foto);

  const body = document.createElement('div');
  body.className = 'chat-body';

  const linhaNome = document.createElement('span');
  linhaNome.className = 'who dj-who';
  linhaNome.textContent = DJ_NOME;
  const tag = document.createElement('span');
  tag.className = 'dj-tag';
  tag.textContent = 'DJ';
  linhaNome.appendChild(tag);

  const txt = document.createElement('span');
  txt.className = 'chat-text dj-texto';
  corpoDoDj(dj, texto).forEach((n) => txt.appendChild(n));

  body.append(linhaNome, txt);
  el.append(av, body);

  const box = $('chat-messages');
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
}


/* ---- Painel ---- */

function fmtTime(sec) {
  sec = Math.max(0, Math.round(sec));
  return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
}

function openMusic() {
  $('music-modal').classList.remove('hidden');
  sendMusic('sync');
  renderMusic();
  if (!musicUiTimer) musicUiTimer = setInterval(updateMusicProgress, 300);
  setTimeout(() => $('music-input').focus(), 30);
}

function closeMusic() {
  $('music-modal').classList.add('hidden');
  if (musicUiTimer) { clearInterval(musicUiTimer); musicUiTimer = null; }
}

$('btn-music').addEventListener('click', () => {
  if ($('music-modal').classList.contains('hidden')) openMusic();
  else closeMusic();
});
$('music-close').addEventListener('click', closeMusic);
$('music-modal').addEventListener('click', (e) => { if (e.target === $('music-modal')) closeMusic(); });

$('music-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = $('music-input').value.trim();
  if (!q) return;
  $('music-input').value = '';
  $('music-results').classList.add('hidden');
  ensurePlayer();
  sendMusic('add', { query: q });
  showMusicNotice('Procurando…');
});

$('music-search-btn').addEventListener('click', () => {
  const q = $('music-input').value.trim();
  if (!q) return;
  sendMusic('search', { query: q });
  showMusicNotice('Buscando opções…');
});

$('music-clear').addEventListener('click', () => {
  if (!musicState.queue.length) return;
  sendMusic('clear');
});

$('music-play').addEventListener('click', () => sendMusic(musicState.paused ? 'resume' : 'pause'));
$('music-skip').addEventListener('click', () => sendMusic('skip'));
$('music-stop').addEventListener('click', () => sendMusic('stop'));

$('music-volume').addEventListener('input', (e) => {
  const pct = parseInt(e.target.value, 10);
  $('music-vol-label').textContent = pct + '%';
  setMusicVolume(pct / 100);
});

const musicProg = $('music-progress');
musicProg.addEventListener('pointerdown', () => { musicDragging = true; });
musicProg.addEventListener('change', () => {
  musicDragging = false;
  const cur = musicState.current;
  if (!cur || !cur.duration) return;
  sendMusic('seek', { posMs: (parseInt(musicProg.value, 10) / 1000) * cur.duration * 1000 });
});

function showMusicNotice(text, kind) {
  const el = $('music-notice');
  el.textContent = text;
  el.className = 'music-notice' + (kind === 'erro' ? ' erro' : kind === 'ok' ? ' ok' : '');
  clearTimeout(showMusicNotice._t);
  showMusicNotice._t = setTimeout(() => el.classList.add('hidden'), 8000);
}

function updateMusicProgress() {
  const cur = musicState.current;
  if (!cur) return;
  const pos = expectedMusicMs() / 1000;
  $('music-time').textContent = fmtTime(pos);
  $('music-dur').textContent = cur.duration ? fmtTime(cur.duration) : '--:--';
  if (!musicDragging && cur.duration) {
    musicProg.value = Math.min(1000, Math.round((pos / cur.duration) * 1000));
  }
}

function musicRow(track, acao, rotulo, arrastavel) {
  const row = document.createElement('div');
  row.className = 'music-row';

  if (arrastavel) {
    row.draggable = true;
    row.dataset.id = track.id;
    row.classList.add('music-row-drag');
    const alca = document.createElement('span');
    alca.className = 'music-grip';
    alca.title = 'Arraste para mudar a ordem';
    alca.textContent = '⋮⋮';
    row.appendChild(alca);
  }

  const img = document.createElement('img');
  img.className = 'music-row-thumb';
  if (track.thumb) img.src = track.thumb;
  img.alt = '';

  const info = document.createElement('div');
  info.className = 'music-row-info';
  const t = document.createElement('div');
  t.className = 'music-row-title';
  t.textContent = track.title;
  const s = document.createElement('div');
  s.className = 'music-row-sub';
  s.textContent = [track.artist, track.duration ? fmtTime(track.duration) : '', track.by ? 'pedida por ' + track.by : '']
    .filter(Boolean).join(' · ');
  info.append(t, s);

  const btn = document.createElement('button');
  btn.className = 'btn music-row-btn';
  btn.textContent = rotulo;
  btn.addEventListener('click', acao);

  row.append(img, info, btn);
  return row;
}

/* ---- Arrastar para mudar a ordem da fila (tipo Spotify) ---- */

let arrastando = null;

// Descobre entre quais linhas o cursor está, para soltar no lugar certo.
function linhaDepoisDoCursor(lista, y) {
  const outras = [...lista.querySelectorAll('.music-row:not(.arrastando)')];
  for (const linha of outras) {
    const r = linha.getBoundingClientRect();
    if (y < r.top + r.height / 2) return linha;
  }
  return null;
}

$('music-queue').addEventListener('dragstart', (e) => {
  const linha = e.target.closest('.music-row');
  if (!linha) return;
  arrastando = linha;
  linha.classList.add('arrastando');
  e.dataTransfer.effectAllowed = 'move';
  // O Firefox/Chromium só começa o arrasto se algo for escrito aqui.
  try { e.dataTransfer.setData('text/plain', linha.dataset.id); } catch {}
});

$('music-queue').addEventListener('dragover', (e) => {
  if (!arrastando) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const lista = $('music-queue');
  const depois = linhaDepoisDoCursor(lista, e.clientY);
  if (depois) lista.insertBefore(arrastando, depois);
  else lista.appendChild(arrastando);
});

$('music-queue').addEventListener('drop', (e) => e.preventDefault());

$('music-queue').addEventListener('dragend', () => {
  if (!arrastando) return;
  const linha = arrastando;
  arrastando = null;
  linha.classList.remove('arrastando');

  const nova = [...$('music-queue').children].indexOf(linha);
  const antiga = musicState.queue.findIndex((t) => t.id === linha.dataset.id);
  if (nova >= 0 && nova !== antiga) sendMusic('move', { id: linha.dataset.id, to: nova });
  else renderMusic(); // desistiu no meio: volta a ordem de verdade
});

function renderMusic() {
  // Enquanto alguém está arrastando, não redesenha por baixo da mão dela.
  if (arrastando) return;

  const now = $('music-now');
  const cur = musicState.current;

  if (cur) {
    now.classList.remove('hidden');
    const thumb = $('music-thumb');
    if (cur.thumb) { thumb.src = cur.thumb; thumb.classList.remove('hidden'); }
    else thumb.classList.add('hidden');
    $('music-title').textContent = cur.title;
    $('music-sub').textContent = [cur.artist, cur.by ? 'pedida por ' + cur.by : ''].filter(Boolean).join(' · ');
    $('music-play').textContent = musicState.paused ? 'Continuar' : 'Pausar';
    updateMusicProgress();
  } else {
    now.classList.add('hidden');
  }

  const wrap = $('music-queue-wrap');
  const list = $('music-queue');
  list.textContent = '';
  if (musicState.queue.length) {
    wrap.classList.remove('hidden');
    musicState.queue.forEach((t, i) => {
      list.appendChild(musicRow(t, () => sendMusic('remove', { index: i }), 'Tirar', true));
    });
  } else {
    wrap.classList.add('hidden');
  }

  const volPct = Math.round(musicVolume * 100);
  $('music-volume').value = volPct;
  $('music-vol-label').textContent = volPct + '%';
}

function renderMusicResults(results) {
  const box = $('music-results');
  box.textContent = '';
  if (!results.length) {
    showMusicNotice('Não achei nada com esse nome.', 'erro');
    box.classList.add('hidden');
    return;
  }
  for (const t of results) {
    box.appendChild(musicRow(t, () => {
      ensurePlayer();
      sendMusic('add-track', { track: t });
      box.classList.add('hidden');
      $('music-input').value = '';
    }, 'Tocar'));
  }
  box.classList.remove('hidden');
}

/* ======================= PESSOAS ONLINE E CONVITES ======================= *
 * O app abre uma conexão de "presença" assim que liga — mesmo fora de uma
 * sala e mesmo minimizado na bandeja. Com isso a galera vê quem está online
 * e pode chamar você para uma sala.                                         */


function nomeSalvo() {
  return (selfName || localStorage.getItem('pokecall.name') || '').trim();
}

function presenceSend(obj) {
  if (presenceWs && presenceWs.readyState === WebSocket.OPEN) {
    presenceWs.send(JSON.stringify(obj));
  }
}

function presenceHello() {
  const nome = nomeSalvo();
  if (!nome) return;
  presenceSend({ type: 'hello', name: nome, avatar: selectedAvatar || localStorage.getItem('pokecall.avatar') });
  if (roomId) presenceSend({ type: 'presence-room', room: roomId, roomName: roomDisplayName });
}

function startPresence() {
  if (!nomeSalvo()) return;                       // sem nome ainda, não anuncia
  if (presenceWs && presenceWs.readyState <= WebSocket.OPEN) { presenceHello(); return; }

  try { presenceWs = new WebSocket(DEFAULT_SERVER); }
  catch { return; }

  presenceWs.addEventListener('open', presenceHello);
  presenceWs.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handlePresence(msg);
  });
  presenceWs.addEventListener('close', () => {
    presenceWs = null;
    peopleOnline = [];
    renderPeople();
    clearTimeout(presenceRetry);
    presenceRetry = setTimeout(startPresence, 6000);  // volta sozinho
  });
  presenceWs.addEventListener('error', () => {});
}

function handlePresence(msg) {
  switch (msg.type) {
    case 'presence-self':
      presenceId = msg.id;
      break;

    case 'presence':
      peopleOnline = msg.people || [];
      renderPeople();
      break;

    case 'invited':
      mostrarConvite(msg);
      break;

    case 'invite-sent':
      setPeopleAviso(`Chamado enviado para ${msg.to}.`);
      break;

    case 'invite-refused':
      setPeopleAviso(`${msg.from} não pôde vir agora.`);
      break;
  }
}

/* ---- A barra lateral ---- */

function abrirPessoas() {
  $('people-panel').classList.remove('hidden');
  renderPeople();
}
function fecharPessoas() { $('people-panel').classList.add('hidden'); }
function alternarPessoas() {
  if ($('people-panel').classList.contains('hidden')) abrirPessoas();
  else fecharPessoas();
}

$('btn-people').addEventListener('click', alternarPessoas);
$('btn-people-lobby').addEventListener('click', alternarPessoas);
$('people-close').addEventListener('click', fecharPessoas);

function setPeopleAviso(texto) {
  const el = $('people-hint-live') || (() => {
    const p = document.createElement('p');
    p.id = 'people-hint-live';
    p.className = 'people-aviso';
    $('people-panel').appendChild(p);
    return p;
  })();
  el.textContent = texto;
  clearTimeout(setPeopleAviso._t);
  setPeopleAviso._t = setTimeout(() => el.remove(), 6000);
}

function avatarNode(pessoa) {
  const av = document.createElement('span');
  av.className = 'people-av';
  if (pessoa.avatar && AVATARS.includes(pessoa.avatar)) {
    const img = document.createElement('img');
    img.src = avatarSrc(pessoa.avatar);
    img.alt = '';
    av.appendChild(img);
  } else {
    av.textContent = initials(pessoa.name);
  }
  return av;
}

function renderPeople() {
  const lista = $('people-list');
  const outros = peopleOnline.filter((p) => p.id !== presenceId);

  $('people-count').textContent = peopleOnline.length;
  $('people-tab-count').textContent = peopleOnline.length;
  $('btn-people-lobby').classList.toggle('hidden', !lobby || lobby.classList.contains('hidden'));

  lista.textContent = '';

  if (!outros.length) {
    const vazio = document.createElement('div');
    vazio.className = 'people-empty';
    vazio.textContent = presenceWs ? 'Ninguém mais online agora.' : 'Sem conexão com o servidor.';
    lista.appendChild(vazio);
    return;
  }

  for (const p of outros) {
    const linha = document.createElement('div');
    linha.className = 'people-row';

    const info = document.createElement('div');
    info.className = 'people-info';
    const nome = document.createElement('div');
    nome.className = 'people-name';
    nome.textContent = p.name;
    const onde = document.createElement('div');
    onde.className = 'people-where';
    onde.textContent = p.roomName ? p.roomName : 'no lobby';
    if (p.room && p.room === roomId) onde.textContent = 'aqui com você';
    info.append(nome, onde);

    const acao = document.createElement('button');
    acao.className = 'btn people-btn';

    if (p.room && p.room === roomId) {
      acao.textContent = 'aqui';
      acao.disabled = true;
    } else if (p.room) {
      // A pessoa está numa sala: dá para ir junto.
      acao.textContent = 'Entrar';
      acao.title = 'Entrar na ' + p.roomName;
      acao.addEventListener('click', () => irParaSala(p.room, p.roomName));
    } else if (roomId) {
      // Eu estou numa sala e ela não: chamo pra cá.
      acao.textContent = 'Chamar';
      acao.title = 'Chamar para a ' + roomDisplayName;
      acao.addEventListener('click', () => {
        presenceSend({ type: 'invite', to: p.id, room: roomId, roomName: roomDisplayName, icon: roomIcon });
        acao.textContent = 'Chamado';
        acao.disabled = true;
        setTimeout(() => { acao.textContent = 'Chamar'; acao.disabled = false; }, 8000);
      });
    } else {
      acao.textContent = '—';
      acao.disabled = true;
      acao.title = 'Entre numa sala para poder chamar';
    }

    linha.append(avatarNode(p), info, acao);
    lista.appendChild(linha);
  }
}

/* ---- Entrar numa sala (por convite ou pelo "Entrar junto") ---- */

function irParaSala(room, roomName) {
  fecharPessoas();
  const display = ROOMS[room] || { name: roomName || room, icon: 'chat' };

  if (!roomId) {
    // Estou no lobby: entra direto.
    if (!$('inp-name').value.trim()) $('inp-name').value = nomeSalvo();
    join(room, display);
    return;
  }
  if (room === roomId) return;

  // Já estou numa call: guarda o destino e recarrega limpo.
  sessionStorage.setItem('pokecall.autojoin', JSON.stringify({ room, name: display.name, icon: display.icon }));
  leave();
}

// Ao abrir o app, se ficou um destino guardado, entra nele.
function autoJoinPendente() {
  const cru = sessionStorage.getItem('pokecall.autojoin');
  if (!cru) return;
  sessionStorage.removeItem('pokecall.autojoin');
  let alvo;
  try { alvo = JSON.parse(cru); } catch { return; }
  if (!alvo || !alvo.room || !nomeSalvo()) return;
  $('inp-name').value = nomeSalvo();
  setTimeout(() => join(alvo.room, { name: alvo.name, icon: alvo.icon }), 250);
}

/* ---- Convite que chegou ---- */

function mostrarConvite(msg) {
  convitePendente = msg;
  const toast = $('invite-toast');
  const av = $('invite-av');

  av.textContent = '';
  av.appendChild(avatarNode({ name: msg.from, avatar: msg.avatar }));

  $('invite-text').textContent = `${msg.from} está chamando você para a ${msg.roomName || 'call'}.`;
  toast.classList.remove('hidden');
  SFX.peerJoin();

  // Se o app estiver escondido na bandeja, aparece para a pessoa ver.
  try { window.pokecall.overlay.focusApp(); } catch {}

  clearTimeout(mostrarConvite._t);
  mostrarConvite._t = setTimeout(fecharConvite, 45000);
}

function fecharConvite() {
  $('invite-toast').classList.add('hidden');
  convitePendente = null;
}

$('invite-accept').addEventListener('click', () => {
  const c = convitePendente;
  fecharConvite();
  if (c) irParaSala(c.room, c.roomName);
});

$('invite-refuse').addEventListener('click', () => {
  const c = convitePendente;
  fecharConvite();
  if (c) presenceSend({ type: 'invite-refused', to: c.fromId });
});

/* Ao abrir o app: entra na lista de online e, se veio de um convite aceito
   estando em outra call, cai direto na sala certa. */
startPresence();
autoJoinPendente();
