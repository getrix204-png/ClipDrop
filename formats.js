// Convierte el JSON de yt-dlp en la lista de formatos que consume la PWA. Es lógica pura (sin red ni procesos) y está probada.
const TIERS = [['v2160', '4K', 2160, true], ['v1440', '1440p', 1440, true], ['v1080', '1080p', 1080], ['v720', '720p', 720], ['v480', '480p', 480]];   // true = solo YouTube
const short = (f) => Math.min(f.width || f.height || 0, f.height || f.width || 0);   // lado corto: un 1080x1920 vertical es "1080p"
const hasV = (f) => !!f.vcodec && f.vcodec !== 'none';
const hasA = (f) => !!f.acodec && f.acodec !== 'none';
const isImg = (f) => /^(jpe?g|png|webp|gif)$/i.test(f.ext || '');
const watermarked = (f) => /watermark/i.test(`${f.format_note || ''} ${f.format_id || ''}`);   // así marca yt-dlp las variantes con marca de agua
const est = (f, dur) => Number(f.filesize || f.filesize_approx) || (f.tbr && dur ? Math.round(f.tbr * 125 * dur) : 0);   // tbr kbit/s → bytes/s = tbr·125
const h264 = (f) => (/avc|h264/i.test(f.vcodec || '') ? 1 : 0);   // a igual resolución se prefiere H.264 (compatible con todos los celulares)

export const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
export const httpsOnly = (u) => (/^https:\/\//i.test(u || '') ? u : '');

function itemsFor(platform, info, page, index) {
  const dur = Number(info.duration) || 0;
  const fmts = (info.formats || []).filter((f) => !watermarked(f));   // solo fuentes sin marca de agua
  const yt = platform === 'youtube';
  const tiers = TIERS.filter(([, , , onlyYt]) => yt || !onlyYt);
  const tierOf = (f) => (tiers.find(([, , h]) => short(f) >= h * 0.9) || [])[0];
  const vids = fmts.filter((f) => hasV(f) && !isImg(f) && short(f) && (yt || short(f) <= 1300));   // 4K/1440p solo en YouTube
  const audio = fmts.filter((f) => hasA(f) && !hasV(f)).sort((a, b) => (b.abr || 0) - (a.abr || 0))[0];
  const out = [];

  for (const [id, label] of tiers) {
    const best = vids.filter((f) => tierOf(f) === id)
      .sort((a, b) => short(b) - short(a) || h264(b) - h264(a) || (b.tbr || 0) - (a.tbr || 0))[0];
    if (!best) continue;
    const muxed = hasA(best) || (best.acodec == null && !audio);   // acodec desconocido y sin pista de audio aparte: ya trae audio
    const direct = muxed && /^https?$/.test(best.protocol || '') && !!best.url;   // progresivo: se retransmite sin tocar disco
    const sel = muxed ? best.format_id : `${best.format_id}+ba[ext=m4a]/${best.format_id}+ba/${best.format_id}`;
    out.push({
      id, type: 'video', label, ext: 'MP4',
      size: est(best, dur) + (muxed || !audio ? 0 : est(audio, dur)),
      kind: direct ? 'direct' : 'merge', fmt: best, args: ['-f', sel, '--merge-output-format', 'mp4']
    });
  }

  if (fmts.some(hasA)) {
    for (const kbps of [320, 128]) {
      out.push({
        id: `a${kbps}`, type: 'audio', label: `MP3 ${kbps} kbps`, ext: 'MP3',
        size: dur ? Math.round(kbps * 125 * dur) : 0,
        kind: 'convert', args: ['-f', 'ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', `${kbps}K`]
      });
    }
  }

  // Imágenes y GIF (Instagram, X, carruseles): la de mayor resolución
  const imgs = [...fmts.filter(isImg), ...(isImg(info) && info.url ? [info] : [])]
    .sort((a, b) => (b.width * b.height || 0) - (a.width * a.height || 0) || est(b, 0) - est(a, 0));
  if (imgs[0]) {
    const f = imgs[0], gif = /^gif$/i.test(f.ext);
    out.push({
      id: gif ? 'gif' : 'photo', type: 'photo', label: gif ? 'GIF' : 'Foto HD', ext: f.ext.toUpperCase(),
      size: est(f, 0), kind: 'direct', fmt: f, args: f.format_id ? ['-f', f.format_id] : []
    });
  }
  return out.map((i) => ({ ...i, page, index }));
}

// Carruseles: cada elemento recibe un prefijo (1-photo, 2-photo…) y se descarga con --playlist-items.
export function buildItems(platform, info, page) {
  let list = (info.entries || []).filter(Boolean);
  if (platform === 'youtube') list = list.slice(0, 1);   // enlace de lista de reproducción: solo el primer video
  if (!list.length) list = [info];
  const multi = list.length > 1;
  return list.flatMap((e, i) =>
    itemsFor(platform, e, page, multi ? i + 1 : 0).map((it) => (multi ? { ...it, id: `${i + 1}-${it.id}`, label: `${it.label} · ${i + 1}` } : it)));
}

// ¿Todo lo que ofrece la plataforma lleva marca de agua? (para responder con un error claro en vez de una lista vacía)
export const onlyWatermarked = (info) => {
  const f = [...(info.formats || []), ...(info.entries || []).flatMap((e) => (e && e.formats) || [])];
  return f.length > 0 && f.every(watermarked);
};
