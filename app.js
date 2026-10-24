const DEMO_ITEMS = [
    { id: 1, type: 'video', title: 'Anime Edit Velocity 4K', thumb: 'https://images.unsplash.com/photo-1578632767115-351597cf2477?w=300' },
    { id: 2, type: 'audio', title: 'Phonk Viral Beat Sound', thumb: 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=300' },
    { id: 3, type: 'photo', title: 'Carrusel IG Aesthetic #1', thumb: 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=300' },
    { id: 4, type: 'video', title: 'Football Skill Clip HD', thumb: 'https://images.unsplash.com/photo-1508098682722-e99c43a406b2?w=300' },
    { id: 5, type: 'photo', title: 'Wallpaper Anime HD 1080p', thumb: 'https://images.unsplash.com/photo-1534447677768-be436bb09401?w=300' }
];
let galleryItems = [];   // se carga desde IndexedDB en initGallery()

// ===== Persistencia: IndexedDB (BD "clipdrop": stores "gallery" y "meta") =====
const DB_NAME = 'clipdrop', DB_VERSION = 3;
let dbPromise = null;
let dbWarned = false;

function openDB() {
    if (!dbPromise) {
        dbPromise = new Promise((resolve, reject) => {
            if (!window.indexedDB) return reject(new Error('IndexedDB no disponible'));
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains('gallery')) db.createObjectStore('gallery', { keyPath: 'id' });
                if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
                if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'id' });   // v2: Blobs / manifiestos
                if (!db.objectStoreNames.contains('parts')) db.createObjectStore('parts', { keyPath: ['id', 'n'] });   // v3: partes de archivos grandes
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }
    return dbPromise;
}

// Ejecuta fn(store) en una transacción y resuelve al terminar (con el resultado si fn devuelve un request)
function tx(store, mode, fn) {
    return openDB().then(db => new Promise((resolve, reject) => {
        const t = db.transaction(store, mode);
        const out = fn(t.objectStore(store));
        t.oncomplete = () => resolve(out && 'result' in out ? out.result : undefined);
        t.onerror = t.onabort = () => reject(t.error);
    }));
}

// Transacción sobre varios stores (guardar/borrar metadatos y archivo de forma atómica)
function txn(stores, mode, fn) {
    return openDB().then(db => new Promise((resolve, reject) => {
        const t = db.transaction(stores, mode);
        fn(t);
        t.oncomplete = () => resolve();
        t.onerror = t.onabort = () => reject(t.error);
    }));
}
const dbGetAll = () => tx('gallery', 'readonly', s => s.getAll());
const partRange = (id) => IDBKeyRange.bound([id, 0], [id, Infinity]);
const dbDeleteParts = (id) => tx('parts', 'readwrite', s => s.delete(partRange(id)));

// Devuelve el archivo como Blob: directo (archivos pequeños) o recompuesto desde sus partes.
// Las partes que entrega IndexedDB son referencias a disco: recomponerlas no carga el archivo en la memoria JS.
const dbGetFile = async (id) => {
    const rec = await tx('files', 'readonly', s => s.get(id));
    if (!rec) return null;
    if (rec.blob) return rec.blob;
    const parts = await tx('parts', 'readonly', s => s.getAll(partRange(id)));
    return new Blob(parts.map(p => p.blob), { type: rec.mime || '' });
};

// Partes de descargas interrumpidas (app cerrada, fallo de energía): se borran si tienen más de 1 h y no pertenecen a ningún elemento
async function purgeOrphanParts(items) {
    const known = new Set(items.map(i => i.id));
    const keys = await tx('parts', 'readonly', s => s.getAllKeys());
    const stale = [...new Set(keys.map(k => k[0]))].filter(id => !known.has(id) && Date.now() - id > 3600e3);
    if (stale.length) await txn('parts', 'readwrite', t => stale.forEach(id => t.objectStore('parts').delete(partRange(id))));
}
const dbPut = (item) => tx('gallery', 'readwrite', s => s.put(item));
const dbDelete = (ids) => txn(['gallery', 'files', 'parts'], 'readwrite', t => ids.forEach(id => {
    t.objectStore('gallery').delete(id); t.objectStore('files').delete(id); t.objectStore('parts').delete(partRange(id));
}));

function persistError(e) {
    console.warn('IndexedDB:', e);
    if (dbWarned) return;
    dbWarned = true;
    alert('No se pudo guardar en este dispositivo (almacenamiento bloqueado o lleno). Los cambios se mantendrán solo mientras la app esté abierta.');
}

async function initGallery() {
    try {
        let items = await dbGetAll();
        const seeded = await tx('meta', 'readonly', s => s.get('seeded'));
        if (!seeded) {   // primera ejecución: carga los ejemplos una sola vez
            if (!items.length) {
                const now = Date.now();
                items = DEMO_ITEMS.map((it, i) => ({ ...it, createdAt: now - i * 1000 }));
                await tx('gallery', 'readwrite', s => items.forEach(it => s.put(it)));
            }
            await tx('meta', 'readwrite', s => s.put({ key: 'seeded', value: true }));
        }
        galleryItems = items.sort((a, b) => b.createdAt - a.createdAt);   // más nuevos primero
        purgeOrphanParts(galleryItems).catch(() => {});
        if (navigator.storage && navigator.storage.persist) navigator.storage.persist();   // evita que el navegador lo borre
    } catch (e) {
        persistError(e);   // sin IndexedDB la galería sigue funcionando en memoria
        galleryItems = DEMO_ITEMS.map((it, i) => ({ ...it, createdAt: Date.now() - i * 1000 }));
    }
    renderGallery(currentGalleryFilter);
}

let currentGalleryFilter = 'all';
let galleryLayout = 'grid'; // 'grid' or 'list'

window.onload = function() {
    initGallery();

    document.addEventListener('keydown', function(e) {
        if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
            const input = document.getElementById('urlInput');
            if (document.activeElement !== input) {
                input.focus();
            }
        }
    });
};

// ===== Detección de plataforma + glow dinámico (body[data-p]) =====
const PLATFORM_ICONS = {
    tiktok: 'fa-brands fa-tiktok text-white',
    instagram: 'fa-brands fa-instagram text-pink-400',
    youtube: 'fa-brands fa-youtube text-red-500',   // Shorts y videos largos
    x: 'fa-brands fa-x-twitter text-white',
    pinterest: 'fa-brands fa-pinterest text-red-500',
    default: 'fa-solid fa-link'
};

