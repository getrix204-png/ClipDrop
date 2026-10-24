// Pinterest: los VIDEOS los resuelve yt-dlp; las IMÁGENES y los GIF se resuelven con los metadatos Open Graph públicos
// del pin y comprobando en el CDN (i.pinimg.com) qué variante existe: GIF animado, imagen original o, si no, la del og:image.
import { config } from './config.js';
import { HttpError } from './errors.js';
import { clip } from './formats.js';
import { readText, request } from './net.js';
import { PLATFORMS } from './platforms.js';

const decode = (s) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

// <meta property|name="…" content="…"> en cualquier orden de atributos y con comillas simples o dobles
export function parseMeta(html) {
  const meta = {};
  for (const tag of html.match(/<meta\s[^>]*>/gi) || []) {
    const a = {};
    for (const m of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) a[m[1].toLowerCase()] = m[2] ?? m[3];
    const key = (a.property || a.name || '').toLowerCase();
    if (key && a.content !== undefined && !(key in meta)) meta[key] = decode(a.content);
  }
  return meta;
}

// Decide el tipo de contenido. probe(url) → { status, type, size } (se inyecta para poder probarlo sin red).
export async function classify(meta, probe) {
  const img = meta['og:image'];
  const m = /^https:\/\/i\.pinimg\.com\/(?:\d+x|originals)\/(.+)\.(\w{2,5})$/i.exec(img || '');
  if (!m) return /^https:\/\/i\.pinimg\.com\//i.test(img || '') ? { kind: 'image', url: img, size: 0, ext: 'JPG', reduced: true } : null;
  const base = `https://i.pinimg.com/originals/${m[1]}`;
  const gif = await probe(`${base}.gif`);
  if (gif.status === 200 && /gif/i.test(gif.type)) return { kind: 'gif', url: `${base}.gif`, size: gif.size, ext: 'GIF' };
  for (const ext of new Set([m[2].toLowerCase(), 'jpg', 'png', 'webp'])) {
    const r = await probe(`${base}.${ext}`);
    if (r.status === 200 && /^image\//i.test(r.type)) return { kind: 'image', url: `${base}.${ext}`, size: r.size, ext: ext.toUpperCase() };
  }
  return { kind: 'image', url: img, size: 0, ext: m[2].toUpperCase(), reduced: true };   // sin original disponible: la versión reducida
}

const BLOCKED = () => new HttpError(429, 'platform_blocked', 'Pinterest bloqueó temporalmente la solicitud. Inténtalo de nuevo en unos minutos.');

export async function pinterestImage(url, signal) {
  const res = await request(url, {
    headers: { 'User-Agent': config.userAgent, Accept: 'text/html', 'Accept-Language': 'en-US,en;q=0.8' },
    signal, allow: (h) => PLATFORMS.pinterest.test(h)
  });
  if (res.statusCode === 404 || res.statusCode === 410) { res.resume(); throw new HttpError(404, 'not_found', 'El pin no existe o fue eliminado.'); }
  if (res.statusCode === 403 || res.statusCode === 429) { res.resume(); throw BLOCKED(); }
  if (res.statusCode !== 200) { res.resume(); throw new HttpError(502, 'upstream_error', `Pinterest respondió ${res.statusCode}.`); }
  const meta = parseMeta(await readText(res, 1_500_000));

  const probe = async (u) => {
    try {
      const r = await request(u, { method: 'HEAD', signal, timeoutMs: 10_000, headers: { 'User-Agent': config.userAgent, Referer: 'https://www.pinterest.com/' }, allow: (h) => /(^|\.)pinimg\.com$/.test(h) });
      r.resume();
      return { status: r.statusCode, type: String(r.headers['content-type'] || ''), size: Number(r.headers['content-length']) || 0 };
    } catch { return { status: 0, type: '', size: 0 }; }
  };
  const pick = await classify(meta, probe);
  if (!pick) throw new HttpError(404, 'no_media', 'No se encontró una imagen, GIF o video descargable en este pin.');

  const gif = pick.kind === 'gif';
  return {
    title: clip(meta['og:title'] || 'Pin de Pinterest', 140),
    author: clip(meta['pinterestapp:pinner'] || '', 80),
    thumb: meta['og:image'] || '',
    contentKind: gif ? 'gif' : 'image',
    items: [{
      id: gif ? 'gif' : 'photo', type: 'photo', label: gif ? 'GIF' : pick.reduced ? 'Foto' : 'Foto HD', ext: pick.ext, size: pick.size,
      kind: 'direct', fmt: { url: pick.url, http_headers: { Referer: 'https://www.pinterest.com/' } }, args: null, page: url, index: 0
    }]
  };
}
