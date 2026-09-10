/*
 * PokeCall - Musica: quem procura as musicas
 * ------------------------------------------
 * Este modulo NAO baixa nem serve audio. Ele so descobre QUAL video do
 * YouTube corresponde ao que a pessoa pediu (nome, link do YouTube ou link
 * do Spotify). Quem toca o audio e o proprio app de cada pessoa, usando o
 * player oficial do YouTube escondido - e o servidor so diz o que esta
 * tocando e em que segundo, para todo mundo ouvir junto.
 *
 * Nao precisa instalar nada no servidor: usamos a pagina de busca do
 * YouTube e o oEmbed (publicos). Se o yt-dlp estiver instalado, ele entra
 * como plano B quando a busca falhar.
 */

const https = require('https');
const { execFile } = require('child_process');

const YTDLP = process.env.YTDLP_PATH || 'yt-dlp';

const RE_YT = /(?:youtube\.com\/(?:watch\?[^\s]*v=|shorts\/|live\/|embed\/)|youtu\.be\/)([\w-]{6,})/i;
const RE_YT_LIST = /[?&]list=([\w-]+)/i;
const RE_SPOTIFY = /open\.spotify\.com\/(?:intl-[a-z]+\/)?(track|album|playlist)\/([A-Za-z0-9]+)/i;

/* ======================= HTTP simples ======================= */

function get(url, redirects = 3) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
          // Em portugues o YouTube devolve o titulo TRADUZIDO ("Não estou em
          // LA" no lugar de "Ain't In LA"). Pedindo em ingles vem o nome
          // original, que e o que a pessoa espera ver.
          'Accept-Language': 'en-US,en;q=0.9',
          Cookie: 'CONSENT=YES+1', // pula a tela de consentimento da Europa
        },
        timeout: 15000,
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
          res.resume();
          return resolve(get(new URL(res.headers.location, url).href, redirects - 1));
        }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; if (body.length > 6e6) req.destroy(); });
        res.on('end', () => resolve(body));
      }
    );
    req.on('timeout', () => req.destroy(new Error('demorou demais')));
    req.on('error', reject);
  });
}

/* ======================= Busca no YouTube ======================= */

// "3:55" ou "1:02:30" -> segundos
function parseLength(txt) {
  if (!txt) return 0;
  const p = String(txt).split(':').map((n) => parseInt(n, 10));
  if (p.some(isNaN)) return 0;
  return p.reduce((acc, n) => acc * 60 + n, 0);
}

function pickText(node) {
  if (!node) return '';
  if (node.simpleText) return node.simpleText;
  if (Array.isArray(node.runs)) return node.runs.map((r) => r.text).join('');
  return '';
}

function trackFromRenderer(v) {
  return {
    id: v.videoId,
    title: pickText(v.title) || 'sem nome',
    artist: pickText(v.ownerText) || pickText(v.longBylineText) || '',
    duration: parseLength(pickText(v.lengthText)),
    thumb: 'https://i.ytimg.com/vi/' + v.videoId + '/mqdefault.jpg',
  };
}

// Le a pagina de resultados do YouTube (filtro sp=EgIQAQ = so videos).
async function searchScrape(query, n) {
  const html = await get(
    'https://www.youtube.com/results?search_query=' + encodeURIComponent(query) + '&sp=EgIQAQ%253D%253D&hl=en&gl=US'
  );
  const m = html.match(/ytInitialData\s*=\s*(\{.+?\});<\/script>/s);
  if (!m) throw new Error('o YouTube nao devolveu resultados');

  const encontrados = [];
  JSON.parse(m[1], (k, v) => {
    if (k === 'videoRenderer' && v && v.videoId) encontrados.push(v);
    return v;
  });

  const vistos = new Set();
  const out = [];
  for (const v of encontrados) {
    if (vistos.has(v.videoId)) continue;
    vistos.add(v.videoId);
    const t = trackFromRenderer(v);
    if (!t.duration) continue;          // pula lives e estreias
    out.push(t);
    if (out.length >= n) break;
  }
  return out;
}

// Plano B: se o yt-dlp existir no servidor, usa ele.
function searchYtdlp(query, n) {
  return new Promise((resolve, reject) => {
    execFile(
      YTDLP,
      ['--no-warnings', '--flat-playlist', '-J', 'ytsearch' + n + ':' + query],
      { timeout: 45000, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(new Error('busca indisponivel'));
        try {
          const info = JSON.parse(stdout);
          resolve(
            (info.entries || [])
              .filter((e) => e && e.id)
              .slice(0, n)
              .map((e) => ({
                id: e.id,
                title: e.title || 'sem nome',
                artist: e.uploader || e.channel || '',
                duration: Math.round(Number(e.duration) || 0),
                thumb: 'https://i.ytimg.com/vi/' + e.id + '/mqdefault.jpg',
              }))
          );
        } catch { reject(new Error('busca indisponivel')); }
      }
    );
  });
}

