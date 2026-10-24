// ClipDrop API · Express + yt-dlp
//
//   POST /extract { url }   → { ok, platform, contentKind, title, author, thumb, formats: [{ id, type, label, ext, size, fileUrl }] }
//   GET  /file/:id          → binario retransmitido (CORS estricto, Content-Length exacto, sin compresión)
//   GET  /health            → estado del servicio
//
// Los errores siempre son JSON { ok:false, error:<código>, message:<texto>, retryAfter? } y nunca tumban el proceso.
import express from 'express';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { config } from './config.js';
import { HttpError } from './errors.js';
import { buildItems, clip, httpsOnly, onlyWatermarked } from './formats.js';
import { cleanHeaders, request } from './net.js';
import { pinterestImage } from './pinterest.js';
import { detectPlatform, parseTarget } from './platforms.js';
import { Store, rateLimit } from './runtime.js';
import { discard, prepare, sweepTemp, ytdlp } from './ytdlp.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', config.trustProxy);

const store = new Store(config.tokenTtlMs, 5000, discard);
const extractLimit = rateLimit({ max: config.rateExtract });
const fileLimit = rateLimit({ max: config.rateFile });
let streams = 0;

// ── Registro: una línea JSON por petición (nunca se guardan las URLs de los usuarios) ──
app.use((req, res, next) => {
  const t = Date.now();
  res.on('close', () => console.log(JSON.stringify({
    t: new Date().toISOString(), m: req.method, p: req.path.startsWith('/file/') ? '/file/:id' : req.path,
    s: res.statusCode, ms: Date.now() - t, done: res.writableFinished, ...res.locals.log
  })));
  next();
});