const CHIP_TEXT = { default: 'Soporta TikTok, IG, Shorts, YouTube, X y Pinterest' };

function detectPlatform(raw) {
    let host;
    try { host = new URL(/^https?:\/\//i.test(raw) ? raw : 'https://' + raw).hostname.toLowerCase(); }
    catch (e) { return 'default'; }
    if (/(^|\.)tiktok\.com$/.test(host)) return 'tiktok';
    if (/(^|\.)(instagram\.com|instagr\.am)$/.test(host)) return 'instagram';
    if (/(^|\.)(youtube\.com|youtu\.be)$/.test(host)) return 'youtube';
    if (/(^|\.)(x\.com|twitter\.com|t\.co)$/.test(host)) return 'x';
    if (/(^|\.)(pinterest\.[a-z]{2,3}(\.[a-z]{2})?|pin\.it)$/.test(host)) return 'pinterest';
    return 'default';
}

function handleUrlInputChange() {
    const raw = document.getElementById('urlInput').value.trim();
    document.getElementById('clearBtn').classList.toggle('hidden', !raw);
    const p = detectPlatform(raw);
    document.body.dataset.p = p;   // el CSS cambia --g1/--g2 según este valor
    document.getElementById('platformIcon').innerHTML = `<i class="${PLATFORM_ICONS[p]} text-sm"></i>`;
    document.getElementById('platformChip').textContent = (CHIP_TEXT[p] || CHIP_TEXT.default) + (DOWNLOAD_API ? '' : ' · demo');
}

// ===== Miniaturas: fallback si una URL falla (404, bloqueo, sin red) =====
const PH_ICONS = {
    video: '<path d="M26 20v24l20-12z"/>',
    audio: '<circle cx="25" cy="44" r="6"/><circle cx="41" cy="40" r="6"/><path d="M29 44V20l16-4v24" fill="none" stroke="#fff" stroke-width="4"/>',
    photo: '<path d="M12 46l13-17 9 11 6-7 12 13z"/><circle cx="43" cy="22" r="5"/>'
};
const PH_COLORS = { video: ['#0891B2', '#7C3AED'], audio: ['#0E7490', '#4F46E5'], photo: ['#7C3AED', '#DB2777'] };

function placeholderThumb(type) {
    const c = PH_COLORS[type] || PH_COLORS.photo;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c[0]}"/><stop offset="1" stop-color="${c[1]}"/></linearGradient></defs><rect width="64" height="64" fill="url(#g)"/><g fill="#fff" fill-opacity=".9">${PH_ICONS[type] || PH_ICONS.photo}</g></svg>`;
    return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}

function thumbFallback(img, type) {
    img.onerror = null;   // evita bucles si el placeholder también fallara
    img.src = placeholderThumb(type);
}


function clearInput() {
    document.getElementById('urlInput').value = '';
    handleUrlInputChange();
}

function toggleDrawer(show) {
    const drawer = document.getElementById('sideDrawer');
    if (show) drawer.classList.remove('hidden');
    else drawer.classList.add('hidden');
}

function toggleNotifications() {
    const panel = document.getElementById('notifPanel');
    const backdrop = document.getElementById('notifBackdrop');
    if (panel.classList.contains('hidden')) {
        panel.classList.remove('hidden');
        backdrop.classList.remove('hidden');
    } else {
        closeNotifications();
    }
}

function closeNotifications() {
    document.getElementById('notifPanel').classList.add('hidden');
    document.getElementById('notifBackdrop').classList.add('hidden');
}

function markAllRead() {
    const badge = document.getElementById('notifBadge');
    if (badge) badge.classList.add('hidden');
}

function switchTab(tab) {
    const btnDownloader = document.getElementById('tabBtnDownloader');
    const btnGallery = document.getElementById('tabBtnGallery');
    const secDownloader = document.getElementById('secDownloader');
    const secGallery = document.getElementById('secGallery');

    if (tab === 'downloader') {
        secDownloader.classList.remove('hidden');
        secGallery.classList.add('hidden');
        btnDownloader.className = "flex-1 py-2.5 rounded-xl font-bold text-sm transition-all cd-grad-bg text-white shadow-lg";
        btnGallery.className = "flex-1 py-2.5 rounded-xl font-bold text-sm transition-all text-gray-400 hover:text-white";
    } else {
        secDownloader.classList.add('hidden');
        secGallery.classList.remove('hidden');
        btnGallery.className = "flex-1 py-2.5 rounded-xl font-bold text-sm transition-all cd-grad-bg text-white shadow-lg";
        btnDownloader.className = "flex-1 py-2.5 rounded-xl font-bold text-sm transition-all text-gray-400 hover:text-white";
    }
}

async function pasteClipboard() {
    const input = document.getElementById('urlInput');
    try {
        const text = (await navigator.clipboard.readText()).trim();
        if (text) { input.value = text; handleUrlInputChange(); }
    } catch (e) { input.focus(); }   // sin permiso del portapapeles: pegado manual
}

// ===== Calidades y formatos (la tarjeta de resultado se arma con esta lista) =====
let currentMedia = null;   // { platform, url, title, author, thumb, formats: [...] }
const PLATFORM_NAMES = { tiktok: 'TikTok', instagram: 'Instagram', youtube: 'YouTube', pinterest: 'Pinterest', x: 'X' };
const VIDEO_TIERS = [['v2160', '4K', 18], ['v1080', '1080p', 5], ['v720', '720p', 2.5], ['v480', '480p', 1.2]];   // [id, etiqueta, Mbps aprox.]
const AUDIO_TIERS = [['a320', 'MP3 320 kbps', 320], ['a128', 'MP3 128 kbps', 128]];
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtMB = b => (b / 1e6 < 10 ? (b / 1e6).toFixed(1) : Math.round(b / 1e6)) + ' MB';

// Modo simulado: pesos estimados con una duración aleatoria (con la API real el servidor envía el tamaño en bytes).
// Supuesto: 4K solo en videos de YouTube; Shorts, TikTok, Instagram, Pinterest y X llegan hasta 1080p.
function simulatedFormats(platform, short) {
    const [lo, hi] = { tiktok: [15, 60], instagram: [10, 90], youtube: [60, 300], pinterest: [8, 45], x: [10, 120] }[platform] || [15, 90];
    const dur = lo + Math.random() * (hi - lo), f = [];
    if (platform !== 'youtube') f.push({ id: 'photo', type: 'photo', label: 'Foto HD', ext: 'JPG', size: (0.6 + Math.random() * 3) * 1e6 });
    if (platform === 'pinterest') f.push({ id: 'gif', type: 'photo', label: 'GIF', ext: 'GIF', size: (2 + Math.random() * 7) * 1e6 });
    VIDEO_TIERS.slice(platform === 'youtube' && !short ? 0 : 1).forEach(([id, label, mbps]) => f.push({ id, type: 'video', label, ext: 'MP4', size: mbps * 1e6 / 8 * dur }));
    AUDIO_TIERS.forEach(([id, label, kbps]) => f.push({ id, type: 'audio', label, ext: 'MP3', size: kbps * 1000 / 8 * dur }));
    return f;
}

// Contrato esperado: POST DOWNLOAD_API { url } → { title, author, thumb, formats: [{ id, type: 'video'|'audio'|'photo', label, ext, size (bytes), fileUrl }] }
async function extractInfo(url, platform, short) {
    if (!DOWNLOAD_API) {
        const names = { tiktok: 'Clip de TikTok', instagram: 'Reel de Instagram', youtube: 'Video de YouTube', pinterest: 'Pin de Pinterest', x: 'Video de X' };
        const thumb = 'https://images.unsplash.com/' + (platform === 'pinterest' ? 'photo-1534447677768-be436bb09401' : 'photo-1618005182384-a83a8bd57fbe') + '?w=300';
        return { title: (names[platform] || 'Archivo') + ' #' + Math.floor(Math.random() * 100), author: '@usuario', thumb, formats: simulatedFormats(platform, short) };
    }
    return apiExtract(url);
}

function renderFormats(m) {
    document.getElementById('resThumb').src = m.thumb || placeholderThumb('video');
    document.getElementById('resTitle').textContent = m.title;
    document.getElementById('resAuthor').textContent = (m.author || '') + ' • ' + (m.short ? 'YouTube Shorts' : PLATFORM_NAMES[m.platform] || 'Enlace');
    const groups = [['video', 'fa-video', 'Video'], ['audio', 'fa-music', 'Audio'], ['photo', 'fa-image', 'Foto / GIF']];
    document.getElementById('formatList').innerHTML = groups.map(([type, icon, name]) => {
        const list = m.formats.filter(f => f.type === type);
        if (!list.length) return '';
        const btns = list.map(f => `<button data-fmt="${esc(f.id)}" class="cd-fmt"><span class="font-bold text-xs">${esc(f.label)}</span><span class="text-[10px] text-gray-400">${esc(f.ext || '')} · ${f.size ? fmtMB(f.size) : '—'}</span></button>`).join('');
        return `<div><div class="text-[10px] font-bold uppercase text-gray-500 tracking-wider mb-1.5"><i class="fa-solid ${icon} mr-1"></i>${name}</div><div class="grid grid-cols-2 gap-2">${btns}</div></div>`;
    }).join('');
}

document.getElementById('formatList').addEventListener('click', e => {
    const b = e.target.closest('[data-fmt]');
    if (b) saveToGallery(b.dataset.fmt);
});

async function processDownload() {
    const url = document.getElementById('urlInput').value.trim();
    if (!url) { alert("Por favor pega un enlace primero."); return; }
    const platform = detectPlatform(url), short = /youtube\.com\/shorts\//i.test(url);
    if (DOWNLOAD_API && platform === 'default') { alert('Plataforma no soportada. Usa un enlace de TikTok, Instagram, YouTube, X o Pinterest.'); return; }
    const resCard = document.getElementById('resultCard');
    document.getElementById('resTitle').textContent = 'Analizando enlace…';
    document.getElementById('resAuthor').textContent = '';
    document.getElementById('formatList').innerHTML = '';
    resCard.classList.remove('hidden');
    resCard.scrollIntoView({ behavior: 'smooth' });
    const slow = DOWNLOAD_API ? setTimeout(() => { document.getElementById('resTitle').textContent = 'Esto está tardando: el servidor puede estar despertando (hasta 1 minuto)…'; }, 6000) : 0;
    try {
        currentMedia = { ...(await extractInfo(url, platform, short)), platform, url, short };
        renderFormats(currentMedia);
    } catch (e) {
        resCard.classList.add('hidden');
        alert('No se pudo analizar el enlace: ' + e.message);
    } finally { clearTimeout(slow); }
}

// ===== Descargador: estructura lista para la API real =====
// Cada formato trae su fileUrl (enlace directo al archivo). El servidor debe permitir CORS o entregarlo por proxy.
// ===== Conexión con el backend =====
// Producción: build.mjs reemplaza API_BASE con CLIPDROP_API (https://api.tudominio.com). Vacío = modo simulado.
// Desarrollo: en localhost puedes probar con  ?api=http://localhost:8787  sin recompilar (se ignora en otros dominios).
// Contrato:  POST {API}/extract { url } → { title, author, thumb, formats: [{ id, type, label, ext, size, fileUrl }] }
//            GET  fileUrl → binario (mismo origen que la API; CORS habilitado; sin compresión para que el progreso sea exacto)
const API_BASE = '';
const DOWNLOAD_API = ((['localhost', '127.0.0.1'].includes(location.hostname) && new URLSearchParams(location.search).get('api')) || API_BASE).replace(/\/+$/, '');
const API_ERRORS = { 400: 'El enlace no es válido.', 404: 'El contenido no existe o es privado.', 410: 'El contenido ya no está disponible.', 413: 'El archivo es demasiado grande.', 429: 'Demasiadas solicitudes. Espera un minuto e inténtalo de nuevo.' };

// Si el backend responde con { message }, se muestra ese texto; si no, el mensaje genérico del estado HTTP
async function apiErrorFrom(res) {
    const b = await res.json().catch(() => ({}));
    return b && b.message ? new Error(b.message) : apiError(res.status);
}

function apiError(status) {
    return new Error(API_ERRORS[status] || (status >= 500 ? 'El servidor no pudo procesar el enlace. Inténtalo más tarde.' : 'Error de red (' + status + ').'));
}

// Solo se descargan archivos del propio backend (el servidor actúa como proxy con CORS)
function trustedFileUrl(u) {
    try { return new URL(u, DOWNLOAD_API + '/').origin === new URL(DOWNLOAD_API).origin; } catch (e) { return false; }
}

async function apiExtract(url) {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 70000);
    try {
        const res = await fetch(DOWNLOAD_API + '/extract', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }), signal: ctl.signal, credentials: 'omit' });
        if (!res.ok) throw await apiErrorFrom(res);
        const d = await res.json();
        const formats = (Array.isArray(d.formats) ? d.formats : [])
            .filter(f => f && ['video', 'audio', 'photo'].includes(f.type) && f.id && f.fileUrl && trustedFileUrl(f.fileUrl))
            .map(f => ({ id: String(f.id), type: f.type, label: String(f.label || f.id), ext: String(f.ext || ''), size: Number(f.size) || 0, fileUrl: new URL(f.fileUrl, DOWNLOAD_API + '/').href }));
        if (!formats.length) throw new Error('No hay formatos disponibles para este enlace.');
        return { title: String(d.title || 'Sin título'), author: String(d.author || ''), thumb: /^https:\/\//.test(d.thumb || '') ? d.thumb : '', formats };
    } catch (e) {
        throw e.name === 'AbortError' ? new Error('El servidor tardó demasiado en responder.') : e;
    } finally { clearTimeout(timer); }
}