const pausa = (ms) => new Promise((r) => setTimeout(r, ms));

async function search(query, n = 6) {
  // Duas tentativas: de vez em quando o YouTube responde com um redirect
  // (302) quando vêm muitas buscas seguidas — esperar um pouco resolve.
  for (let tentativa = 0; tentativa < 2; tentativa++) {
    try {
      const r = await searchScrape(query, n);
      if (r.length) return r;
    } catch (err) {
      console.warn('[musica] busca falhou (' + (tentativa + 1) + '/2):', err.message);
    }
    await pausa(900);
  }
  return searchYtdlp(query, n).catch(() => []);
}

/* ======================= Playlist do YouTube ======================= */

// O YouTube mudou o formato da pagina de playlist: hoje cada item vem num
// "lockupViewModel". Lemos os dois formatos (o novo e o antigo).
function trackFromLockup(v) {
  const id = String(v.contentId || '');
  if (!/^[\w-]{6,}$/.test(id)) return null;

  const textos = [];
  JSON.stringify(v.metadata || {}, (k, val) => {
    if (k === 'content' && typeof val === 'string' && val.trim()) textos.push(val.trim());
    return val;
  });

  let dur = '';
  JSON.stringify(v, (k, val) => {
    if (!dur && k === 'text' && typeof val === 'string' && /^(\d+:)?\d{1,2}:\d{2}$/.test(val)) dur = val;
    return val;
  });

  const canal = textos[1] && !/visualiza|views|Colaboradores|Contributors/i.test(textos[1]) ? textos[1] : '';

  return {
    id,
    title: textos[0] || 'sem nome',
    artist: canal,
    duration: parseLength(dur),
    thumb: 'https://i.ytimg.com/vi/' + id + '/mqdefault.jpg',
  };
}

async function youtubePlaylist(listId, limite = 100) {
  const html = await get('https://www.youtube.com/playlist?list=' + encodeURIComponent(listId) + '&hl=en&gl=US');
  const m = html.match(/ytInitialData\s*=\s*(\{.+?\});<\/script>/s);
  if (!m) throw new Error('nao consegui abrir essa playlist');

  const achados = [];
  JSON.parse(m[1], (k, v) => {
    if (k === 'lockupViewModel' && v && v.contentId) {
      const t = trackFromLockup(v);
      if (t) achados.push(t);
    } else if (k === 'playlistVideoRenderer' && v && v.videoId) {
      achados.push(trackFromRenderer(v)); // formato antigo
    }
    return v;
  });

  const vistos = new Set();
  return achados.filter((t) => (vistos.has(t.id) ? false : vistos.add(t.id))).slice(0, limite);
}

/* ======================= Playlist / album do Spotify ======================= */

// A pagina de "embed" do Spotify traz a lista de faixas pronta, sem precisar
// de chave de API. Como o Spotify nao deixa tocar o audio dele, cada faixa
// vira uma busca no YouTube depois (feita aos poucos, na ordem).
async function spotifyList(tipo, id, limite = 100) {
  const html = await get('https://open.spotify.com/embed/' + tipo + '/' + id);
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">(.+?)<\/script>/s);
  if (!m) throw new Error('nao consegui abrir essa ' + (tipo === 'album' ? 'álbum' : 'playlist'));

  let nome = '';
  let lista = null;
  JSON.parse(m[1], (k, v) => {
    if (k === 'trackList' && Array.isArray(v) && !lista) lista = v;
    if (k === 'name' && typeof v === 'string' && !nome) nome = v;
    return v;
  });

  if (!lista || !lista.length) throw new Error('essa lista está vazia ou é privada');

  const itens = lista.slice(0, limite).map((t) => {
    const titulo = String(t.title || '').trim();
    const artista = String(t.subtitle || '').split(',')[0].trim();
    return {
      title: titulo,
      artist: artista,
      duration: Math.round(Number(t.duration || 0) / 1000),
      explicit: !!t.isExplicit,
      query: [titulo, artista].filter(Boolean).join(' '),
    };
  }).filter((it) => it.query);

  return { nome: nome || (tipo === 'album' ? 'álbum' : 'playlist'), itens };
}

/* ======================= Escolher a melhor versao ======================= */

// Coisas que quase nunca sao a musica que a pessoa quer (a menos que ela
// tenha pedido justamente isso — ai nao penalizamos).
const LIXO = ['tradu', 'legendad', 'lyric', 'letra', 'karaok', 'cover', 'reação', 'reacao', 'reaction',
  'ao vivo', 'live', 'sped up', 'slowed', 'reverb', 'nightcore', '8d audio', 'tutorial', 'piano', 'instrumental'];

