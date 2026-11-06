import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';

const ROOT = resolve(import.meta.dirname);
const PORT = Number(process.env.PORT ?? 3000);
let currentPort = PORT;

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.mp4': 'video/mp4',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};

const server = createServer(async (request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
  } catch {
    response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Requisição inválida');
    return;
  }

  if (pathname.endsWith('/')) pathname += 'index.html';

  const filePath = resolve(join(ROOT, pathname.replace(/^[/\\]+/, '')));
  if (filePath !== ROOT && !filePath.startsWith(ROOT + sep)) {
    response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Acesso negado');
    return;
  }

  const fileInfo = await stat(filePath).catch(() => null);
  if (!fileInfo || !fileInfo.isFile()) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Arquivo não encontrado');
    return;
  }

  const contentType = MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
  const size = fileInfo.size;
  const rangeHeader = request.headers.range;

  if (!rangeHeader) {
    response.writeHead(200, {
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache',
      'Content-Length': size,
      'Content-Type': contentType,
    });
    if (request.method === 'HEAD') response.end();
    else createReadStream(filePath).pipe(response);
    return;
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
  if (!match || (match[1] === '' && match[2] === '')) {
    response.writeHead(416, { 'Content-Range': `bytes */${size}` }).end();
    return;
  }

  let start;
  let end;
  if (match[1] === '') {
    end = size - 1;
    start = Math.max(size - Number(match[2]), 0);
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  }

  if (start > end || start >= size) {
    response.writeHead(416, { 'Content-Range': `bytes */${size}` }).end();
    return;
  }

  response.writeHead(206, {
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
    'Content-Length': end - start + 1,
    'Content-Range': `bytes ${start}-${end}/${size}`,
    'Content-Type': contentType,
  });

  if (request.method === 'HEAD') {
    response.end();
    return;
  }

  const stream = createReadStream(filePath, { start, end });
  stream.on('error', () => response.destroy());
  stream.pipe(response);
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE' && currentPort < PORT + 20) {
    currentPort += 1;
    console.warn(`Porta ${currentPort - 1} em uso, tentando ${currentPort}…`);
    server.listen(currentPort);
    return;
  }
  console.error(error);
  process.exit(1);
});

server.on('listening', () => {
  console.log(`Inklu disponível em http://localhost:${currentPort}`);
});

server.listen(currentPort);