let downloading = false;

function setDlStatus(t, cancellable) {
    const el = document.getElementById('dlStatus');
    el.innerHTML = esc(t) + (t && cancellable ? ' <button data-action="cancelDownload" class="ml-2 underline text-red-400">Cancelar</button>' : '');
    el.classList.toggle('hidden', !t);
}

// Descarga por streaming y guarda cada parte en la store "parts" a medida que llega: en memoria solo hay
// una parte a la vez (no el archivo completo). Mientras se escribe no se lee más red (contrapresión).
// Devuelve { id, parts, size, mime }. Para probar varias partes con archivos pequeños, baja PART_SIZE (p. ej. 256 * 1024).
const PART_SIZE = 8 * 1024 * 1024;
let downloadCtl = null;

async function fetchToStore(fileUrl, onProgress, signal) {
    if (!trustedFileUrl(fileUrl)) throw new Error('Origen de archivo no permitido.');
    const res = await fetch(fileUrl, { credentials: 'omit', signal });
    if (!res.ok) throw await apiErrorFrom(res);
    const id = Date.now(), mime = res.headers.get('Content-Type') || '';
    const total = Number(res.headers.get('Content-Length')) || 0;
    let n = 0, size = 0, buf = [], bufSize = 0;
    const flush = async () => {
        if (!bufSize) return;
        await tx('parts', 'readwrite', s => s.put({ id, n: n++, blob: new Blob(buf) }));
        buf = []; bufSize = 0;
    };
    try {
        if (res.body && res.body.getReader) {
            const reader = res.body.getReader();
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                buf.push(value); bufSize += value.length; size += value.length;
                if (bufSize >= PART_SIZE) await flush();
                onProgress(total ? size / total : null);
            }
            await flush();
        } else {   // navegador sin streams: el cuerpo llega completo y se corta en partes
            const whole = await res.blob();
            for (let o = 0; o < whole.size; o += PART_SIZE) {
                await tx('parts', 'readwrite', s => s.put({ id, n: n++, blob: whole.slice(o, o + PART_SIZE) }));
                onProgress(Math.min(1, (o + PART_SIZE) / whole.size));
            }
            size = whole.size;
        }
        if (!size) throw new Error('El servidor devolvió un archivo vacío.');
        return { id, parts: n, size, mime };
    } catch (e) {
        await dbDeleteParts(id).catch(() => {});   // sin partes huérfanas si falla o se cancela
        throw e;
    }
}