// Versões mexidas: não são a gravação original da música.
const RE_MODIFICADA = /\bremix\b|\bmix\b|432\s?hz|\b8d\b|bass boost|mashup|extended|sped up|slowed|nightcore|acapella|acappella|\bloop\b|1 hour|1 hora/i;

// Versao sem palavrão x versao original.
const RE_EXPLICIT = /\bexplicit\b|\bdirty\b|uncensored|sem censura|\[e\]/i;
const RE_LIMPA = /\bclean\b|\bcensored\b|\bcensurad|radio edit|sem palavr|no cussing|\bedited\b/i;

// Dá uma nota para cada resultado do YouTube. A duracao (quando sabemos, via
// Spotify) e o sinal mais forte: a versao certa tem praticamente o mesmo tempo.
function nota(resultado, alvo) {
  let n = 0;
  const titulo = (resultado.title || '').toLowerCase();
  const canalCru = (resultado.artist || '');
  const canal = canalCru.toLowerCase().replace(/ - topic$/, '').trim();
  const artista = (alvo.artist || '').toLowerCase();
  const pedido = (alvo.query || alvo.title || '').toLowerCase();

  // Palavras do pedido que aparecem no titulo
  const palavras = pedido.split(/[^\p{L}\p{N}]+/u).filter((p) => p.length > 2);
  const acertos = palavras.filter((p) => titulo.includes(p)).length;
  if (palavras.length) n += Math.min(3, acertos * 0.6);

  // Canal de confiança: o canal do próprio artista (ou o "- Topic", que é o
  // áudio do álbum enviado pela gravadora). Vale tanto quando sabemos o
  // artista (veio do Spotify) quanto quando ele aparece no que foi digitado.
  const canalConfiavel =
    canal.length > 2 &&
    ((artista && (canal.includes(artista) || artista.includes(canal))) || pedido.includes(canal));
  const doTopic = / - topic$/i.test(canalCru);
  if (canalConfiavel) n += 3;
  if (doTopic) n += 3;
  // Reupload de canal aleatório: costuma ser pior (qualidade, cortes) e some
  // do YouTube com o tempo. Só ganha se tiver um motivo forte (ser explicit).
  if (!canalConfiavel && !doTopic) n -= 1.5;
  if (artista && titulo.includes(artista)) n += 1;

  const querExplicita = alvo.explicit !== false;

  if (/official|oficial/i.test(titulo)) n += 1;
  // O clipe costuma ser a versão CENSURADA; o "official audio" do canal do
  // artista costuma ser a faixa do álbum, do jeito que foi lançada — é o
  // melhor caminho para a versão sem censura. Em canal aleatório, "audio"
  // não quer dizer nada.
  if (/\b(audio|áudio)\b/i.test(titulo) && (canalConfiavel || doTopic)) n += 3;
  if (/music video|videoclipe|official video/i.test(titulo) && querExplicita) n -= 1.5;

  // Só penaliza o "lixo" que a pessoa NÃO pediu.
  for (const termo of LIXO) {
    if (titulo.includes(termo) && !pedido.includes(termo)) { n -= 4; break; }
  }

  // Versão mexida (remix, 432hz, acelerada...) não é a música original.
  if (RE_MODIFICADA.test(titulo) && !RE_MODIFICADA.test(pedido)) n -= 6;

  // Explícito na frente: versão original ganha da "clean/censored".
  const pediuLimpa = RE_LIMPA.test(pedido);
  if (RE_EXPLICIT.test(titulo)) n += querExplicita ? 5 : 0;
  if (RE_LIMPA.test(titulo) && !pediuLimpa) n -= alvo.explicit === false ? 2 : 6;

  if (alvo.duration && resultado.duration) {
    const dif = Math.abs(resultado.duration - alvo.duration);
    if (dif <= 5) n += 4;
    else if (dif <= 15) n += 2;
    else if (dif > 45) n -= 3;
  }
  return n;
}

