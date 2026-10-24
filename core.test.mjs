import test from 'node:test';
import assert from 'node:assert/strict';
import { buildItems, onlyWatermarked } from './formats.js';
import { parseTarget, detectPlatform } from './platforms.js';
import { mapYtDlpError } from './errors.js';
import { isPrivateIp } from './net.js';
import { classify, parseMeta } from './pinterest.js';
import { Pool, rateLimit } from './runtime.js';

const v = (id, w, h, o = {}) => ({ format_id: id, width: w, height: h, vcodec: 'avc1.64', acodec: 'none', ext: 'mp4', protocol: 'https', tbr: h * 2, url: 'https://cdn.example/' + id, ...o });
const audio = { format_id: '140', vcodec: 'none', acodec: 'mp4a', abr: 128, ext: 'm4a', protocol: 'https', tbr: 128 };
const youtube = { duration: 100, formats: [v('313', 3840, 2160, { vcodec: 'vp09' }), v('271', 2560, 1440, { vcodec: 'vp09' }), v('137', 1920, 1080), v('136', 1280, 720), v('135', 854, 480), v('134', 640, 360), audio] };
const ids = (platform, info) => buildItems(platform, info, 'https://x.test/p').map((i) => i.id);

test('YouTube: 4K, 1440p, 1080p, 720p, 480p y MP3 (360p no tiene escalón)', () => {
  assert.deepEqual(ids('youtube', youtube), ['v2160', 'v1440', 'v1080', 'v720', 'v480', 'a320', 'a128']);
});
test('4K y 1440p son exclusivos de YouTube', () => {
  assert.deepEqual(ids('tiktok', youtube), ['v1080', 'v720', 'v480', 'a320', 'a128']);
});
test('TikTok: descarta la variante con marca de agua y sirve la limpia en directo', () => {
  const info = { duration: 20, formats: [
    { format_id: 'download', format_note: 'Download video, watermarked', width: 1080, height: 1920, vcodec: 'h264', acodec: 'aac', ext: 'mp4', protocol: 'https', url: 'https://cdn.example/wm.mp4' },
    { format_id: 'play', width: 1080, height: 1920, vcodec: 'h264', acodec: 'aac', ext: 'mp4', protocol: 'https', url: 'https://cdn.example/clean.mp4' }] };
  const [it] = buildItems('tiktok', info, 'https://tiktok.com/x');
  assert.equal(it.id, 'v1080'); assert.equal(it.fmt.format_id, 'play'); assert.equal(it.kind, 'direct');
  const wmOnly = { formats: [info.formats[0]] };
  assert.deepEqual(buildItems('tiktok', wmOnly, 'https://tiktok.com/x'), []); assert.ok(onlyWatermarked(wmOnly));
});
test('video sin audio incluido: se fusiona con la mejor pista de audio', () => {
  const [it] = buildItems('youtube', { duration: 10, formats: [v('137', 1920, 1080), audio] }, 'https://youtu.be/x');
  assert.equal(it.kind, 'merge'); assert.match(it.args[1], /^137\+ba\[ext=m4a\]/);
});
test('carrusel de Instagram: ids con prefijo y fotos HD', () => {
  const img = (u) => ({ ext: 'jpg', formats: [{ format_id: 'o', ext: 'jpg', width: 1080, height: 1350, url: u, vcodec: 'none', acodec: 'none' }] });
  const items = buildItems('instagram', { entries: [img('https://cdn.example/1.jpg'), img('https://cdn.example/2.jpg')] }, 'https://instagram.com/p/x');
  assert.deepEqual(items.map((i) => i.id), ['1-photo', '2-photo']); assert.deepEqual(items.map((i) => i.index), [1, 2]);
});

test('URLs: normalización y rechazos', () => {
  assert.deepEqual(parseTarget('http://www.pinterest.com.mx/pin/1/#x'), { url: 'https://www.pinterest.com.mx/pin/1/', platform: 'pinterest' });
  assert.equal(parseTarget('vm.tiktok.com/abc').platform, 'tiktok');
  assert.throws(() => parseTarget('https://evil.com/x'), { code: 'unsupported_platform' });
  for (const bad of ['', 'https://user:pw@tiktok.com/x', 'https://tiktok.com:8443/x', 'javascript:alert(1)', 'x'.repeat(3000)]) assert.throws(() => parseTarget(bad), { code: 'invalid_url' });
  assert.equal(detectPlatform('pin.it'), 'pinterest'); assert.equal(detectPlatform('music.youtube.com'), 'youtube'); assert.equal(detectPlatform('nottiktok.com'), null);
});
test('IPs privadas bloqueadas (SSRF)', () => {
  assert.ok(['127.0.0.1', '10.1.2.3', '172.16.0.1', '169.254.169.254', '100.64.0.1', '::1', '::ffff:192.168.0.5', 'fd00::1', 'fe80::1'].every(isPrivateIp));
  assert.ok(!['8.8.8.8', '172.32.0.1', '2606:4700::1111'].some(isPrivateIp));
});
test('errores de yt-dlp → estados y códigos claros', () => {
  const c = (s) => [mapYtDlpError(s).status, mapYtDlpError(s).code];
  assert.deepEqual(c("Sign in to confirm you're not a bot"), [429, 'platform_blocked']);
  assert.deepEqual(c('This video is private'), [404, 'private_content']);
  assert.deepEqual(c('Video unavailable'), [404, 'not_found']);
  assert.deepEqual(c('This video has been removed by the uploader'), [410, 'gone']);
  assert.deepEqual(c('Unsupported URL: https://x'), [400, 'unsupported_url']);
  assert.deepEqual(c('No video formats found!'), [502, 'extractor_failed']);
});

test('Pinterest: metadatos y clasificación GIF / imagen HD / reducida', async () => {
  const meta = parseMeta(`<meta content='Mi &amp; pin' property="og:title"><meta property="og:image" content="https://i.pinimg.com/736x/ab/cd/ef/abcdef.jpg">`);
  assert.equal(meta['og:title'], 'Mi & pin');
  const ok = (type, size = 10) => ({ status: 200, type, size }), no = { status: 404, type: '', size: 0 };
  assert.deepEqual(await classify(meta, async (u) => (u.endsWith('.gif') ? ok('image/gif') : no)), { kind: 'gif', url: 'https://i.pinimg.com/originals/ab/cd/ef/abcdef.gif', size: 10, ext: 'GIF' });
  assert.equal((await classify(meta, async (u) => (u.endsWith('.jpg') ? ok('image/jpeg', 99) : no))).url, 'https://i.pinimg.com/originals/ab/cd/ef/abcdef.jpg');
  assert.equal((await classify(meta, async () => no)).reduced, true);
  assert.equal(await classify({ 'og:image': 'https://evil.example/a.jpg' }, async () => no), null);
});

test('límite por IP y cola de procesos', async () => {
  const mw = rateLimit({ windowMs: 1000, max: 2 }), req = { ip: '1.1.1.1' }, res = { setHeader() {} };
  mw(req, res, () => {}); mw(req, res, () => {});
  assert.throws(() => mw(req, res, () => {}), { status: 429 });
  const pool = new Pool(1, 0), first = pool.run(() => new Promise((r) => setTimeout(r, 20)));
  await assert.rejects(pool.run(async () => {}), { status: 503 });
  await first;
});