async function hasRoom(bytes) {   // evita empezar una descarga que no cabe en el almacenamiento del navegador
    try { const { quota, usage } = await navigator.storage.estimate(); return !quota || quota - usage > bytes * 1.1; } catch (e) { return true; }
}

function cancelDownload() { if (downloadCtl) downloadCtl.abort(); }

// Archivos de prueba reales (foto PNG, audio WAV, video grabado de un canvas) para probar el flujo completo sin API
function demoBlob(type) {
    if (type === 'photo') {
        const c = Object.assign(document.createElement('canvas'), { width: 720, height: 720 }), g = c.getContext('2d');
        const gr = g.createLinearGradient(0, 0, 720, 720); gr.addColorStop(0, '#22D3EE'); gr.addColorStop(1, '#A855F7');
        g.fillStyle = gr; g.fillRect(0, 0, 720, 720);
        g.fillStyle = '#fff'; g.font = 'bold 64px sans-serif'; g.textAlign = 'center'; g.fillText('ClipDrop', 360, 380);
        return new Promise(r => c.toBlob(r, 'image/png'));
    }
    if (type === 'audio') {   // WAV mono 16-bit, 1.5 s a 440 Hz
        const rate = 22050, n = rate * 1.5, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
        const str = (o, t) => [...t].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
        str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
        v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, n * 2, true);
        for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.sin(2 * Math.PI * 440 * i / rate) * 12000 * (1 - i / n), true);
        return Promise.resolve(new Blob([buf], { type: 'audio/wav' }));
    }
    return new Promise(resolve => {
        const c = Object.assign(document.createElement('canvas'), { width: 320, height: 180 }), g = c.getContext('2d');
        if (!c.captureStream || !window.MediaRecorder) return resolve(null);   // sin soporte: se guarda sin archivo
        const rec = new MediaRecorder(c.captureStream(15)), chunks = [];
        rec.ondataavailable = e => chunks.push(e.data);
        rec.onstop = () => resolve(new Blob(chunks, { type: rec.mimeType || 'video/webm' }));
        rec.start();
        let f = 0;
        const timer = setInterval(() => {
            g.fillStyle = `hsl(${f * 12},70%,45%)`; g.fillRect(0, 0, 320, 180);
            g.fillStyle = '#fff'; g.font = '24px sans-serif'; g.textAlign = 'center'; g.fillText('ClipDrop demo', 160, 98);
            if (++f > 20) { clearInterval(timer); rec.stop(); }
        }, 66);
    });
}

