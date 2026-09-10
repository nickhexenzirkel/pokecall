/*
 * PokeCall - janela suspensa (overlay)
 * Fica sempre no topo: microfone, chat rápido e as mensagens novas, sem
 * precisar dar Alt+Tab para voltar ao app.
 *
 * Só desenha: quem manda o estado e as mensagens é a janela principal
 * (via preload -> ipcMain -> aqui). As ações voltam pelo mesmo caminho.
 */

const $ = (id) => document.getElementById(id);
const bridge = window.pokecall.overlay;

const SVG = (inner) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
const ICONS = {
  mic: SVG('<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>'),
  micOff: SVG('<line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>'),
  send: SVG('<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>'),
  open: SVG('<polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/>'),
  close: SVG('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'),
};

$('btn-open').innerHTML = ICONS.open;
$('btn-close').innerHTML = ICONS.close;
document.querySelector('.send').innerHTML = ICONS.send;

let micOn = false;
$('mic').innerHTML = ICONS.micOff; // até o app mandar o estado real

/* ---------------- Estado vindo do app ---------------- */

bridge.onState((s) => {
  if (!s) return;
  if (s.type === 'state') {
    micOn = !!s.mic;
    const mic = $('mic');
    mic.classList.toggle('on', micOn);
    mic.innerHTML = micOn ? ICONS.mic : ICONS.micOff;
    $('dot').classList.toggle('on', !!s.connected);
    $('live').textContent = s.sharing
      ? `${s.sharing} está transmitindo`
      : s.room || 'PokeCall';
  } else if (s.type === 'msg') {
    addMessage(s);
  }
  fit();
});

/* ---------------- Mensagens ---------------- */

// O app manda o texto já quebrado em pedaços ({t:'text'} / {t:'emote'}),
// para não precisar duplicar aqui a lista de emotes.
function addMessage(m) {
  const box = $('msgs');

  const el = document.createElement('div');
  el.className = 'msg';

  const av = document.createElement('span');
  av.className = 'av';
  if (m.avatarSrc) {
    const img = document.createElement('img');
    img.src = m.avatarSrc;
    img.alt = '';
    av.appendChild(img);
  } else {
    av.textContent = (m.name || '?').trim().slice(0, 2).toUpperCase();
  }

  const body = document.createElement('div');
  body.className = 'body';
  const who = document.createElement('span');
  who.className = 'who';
  who.textContent = m.name || '';
  const txt = document.createElement('span');
  txt.className = 'txt';
  for (const part of m.parts || []) {
    if (part.t === 'emote') {
      const img = document.createElement('img');
      img.src = part.v;
      img.alt = '';
      txt.appendChild(img);
    } else {
      txt.appendChild(document.createTextNode(part.v));
    }
  }
  body.append(who, txt);

  el.append(av, body);
  box.appendChild(el);
  while (box.children.length > 4) box.removeChild(box.firstChild);

  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => { el.remove(); fit(); }, 500);
  }, 10000);
}

/* ---------------- Ações ---------------- */

$('mic').addEventListener('click', () => bridge.action({ type: 'mic' }));
$('btn-close').addEventListener('click', () => bridge.close());
$('btn-open').addEventListener('click', () => bridge.focusApp());

$('form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('input');
  const text = input.value.trim();
  if (!text) return;
  bridge.action({ type: 'chat', text });
  input.value = '';
});

/* ---------------- Tamanho da janelinha ---------------- */

// A janela cresce para cima conforme chegam mensagens (o main ancora embaixo).
function fit() {
  const h = Math.ceil($('card').getBoundingClientRect().height) + 16; // + padding do body
  bridge.resize(h);
}

new ResizeObserver(fit).observe($('card'));
fit();

// Pede o estado atual assim que a janelinha carrega (o app pode ter mandado
// o primeiro estado antes desta página existir).
bridge.action({ type: 'ready' });
