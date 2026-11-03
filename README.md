# ClipDrop API

Backend de extracción y retransmisión para la PWA ClipDrop (Express + yt-dlp + ffmpeg).

## Estructura (plana, sin carpetas)
`server.js` rutas, CORS y errores · `config.js` variables de entorno · `platforms.js` plataformas y validación de URL · `formats.js` formatos desde yt-dlp (puro, con pruebas) · `pinterest.js` imágenes y GIF de Pinterest · `ytdlp.js` procesos, colas y temporales · `net.js` red segura (SSRF) · `runtime.js` límites, cola y almacén · `errors.js` · `core.test.mjs` · `Dockerfile` · `.env.example`

## Contrato
- `POST /extract` `{ "url": "https://…" }` → `{ ok, platform, contentKind, title, author, thumb, formats: [{ id, type, label, ext, size, fileUrl }] }`
- `GET fileUrl` → binario con `Content-Length` exacto, sin compresión, `Cache-Control: no-store, no-transform` y CORS solo para `ALLOWED_ORIGINS`.
- Error: `{ ok:false, error:"private_content", message:"…" }` con estados 400, 403, 404, 410, 413, 422, 429, 502, 503 o 504.

## Desplegar (Render, con Docker)
1. Crea un repositorio de GitHub **aparte** (por ejemplo `clipdrop-api`) y sube estos archivos en la raíz.
2. En render.com: **New → Web Service**, conecta el repositorio, **Runtime: Docker**.
3. Variables de entorno: `NODE_ENV=production`, `ALLOWED_ORIGINS=https://tu-pwa.vercel.app`, `TRUST_PROXY=1`.
4. Despliega y abre `https://TU-SERVICIO.onrender.com/health` (debe responder `{"ok":true,…}`).

Vercel no sirve para este backend: no puede ejecutar yt-dlp/ffmpeg ni mantener descargas largas. Railway, Fly.io o un VPS con Docker también funcionan.

## Conectar la PWA (Vercel)
1. En el repositorio de la PWA edita `vercel.json` y añade: `"buildCommand": "npm run build:prod", "outputDirectory": "dist"`.
2. En Vercel → Settings → Environment Variables: `CLIPDROP_API` = `https://TU-SERVICIO.onrender.com` (sin barra final).
3. Redeploy. El build inyecta la URL y activa la CSP (`connect-src` solo hacia tu backend).
4. `ALLOWED_ORIGINS` del backend debe coincidir exactamente con el dominio de la PWA.

## Pruebas locales
```
npm install
npm test                                  # lógica pura
YTDLP_PATH=/ruta/yt-dlp npm run dev       # servidor en :8787
curl -s -X POST localhost:8787/extract -H 'Content-Type: application/json' -d '{"url":"https://www.tiktok.com/@u/video/1"}'
```

## Operación
- Actualiza yt-dlp con frecuencia (reconstruye la imagen); las plataformas cambian y a veces bloquean IPs de centros de datos: verás `platform_blocked`.
- Cada descarga pasa por tu servidor: vigila el ancho de banda. El límite por IP es en memoria; con varias instancias usa Redis.
- Uso responsable: descargar contenido ajeno puede infringir los términos de las plataformas y los derechos de autor. Limita el servicio a contenido propio o con permiso, mantén `ALLOWED_ORIGINS` acotado y ofrece un contacto para retirar contenido.
