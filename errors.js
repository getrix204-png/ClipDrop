// Errores de la API. Siempre se responden como JSON: { ok: false, error: <código>, message: <texto>, retryAfter? }
export class HttpError extends Error {
  constructor(status, code, message, retryAfter) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

// Traduce el stderr de yt-dlp a un HttpError. Los estados (400, 404, 410, 413, 429, 5xx) son los que la PWA ya sabe mostrar.
export function mapYtDlpError(stderr = '') {
  const s = String(stderr).toLowerCase();
  const rules = [
    [/unsupported url/, 400, 'unsupported_url', 'Este enlace no es compatible.'],
    [/not a bot|captcha|http error 429|too many requests|rate.?limit/, 429, 'platform_blocked', 'La plataforma bloqueó temporalmente la solicitud. Inténtalo de nuevo en unos minutos.'],
    [/larger than max-filesize/, 413, 'too_large', 'El archivo supera el tamaño máximo permitido.'],
    [/no space left/, 503, 'storage_full', 'El servidor se quedó sin espacio temporal. Inténtalo de nuevo.'],
    [/ffmpeg|ffprobe/, 500, 'server_misconfigured', 'El servidor no puede procesar este formato.'],
    [/private|log ?in|sign in|members.only|age.restricted|confirm your age|authentication|cookies/, 404, 'private_content', 'El contenido es privado o requiere iniciar sesión.'],
    [/removed|deleted|no longer available|account.*(terminated|suspended)/, 410, 'gone', 'El contenido ya no está disponible.'],
    [/unavailable|not available|does not exist|not found|http error 404/, 404, 'not_found', 'No se encontró el contenido: puede ser privado, estar borrado o restringido en tu región.'],
    [/timed out|timeout/, 504, 'timeout', 'La plataforma tardó demasiado en responder.'],
    [/unable to download|connection|network|ssl|certificate/, 502, 'upstream_error', 'No se pudo conectar con la plataforma.']
  ];
  for (const [re, status, code, msg] of rules) if (re.test(s)) return new HttpError(status, code, msg);
  return new HttpError(502, 'extractor_failed', 'No se pudo procesar este enlace. Puede que la plataforma haya cambiado o requiera sesión.');
}
