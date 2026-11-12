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
    galleryReady = true; galPickTab(); renderGallery(); backfillMeta();
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
    youtube: 'fa-brands fa-youtube text-red-500',
    shorts: 'fa-solid fa-bolt text-red-500',   // respaldo: el logo real se dibuja con SHORTS_SVG
    x: 'fa-brands fa-x-twitter text-white',
    pinterest: 'fa-brands fa-pinterest text-red-500',
    default: 'fa-solid fa-link'
};

const SHORTS_SVG = '<svg viewBox="0 0 24 24" class="inline-block w-4 h-4 fill-current text-red-500" aria-hidden="true"><path d="M17.77 10.32l-1.2-.5L18 9.06c1.84-.96 2.53-3.23 1.56-5.06s-3.24-2.53-5.07-1.56L6 6.94c-1.29.68-2.07 2.04-2 3.49.07 1.42.93 2.67 2.22 3.25.03.01 1.2.5 1.2.5L6 14.93c-1.83.97-2.53 3.24-1.56 5.07.97 1.83 3.24 2.53 5.07 1.56l8.5-4.5c1.29-.68 2.06-2.04 1.99-3.49-.07-1.42-.94-2.68-2.23-3.25zM10 14.65v-5.3L15 12l-5 2.65z"/></svg>';   // logo de YouTube Shorts (Font Awesome no lo incluye)
const platformIconHtml = (p) => (p === 'shorts' ? SHORTS_SVG : `<i class="${PLATFORM_ICONS[p]} text-sm"></i>`);

const CHIP_TEXT = { default: 'Soporta TikTok, IG, Shorts, YouTube, X y Pinterest' };