// Punto único para guardar: metadatos en "gallery" + Blob en "files" (misma transacción)
async function saveItem(meta, file) {   // file: Blob, o { id, parts, size, mime } si se guardó por partes
    const now = Date.now(), chunked = !!(file && file.parts);
    const id = chunked ? file.id : now;
    const item = { ...meta, id, createdAt: now, hasFile: !!file, mime: file ? (file.mime || file.type || '') : '', size: file ? file.size : 0 };
    try {
        await txn(['gallery', 'files'], 'readwrite', t => {
            t.objectStore('gallery').put(item);
            if (chunked) t.objectStore('files').put({ id, parts: file.parts, mime: file.mime });   // manifiesto: los datos ya están en "parts"
            else if (file) t.objectStore('files').put({ id, blob: file });
        });
    } catch (e) {
        if (chunked) { await dbDeleteParts(id).catch(() => {}); throw e; }
        persistError(e); if (file) item.blob = file;   // sin BD: el archivo queda solo en memoria
    }
    galleryItems.unshift(item);
    renderGallery(currentGalleryFilter);
    return item;
}

async function saveToGallery(formatId) {
    const m = currentMedia, f = m && m.formats.find(x => x.id === formatId);
    if (!f || downloading) return;
    if (f.fileUrl && f.size && !(await hasRoom(f.size))) { alert('No hay espacio suficiente en el dispositivo para este archivo.'); return; }
    if (f.size > 200e6 && !confirm('Este archivo pesa ' + fmtMB(f.size) + ' y puede consumir datos y espacio. ¿Continuar?')) return;
    downloading = true;
    downloadCtl = new AbortController();
    try {
        setDlStatus('Preparando…', true);
        const file = f.fileUrl
            ? await fetchToStore(f.fileUrl, p => setDlStatus(p == null ? 'Descargando…' : 'Descargando ' + Math.round(p * 100) + '%', true), downloadCtl.signal)
            : await demoBlob(f.type);
        setDlStatus('Guardando en el dispositivo…');
        await saveItem({ type: f.type, title: m.title + ' (' + f.label + ')', thumb: m.thumb || placeholderThumb(f.type), source: m.url, quality: f.label, ext: f.ext }, file);
        switchTab('gallery');
    } catch (e) {
        if (e.name !== 'AbortError') { console.warn(e); alert('No se pudo completar la descarga: ' + e.message); }
    } finally { downloading = false; downloadCtl = null; setDlStatus(''); }
}

function setGalleryLayout(layout) {
    galleryLayout = layout;
    const gridBtn = document.getElementById('layoutGridBtn');
    const listBtn = document.getElementById('layoutListBtn');

    if(layout === 'grid') {
        gridBtn.className = "px-2.5 py-1 rounded-lg cd-grad-bg text-white font-bold";
        listBtn.className = "px-2.5 py-1 rounded-lg text-gray-400 hover:text-white font-bold";
    } else {
        listBtn.className = "px-2.5 py-1 rounded-lg cd-grad-bg text-white font-bold";
        gridBtn.className = "px-2.5 py-1 rounded-lg text-gray-400 hover:text-white font-bold";
    }
    renderGallery(currentGalleryFilter);
}

function renderGallery(filter) {
    const container = document.getElementById('galleryContainer');
    container.innerHTML = '';

    const filtered = filter === 'all' ? galleryItems : galleryItems.filter(i => i.type === filter);

    if (filtered.length === 0) {
        container.className = "grid grid-cols-1";
        container.innerHTML = `<p class="text-center text-xs text-gray-500 py-12">No hay archivos guardados en esta categoría.</p>`;
        return;
    }

    if(galleryLayout === 'grid') {
        container.className = "grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3";
    } else {
        container.className = "grid grid-cols-1 gap-2.5";
    }

    filtered.forEach((item, index) => {
        const card = document.createElement('div');

        let iconClass = 'fa-solid fa-video text-brand-accent';
        if(item.type === 'audio') iconClass = 'fa-solid fa-music text-brand-cyan';
        if(item.type === 'photo') iconClass = 'fa-solid fa-image text-purple-400';

        if(galleryLayout === 'grid') {
            card.className = "glass-panel p-2.5 rounded-2xl border border-brand-border space-y-2 relative group";
            card.innerHTML = `
                <div class="relative aspect-square rounded-xl overflow-hidden bg-black">
                    <img src="${item.thumb}" loading="lazy" data-fallback="${item.type}" class="w-full h-full object-cover">
                    <div class="absolute top-1.5 left-1.5 px-2 py-0.5 rounded-md bg-black/60 backdrop-blur-sm text-[10px] font-bold text-white uppercase">
                        <i class="${iconClass} mr-1"></i> ${item.type}
                    </div>

                    <!-- 3-DOTS ACTION BUTTON (⋮) -->
                    <div class="absolute top-1.5 right-1.5">
                        <button data-action="toggleCardMenu" data-arg="${item.id}" class="w-6 h-6 rounded-lg bg-black/70 text-white flex items-center justify-center hover:bg-brand-accent hover:text-black transition-all">
                            <i class="fa-solid fa-ellipsis-vertical text-xs"></i>
                        </button>
                        <div id="cardMenu-${item.id}" class="hidden absolute right-0 top-7 w-32 bg-brand-dark border border-brand-border rounded-xl shadow-xl p-1 z-20 space-y-0.5">
                            <button data-action="playFromMenu" data-arg="${item.id}" class="w-full px-2 py-1.5 text-left text-[11px] font-medium text-gray-200 hover:bg-brand-border rounded-lg flex items-center gap-1.5">
                                <i class="fa-solid ${item.type === 'photo' ? 'fa-crop-simple' : 'fa-play'} text-[10px]"></i> ${item.type === 'photo' ? 'Recortar' : 'Reproducir'}
                            </button>
                            <button data-action="redownload" data-arg="${item.id}" class="w-full px-2 py-1.5 text-left text-[11px] font-medium text-amber-400 hover:bg-brand-border rounded-lg flex items-center gap-1.5">
                                <i class="fa-solid fa-arrow-down text-[10px]"></i> Re-descargar
                            </button>
                            <button data-action="deleteGalleryItem" data-arg="${item.id}" class="w-full px-2 py-1.5 text-left text-[11px] font-medium text-red-400 hover:bg-brand-border rounded-lg flex items-center gap-1.5">
                                <i class="fa-solid fa-trash text-[10px]"></i> Eliminar
                            </button>
                        </div>
                    </div>
                </div>
                <h4 class="font-bold text-xs line-clamp-1">${item.title}</h4>
                <button data-action="playMedia" data-arg="${item.id}" class="w-full py-1.5 bg-brand-border hover:bg-gray-700 text-xs font-semibold rounded-lg transition-all flex items-center justify-center gap-1">
                    <i class="fa-solid ${item.type === 'photo' ? 'fa-crop-simple' : 'fa-play'} text-[10px]"></i> ${item.type === 'photo' ? 'Ver / Recortar' : 'Reproducir'}
                </button>
            `;
        } else {
            card.className = "glass-panel p-3 rounded-2xl border border-brand-border flex items-center justify-between gap-3";
            card.innerHTML = `
                <div class="flex items-center gap-3">
                    <img src="${item.thumb}" loading="lazy" data-fallback="${item.type}" class="w-12 h-12 rounded-xl object-cover">
                    <div>
                        <h4 class="font-bold text-xs">${item.title}</h4>
                        <span class="text-[10px] text-gray-400 uppercase"><i class="${iconClass} mr-1"></i> ${item.type}</span>
                    </div>
                </div>
                <div class="flex items-center gap-2">
                    <button data-action="playMedia" data-arg="${item.id}" class="px-3 py-1.5 bg-brand-border hover:bg-gray-700 text-xs font-semibold rounded-xl">
                        ${item.type === 'photo' ? 'Recortar' : 'Reproducir'}
                    </button>
                    <button data-action="deleteGalleryItem" data-arg="${item.id}" class="p-2 text-red-400 hover:bg-brand-border rounded-xl">
                        <i class="fa-solid fa-trash text-xs"></i>
                    </button>
                </div>
            `;
        }
        container.appendChild(card);

        // Insert a native-like ad banner in the gallery every 3 items for free users
        if ((index + 1) % 3 === 0 && index < filtered.length - 1) {
            const adCard = document.createElement('div');
            adCard.className = "col-span-full p-3 bg-brand-card/60 rounded-2xl border border-amber-500/20 flex items-center justify-between text-xs";
            adCard.innerHTML = `
                <div class="flex items-center gap-2.5">
                    <span class="px-2 py-0.5 bg-amber-500/20 text-amber-400 text-[9px] font-bold rounded">PATROCINADO</span>
                    <span class="text-gray-300 font-medium">Pack de transiciones para editores v2.0 disponible</span>
                </div>
                <button data-action="openUltraModal" class="text-brand-accent hover:underline font-bold text-[11px]">Ver más</button>
            `;
            container.appendChild(adCard);
        }
    });
}