// Procura e devolve a versao que mais parece com a faixa pedida.
//
// Detalhe importante: o clipe oficial de muita musica no YouTube JA E a
// versao censurada, e a versao sem censura nem aparece na busca normal. Por
// isso, quando queremos a explicita, fazemos uma segunda busca pedindo por
// ela e juntamos os dois conjuntos antes de escolher.
async function searchBest(alvo) {
  const base = alvo.query || [alvo.title, alvo.artist].filter(Boolean).join(' ');

  let candidatos = await search(base, 6);

  const querExplicita = alvo.explicit !== false && !RE_LIMPA.test(base);
  const jaTemExplicita = candidatos.some((r) => RE_EXPLICIT.test(r.title));

  if (querExplicita && !jaTemExplicita) {
    const extras = await search(base + ' explicit', 5).catch(() => []);
    const vistos = new Set(candidatos.map((c) => c.id));
    for (const e of extras) if (!vistos.has(e.id)) { candidatos.push(e); vistos.add(e.id); }
  }

  if (!candidatos.length) return null;

  let melhor = candidatos[0];
  let melhorNota = nota(candidatos[0], alvo);
  for (const r of candidatos.slice(1)) {
    const n = nota(r, alvo);
    if (n > melhorNota) { melhor = r; melhorNota = n; }
  }
  return melhor;
}

/* ======================= Dados de um video ======================= */

// oEmbed publico: da o titulo e o canal sem precisar de chave de API.
async function videoInfo(id) {
  const base = {
    id,
    title: 'YouTube ' + id,
    artist: '',
    duration: 0, // o app avisa a duracao quando o player carrega
    thumb: 'https://i.ytimg.com/vi/' + id + '/mqdefault.jpg',
  };
  try {
    const j = JSON.parse(
      await get('https://www.youtube.com/oembed?format=json&url=https://www.youtube.com/watch?v=' + id)
    );
    base.title = j.title || base.title;
    base.artist = (j.author_name || '').replace(/ - Topic$/, '');
  } catch {}
  return base;
}

/* ======================= Spotify ======================= */

function og(html, prop) {
  const m =
    html.match(new RegExp('<meta[^>]+property="og:' + prop + '"[^>]+content="([^"]*)"', 'i')) ||
    html.match(new RegExp('<meta[^>]+content="([^"]*)"[^>]+property="og:' + prop + '"', 'i'));
  return m
    ? m[1].replace(/&amp;/g, '&').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"')
    : '';
}

// O Spotify nao deixa tocar o audio dele fora do app oficial. Entao fazemos
// como os bots do Discord: pegamos o NOME da musica pelo link e procuramos a
// mesma musica no YouTube.
async function spotifyQuery(url) {
  let title = '';
  let artist = '';
  try {
    const j = JSON.parse(await get('https://open.spotify.com/oembed?url=' + encodeURIComponent(url)));
    title = String(j.title || '');
  } catch {}
  try {
    const html = await get(url);
    if (!title) title = og(html, 'title');
    const partes = og(html, 'description').split('·').map((s) => s.trim()).filter(Boolean);
    artist = partes.find((p) => p.toLowerCase() !== title.toLowerCase() && !/^\d{4}$/.test(p)) || '';
  } catch {}
  const q = [title, artist].filter(Boolean).join(' ').trim();
  if (!q) throw new Error('nao consegui ler o nome dessa musica no Spotify');
  return { q, title, artist };
}

/* ======================= Resolver o que a pessoa pediu ======================= */

// Devolve { tracks: [...], note?: 'texto' }
async function resolve(input) {
  const text = String(input || '').trim();
  if (!text) throw new Error('digite o nome de uma musica ou cole um link');

  const sp = text.match(RE_SPOTIFY);
  if (sp) {
    // Playlist ou album: pega a lista de faixas e procura cada uma no
    // YouTube depois, aos poucos (quem faz isso e o servidor da sala).
    if (sp[1] !== 'track') {
      const { nome, itens } = await spotifyList(sp[1], sp[2]);
      return { pendente: { nome, itens, origem: sp[1] === 'album' ? 'álbum' : 'playlist' } };
    }
    const { q, title, artist } = await spotifyQuery(text);
    const melhor = await searchBest({ query: q, title, artist });
    if (!melhor) throw new Error('nao achei essa musica do Spotify no YouTube');
    return { tracks: [melhor], note: 'Spotify: achei "' + melhor.title + '" no YouTube' };
  }

  const yt = text.match(RE_YT);
  if (yt) return { tracks: [await videoInfo(yt[1])] };

  // Playlist do YouTube (link sem video, so com a lista)
  const lista = text.match(RE_YT_LIST);
  if (lista && /youtube\.com|youtu\.be/i.test(text)) {
    const tracks = await youtubePlaylist(lista[1]);
    if (!tracks.length) throw new Error('essa playlist está vazia ou é privada');
    return { tracks, note: 'playlist do YouTube com ' + tracks.length + ' músicas' };
  }

  if (/^https?:\/\//i.test(text)) throw new Error('esse link nao e do YouTube nem do Spotify');

  const melhor = await searchBest({ query: text });
  if (!melhor) throw new Error('nao achei nada com esse nome');
  return { tracks: [melhor] };
}

module.exports = { search, searchBest, resolve, videoInfo, youtubePlaylist, spotifyList };