function detectPlatform(raw) {
    let u;
    try { u = new URL(/^https?:\/\//i.test(raw) ? raw : 'https://' + raw); }
    catch (e) { return 'default'; }
    const host = u.hostname.toLowerCase();
    if (/(^|\.)tiktok\.com$/.test(host)) return 'tiktok';
    if (/(^|\.)(instagram\.com|instagr\.am)$/.test(host)) return 'instagram';
    if (/(^|\.)(youtube\.com|youtu\.be)$/.test(host)) return /^\/shorts\//i.test(u.pathname) ? 'shorts' : 'youtube';   // YouTube Shorts tiene identidad propia
    if (/(^|\.)(x\.com|twitter\.com|t\.co)$/.test(host)) return 'x';
    if (/(^|\.)(pinterest\.[a-z]{2,3}(\.[a-z]{2})?|pin\.it)$/.test(host)) return 'pinterest';
    return 'default';
}

function handleUrlInputChange() {
    const raw = document.getElementById('urlInput').value.trim();
    document.getElementById('clearBtn').classList.toggle('hidden', !raw);
    const p = detectPlatform(raw);
    document.body.dataset.p = p;   // el CSS cambia --g1/--g2 según este valor
    document.getElementById('platformIcon').innerHTML = platformIconHtml(p);
    document.querySelectorAll('#platformRow [data-platform]').forEach((el) => el.classList.toggle('active', el.dataset.platform === p));
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
const PLATFORM_NAMES = { tiktok: 'TikTok', instagram: 'Instagram', youtube: 'YouTube', shorts: 'YouTube Shorts', pinterest: 'Pinterest', x: 'X' };
const VIDEO_TIERS = [['v2160', '4K', 18], ['v1080', '1080p', 5], ['v720', '720p', 2.5], ['v480', '480p', 1.2]];   // [id, etiqueta, Mbps aprox.]
const AUDIO_TIERS = [['a320', 'MP3 320 kbps', 320], ['a128', 'MP3 128 kbps', 128]];
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtMB = b => (b / 1e6 < 10 ? (b / 1e6).toFixed(1) : Math.round(b / 1e6)) + ' MB';

// Modo simulado: pesos estimados con una duración aleatoria (con la API real el servidor envía el tamaño en bytes).
// Supuesto: 4K solo en videos de YouTube; Shorts, TikTok, Instagram, Pinterest y X llegan hasta 1080p.
function simulatedFormats(platform, short) {
    const [lo, hi] = { tiktok: [15, 60], instagram: [10, 90], youtube: [60, 300], shorts: [15, 60], pinterest: [8, 45], x: [10, 120] }[platform] || [15, 90];
    const dur = lo + Math.random() * (hi - lo), f = [];
    if (!['youtube', 'shorts'].includes(platform)) f.push({ id: 'photo', type: 'photo', label: 'Foto HD', ext: 'JPG', size: (0.6 + Math.random() * 3) * 1e6 });
    if (platform === 'pinterest') f.push({ id: 'gif', type: 'photo', label: 'GIF', ext: 'GIF', size: (2 + Math.random() * 7) * 1e6 });
    VIDEO_TIERS.slice(platform === 'youtube' && !short ? 0 : 1).forEach(([id, label, mbps]) => f.push({ id, type: 'video', label, ext: 'MP4', size: mbps * 1e6 / 8 * dur }));
    AUDIO_TIERS.forEach(([id, label, kbps]) => f.push({ id, type: 'audio', label, ext: 'MP3', size: kbps * 1000 / 8 * dur }));
    return f;
}

// Contrato esperado: POST DOWNLOAD_API { url } → { title, author, thumb, formats: [{ id, type: 'video'|'audio'|'photo', label, ext, size (bytes), fileUrl }] }
async function extractInfo(url, platform, short) {
    if (!DOWNLOAD_API) {
        const names = { tiktok: 'Clip de TikTok', instagram: 'Reel de Instagram', youtube: 'Video de YouTube', shorts: 'Short de YouTube', pinterest: 'Pin de Pinterest', x: 'Video de X' };
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
    const platform = detectPlatform(url), short = platform === 'shorts';
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
        const yt = platform === 'youtube' || platform === 'shorts';   // YouTube suele bloquear a los servidores gratuitos
        alert('No se pudo analizar el enlace: ' + (yt && /bloque/i.test(e.message) ? 'YouTube está bloqueando al servidor en este momento. Prueba con TikTok, Instagram, X o Pinterest.' : e.message));
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
// La URL del backend también puede venir de config.js (se edita sin recompilar)
// Backend por defecto (tu servicio de Render): la app se conecta aunque config.js falte o no se haya subido.
// config.js puede cambiar la URL; window.CLIPDROP_API = '' fuerza el modo demo.
const DEFAULT_API = 'https://clipdrop-api-4pem.onrender.com';
const CFG_API = 'CLIPDROP_API' in window ? String(window.CLIPDROP_API || '').replace(/\/+$/, '') : DEFAULT_API;
const RUNTIME_API = /^https:\/\/[^\s/]+$/i.test(CFG_API) ? CFG_API : '';
const DOWNLOAD_API = ((['localhost', '127.0.0.1'].includes(location.hostname) && new URLSearchParams(location.search).get('api')) || API_BASE || RUNTIME_API).replace(/\/+$/, '');
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
        throw e.name === 'AbortError' ? new Error('El servidor tardó demasiado en responder.')
                : e instanceof TypeError ? new Error('No se pudo conectar con el servidor. Puede estar despertando o rechazar este sitio (revisa ALLOWED_ORIGINS en el backend).')
                : e;
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
    currentGalleryFilter = item.type; galShown = GAL_PAGE;
    renderGallery();
    enrichAndPersist(item);
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
        const saved = await saveItem({ type: f.type, title: m.title + ' (' + f.label + ')', thumb: m.thumb || placeholderThumb(f.type), source: m.url, quality: f.label, ext: f.ext, author: m.author || '' }, file);
        switchTab('gallery');
        if (await saveToDevice(saved)) toast('Guardado en la galería y en tu dispositivo ✔');
    } catch (e) {
        if (e.name !== 'AbortError') { console.warn(e); alert('No se pudo completar la descarga: ' + e.message); }
    } finally { downloading = false; downloadCtl = null; setDlStatus(''); }
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
        await saveItem({ type: 'photo', title: it.title + ' (' + crop.key + ')', thumb: t.toDataURL('image/jpeg', 0.7), source: it.source || '', quality: crop.key, ext: 'JPG', author: it.author || '' }, blob);
        closeModal('mediaModal');
        toast('Recorte guardado en la galería ✔');
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

// ===== Guardar en el dispositivo (carpeta Descargas) =====
const EXT_BY_MIME = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/mp4': 'm4a', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' };

function toast(msg) {   // aviso breve, sin bloquear la pantalla
    const el = document.createElement('div');
    el.className = 'fixed bottom-6 left-1/2 -translate-x-1/2 z-[70] max-w-[90vw] px-4 py-2.5 rounded-xl bg-brand-card border border-brand-border text-xs font-semibold text-white shadow-xl';
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 4500);
}

// Lleva un archivo de la galería al dispositivo. En iPhone, con un toque del usuario, abre la hoja de compartir (Guardar en Archivos / Fotos).
async function saveToDevice(item, viaGesture = false) {
    try {
        const blob = item.blob || (item.hasFile ? await dbGetFile(item.id) : null);
        if (!blob) { toast('Este elemento de ejemplo no tiene archivo para descargar.'); return false; }
        const ext = EXT_BY_MIME[String(blob.type).split(';')[0]] || String(item.ext || 'bin').toLowerCase();
        const name = (String(item.title || '').replace(/[\\/:*?"<>|]+/g, '').trim().slice(0, 90) || 'clipdrop') + '.' + ext;
        const file = new File([blob], name, { type: blob.type });
        if (viaGesture && isIOS && navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file] }); return true; }
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = name;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 120_000);
        return true;
    } catch (e) {
        if (e && e.name === 'AbortError') return false;   // el usuario cerró la hoja de compartir
        console.warn(e);
        toast('No se pudo guardar en el dispositivo. Prueba desde la galería: ⋮ → Descargar.');
        return false;
    }
}

// ===== Galería rediseñada: pestañas, tarjetas, bottom sheet, lightbox y carga progresiva =====
const GAL_TYPES = ['video', 'audio', 'photo'];
const GAL_LABEL = { video: 'Videos', audio: 'Audios', photo: 'Imágenes' };
const GAL_PAGE = 24;
let galleryReady = false, galQuery = '', galShown = GAL_PAGE, galList = [];
const galOpenTags = new Set();
const galPref = {
    get(k, d) { try { return localStorage.getItem(k) || d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* modo privado */ } }
};
let galView = galPref.get('cd_view', 'grid') === 'list' ? 'list' : 'grid';
const galEl = (id) => document.getElementById(id);

// ── Utilidades ──
const fmtDur = (s) => {
    s = Math.round(s || 0);
    if (!s) return '';
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0');
};
const fmtSize = (b) => (!b ? '' : b >= 1e9 ? (b / 1e9).toFixed(1) + ' GB' : b >= 1e6 ? (b / 1e6 < 10 ? (b / 1e6).toFixed(1) : Math.round(b / 1e6)) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB');
const tagsOf = (title) => [...new Set(String(title || '').match(/#[\p{L}\p{N}_]{2,30}/gu) || [])].slice(0, 24);
const titleOf = (it) => String(it.title || '').replace(/#[\p{L}\p{N}_]+/gu, '').replace(/\s+/g, ' ').trim() || String(it.title || 'Sin título');
const qualityOf = (it) => { const s = Math.min(it.w || 0, it.h || 0); return !s ? '' : s >= 2160 ? '4K' : s >= 720 ? 'HD' : 'SD'; };
const metaOf = (it) => [it.author, it.quality, fmtSize(it.size)].filter(Boolean).map(esc).join(' · ') || (it.hasFile ? '' : 'Elemento de ejemplo');
const galViewEff = () => (currentGalleryFilter === 'audio' ? 'list' : galView);
const itemById = (id) => galleryItems.find((i) => i.id === id);
const itemBlob = async (it) => it.blob || (it.hasFile ? dbGetFile(it.id) : null);
function pseudoWave(id, n = 48) {   // onda simulada y estable mientras el audio no se ha analizado
    let s = Number(id) % 2147483647 || 7;
    return Array.from({ length: n }, (_, i) => { s = (s * 48271) % 2147483647; return 0.25 + 0.75 * Math.abs(Math.sin(i / 3.1 + (s % 100) / 40)) * (((s % 100) / 100) * 0.5 + 0.5); });
}

// ── Tarjetas ──
function tagsHtml(it) {
    const tags = tagsOf(it.title);
    if (!tags.length) return '';
    const open = galOpenTags.has(it.id), vis = open ? tags : tags.slice(0, 2), more = tags.length - 2;
    return `<div class="flex flex-wrap gap-1 pt-0.5">${vis.map((t) => `<span class="cd-tag">${esc(t)}</span>`).join('')}${more > 0 ? `<button class="cd-tag" data-action="toggleTags" data-arg="${it.id}" aria-expanded="${open}">${open ? 'menos' : '+' + more}</button>` : ''}</div>`;
}

function mediaCard(it, i, anim) {   // videos (y fotos en vista lista)
    const video = it.type === 'video', q = video ? qualityOf(it) : '', dur = video ? fmtDur(it.dur) : '';
    return `<article class="cd-card cd-vcard${anim ? ' cd-card-in' : ''}" style="--i:${i}" data-id="${it.id}">
        <div class="cd-thumb" data-action="${video ? 'playMedia' : 'openLightbox'}" data-arg="${it.id}" role="button" tabindex="0" aria-label="${video ? 'Reproducir' : 'Ver'} ${esc(titleOf(it))}">
            <img src="${esc(it.lthumb || it.thumb || placeholderThumb(it.type))}" data-fallback="${it.type}" loading="lazy" decoding="async" alt="">
            ${video ? '<span class="cd-play"><i class="fa-solid fa-play"></i></span>' : ''}
            ${q ? `<span class="cd-badge cd-badge-q">${q}</span>` : ''}${dur ? `<span class="cd-badge cd-badge-d">${dur}</span>` : ''}
        </div>
        <div class="p-3 space-y-1.5 min-w-0 flex-1">
            <div class="flex items-start gap-1.5"><h3 class="cd-title flex-1">${esc(titleOf(it))}</h3><button class="cd-more" data-action="openSheet" data-arg="${it.id}" aria-label="Opciones"><i class="fa-solid fa-ellipsis-vertical"></i></button></div>
            <p class="cd-meta">${metaOf(it)}</p>
            ${tagsHtml(it)}
        </div></article>`;
}

function photoTile(it, i, anim) {
    return `<div class="cd-photo${anim ? ' cd-card-in' : ''}" style="--i:${i}" data-id="${it.id}" data-action="openLightbox" data-arg="${it.id}" role="button" tabindex="0" aria-label="Ver ${esc(titleOf(it))}">
        <img src="${esc(it.lthumb || it.thumb || placeholderThumb('photo'))}" data-fallback="photo" loading="lazy" decoding="async" alt="">
        ${/^gif$/i.test(it.ext) ? '<span class="cd-badge cd-badge-q">GIF</span>' : ''}
        <button class="cd-photo-more" data-action="openSheet" data-arg="${it.id}" aria-label="Opciones"><i class="fa-solid fa-ellipsis"></i></button></div>`;
}

function audioCard(it, i, anim) {
    const wave = it.wave && it.wave.length ? it.wave : pseudoWave(it.id);
    return `<article class="cd-card cd-audio${anim ? ' cd-card-in' : ''}" style="--i:${i}" data-id="${it.id}">
        <div class="cd-note"><i class="fa-solid fa-music text-lg"></i></div>
        <div class="flex-1 min-w-0">
            <h3 class="cd-title">${esc(titleOf(it))}</h3>
            <p class="cd-meta">${esc(it.author || 'Artista desconocido')}${it.quality ? ' · ' + esc(it.quality) : ''}</p>
            <div class="cd-wave" data-seek="${it.id}" aria-label="Progreso de reproducción">${wave.map((v) => `<i style="height:${Math.max(14, Math.round(v * 100))}%"></i>`).join('')}</div>
            <div class="flex justify-between text-[10px] text-gray-500 mt-0.5"><span class="cd-time">0:00</span><span>${fmtDur(it.dur) || fmtSize(it.size) || '--:--'}</span></div>
        </div>
        <button class="cd-pp" data-action="toggleAudio" data-arg="${it.id}" aria-label="Reproducir o pausar"><i class="fa-solid fa-play text-xs"></i><i class="fa-solid fa-pause text-xs"></i></button>
        <button class="cd-more" data-action="openSheet" data-arg="${it.id}" aria-label="Opciones"><i class="fa-solid fa-ellipsis-vertical"></i></button></article>`;
}

const cardFor = (it, i, anim) => (it.type === 'audio' ? audioCard : it.type === 'photo' && galViewEff() === 'grid' ? photoTile : mediaCard)(it, i, anim);
const GAL_AD = `<div class="cd-ad"><span><b class="text-amber-300">PATROCINADO</b> · Pack de transiciones para editores v2.0 disponible</span><button class="text-brand-accent font-bold whitespace-nowrap" data-action="openUltraModal">Quitar anuncios</button></div>`;

// ── Pestañas, resumen y render con carga progresiva ──
function paintGalTabs() {
    galEl('galInd').style.transform = `translateX(${Math.max(0, GAL_TYPES.indexOf(currentGalleryFilter)) * 100}%)`;
    GAL_TYPES.forEach((t) => {
        const on = t === currentGalleryFilter;
        galEl('galTab-' + t).classList.toggle('active', on);
        galEl('galTab-' + t).setAttribute('aria-selected', String(on));
        galEl('galCount-' + t).textContent = galleryItems.filter((i) => i.type === t).length;
    });
    const n = galleryItems.length, total = galleryItems.reduce((s, i) => s + (i.size || 0), 0);
    galEl('galSummary').textContent = n ? `${n} ${n === 1 ? 'elemento' : 'elementos'} · ${fmtSize(total) || '0 KB'} en este dispositivo` : 'Aún no hay archivos guardados';
    galEl('layoutGridBtn').classList.toggle('on', galView === 'grid');
    galEl('layoutListBtn').classList.toggle('on', galView === 'list');
}

function filteredGallery() {
    const q = galQuery.trim().toLowerCase();
    return galleryItems.filter((i) => i.type === currentGalleryFilter && (!q || [i.title, i.author, i.quality].concat(tagsOf(i.title)).join(' ').toLowerCase().includes(q)));
}

function galEmpty() {
    const label = GAL_LABEL[currentGalleryFilter].toLowerCase(), q = galQuery.trim();
    return `<div class="cd-empty"><div class="ic"><i class="fa-solid ${q ? 'fa-magnifying-glass' : 'fa-cloud-arrow-down'}"></i></div>
        <p class="font-bold text-sm">${q ? 'Sin resultados' : 'Aún no tienes ' + label}</p>
        <p class="text-xs text-gray-500">${q ? 'Prueba con otra palabra o etiqueta.' : 'Pega un enlace en Descargar y aparecerá aquí.'}</p>
        ${q ? '' : '<button class="cd-btn" data-action="switchTab" data-arg="downloader">Ir a Descargar</button>'}</div>`;
}

function galAppend(from, to, anim) {
    let html = '';
    for (let i = from; i < to; i++) {
        html += cardFor(galList[i], i - from, anim);
        if (i === 5 && galList.length > 6) html += GAL_AD;   // un solo aviso discreto, en la primera página
    }
    galEl('galleryContainer').insertAdjacentHTML('beforeend', html);
    if (galObserver) { const s = galEl('galSentinel'); galObserver.unobserve(s); galObserver.observe(s); }   // vuelve a comprobar si hace falta otra página
}

function renderGallery() {
    const c = galEl('galleryContainer');
    paintGalTabs();
    if (!galleryReady) { c.className = 'cd-view-grid cd-video'; c.innerHTML = '<div class="cd-skel"></div>'.repeat(6); return; }
    galList = filteredGallery();
    if (!galList.length) { c.className = ''; c.innerHTML = galEmpty(); return; }
    c.className = `cd-${currentGalleryFilter} cd-view-${galViewEff()}`;
    c.innerHTML = '';
    galAppend(0, galObserver ? Math.min(galList.length, galShown) : galList.length, true);
}

const galObserver = typeof IntersectionObserver === 'function' ? new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting) && galleryReady && galShown < galList.length) {
        const from = galShown; galShown += GAL_PAGE;
        galAppend(from, Math.min(galList.length, galShown), true);
    }
}, { rootMargin: '600px 0px' }) : null;
if (galObserver) galObserver.observe(galEl('galSentinel'));

function refreshCard(it) {   // actualiza una sola tarjeta sin repintar la lista (sin parpadeo)
    if (!it) return;
    if (it.type !== currentGalleryFilter) { paintGalTabs(); return; }
    const el = document.querySelector(`#galleryContainer [data-id="${it.id}"]`);
    if (el) { el.outerHTML = cardFor(it, 0, false); paintAudio(); }
}

function galPickTab() {
    const saved = galPref.get('cd_tab', '');
    if (!GAL_TYPES.includes(currentGalleryFilter)) currentGalleryFilter = GAL_TYPES.includes(saved) ? saved : 'video';
    if (!galleryItems.some((i) => i.type === currentGalleryFilter)) currentGalleryFilter = GAL_TYPES.find((t) => galleryItems.some((i) => i.type === t)) || currentGalleryFilter;
}

function filterGallery(type) {
    currentGalleryFilter = GAL_TYPES.includes(type) ? type : 'video';
    galPref.set('cd_tab', currentGalleryFilter);
    galShown = GAL_PAGE;
    renderGallery();
}
function setGalleryLayout(v) { galView = v === 'list' ? 'list' : 'grid'; galPref.set('cd_view', galView); galShown = GAL_PAGE; renderGallery(); }
function toggleTags(id) { if (galOpenTags.has(id)) galOpenTags.delete(id); else galOpenTags.add(id); refreshCard(itemById(id)); }

let galTimer = 0;
galEl('galSearch').addEventListener('input', (e) => {   // búsqueda instantánea sobre los metadatos en memoria
    clearTimeout(galTimer);
    galTimer = setTimeout(() => { galQuery = e.target.value; galShown = GAL_PAGE; galEl('galSearchClear').classList.toggle('hidden', !galQuery); renderGallery(); }, 90);
});
function clearSearch() {
    const s = galEl('galSearch');
    s.value = ''; galQuery = ''; galShown = GAL_PAGE;
    galEl('galSearchClear').classList.add('hidden');
    renderGallery(); s.focus();
}

// ── Borrado ──
function deleteGalleryItem(id) {
    if (audioId === id) stopAudio();
    galleryItems = galleryItems.filter((i) => i.id !== id);
    dbDelete([id]).catch(persistError);
    if (galEl('lightbox').classList.contains('open')) {
        lbIds = lbIds.filter((x) => x !== id);
        if (!lbIds.length) closeLightbox(); else { lbIndex = Math.min(lbIndex, lbIds.length - 1); showLb(); }
    }
    renderGallery();
}
function executeCategoryClear() {
    const ids = galleryItems.filter((i) => i.type === currentGalleryFilter).map((i) => i.id);
    if (ids.includes(audioId)) stopAudio();
    galleryItems = galleryItems.filter((i) => i.type !== currentGalleryFilter);
    dbDelete(ids).catch(persistError);
    renderGallery();
    toast(ids.length ? `${GAL_LABEL[currentGalleryFilter]} eliminados` : 'No había nada que vaciar');
}

// ── Bottom sheet de acciones ──
let galSheetId = null, galSheetMode = 'actions';
const confirmHtml = (title, text, action, label) => `<div class="px-1 pb-1 text-center space-y-1.5">
    <div class="mx-auto w-12 h-12 rounded-2xl bg-red-500/10 text-red-400 flex items-center justify-center"><i class="fa-regular fa-trash-can"></i></div>
    <h3 class="font-extrabold text-sm">${title}</h3><p class="text-xs text-gray-400 leading-relaxed">${text}</p>
    <div class="grid grid-cols-2 gap-2 pt-3"><button class="cd-act justify-center" style="background:#1B2331" data-action="sheetCancel">Cancelar</button><button class="cd-act justify-center danger" style="background:rgba(239,68,68,.12)" data-action="${action}">${label}</button></div></div>`;

function paintSheet() {
    const body = galEl('sheetBody'), it = itemById(galSheetId);
    if (galSheetMode === 'clear') {
        const n = galleryItems.filter((i) => i.type === currentGalleryFilter).length;
        body.innerHTML = confirmHtml(`¿Vaciar ${GAL_LABEL[currentGalleryFilter]}?`, `Se eliminarán ${n} ${n === 1 ? 'archivo guardado' : 'archivos guardados'} en este dispositivo. Esta acción no se puede deshacer.`, 'sheetConfirmClear', 'Vaciar');
        return;
    }
    if (!it) { closeSheet(); return; }
    if (galSheetMode === 'confirm') {
        body.innerHTML = confirmHtml('¿Eliminar este archivo?', `«${esc(titleOf(it))}» se borrará de la galería de este dispositivo. Esta acción no se puede deshacer.`, 'sheetConfirmDelete', 'Eliminar');
        return;
    }
    const primary = it.type === 'photo' ? ['fa-expand', 'Previsualizar'] : it.type === 'audio' ? ['fa-play', 'Reproducir / pausar'] : ['fa-play', 'Reproducir'];
    body.innerHTML = `<div class="flex items-center gap-3 pb-3 mb-1 border-b border-brand-border">
        <div class="w-12 h-12 rounded-xl overflow-hidden bg-brand-dark flex-none">${it.type === 'audio' ? '<div class="cd-note w-full h-full" style="border-radius:0;box-shadow:none"><i class="fa-solid fa-music"></i></div>' : `<img src="${esc(it.lthumb || it.thumb || placeholderThumb(it.type))}" data-fallback="${it.type}" class="w-full h-full object-cover" alt="">`}</div>
        <div class="min-w-0"><div class="cd-title">${esc(titleOf(it))}</div><div class="cd-meta">${metaOf(it)}</div></div></div>
        <button class="cd-act" data-action="sheetPlay"><i class="fa-solid ${primary[0]} text-cyan-300"></i>${primary[1]}</button>
        <button class="cd-act" data-action="sheetShare"><i class="fa-solid fa-share-nodes text-violet-300"></i>Compartir</button>
        ${it.type === 'photo' ? '<button class="cd-act" data-action="sheetEdit"><i class="fa-solid fa-crop-simple text-emerald-300"></i>Editar</button>' : ''}
        <button class="cd-act" data-action="sheetDownload"><i class="fa-solid fa-arrow-down text-amber-300"></i>Descargar al dispositivo</button>
        <button class="cd-act danger" data-action="sheetDelete"><i class="fa-regular fa-trash-can"></i>Eliminar</button>`;
}
function setSheet(open) {
    galEl('sheetBack').classList.toggle('open', open);
    const s = galEl('sheet');
    s.classList.toggle('open', open);
    s.setAttribute('aria-hidden', String(!open));
    if (!open) s.style.transform = '';
}
function openSheet(id) { galSheetId = id; galSheetMode = 'actions'; paintSheet(); setSheet(true); }
function closeSheet() { setSheet(false); }
function promptClearGallery() { galSheetId = null; galSheetMode = 'clear'; paintSheet(); setSheet(true); }
function sheetPlay() {
    const it = itemById(galSheetId);
    closeSheet();
    if (!it) return;
    if (it.type === 'audio') toggleAudio(it.id); else if (it.type === 'photo') openLightbox(it.id); else playMedia(it.id);
}
function sheetShare() { const it = itemById(galSheetId); closeSheet(); if (it) shareItem(it); }
function sheetEdit() { const it = itemById(galSheetId); closeSheet(); closeLightbox(); if (it) playMedia(it.id); }
function sheetDownload() { const it = itemById(galSheetId); closeSheet(); if (it) saveToDevice(it, true); }
function sheetDelete() { galSheetMode = 'confirm'; paintSheet(); }
function sheetCancel() { if (galSheetMode === 'clear') closeSheet(); else { galSheetMode = 'actions'; paintSheet(); } }
function sheetConfirmDelete() { const id = galSheetId; closeSheet(); deleteGalleryItem(id); toast('Archivo eliminado'); }
function sheetConfirmClear() { closeSheet(); executeCategoryClear(); }

(() => {   // arrastrar el asa hacia abajo cierra la hoja
    const sheet = galEl('sheet'), h = galEl('sheetHandle');
    let y0 = null;
    h.addEventListener('pointerdown', (e) => { y0 = e.clientY; sheet.style.transition = 'none'; h.setPointerCapture(e.pointerId); });
    h.addEventListener('pointermove', (e) => { if (y0 !== null) sheet.style.transform = `translateY(${Math.max(0, e.clientY - y0)}px)`; });
    const end = (e) => { if (y0 === null) return; const dy = e.clientY - y0; y0 = null; sheet.style.transition = ''; if (dy > 90) closeSheet(); else sheet.style.transform = ''; };
    h.addEventListener('pointerup', end); h.addEventListener('pointercancel', end);
})();

// ── Compartir (Web Share API) ──
async function shareItem(it) {
    try {
        const blob = await itemBlob(it);
        if (!blob) { toast('Este elemento de ejemplo no tiene archivo para compartir.'); return; }
        const ext = EXT_BY_MIME[String(blob.type).split(';')[0]] || String(it.ext || 'bin').toLowerCase();
        const file = new File([blob], (titleOf(it).replace(/[\\/:*?"<>|]+/g, '').trim().slice(0, 90) || 'clipdrop') + '.' + ext, { type: blob.type });
        if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: titleOf(it) }); return; }
        toast('Tu navegador no permite compartir archivos: se guardará en el dispositivo.');
        await saveToDevice(it, true);
    } catch (e) {
        if (e && e.name === 'AbortError') return;   // el usuario cerró la hoja de compartir
        console.warn(e);
        toast('No se pudo compartir este archivo.');
    }
}

// ── Lightbox de imágenes: deslizar para navegar, doble toque para ampliar, deslizar hacia abajo para cerrar ──
let lbIds = [], lbIndex = 0, lbUrl = null, lbToken = 0, lbScale = 1, lbX = 0, lbY = 0, lbPtr = null, lbTap = 0;
const lbCurrent = () => itemById(lbIds[lbIndex]);
function lbApply() { const img = galEl('lbImg'); img.style.transition = lbPtr ? 'none' : 'transform .2s'; img.style.transform = `translate(${lbX}px, ${lbY}px) scale(${lbScale})`; }
async function showLb() {
    const it = lbCurrent(), my = ++lbToken;
    if (!it) { closeLightbox(); return; }
    galEl('lbCount').textContent = `${lbIndex + 1} / ${lbIds.length}`;
    galEl('lbTitle').textContent = titleOf(it);
    lbScale = 1; lbX = lbY = 0; lbApply();
    const img = galEl('lbImg');
    img.src = it.lthumb || it.thumb || placeholderThumb('photo');   // vista previa inmediata mientras carga el original
    const blob = await itemBlob(it);
    if (my !== lbToken || !blob) return;
    if (lbUrl) URL.revokeObjectURL(lbUrl);
    lbUrl = URL.createObjectURL(blob);
    img.src = lbUrl;
}
function openLightbox(id) {
    lbIds = galList.filter((i) => i.type === 'photo').map((i) => i.id);
    lbIndex = Math.max(0, lbIds.indexOf(id));
    galEl('lightbox').classList.add('open');
    galEl('lightbox').setAttribute('aria-hidden', 'false');
    showLb();
}
function closeLightbox() {
    lbToken++;
    galEl('lightbox').classList.remove('open');
    galEl('lightbox').setAttribute('aria-hidden', 'true');
    if (lbUrl) { URL.revokeObjectURL(lbUrl); lbUrl = null; }
    galEl('lbImg').removeAttribute('src');
}
function lbNav(d) { if (lbIds.length < 2) return; lbIndex = (lbIndex + d + lbIds.length) % lbIds.length; showLb(); }
function lbPrev() { lbNav(-1); }
function lbNext() { lbNav(1); }
function lbShare() { const it = lbCurrent(); if (it) shareItem(it); }
function lbEdit() { const it = lbCurrent(); closeLightbox(); if (it) playMedia(it.id); }
function lbDownload() { const it = lbCurrent(); if (it) saveToDevice(it, true); }
function lbMore() { const it = lbCurrent(); if (it) openSheet(it.id); }

(() => {
    const stage = galEl('lbStage');
    stage.addEventListener('pointerdown', (e) => { lbPtr = { x: e.clientX, y: e.clientY, ox: lbX, oy: lbY, moved: false }; stage.setPointerCapture(e.pointerId); });
    stage.addEventListener('pointermove', (e) => {
        if (!lbPtr) return;
        const dx = e.clientX - lbPtr.x, dy = e.clientY - lbPtr.y;
        if (Math.abs(dx) + Math.abs(dy) > 6) lbPtr.moved = true;
        if (lbScale > 1) { lbX = lbPtr.ox + dx; lbY = lbPtr.oy + dy; lbApply(); }
    });
    const end = (e) => {
        if (!lbPtr) return;
        const p = lbPtr, dx = e.clientX - p.x, dy = e.clientY - p.y;
        lbPtr = null;
        const dbl = !p.moved && Date.now() - lbTap < 300;
        if (!p.moved) lbTap = Date.now();
        if (dbl) { lbScale = lbScale > 1 ? 1 : 2.4; lbX = lbY = 0; lbApply(); return; }
        if (lbScale > 1) { lbApply(); return; }
        if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) lbNav(dx < 0 ? 1 : -1);
        else if (dy > 90) closeLightbox();
    };
    stage.addEventListener('pointerup', end); stage.addEventListener('pointercancel', end);
})();

// ── Audio: reproducción en la propia tarjeta con onda y progreso ──
let audioEl = null, audioId = null, audioUrl = null;
function paintAudio() {
    document.querySelectorAll('.cd-audio').forEach((card) => {
        const on = audioEl && Number(card.dataset.id) === audioId, p = on && audioEl.duration ? audioEl.currentTime / audioEl.duration : 0;
        card.classList.toggle('playing', !!on && !audioEl.paused);
        const bars = card.querySelectorAll('.cd-wave i'), k = Math.round(p * bars.length);
        bars.forEach((b, j) => b.classList.toggle('on', j < k));
        const t = card.querySelector('.cd-time');
        if (t) t.textContent = on ? fmtDur(audioEl.currentTime) || '0:00' : '0:00';
    });
}
function stopAudio() {
    if (audioEl) { audioEl.pause(); audioEl.removeAttribute('src'); }
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    audioEl = audioUrl = audioId = null;
    paintAudio();
}
async function toggleAudio(id) {
    const it = itemById(id);
    if (!it) return;
    if (audioId === id && audioEl) { if (audioEl.paused) audioEl.play(); else audioEl.pause(); return; }
    stopAudio();
    const blob = await itemBlob(it);
    if (!blob) { toast('Este elemento de ejemplo no tiene archivo para reproducir.'); return; }
    audioUrl = URL.createObjectURL(blob);
    audioEl = new Audio(audioUrl);
    audioId = id;
    ['timeupdate', 'play', 'pause'].forEach((ev) => audioEl.addEventListener(ev, paintAudio));
    audioEl.addEventListener('ended', stopAudio);
    audioEl.play().catch(() => toast('No se pudo reproducir este audio.'));
}
document.addEventListener('pointerdown', (e) => {   // tocar la onda: salta a ese punto (o empieza a reproducir)
    const w = e.target.closest && e.target.closest('[data-seek]');
    if (!w) return;
    const id = Number(w.dataset.seek);
    if (audioId !== id) { toggleAudio(id); return; }
    const r = w.getBoundingClientRect();
    if (audioEl && audioEl.duration) audioEl.currentTime = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * audioEl.duration;
});

// ── Metadatos locales: miniatura del propio archivo, duración, resolución y onda real ──
const once = (el, ev, ms) => new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('tiempo agotado: ' + ev)), ms);
    el.addEventListener(ev, () => { clearTimeout(t); res(); }, { once: true });
    el.addEventListener('error', () => { clearTimeout(t); rej(new Error('error de medio')); }, { once: true });
});
function drawThumb(src, w, h) {
    const k = Math.min(1, 480 / Math.max(w, h || 1)), c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
    c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.74);
}
async function computeWave(blob, n = 48) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC || blob.size > 30e6) return null;
    const ctx = new AC();
    try {
        const data = (await ctx.decodeAudioData(await blob.arrayBuffer())).getChannelData(0), step = Math.floor(data.length / n) || 1, peaks = [];
        for (let i = 0; i < n; i++) { let m = 0; for (let j = i * step; j < Math.min(data.length, (i + 1) * step); j += 8) m = Math.max(m, Math.abs(data[j])); peaks.push(m); }
        const mx = Math.max(...peaks) || 1;
        return peaks.map((p) => Math.round((p / mx) * 100) / 100);
    } catch (e) { return null; } finally { if (ctx.close) ctx.close(); }
}
async function enrichItem(it) {   // true si se intentó (aunque falle, no se reintenta en cada carga)
    if (!it.hasFile || it.enriched) return false;
    const blob = await itemBlob(it);
    if (!blob) return false;
    const url = URL.createObjectURL(blob);
    try {
        if (it.type === 'photo') {
            const img = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = url; });
            it.w = img.naturalWidth; it.h = img.naturalHeight; it.lthumb = drawThumb(img, it.w, it.h);
        } else if (it.type === 'video') {
            const v = document.createElement('video');
            v.muted = true; v.playsInline = true; v.preload = 'metadata';
            const meta = once(v, 'loadedmetadata', 8000);
            v.src = url;
            await meta;
            it.dur = v.duration || 0; it.w = v.videoWidth; it.h = v.videoHeight;
            const seeked = once(v, 'seeked', 5000);
            v.currentTime = Math.min(0.6, (v.duration || 1) / 2);
            await seeked;
            it.lthumb = drawThumb(v, v.videoWidth, v.videoHeight);
        } else {
            const a = document.createElement('audio');
            a.preload = 'metadata';
            const meta = once(a, 'loadedmetadata', 8000);
            a.src = url;
            await meta;
            it.dur = a.duration || 0;
            it.wave = await computeWave(blob);
        }
    } catch (e) { console.warn('Metadatos no disponibles:', e.message); }
    finally { URL.revokeObjectURL(url); it.enriched = 1; }
    return true;
}
async function enrichAndPersist(it) {
    try {
        if (!(await enrichItem(it))) return;
        const { blob, ...meta } = it;   // el archivo vive en "files"/"parts": aquí solo van los metadatos
        await tx('gallery', 'readwrite', (s) => s.put(meta));
    } catch (e) { /* sin BD: la miniatura queda en memoria */ }
    refreshCard(it);
}
async function backfillMeta() {   // elementos guardados antes de esta versión: se completan poco a poco
    for (const it of galleryItems.filter((i) => i.hasFile && !i.enriched).slice(0, 40)) {
        await enrichAndPersist(it);
        await new Promise((r) => setTimeout(r, 60));
    }
}

