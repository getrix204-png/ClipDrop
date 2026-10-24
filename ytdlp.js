// Ejecución de yt-dlp: sin shell, con tiempo límite, colas separadas y limpieza de archivos temporales.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config.js';
import { HttpError, mapYtDlpError } from './errors.js';
import { Pool } from './runtime.js';

const extractPool = new Pool(config.maxParallel, config.maxQueue);   // extracciones (rápidas)
const preparePool = new Pool(config.maxPrepare, config.maxQueue);    // fusión / conversión / respaldo (pesadas)

// --use-extractors default,-generic: desactiva el extractor genérico (no descarga páginas arbitrarias desde el servidor).
const BASE = ['--ignore-config', '--no-warnings', '--use-extractors', 'default,-generic', '--socket-timeout', '15', '--retries', '2',
  ...(config.cookies ? ['--cookies', config.cookies] : [])];

export function ytdlp(args, timeoutMs, pool = extractPool) {
  return pool.run(() => new Promise((resolve, reject) => {
    const p = spawn(config.ytdlp, [...BASE, ...args], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });   // args como array: sin inyección de shell
    let out = '', err = '', done = false;
    const kill = () => { try { process.kill(-p.pid, 'SIGKILL'); } catch { /* ya terminó */ } };   // mata también a ffmpeg
    const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); fn(v); };
    const timer = setTimeout(() => { kill(); finish(reject, new HttpError(504, 'timeout', 'La extracción tardó demasiado.')); }, timeoutMs);
    p.stdout.on('data', (d) => {
      out += d;
      if (out.length > 25e6) { kill(); finish(reject, new HttpError(502, 'extractor_failed', 'Respuesta del extractor demasiado grande.')); }
    });
    p.stderr.on('data', (d) => { err = (err + d).slice(-8000); });
    p.on('error', (e) => finish(reject, new HttpError(500, 'extractor_unavailable', e.code === 'ENOENT' ? 'yt-dlp no está instalado en el servidor.' : 'No se pudo iniciar el extractor.')));
    p.on('close', (code) => (code === 0 ? finish(resolve, out) : finish(reject, mapYtDlpError(err))));
  }));
}

// Descarga a disco: fusión de audio y video, conversión a MP3, o respaldo cuando el CDN rechaza el proxy. Una sola vez por entrada.
export function prepare(e) {
  e.pending ??= (async () => {
    await mkdir(config.tmpDir, { recursive: true });
    e.dir = await mkdtemp(join(config.tmpDir, 'cd-'));
    const items = e.index ? ['--playlist-items', String(e.index)] : ['--no-playlist'];
    await ytdlp([...e.args, ...items, '--no-progress', '--max-filesize', `${config.maxFileMb}M`, '-o', join(e.dir, 'out.%(ext)s'), '--', e.page], config.prepareTimeoutMs, preparePool);
    const name = (await readdir(e.dir)).find((n) => n.startsWith('out.') && !/\.(part|ytdl|temp)$/.test(n));
    if (!name) throw new HttpError(502, 'extractor_failed', 'No se generó el archivo.');
    return (e.file = join(e.dir, name));
  })().catch((err) => { discard(e); throw err; });
  return e.pending;
}

export function discard(e) {
  if (e.dir) rm(e.dir, { recursive: true, force: true }).catch(() => {});
  e.dir = e.file = e.pending = null;
}

// Al arrancar se borran los temporales de ejecuciones anteriores (caídas, reinicios).
export async function sweepTemp() {
  await mkdir(config.tmpDir, { recursive: true });
  for (const n of await readdir(config.tmpDir).catch(() => [])) {
    if (n.startsWith('cd-')) await rm(join(config.tmpDir, n), { recursive: true, force: true }).catch(() => {});
  }
}