function toggleCardMenu(id) {
    const menu = document.getElementById(`cardMenu-${id}`);
    if (menu) menu.classList.toggle('hidden');
}

function deleteGalleryItem(id) {
    galleryItems = galleryItems.filter(i => i.id !== id);
    dbDelete([id]).catch(persistError);
    renderGallery(currentGalleryFilter);
}

function promptClearGallery() {
    const confirmText = document.getElementById('confirmClearText');
    if (currentGalleryFilter === 'all') {
        confirmText.innerHTML = "Se eliminarán <strong class='text-red-400'>TODOS los archivos</strong> de tu galería (videos, audios e imágenes).";
    } else if (currentGalleryFilter === 'video') {
        confirmText.innerHTML = "Se eliminarán <strong class='text-red-400'>únicamente los VIDEOS</strong>. Tus audios e imágenes se mantendrán a salvo.";
    } else if (currentGalleryFilter === 'audio') {
        confirmText.innerHTML = "Se eliminarán <strong class='text-red-400'>únicamente los AUDIOS</strong>. Tus videos e imágenes se mantendrán a salvo.";
    } else if (currentGalleryFilter === 'photo') {
        confirmText.innerHTML = "Se eliminarán <strong class='text-red-400'>únicamente las IMÁGENES y FOTOS</strong>. Tus videos y audios se mantendrán a salvo.";
    }
    document.getElementById('confirmClearModal').classList.remove('hidden');
}

function executeCategoryClear() {
    const removed = galleryItems.filter(i => currentGalleryFilter === 'all' || i.type === currentGalleryFilter).map(i => i.id);
    dbDelete(removed).catch(persistError);
    if (currentGalleryFilter === 'all') {
        galleryItems = [];
    } else {
        galleryItems = galleryItems.filter(i => i.type !== currentGalleryFilter);
    }
    renderGallery(currentGalleryFilter);
    closeModal('confirmClearModal');
}

function filterGallery(type) {
    currentGalleryFilter = type;
    const btnText = document.getElementById('clearGalleryBtnText');

    if (type === 'all') btnText.innerText = 'Vaciar Galería Completa';
    else if (type === 'video') btnText.innerText = 'Vaciar Solo Videos';
    else if (type === 'audio') btnText.innerText = 'Vaciar Solo Audios';
    else if (type === 'photo') btnText.innerText = 'Vaciar Solo Fotos';

    ['fAll', 'fVideo', 'fAudio', 'fPhoto'].forEach(id => {
        const btn = document.getElementById(id);
        if(btn) btn.className = "px-3 py-1 rounded-lg font-semibold text-gray-400 hover:text-white";
    });
    if(type === 'all') document.getElementById('fAll').className = "px-3 py-1 rounded-lg font-semibold cd-grad-bg text-white";
    if(type === 'video') document.getElementById('fVideo').className = "px-3 py-1 rounded-lg font-semibold cd-grad-bg text-white";
    if(type === 'audio') document.getElementById('fAudio').className = "px-3 py-1 rounded-lg font-semibold cd-grad-bg text-white";
    if(type === 'photo') document.getElementById('fPhoto').className = "px-3 py-1 rounded-lg font-semibold cd-grad-bg text-white";

    renderGallery(type);
}

let currentObjectUrl = null;

// Libera el Blob del modal (object URL) para no acumular memoria
function releaseMedia() {
    if (currentObjectUrl) { URL.revokeObjectURL(currentObjectUrl); currentObjectUrl = null; }
    ['mainVideo', 'mainAudio'].forEach(id => { const m = document.getElementById(id); m.removeAttribute('src'); m.load(); });
    document.getElementById('cropTargetImg').removeAttribute('src');
}

