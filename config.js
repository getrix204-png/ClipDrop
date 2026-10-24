// Configuración centralizada: todo se controla con variables de entorno (ver .env.example).
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const env = process.env;
const num = (v, d) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
const list = (v) => String(v || '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
const dev = env.NODE_ENV !== 'production';

export const config = Object.freeze({
  port: num(env.PORT, 8787),
  // CORS: orígenes exactos de la PWA (https, sin barra final). Regex opcional para las previews de Vercel.
  origins: list(env.ALLOWED_ORIGINS || (dev ? 'http://localhost:3000,http://127.0.0.1:3000' : '')),
  originRegex: env.ALLOWED_ORIGIN_REGEX ? new RegExp(env.ALLOWED_ORIGIN_REGEX) : null,
  publicUrl: String(env.PUBLIC_URL || '').replace(/\/+$/, ''),   // si falta, se deduce de la petición
  trustProxy: num(env.TRUST_PROXY, 1),                           // saltos de proxy delante del servidor (para la IP real)
  // yt-dlp
  ytdlp: env.YTDLP_PATH || 'yt-dlp',
  cookies: env.YTDLP_COOKIES || '',                              // opcional: cookies.txt de TU cuenta (contenido que ya puedes ver)
  tmpDir: env.TMP_DIR || join(tmpdir(), 'clipdrop'),
  userAgent: env.UPSTREAM_UA || 'Mozilla/5.0 (compatible; ClipDropBot/1.0)',
  // límites
  maxFileMb: num(env.MAX_FILE_MB, 1024),
  maxDurationMin: num(env.MAX_DURATION_MIN, 180),
  maxParallel: num(env.MAX_PARALLEL, 3),                         // extracciones simultáneas
  maxPrepare: num(env.MAX_PREPARE, 2),                           // fusiones/conversiones simultáneas (pesadas)
  maxQueue: num(env.MAX_QUEUE, 20),
  maxStreams: num(env.MAX_STREAMS, 40),
  rateExtract: num(env.RATE_EXTRACT_PER_MIN, 15),
  rateFile: num(env.RATE_FILE_PER_MIN, 60),
  // tiempos
  tokenTtlMs: num(env.TOKEN_TTL_MIN, 10) * 60_000,
  cacheMs: num(env.CACHE_SECONDS, 120) * 1000,
  extractTimeoutMs: num(env.EXTRACT_TIMEOUT_S, 45) * 1000,
  prepareTimeoutMs: num(env.PREPARE_TIMEOUT_MIN, 10) * 60_000
});

if (!config.origins.length && !config.originRegex) console.warn('⚠ ALLOWED_ORIGINS está vacío: ningún navegador podrá usar la API.');