// ── CORS estricto: solo orígenes autorizados; Vary: Origin siempre (también en los errores) ──
app.use((req, res, next) => {
  const o = req.headers.origin;
  res.setHeader('Vary', 'Origin');
  if (o) {
    if (!config.origins.includes(o) && !(config.originRegex && config.originRegex.test(o))) {
      return res.status(403).json({ ok: false, error: 'origin_not_allowed', message: 'Origen no autorizado.' });
    }
    res.setHeader('Access-Control-Allow-Origin', o);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Type, Content-Disposition, Retry-After');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: '2kb' }));

// ── Extracción ──
// yt-dlp no sigue acortadores sin el extractor genérico (desactivado a propósito), así que se resuelven aquí.
const SHORT = /^(pin\.it|t\.co|instagr\.am)$/i;
async function resolveShort(target) {
  if (!SHORT.test(new URL(target.url).hostname)) return target;
  try {
    const res = await request(target.url, { headers: { 'User-Agent': 'ClipDropBot/1.0' }, timeoutMs: 10_000, allow: (h) => detectPlatform(h) !== null });
    res.resume();
    if (res.statusCode >= 400) throw new HttpError(404, 'not_found', 'El enlace corto no existe o caducó.');
    return parseTarget(res.finalUrl);
  } catch (e) {
    if (e instanceof HttpError && e.code === 'blocked_destination') throw new HttpError(400, 'unsupported_platform', 'El enlace corto no apunta a una plataforma compatible.');
    throw e;
  }
}

const contentKind = (items) => {
  if (items.some((i) => /^\d+-/.test(i.id))) return 'carousel';
  if (items.some((i) => i.type === 'video')) return 'video';
  return items.some((i) => i.id === 'gif') ? 'gif' : 'image';
};

async function fromYtDlp(url, platform) {
  const out = await ytdlp(['-J', '--no-playlist', '--playlist-end', '10', '--', url], config.extractTimeoutMs);
  let info;
  try { info = JSON.parse(out); } catch { throw new HttpError(502, 'extractor_failed', 'El extractor devolvió una respuesta inválida.'); }
  if (info.is_live || info.live_status === 'is_live') throw new HttpError(422, 'live_unsupported', 'Las transmisiones en vivo no se pueden descargar.');
  if (config.maxDurationMin && info.duration > config.maxDurationMin * 60) throw new HttpError(413, 'too_long', `El video supera la duración máxima (${config.maxDurationMin} min).`);
  const items = buildItems(platform, info, url);
  if (!items.length) {
    throw onlyWatermarked(info)
      ? new HttpError(422, 'no_clean_source', 'La plataforma solo ofrece una versión con marca de agua de este contenido.')
      : new HttpError(404, 'no_formats', 'No se encontraron formatos descargables en este enlace.');
  }
  return {
    title: clip(info.title, 140) || 'Sin título', author: clip(info.uploader || info.channel || info.uploader_id, 80),
    thumb: httpsOnly(info.thumbnail || ((info.thumbnails || []).at(-1) || {}).url), contentKind: contentKind(items), items
  };
}

async function extract(url, platform) {
  if (platform !== 'pinterest') return fromYtDlp(url, platform);
  try { return await fromYtDlp(url, platform); }
  catch (e) { if (e.code !== 'extractor_failed' && e.code !== 'no_formats') throw e; }   // pin de imagen/GIF: yt-dlp solo entiende los de video
  return pinterestImage(url);
}

// Caché de 2 min + deduplicación de peticiones simultáneas a la misma URL (menos carga sobre yt-dlp y las plataformas)
const cache = new Map(), inflight = new Map();
function extractCached(url, platform) {
  const hit = cache.get(url);
  if (hit && hit.exp > Date.now()) return Promise.resolve(hit.data);
  if (inflight.has(url)) return inflight.get(url);
  const p = extract(url, platform)
    .then((data) => { cache.set(url, { exp: Date.now() + config.cacheMs, data }); if (cache.size > 200) cache.delete(cache.keys().next().value); return data; })
    .finally(() => inflight.delete(url));
  inflight.set(url, p);
  return p;
}

app.get('/health', (req, res) => res.json({ ok: true, uptime: Math.round(process.uptime()), streams }));

app.post('/extract', extractLimit, async (req, res) => {
  const target = await resolveShort(parseTarget(req.body && req.body.url));
  res.locals.log = { platform: target.platform };
  const data = await extractCached(target.url, target.platform);
  const base = config.publicUrl || `${req.protocol}://${req.get('host')}`;
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    ok: true, platform: target.platform, contentKind: data.contentKind, title: data.title, author: data.author, thumb: data.thumb,
    formats: data.items.map((item) => {
      const id = store.add({ ...item, title: data.title });
      return { id: item.id, type: item.type, label: item.label, ext: item.ext, size: item.size, fileUrl: `${base}/file/${id}` };
    })
  });
});

// ── Retransmisión del binario ──
const MIME = { mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', m4a: 'audio/mp4', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };
const mime = (name) => MIME[String(name).split('.').pop().toLowerCase()] || 'application/octet-stream';
const fileName = (e) => `${clip(e.title, 80).replace(/[^\p{L}\p{N} _.-]+/gu, '').trim() || 'clipdrop'}-${String(e.label).replace(/[^\w.-]+/g, '')}.${String(e.ext).toLowerCase()}`;
const upstreamError = (s) => (s === 404 || s === 410
  ? new HttpError(410, 'gone', 'El archivo ya no está disponible en el origen.')
  : s === 429
    ? new HttpError(429, 'platform_blocked', 'La plataforma bloqueó temporalmente la descarga. Inténtalo en unos minutos.')
    : new HttpError(502, 'upstream_blocked', `El origen rechazó la descarga (${s}).`));

app.get('/file/:id', fileLimit, async (req, res) => {
  const e = store.get(req.params.id);
  if (!e) throw new HttpError(404, 'link_expired', 'El enlace de descarga caducó. Vuelve a analizar el enlace.');
  if (streams >= config.maxStreams) throw new HttpError(503, 'busy', 'Hay demasiadas descargas en curso. Inténtalo de nuevo en unos segundos.', 10);
  streams++;
  const ac = new AbortController();
  res.on('close', () => { streams--; ac.abort(); });   // si el cliente cancela, también se corta la conexión con el origen
  res.locals.log = { kind: e.kind, type: e.type };

  res.setHeader('Cache-Control', 'no-store, no-transform');   // no-transform: ningún proxy puede recomprimir ni alterar el binario
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Accept-Ranges', 'none');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName(e))}`);

  let failure;
  if (e.kind === 'direct') {   // progresivo (MP4, imágenes, GIF): se retransmite desde el CDN sin tocar el disco
    try {
      const up = await request(e.fmt.url, { headers: cleanHeaders(e.fmt.http_headers), signal: ac.signal });
      if (up.statusCode === 200) {
        const len = up.headers['content-length'], enc = up.headers['content-encoding'];
        res.setHeader('Content-Type', up.headers['content-type'] || mime(e.ext));
        if (len && (!enc || enc === 'identity')) res.setHeader('Content-Length', len);   // sin Content-Length el progreso del cliente queda indeterminado
        return await pipeline(up, res);
      }
      up.resume();
      failure = upstreamError(up.statusCode);
    } catch (err) {
      if (ac.signal.aborted || res.headersSent) throw err;   // el cliente canceló, o el corte ocurrió a mitad del binario
      failure = err instanceof HttpError ? err : new HttpError(502, 'upstream_error', 'No se pudo conectar con el origen.');
    }
    if (!e.args) throw failure;   // sin respaldo posible (p. ej. imágenes de Pinterest)
    res.removeHeader('Content-Length');
  }

  // Fusión audio+video, conversión a MP3 o respaldo con yt-dlp (maneja las cookies y cabeceras del CDN)
  const file = await prepare(e);
  e.exp = Date.now() + config.tokenTtlMs;
  const { size } = await stat(file);
  res.setHeader('Content-Type', mime(file));
  res.setHeader('Content-Length', size);   // tamaño exacto del archivo ya preparado
  await pipeline(createReadStream(file), res);
  discard(e);   // entrega completa: se libera el disco
});

// ── Errores: siempre JSON ──
app.use(() => { throw new HttpError(404, 'not_found', 'Ruta no encontrada.'); });

app.use((err, req, res, next) => {
  if (res.headersSent) return res.destroy();   // fallo a mitad de un binario: se corta la conexión para que el cliente detecte el truncado
  const e = err instanceof HttpError ? err
    : err.status >= 400 && err.status < 500 ? new HttpError(err.status, 'bad_request', err.type === 'entity.too.large' ? 'Solicitud demasiado grande.' : 'Solicitud inválida.')
      : new HttpError(500, 'internal', 'Error interno del servidor.');
  if (e.code === 'internal') console.error(err);
  res.locals.log = { ...res.locals.log, error: e.code };
  if (e.retryAfter) res.setHeader('Retry-After', e.retryAfter);
  res.status(e.status).json({ ok: false, error: e.code, message: e.message, ...(e.retryAfter && { retryAfter: e.retryAfter }) });
});

// ── Ciclo de vida ──
await sweepTemp();   // temporales de ejecuciones anteriores
const server = app.listen(config.port, () => console.log(`ClipDrop API escuchando en :${config.port} · orígenes: ${config.origins.join(', ') || '(ninguno)'}`));
server.keepAliveTimeout = 65_000;   // mayor que el de los balanceadores habituales (60 s)
server.headersTimeout = 66_000;
ytdlp(['--version'], 10_000).then((v) => console.log('yt-dlp', v.trim())).catch((e) => console.warn('⚠ yt-dlp no responde:', e.message));

const stop = () => { store.clear(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 10_000).unref(); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.on('unhandledRejection', (r) => console.error('unhandledRejection:', r));
process.on('uncaughtException', (e) => { console.error('uncaughtException:', e); process.exit(1); });