async function playMedia(id) {
    const item = galleryItems.find(i => i.id === id);
    if (!item) return;
    releaseMedia();
    document.getElementById('mediaTitle').innerText = item.title;
    ['videoPlayerBox', 'audioPlayerBox', 'photoCropperBox'].forEach(b => document.getElementById(b).classList.add('hidden'));

    let blob = item.blob || null;   // item.blob solo existe si la BD falló al guardar
    try { if (!blob && item.hasFile) blob = await dbGetFile(item.id); } catch (e) { persistError(e); }
    const src = blob ? (currentObjectUrl = URL.createObjectURL(blob)) : null;
    document.getElementById('mediaNote').classList.toggle('hidden', !!src || item.type === 'photo');

    if (item.type === 'video') {
        const v = document.getElementById('mainVideo');
        v.poster = item.thumb || '';
        if (src) v.src = src;
        document.getElementById('videoPlayerBox').classList.remove('hidden');
    } else if (item.type === 'audio') {
        if (src) document.getElementById('mainAudio').src = src;
        document.getElementById('audioPlayerBox').classList.remove('hidden');
    } else {
        const img = document.getElementById('cropTargetImg');
        img.onerror = () => thumbFallback(img, 'photo');
        img.crossOrigin = 'anonymous';   // permite exportar el canvas también con imágenes remotas (si el servidor lo permite)
        img.src = src || item.thumb;   // sin archivo: usa la miniatura
        crop.item = item;
        document.getElementById('photoCropperBox').classList.remove('hidden');
    }
    document.getElementById('mediaModal').classList.remove('hidden');
    if (item.type === 'photo') setRatio('1:1');   // el modal ya es visible: se pueden medir las cajas
}

// ===== Recorte real: 1:1, 9:16 y 16:9 con encuadre arrastrable; se guarda como un elemento nuevo =====
const RATIOS = { '1:1': [1, 1], '9:16': [9, 16], '16:9': [16, 9] };
const crop = { key: '1:1', px: .5, py: .5, item: null };   // px/py: posición del encuadre (0–1)

function layoutCrop() {
    const [w, h] = RATIOS[crop.key], box = document.getElementById('cropBox');
    const bw = Math.min(document.getElementById('cropArea').clientWidth - 16, Math.min(window.innerHeight * 0.5, 380) * w / h);
    box.style.width = bw + 'px'; box.style.height = (bw * h / w) + 'px';
    document.getElementById('cropTargetImg').style.objectPosition = `${crop.px * 100}% ${crop.py * 100}%`;
}

function setRatio(key) {
    crop.key = key; crop.px = crop.py = .5;
    document.querySelectorAll('#ratioBtns button').forEach(b => {
        b.className = 'shrink-0 px-2.5 py-1 rounded-lg text-xs font-semibold ' + (b.dataset.ratio === key ? 'cd-grad-bg text-white' : 'bg-brand-border');
    });
    layoutCrop();
}

(() => {   // arrastrar para mover el encuadre
    const box = document.getElementById('cropBox'), img = document.getElementById('cropTargetImg');
    let last = null;
    box.addEventListener('pointerdown', e => { last = [e.clientX, e.clientY]; box.setPointerCapture(e.pointerId); });
    box.addEventListener('pointermove', e => {
        if (!last || !img.naturalWidth) return;
        const bw = box.clientWidth, bh = box.clientHeight, k = Math.max(bw / img.naturalWidth, bh / img.naturalHeight);
        const ox = img.naturalWidth * k - bw, oy = img.naturalHeight * k - bh;   // sobrante en cada eje
        if (ox > 1) crop.px = Math.min(1, Math.max(0, crop.px - (e.clientX - last[0]) / ox));
        if (oy > 1) crop.py = Math.min(1, Math.max(0, crop.py - (e.clientY - last[1]) / oy));
        last = [e.clientX, e.clientY];
        img.style.objectPosition = `${crop.px * 100}% ${crop.py * 100}%`;
    });
    ['pointerup', 'pointercancel'].forEach(t => box.addEventListener(t, () => { last = null; }));
})();

async function saveCrop() {
    const img = document.getElementById('cropTargetImg'), it = crop.item;
    if (!it || !img.naturalWidth) return;
    try {
        const [rw, rh] = RATIOS[crop.key], iw = img.naturalWidth, ih = img.naturalHeight;
        const cw = Math.min(iw, ih * rw / rh), ch = cw * rh / rw;   // mayor región de esa proporción que cabe en la imagen
        const sx = (iw - cw) * crop.px, sy = (ih - ch) * crop.py;
        const k = Math.min(1, 2160 / Math.max(cw, ch));
        const c = Object.assign(document.createElement('canvas'), { width: Math.round(cw * k), height: Math.round(ch * k) });
        c.getContext('2d').drawImage(img, sx, sy, cw, ch, 0, 0, c.width, c.height);
        const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.92));
        const tk = 300 / Math.max(c.width, c.height);   // miniatura incrustada: funciona sin conexión
        const t = Object.assign(document.createElement('canvas'), { width: Math.round(c.width * tk), height: Math.round(c.height * tk) });
        t.getContext('2d').drawImage(c, 0, 0, t.width, t.height);
        await saveItem({ type: 'photo', title: it.title + ' (' + crop.key + ')', thumb: t.toDataURL('image/jpeg', 0.7), source: it.source || '', quality: crop.key, ext: 'JPG' }, blob);
        closeModal('mediaModal');
    } catch (e) {
        console.warn(e);
        alert('No se pudo recortar esta imagen.');
    }
}

