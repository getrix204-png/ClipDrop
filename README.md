# ClipDrop PWA

Descarga y gestión de multimedia (TikTok, Instagram, YouTube, X y Pinterest). Estética Clean Dark, PWA instalable y galería guardada en IndexedDB.

## Estructura (todo en la raíz, sin carpetas)
`index.html` · `app.js` · `sw.js` · `manifest.webmanifest` · 4 íconos `.png` · `input.css` · `tailwind.config.js` · `build.mjs` · `package.json` · `vercel.json` · `mock-api.mjs` (solo pruebas)

## Desplegar en Vercel (página de prueba, sin build)
1. Sube todos estos archivos a la raíz del repositorio (reemplazando los existentes).
2. En vercel.com: **Add New → Project**, importa el repositorio y **Deploy**.
   Ajustes: Framework Preset = **Other** · Root Directory = **vacío** · Install/Build/Output Command **sin override**.
3. Abre la URL (HTTPS) e instala la app desde Chrome.

Este despliegue usa Tailwind por CDN y el modo simulado (sin backend).

## Build de producción (opcional)
```
npm install
npm run build:prod      # genera dist/ con CSS minificado; con CLIPDROP_API activa la CSP estricta
npm run preview         # sirve dist/
```
Para que Vercel lo use: añade a `vercel.json` `"buildCommand": "npm run build:prod"` y `"outputDirectory": "dist"`, y define `CLIPDROP_API` en Settings → Environment Variables.

## Desarrollo local
```
npm run dev     # sirve la raíz en :3000
npm run mock    # API de prueba en :8787  →  http://localhost:3000/?api=http://localhost:8787
```
