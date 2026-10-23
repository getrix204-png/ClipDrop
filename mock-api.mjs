// Servidor de PRUEBA de ClipDrop (sin dependencias): implementa el contrato de la API con CORS y entrega archivos
// sintéticos reales (WAV y BMP; un MP4 si pones samples/sample.mp4) para probar descarga → IndexedDB → reproductor.
// NO extrae contenido de ninguna plataforma: en producción /extract lo implementa tu backend o proveedor.
// Uso:  node mock-api.mjs      Variables: PORT (8787), ALLOWED_ORIGINS="https://app.tudominio.com,http://localhost:3000"
import http from 'node:http';
import fs from 'node:fs';

const PORT = Number(process.env.PORT) || 8787;
const ALLOWED = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000,http://127.0.0.1:3000').split(',').map(s => s.trim());
const HOSTS = /(^|\.)(tiktok\.com|instagram\.com|instagr\.am|youtube\.com|youtu\.be|x\.com|twitter\.com|t\.co|pinterest\.[a-z]{2,3}(\.[a-z]{2})?|pin\.it)$/;
const SAMPLE_MP4 = new URL('./samples/sample.mp4', import.meta.url);

// CORS: origen exacto de la lista (nunca "*"), sin cookies. Los orígenes no listados quedan bloqueados por el navegador.
function cors(req, res) {
  const o = req.headers.origin;
  if (!o || !ALLOWED.includes(o)) return;
  res.setHeader('Access-Control-Allow-Origin', o);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

const hits = new Map();   // límite simple: 30 solicitudes por minuto e IP
function limited(ip) {
  const now = Date.now(), a = (hits.get(ip) || []).filter(t => now - t < 60000);
  a.push(now); hits.set(ip, a);
  return a.length > 30;
}
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

function wav(sec) {   // tono de 440 Hz, mono, 16-bit
  const rate = 22050, n = rate * sec, b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * i / rate) * 9000), 44 + i * 2);
  return b;
}

function bmp(size = 512) {   // degradado de 24 bits (512*3 es múltiplo de 4: sin relleno por fila)
  const px = size * size * 3, b = Buffer.alloc(54 + px);
  b.write('BM', 0); b.writeUInt32LE(54 + px, 2); b.writeUInt32LE(54, 10); b.writeUInt32LE(40, 14);
  b.writeInt32LE(size, 18); b.writeInt32LE(size, 22); b.writeUInt16LE(1, 26); b.writeUInt16LE(24, 28); b.writeUInt32LE(px, 34);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const o = 54 + (y * size + x) * 3;
    b[o] = (247 - x / 3) | 0; b[o + 1] = (58 + y / 4) | 0; b[o + 2] = (34 + x / 3) | 0;   // BGR
  }
  return b;
}

// id → [bytes, mime, tipo, etiqueta, extensión mostrada]  (los "MP3" del mock son WAV con la etiqueta del contrato)
const FILES = {
  a320: [wav(40), 'audio/wav', 'audio', 'MP3 320 kbps', 'MP3'],
  a128: [wav(20), 'audio/wav', 'audio', 'MP3 128 kbps', 'MP3'],
  photo: [bmp(), 'image/bmp', 'photo', 'Foto HD', 'BMP']
};
if (fs.existsSync(SAMPLE_MP4)) {
  const mp4 = fs.readFileSync(SAMPLE_MP4);
  FILES.v720 = [mp4, 'video/mp4', 'video', '720p', 'MP4'];
  FILES.v480 = [mp4, 'video/mp4', 'video', '480p', 'MP4'];
}

if (process.env.MOCK_BIG) FILES.big = [wav(720), 'audio/wav', 'audio', 'Audio largo (32 MB)', 'WAV'];   // ≈32 MB: varias partes de 8 MB

http.createServer((req, res) => {
  cors(req, res);
  const u = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (req.method === 'POST' && u.pathname === '/extract') {
    if (limited(req.socket.remoteAddress)) return json(res, 429, { error: 'rate_limited' });
    let body = '';
    req.on('data', c => { body += c; if (body.length > 4096) req.destroy(); });
    req.on('end', () => {
      let target;
      try { target = new URL(JSON.parse(body).url); } catch { return json(res, 400, { error: 'invalid_url' }); }
      if (target.protocol !== 'https:' || !HOSTS.test(target.hostname)) return json(res, 400, { error: 'unsupported_host' });
      const base = `http://${req.headers.host}`;
      json(res, 200, {
        title: 'Archivo de prueba', author: '@mock', thumb: '',
        formats: Object.entries(FILES).map(([id, [buf, , type, label, ext]]) => ({ id, type, label, ext, size: buf.length, fileUrl: `${base}/files/${id}` }))
      });
    });
    return;
  }

  const m = u.pathname.match(/^\/files\/(\w+)$/);
  if (req.method === 'GET' && m && FILES[m[1]]) {
    const [buf, mime] = FILES[m[1]];
    res.writeHead(200, { 'Content-Type': mime, 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
    let off = 0;
    const t = setInterval(() => {   // se entrega por tramos para que el progreso sea visible
      res.write(buf.subarray(off, off += 65536));
      if (off >= buf.length) { clearInterval(t); res.end(); }
    }, 25);
    req.on('close', () => clearInterval(t));
    return;
  }
  json(res, 404, { error: 'not_found' });
}).listen(PORT, () => console.log(`Mock API en http://localhost:${PORT} · orígenes permitidos: ${ALLOWED.join(', ')}`));