function selectPlan(plan) {
    document.getElementById('radioWeekly').checked = (plan === 'weekly');
    document.getElementById('radioMonthly').checked = (plan === 'monthly');
    document.getElementById('radioAnnual').checked = (plan === 'annual');

    document.getElementById('planWeekly').className = plan === 'weekly' ? "p-3.5 bg-brand-dark rounded-2xl border-2 border-amber-400 cursor-pointer transition-all flex items-center justify-between" : "p-3.5 bg-brand-dark rounded-2xl border border-brand-border cursor-pointer hover:border-amber-400/50 transition-all flex items-center justify-between";
    document.getElementById('planMonthly').className = plan === 'monthly' ? "p-3.5 bg-brand-dark rounded-2xl border-2 border-amber-400 relative cursor-pointer shadow-lg shadow-amber-500/10 transition-all flex items-center justify-between" : "p-3.5 bg-brand-dark rounded-2xl border border-brand-border relative cursor-pointer hover:border-amber-400/50 transition-all flex items-center justify-between";
    document.getElementById('planAnnual').className = plan === 'annual' ? "p-3.5 bg-brand-dark rounded-2xl border-2 border-emerald-400 relative cursor-pointer shadow-lg shadow-emerald-500/10 transition-all flex items-center justify-between" : "p-3.5 bg-brand-dark rounded-2xl border border-brand-border relative cursor-pointer hover:border-amber-400/50 transition-all flex items-center justify-between";
}

function openHistoryModal() { document.getElementById('historyModal').classList.remove('hidden'); }
function openUltraModal() { document.getElementById('ultraModal').classList.remove('hidden'); }
function openTutorialModal() { document.getElementById('tutorialModal').classList.remove('hidden'); }
function openFaqModal() { document.getElementById('faqModal').classList.remove('hidden'); }
function openFeedbackModal() { document.getElementById('feedbackModal').classList.remove('hidden'); }
function openRatingModal() { document.getElementById('ratingModal').classList.remove('hidden'); }

function closeModal(id) {
    document.getElementById(id).classList.add('hidden');
    if (id === 'mediaModal') {
        document.getElementById('mainVideo').pause();
        document.getElementById('mainAudio').pause();
        releaseMedia();
    }
}

function submitFeedback() {
    const text = document.getElementById('feedbackText').value;
    if(!text.trim()) return;
    alert("¡Muchas gracias por tus comentarios!");
    document.getElementById('feedbackText').value = '';
    closeModal('feedbackModal');
}

function setRating(stars) {
    const starBtns = document.querySelectorAll('.star-btn');
    starBtns.forEach((btn, idx) => {
        btn.className = idx < stars ? "fa-solid fa-star cursor-pointer hover:scale-125 transition-all star-btn text-amber-400" : "fa-regular fa-star cursor-pointer hover:scale-125 transition-all star-btn text-amber-400";
    });
}

function shareApp() {
    if (navigator.share) {
        navigator.share({
            title: 'ClipDrop Web App',
            text: 'Descarga videos sin marca de agua, audios y carruseles en HD.',
            url: window.location.href,
        });
    } else {
        alert("Enlace copiado al portapapeles para compartir.");
    }
}
// ===== PWA: Service Worker + botón "Instalar app" =====
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js').catch(err => console.warn('Service Worker no registrado:', err));
    });
}

let deferredInstall = null;
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);

function toggleInstallBtn(show) {
    document.getElementById('installBtn').classList.toggle('hidden', !show);
}

window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();            // guardamos el evento y lo lanzamos desde nuestro botón
    deferredInstall = e;
    toggleInstallBtn(!isStandalone());
});
window.addEventListener('appinstalled', () => { deferredInstall = null; toggleInstallBtn(false); });
if (isIOS && !isStandalone()) toggleInstallBtn(true);   // iOS no dispara beforeinstallprompt

async function installApp() {
    if (deferredInstall) {
        deferredInstall.prompt();
        await deferredInstall.userChoice;
        deferredInstall = null;
        toggleInstallBtn(false);
    } else {
        alert('Para instalar: toca Compartir y luego "Añadir a pantalla de inicio".');
    }
}

// Atajo del ícono (manifest → shortcuts): abre directo la galería
if (new URLSearchParams(location.search).get('tab') === 'gallery') switchTab('gallery');

// ===== Eventos: delegación por data-action (sin atributos on*; la CSP prohíbe scripts en línea) =====
// Uso en el HTML:  <button data-action="closeModal" data-arg="faqModal">
//   data-arg → único argumento (número, true/false o texto) · data-close-drawer → cierra el menú antes · data-close-modal="id" → cierra ese modal después
const ACTIONS = {
    switchTab, toggleDrawer, closeModal, openUltraModal, openTutorialModal, openRatingModal, openHistoryModal, openFeedbackModal, openFaqModal, toggleNotifications, closeNotifications, markAllRead, shareApp, installApp, filterGallery, setGalleryLayout, promptClearGallery, executeCategoryClear, playMedia, deleteGalleryItem, toggleCardMenu, setRatio, saveCrop, setRating, submitFeedback, selectPlan, processDownload, pasteClipboard, clearInput, cancelDownload,
    openLink: url => window.open(url, '_blank', 'noopener'),
    redownload: id => { alert('Iniciando re-descarga...'); if (id !== undefined) toggleCardMenu(id); },
    subscribe: () => alert('Iniciando suscripción elegida...'),
    playFromMenu: id => { playMedia(id); toggleCardMenu(id); }
};
const parseArg = v => v === undefined ? undefined : v === 'true' ? true : v === 'false' ? false : /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v;

document.addEventListener('click', e => {
    const el = e.target.closest('[data-action]');
    if (!el || !ACTIONS.hasOwnProperty(el.dataset.action)) return;
    if ('closeDrawer' in el.dataset) toggleDrawer(false);
    ACTIONS[el.dataset.action](parseArg(el.dataset.arg));
    if (el.dataset.closeModal) closeModal(el.dataset.closeModal);
});

document.getElementById('urlInput').addEventListener('input', handleUrlInputChange);

// 'error' no burbujea: se escucha en la fase de captura para las miniaturas con data-fallback
document.addEventListener('error', e => {
    const img = e.target;
    if (img.tagName === 'IMG' && img.dataset.fallback && !img.src.startsWith('data:')) thumbFallback(img, img.dataset.fallback);
}, true);
document.querySelectorAll('img[data-fallback]').forEach(img => {   // por si el error ocurrió antes de registrar el listener
    if (img.complete && !img.naturalWidth) thumbFallback(img, img.dataset.fallback);
});

// Con backend: calienta el servidor al abrir la app (los planes gratuitos lo duermen tras unos minutos sin uso).
// Sin backend: el chip muestra «· demo» para saber que se usan archivos de prueba.
if (DOWNLOAD_API) fetch(DOWNLOAD_API + '/health', { credentials: 'omit' }).catch(() => {});
else document.getElementById('platformChip').textContent += ' · demo';
