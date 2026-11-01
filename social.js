// Publicaciones SOLO con fotos en X e Instagram. yt-dlp únicamente entiende videos, así que estas dos usan otra vía:
//  · X: API pública de FixTweet (api.fxtwitter.com) — servicio de terceros; FX_API="" lo desactiva.
//  · Instagram: la página pública de "embed" de la publicación (solo la primera foto de un carrusel).
// Ambas dependen de páginas/servicios que pueden cambiar: si fallan, se devuelve el error original del extractor.
import { config } from './config.js';
import { HttpError } from './errors.js';
import { clip } from './formats.js';
import { readText, request } from './net.js';

const decode = (s) => String(s).replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const UA = { 'User-Agent': 'ClipDropBot/1.0' };
const BLOCKED = () => new HttpError(429, 'platform_blocked', 'La plataforma bloqueó temporalmente la solicitud. Inténtalo de nuevo en unos minutos.');

// ── X ──
export function parseFxTweet(json) {
  const t = json && json.tweet;
  const photos = ((t && t.media && t.media.photos) || []).filter((p) => p && /^https:\/\//.test(p.url || ''));
  if (!photos.length) return null;
  return {
    title: clip(t.text || 'Publicación de X', 140),
    author: clip((t.author && (t.author.name || t.author.screen_name)) || '', 80),
    photos: photos.map((p) => { const u = new URL(p.url); if (!u.searchParams.has('name')) u.searchParams.set('name', 'orig'); return { url: u.href, ext: (/\.(\w{3,4})$/.exec(u.pathname) || [, 'jpg'])[1].toUpperCase() }; })
  };
}

export async function xPhotos(url) {
  if (!config.fxApi) throw new HttpError(404, 'no_media', 'Este tweet no contiene video.');
  const path = new URL(url).pathname;
  const id = (/\/status\/(\d+)/.exec(path) || [])[1];
  if (!id) throw new HttpError(400, 'invalid_url', 'El enlace no es válido.');
  const res = await request(`${config.fxApi}/${encodeURIComponent(path.split('/')[1] || 'i')}/status/${id}`, { headers: { ...UA, Accept: 'application/json' }, timeoutMs: 15_000 });
  if (res.statusCode === 404) { res.resume(); throw new HttpError(404, 'not_found', 'El tweet no existe o es privado.'); }
  if (res.statusCode >= 400) { res.resume(); throw new HttpError(502, 'upstream_error', `El servicio de tweets respondió ${res.statusCode}.`); }
  let data;
  try { data = JSON.parse(await readText(res, 1_000_000)); } catch { throw new HttpError(502, 'upstream_error', 'Respuesta inválida del servicio de tweets.'); }
  const r = parseFxTweet(data);
  if (!r) throw new HttpError(404, 'no_media', 'No se encontraron fotos en este tweet.');
  const multi = r.photos.length > 1;
  return {
    title: r.title, author: r.author, thumb: r.photos[0].url, contentKind: multi ? 'carousel' : 'image',
    items: r.photos.map((p, i) => ({
      id: multi ? `${i + 1}-photo` : 'photo', type: 'photo', label: multi ? `Foto HD · ${i + 1}` : 'Foto HD', ext: p.ext, size: 0,
      kind: 'direct', fmt: { url: p.url, http_headers: {} }, args: null, page: url, index: 0
    }))
  };
}

// ── Instagram ──
export function parseInstagramEmbed(html) {
  const tag = /<img[^>]*class="[^"]*EmbeddedMediaImage[^"]*"[^>]*>/i.exec(html);
  const src = tag && /\ssrc="([^"]+)"/i.exec(tag[0]);
  const url = src ? decode(src[1]) : '';
  if (!/^https:\/\//.test(url)) return null;
  const alt = /\salt="([^"]*)"/i.exec(tag[0]);
  const user = /class="[^"]*UsernameText[^"]*"[^>]*>([^<]+)</i.exec(html);
  return { url, title: clip(decode((alt && alt[1]) || 'Foto de Instagram'), 140), author: clip(decode(user ? user[1] : ''), 80) };
}

export async function instagramImage(url) {
  const m = /^\/(?:[^/]+\/)?(p|reel|tv)\/([\w-]+)/.exec(new URL(url).pathname);
  if (!m) throw new HttpError(400, 'invalid_url', 'El enlace no es válido.');
  const res = await request(`https://www.instagram.com/${m[1]}/${m[2]}/embed/captioned/`, {
    headers: { 'User-Agent': config.userAgent, Accept: 'text/html', 'Accept-Language': 'en-US,en;q=0.8' }, timeoutMs: 15_000, allow: (h) => /(^|\.)instagram\.com$/.test(h)
  });
  if (res.statusCode === 404 || res.statusCode === 410) { res.resume(); throw new HttpError(404, 'not_found', 'La publicación no existe o es privada.'); }
  if (res.statusCode === 403 || res.statusCode === 429) { res.resume(); throw BLOCKED(); }
  if (res.statusCode !== 200) { res.resume(); throw new HttpError(502, 'upstream_error', `Instagram respondió ${res.statusCode}.`); }
  const r = parseInstagramEmbed(await readText(res, 1_500_000));
  if (!r) throw new HttpError(404, 'no_media', 'No se encontró una foto descargable en esta publicación.');
  return {
    title: r.title, author: r.author, thumb: r.url, contentKind: 'image',
    items: [{ id: 'photo', type: 'photo', label: 'Foto HD', ext: (/\.(jpe?g|png|webp)(?:\?|$)/i.exec(r.url) || [, 'jpg'])[1].toUpperCase(), size: 0, kind: 'direct', fmt: { url: r.url, http_headers: { Referer: 'https://www.instagram.com/' } }, args: null, page: url, index: 0 }]
  };
}
