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
const RE_SPOTIFY = /open\.spotify\.com\/(?:intl-[a-z]+\/)?(track|album|playlist)\/([A-Za-z0-9]+)/i;

/* ======================= HTTP simples ======================= */

function get(url, redirects = 3) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
          'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
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
    'https://www.youtube.com/results?search_query=' + encodeURIComponent(query) + '&sp=EgIQAQ%253D%253D'
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

async function search(query, n = 6) {
  try {
    const r = await searchScrape(query, n);
    if (r.length) return r;
  } catch (err) {
    console.warn('[musica] busca direta falhou:', err.message);
  }
  return searchYtdlp(query, n).catch(() => []);
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
  return q;
}

/* ======================= Resolver o que a pessoa pediu ======================= */

// Devolve { tracks: [...], note?: 'texto' }
async function resolve(input) {
  const text = String(input || '').trim();
  if (!text) throw new Error('digite o nome de uma musica ou cole um link');

  const sp = text.match(RE_SPOTIFY);
  if (sp) {
    if (sp[1] !== 'track') throw new Error('por enquanto so link de MUSICA do Spotify (album e playlist ainda nao)');
    const q = await spotifyQuery(text);
    const achados = await search(q, 1);
    if (!achados.length) throw new Error('nao achei essa musica do Spotify no YouTube');
    return { tracks: achados, note: 'Spotify: achei "' + achados[0].title + '" no YouTube' };
  }

  const yt = text.match(RE_YT);
  if (yt) return { tracks: [await videoInfo(yt[1])] };

  if (/^https?:\/\//i.test(text)) throw new Error('esse link nao e do YouTube nem do Spotify');

  const achados = await search(text, 1);
  if (!achados.length) throw new Error('nao achei nada com esse nome');
  return { tracks: achados };
}

module.exports = { search, resolve, videoInfo };
