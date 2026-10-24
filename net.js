// Salida de red segura hacia las plataformas y sus CDN: solo HTTPS, sin IPs privadas (SSRF) y con redirecciones controladas.
import https from 'node:https';
import { lookup } from 'node:dns';
import { isIP } from 'node:net';
import { HttpError } from './errors.js';

const PRIVATE = /^(0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|::1?$|f[cd][0-9a-f]{2}:|fe[89ab][0-9a-f]:)/i;
export const isPrivateIp = (ip) => PRIVATE.test(String(ip).replace(/^::ffff:/i, ''));

// Se valida la IP real a la que resuelve el nombre (también frente a DNS rebinding).
function safeLookup(host, opts, cb) {
  lookup(host, opts, (err, address, family) => {
    if (err) return cb(err);
    const found = Array.isArray(address) ? address : [{ address, family }];
    if (found.some((a) => isPrivateIp(a.address))) return cb(new HttpError(502, 'blocked_destination', 'Destino no permitido.'));
    cb(null, address, family);
  });
}

// Solo se reenvían al origen las cabeceras que yt-dlp considera necesarias para ese CDN.
const FORWARD = ['user-agent', 'referer', 'accept', 'accept-language', 'origin', 'cookie'];
export const cleanHeaders = (h = {}) =>
  Object.fromEntries(Object.entries(h).filter(([k, v]) => FORWARD.includes(k.toLowerCase()) && typeof v === 'string'));

// GET/HEAD con hasta 3 redirecciones. Pide siempre Accept-Encoding: identity (el Content-Length del origen es el real).
// Resuelve con la respuesta (IncomingMessage) sin consumirla; res.finalUrl es la URL final tras las redirecciones.
export function request(url, { method = 'GET', headers = {}, signal, timeoutMs = 30_000, hops = 3, allow = () => true } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { return reject(new HttpError(502, 'upstream_error', 'URL de origen inválida.')); }
    const bare = u.hostname.replace(/^\[|\]$/g, '');
    if (u.protocol !== 'https:' || !allow(u.hostname) || (isIP(bare) && isPrivateIp(bare))) {
      return reject(new HttpError(502, 'blocked_destination', 'Destino no permitido.'));
    }
    const req = https.request(u, { method, lookup: safeLookup, signal, timeout: timeoutMs, headers: { ...headers, 'Accept-Encoding': 'identity' } }, (res) => {
      const loc = res.headers.location;
      if (res.statusCode >= 300 && res.statusCode < 400 && loc) {
        res.resume();
        if (hops <= 0) return reject(new HttpError(502, 'upstream_error', 'Demasiadas redirecciones.'));
        let next;
        try { next = new URL(loc, u).href; } catch { return reject(new HttpError(502, 'upstream_error', 'Redirección inválida.')); }
        return resolve(request(next, { method, headers, signal, timeoutMs, hops: hops - 1, allow }));
      }
      res.finalUrl = u.href;
      resolve(res);
    });
    req.on('timeout', () => req.destroy(new HttpError(504, 'timeout', 'El origen tardó demasiado en responder.')));
    req.on('error', reject);
    req.end();
  });
}

// Lee el cuerpo como texto con un tope de bytes (evita agotar memoria con páginas enormes).
export async function readText(res, max) {
  const chunks = [];
  let n = 0;
  for await (const c of res) {
    chunks.push(c);
    n += c.length;
    if (n > max) { res.destroy(); break; }
  }
  return Buffer.concat(chunks).toString('utf8');
}
