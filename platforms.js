// Plataformas admitidas y validación estricta de la URL que llega desde la PWA.
import { HttpError } from './errors.js';

export const PLATFORMS = {
  tiktok: /(^|\.)tiktok\.com$/,
  instagram: /(^|\.)(instagram\.com|instagr\.am)$/,
  youtube: /(^|\.)(youtube\.com|youtu\.be)$/,
  x: /(^|\.)(x\.com|twitter\.com|t\.co)$/,
  pinterest: /(^|\.)(pinterest\.[a-z]{2,3}(\.[a-z]{2})?|pin\.it)$/
};

export const detectPlatform = (hostname) =>
  Object.keys(PLATFORMS).find((k) => PLATFORMS[k].test(String(hostname).toLowerCase())) || null;

const invalid = () => new HttpError(400, 'invalid_url', 'El enlace no es válido.');

// Solo https (http se reescribe), sin credenciales ni puertos raros, y solo dominios de las plataformas soportadas.
// La plataforma se deduce siempre en el servidor: nunca se confía en la que declare el cliente.
export function parseTarget(raw) {
  let s = typeof raw === 'string' ? raw.trim() : '';
  if (!s || s.length > 2048) throw invalid();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s;
  let u;
  try { u = new URL(s); } catch { throw invalid(); }
  if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password || (u.port && !['80', '443'].includes(u.port))) throw invalid();
  u.protocol = 'https:'; u.port = ''; u.hash = '';
  const platform = detectPlatform(u.hostname);
  if (!platform) throw new HttpError(400, 'unsupported_platform', 'Plataforma no compatible. Usa un enlace de TikTok, Instagram, YouTube, X o Pinterest.');
  return { url: u.href, platform };
}
