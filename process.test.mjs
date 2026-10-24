// Pruebas de procesos y red con un yt-dlp falso (no necesitan internet ni Express).
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

const dir = mkdtempSync(join(tmpdir(), 'cdtest-'));
const fake = join(dir, 'yt-dlp');
writeFileSync(fake, `#!/usr/bin/env node
const fs = require('node:fs'), a = process.argv.slice(2), url = a[a.length - 1];
if (url.endsWith('/private')) { console.error('ERROR: [x] Video is private'); process.exit(1); }
else if (url.endsWith('/slow')) { setTimeout(() => {}, 10000); }
else if (a.includes('-o')) {
  const out = a[a.indexOf('-o') + 1].replace('%(ext)s', a.includes('-x') ? 'mp3' : 'mp4');
  fs.writeFileSync(out, Buffer.alloc(a.includes('-x') ? 4096 : 8192, 7));
} else console.log(JSON.stringify({ title: 't' }));
`);
chmodSync(fake, 0o755);
process.env.YTDLP_PATH = fake;
process.env.TMP_DIR = join(dir, 'tmp');
const { ytdlp, prepare, discard, sweepTemp } = await import('./ytdlp.js');
const { request, readText } = await import('./net.js');

test('ytdlp devuelve el JSON, traduce errores y respeta el tiempo límite', async () => {
  assert.match(await ytdlp(['-J', '--', 'https://ok.test/json'], 5000), /"title"/);
  await assert.rejects(ytdlp(['-J', '--', 'https://ok.test/private'], 5000), { status: 404, code: 'private_content' });
  await assert.rejects(ytdlp(['-J', '--', 'https://ok.test/slow'], 300), { status: 504, code: 'timeout' });
});

test('prepare genera el archivo (MP3), discard libera el disco y los fallos no dejan restos', async () => {
  const e = { args: ['-f', 'ba/b', '-x', '--audio-format', 'mp3'], page: 'https://ok.test/json', index: 0 };
  const file = await prepare(e);
  assert.ok(file.endsWith('.mp3')); assert.equal(readFileSync(file).length, 4096);
  const d = e.dir; discard(e);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(existsSync(d), false);
  const bad = { args: [], page: 'https://ok.test/private', index: 0 };
  await assert.rejects(prepare(bad), { code: 'private_content' });
  assert.equal(bad.dir, null);
});

test('sweepTemp borra temporales huérfanos', async () => {
  mkdirSync(join(dir, 'tmp', 'cd-viejo'), { recursive: true });
  await sweepTemp();
  assert.equal(existsSync(join(dir, 'tmp', 'cd-viejo')), false);
});

test('request rechaza destinos no permitidos (http, IP privada, loopback, anfitrión no autorizado)', async () => {
  for (const u of ['http://example.com/', 'https://127.0.0.1/', 'https://[::1]/', 'https://169.254.169.254/', 'https://localhost/']) {
    await assert.rejects(request(u), { code: 'blocked_destination' }, u);
  }
  await assert.rejects(request('https://tiktok.com/', { allow: () => false }), { code: 'blocked_destination' });
});

test('readText corta lecturas enormes', async () => {
  const txt = await readText(Readable.from(['abc', 'def', 'ghi'].map((s) => Buffer.from(s))), 4);
  assert.ok(txt.length <= 6 && txt.startsWith('abc'));
});
