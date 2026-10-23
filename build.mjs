// Build de producción: compila y minifica Tailwind, inyecta la URL del backend y genera dist/ con CSP estricta.
// Uso:  CLIPDROP_API=https://api.tudominio.com npm run build     (sin variable = modo simulado y sin CSP)
import { execSync } from 'node:child_process';
import fs from 'node:fs';

const API = (process.env.CLIPDROP_API || '').replace(/\/+$/, '');
if (API && !/^(https:\/\/|http:\/\/localhost)/.test(API)) throw new Error('CLIPDROP_API debe empezar por https://');

fs.rmSync('dist', { recursive: true, force: true });
fs.mkdirSync('dist/css', { recursive: true });
execSync('npx tailwindcss -c tailwind.config.js -i src/input.css -o dist/css/tailwind.css --minify', { stdio: 'inherit' });

// app.js: inyecta la URL del backend
let js = fs.readFileSync('app.js', 'utf8');
if (!js.includes("const API_BASE = '';")) throw new Error('No se encontró API_BASE en app.js');
js = js.replace("const API_BASE = '';", `const API_BASE = ${JSON.stringify(API)};`);
fs.writeFileSync('dist/app.js', js);

// index.html: el bloque TW-CDN (script CDN + config inline) se sustituye por el CSS compilado
let html = fs.readFileSync('index.html', 'utf8')
  .replace(/<!-- TW-CDN:START[\s\S]*?<!-- TW-CDN:END -->/, '<link rel="stylesheet" href="css/tailwind.css">');

// Guardas: la CSP estricta no admite scripts ni manejadores en línea
if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(html)) throw new Error('index.html tiene un <script> en línea');
const inlineHandler = /\son(click|error|input|change|load|submit|focus|blur|key\w+|mouse\w+|touch\w+|pointer\w+)=["']/i;
if (inlineHandler.test(html) || inlineHandler.test(js)) throw new Error('Quedan manejadores on* en línea: usa data-action');

const csp = [
  "default-src 'self'",
  "script-src 'self'",          // sin 'unsafe-inline'
  "script-src-attr 'none'",     // prohíbe cualquier on* en el HTML
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com",
  "font-src 'self' https://fonts.gstatic.com https://cdnjs.cloudflare.com",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob:",
  `connect-src 'self' ${API}`,
  "worker-src 'self'", "manifest-src 'self'", "object-src 'none'", "base-uri 'self'", "form-action 'self'"
].join('; ');
if (API) html = html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}">`);   // respaldo para hosts sin _headers
fs.writeFileSync('dist/index.html', html);

// _headers (Netlify / Cloudflare Pages): cabeceras reales; permiten frame-ancestors, que no funciona en <meta>
fs.writeFileSync('dist/_headers', [
  '/*',
  ...(API ? [`  Content-Security-Policy: ${csp}; frame-ancestors 'none'`] : []),
  '  X-Content-Type-Options: nosniff',
  '  Referrer-Policy: strict-origin-when-cross-origin',
  '  Permissions-Policy: camera=(), microphone=(), geolocation=()',
  '/index.html', '  Cache-Control: no-cache',
  '/app.js', '  Cache-Control: no-cache',
  '/sw.js', '  Cache-Control: no-cache',
].join('\n') + '\n');

// sw.js: precachea también el CSS compilado
const sw = fs.readFileSync('sw.js', 'utf8').replace("'./manifest.webmanifest',", "'./manifest.webmanifest', './css/tailwind.css',");
fs.writeFileSync('dist/sw.js', sw);

fs.copyFileSync('manifest.webmanifest', 'dist/manifest.webmanifest');
fs.cpSync('icons', 'dist/icons', { recursive: true });
console.log('dist/ listo · ' + (API ? 'API: ' + API + ' · CSP estricta' : 'modo simulado (sin CSP)'));