// ── Teclado y altura de la cabecera ──
document.addEventListener('keydown', (e) => {
    const sheetOpen = galEl('sheet').classList.contains('open'), lbOpen = galEl('lightbox').classList.contains('open');
    if (e.key === 'Escape') { if (sheetOpen) closeSheet(); else if (lbOpen) closeLightbox(); }
    else if (lbOpen && e.key === 'ArrowRight') lbNext();
    else if (lbOpen && e.key === 'ArrowLeft') lbPrev();
    else if ((e.key === 'Enter' || e.key === ' ') && e.target && e.target.matches && e.target.matches('[role="button"][data-action]')) { e.preventDefault(); e.target.click(); }
});
const galSyncHeader = () => { const h = document.querySelector('header'); if (h) document.documentElement.style.setProperty('--hdr', h.offsetHeight + 'px'); };
galSyncHeader();
window.addEventListener('resize', galSyncHeader);
renderGallery();   // esqueleto de carga hasta que IndexedDB responda

// ===== Eventos: delegación por data-action (sin atributos on*; la CSP prohíbe scripts en línea) =====
// Uso en el HTML:  <button data-action="closeModal" data-arg="faqModal">
//   data-arg → único argumento (número, true/false o texto) · data-close-drawer → cierra el menú antes · data-close-modal="id" → cierra ese modal después
const ACTIONS = {
    switchTab, toggleDrawer, closeModal, openUltraModal, openTutorialModal, openRatingModal, openHistoryModal, openFeedbackModal, openFaqModal, toggleNotifications, closeNotifications, markAllRead, shareApp, installApp, filterGallery, setGalleryLayout, promptClearGallery, executeCategoryClear, playMedia, deleteGalleryItem, setRatio, saveCrop, setRating, submitFeedback, selectPlan, processDownload, pasteClipboard, clearInput, cancelDownload, openSheet, closeSheet, sheetPlay, sheetShare, sheetEdit, sheetDownload, sheetDelete, sheetCancel, sheetConfirmDelete, sheetConfirmClear, openLightbox, closeLightbox, lbPrev, lbNext, lbShare, lbEdit, lbDownload, lbMore, toggleAudio, toggleTags, clearSearch,
    openLink: url => window.open(url, '_blank', 'noopener'),
    redownload: id => {   // el historial de ejemplo no trae id; la galería sí
        if (id === undefined) { alert('Iniciando re-descarga...'); return; }
        const item = galleryItems.find(i => i.id === id);
        if (item) saveToDevice(item, true);
    },
    subscribe: () => alert('Iniciando suscripción elegida...')
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
