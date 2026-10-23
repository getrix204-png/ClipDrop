# ClipDrop PWA

Descarga y gestión de multimedia (TikTok, Instagram, YouTube, X y Pinterest). Estética Clean Dark, PWA instalable y galería guardada en IndexedDB.

## Estructura
`index.html` · `app.js` · `sw.js` · `manifest.webmanifest` · `icons/` · `src/input.css` · `tailwind.config.js` · `build.mjs` · `vercel.json` · `server/mock-api.mjs` (solo para pruebas locales)

## Desplegar en Vercel (página de prueba)
1. Sube el **contenido** de esta carpeta (no el .zip) a un repositorio de GitHub.
2. En vercel.com: **Add New → Project**, importa el repositorio y pulsa **Deploy**. No cambies nada: `vercel.json` ya define el build (`npm run build`) y la carpeta de salida (`dist`).
3. Abre la URL (HTTPS) y, desde Chrome, instala la app.

Sin API configurada la app funciona en modo simulado (archivos de prueba).

## Conectar el backend
En Vercel: **Settings → Environment Variables** → `CLIPDROP_API` = `https://api.tudominio.com` y vuelve a desplegar. Eso inyecta la URL y activa la CSP estricta (sin `unsafe-inline` en scripts). El backend debe permitir CORS para el dominio de tu PWA.

## Desarrollo local
```
npm install
npm run dev       # sirve la raíz (Tailwind por CDN) en :3000
npm run mock      # API de prueba en :8787  →  http://localhost:3000/?api=http://localhost:8787
npm run build     # genera dist/ (CSS minificado, CSP con CLIPDROP_API)
npm run preview   # sirve dist/
```
