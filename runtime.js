// Piezas de ejecución para tráfico real: límite por IP, cola de procesos pesados y almacén temporal de descargas.
import { randomBytes } from 'node:crypto';
import { HttpError } from './errors.js';

// Ventana deslizante por IP. En varias instancias conviene moverlo a Redis (cada instancia cuenta por separado).
export function rateLimit({ windowMs = 60_000, max }) {
  const hits = new Map();   // ip → marcas de tiempo dentro de la ventana
  setInterval(() => {
    const cut = Date.now() - windowMs;
    for (const [ip, a] of hits) { while (a.length && a[0] <= cut) a.shift(); if (!a.length) hits.delete(ip); }
  }, windowMs).unref();
  return (req, res, next) => {
    const now = Date.now(), a = hits.get(req.ip) || [];
    while (a.length && a[0] <= now - windowMs) a.shift();
    if (a.length >= max) {
      const wait = Math.ceil((a[0] + windowMs - now) / 1000);
      res.setHeader('Retry-After', wait);
      throw new HttpError(429, 'rate_limited', `Demasiadas solicitudes. Inténtalo de nuevo en ${wait} s.`, wait);
    }
    a.push(now);
    hits.set(req.ip, a);
    if (hits.size > 100_000) hits.clear();   // tope de memoria
    next();
  };
}

// Ejecuta como máximo `limit` tareas a la vez; el resto espera en cola y, si la cola se llena, se rechaza con 503.
export class Pool {
  constructor(limit, maxQueue) { this.limit = limit; this.maxQueue = maxQueue; this.active = 0; this.queue = []; }
  async run(task) {
    if (this.active >= this.limit) {
      if (this.queue.length >= this.maxQueue) throw new HttpError(503, 'busy', 'El servidor está ocupado. Inténtalo de nuevo en unos segundos.', 10);
      await new Promise((resolve) => this.queue.push(resolve));   // el hueco se transfiere sin liberar `active`
    } else this.active++;
    try { return await task(); }
    finally { const next = this.queue.shift(); if (next) next(); else this.active--; }
  }
}

// Descargas autorizadas: al cliente solo viaja un id opaco de 128 bits (no existe un proxy abierto) con caducidad.
export class Store {
  constructor(ttlMs, max = 5000, onEvict = () => {}) {
    this.ttl = ttlMs; this.max = max; this.onEvict = onEvict; this.map = new Map();
    setInterval(() => this.sweep(), 60_000).unref();
  }
  add(entry) {
    const id = randomBytes(16).toString('hex');
    this.map.set(id, { ...entry, exp: Date.now() + this.ttl });
    while (this.map.size > this.max) this.evict(this.map.keys().next().value);
    return id;
  }
  get(id) {
    const e = /^[0-9a-f]{32}$/.test(String(id)) ? this.map.get(id) : null;
    if (!e || e.exp < Date.now()) return null;
    e.exp = Date.now() + this.ttl;
    return e;
  }
  evict(id) { const e = this.map.get(id); this.map.delete(id); if (e) this.onEvict(e); }
  sweep() { const now = Date.now(); for (const [id, e] of this.map) if (e.exp < now) this.evict(id); }
  clear() { for (const id of [...this.map.keys()]) this.evict(id); }
}
