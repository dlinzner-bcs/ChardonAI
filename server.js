const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const port = Number(process.env.PORT) || 4173;
const python = process.env.PYTHON || 'python3';
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

function jsonResponse(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

function analyzeRequest(req, res) {
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > 20_000_000) req.destroy(new Error('Bild ist zu groß'));
  });
  req.on('end', () => {
    let payload;
    try {
      payload = JSON.parse(body);
      if (!/^data:image\/(jpeg|png|webp);base64,/.test(payload.image || '')) throw new Error('Ungültiges Bildformat');
    } catch (error) {
      jsonResponse(res, 400, { error: error.message });
      return;
    }

    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'traubenscan-'));
    const input = path.join(directory, 'input.jpg');
    const output = path.join(directory, 'overlay.jpg');
    const result = path.join(directory, 'result.json');
    fs.writeFileSync(input, Buffer.from(payload.image.split(',')[1], 'base64'));
    const child = spawn(python, [path.join(__dirname, 'segment_grapes.py'), input, '--overlay', output, '--json', result]);
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      fs.rmSync(directory, { recursive: true, force: true });
      jsonResponse(res, 503, { error: 'Computer-Vision-Dienst ist nicht verfügbar', detail: error.message });
    });
    child.on('close', (code) => {
      if (code !== 0 || !fs.existsSync(result)) {
        fs.rmSync(directory, { recursive: true, force: true });
        jsonResponse(res, 500, { error: 'Analyse fehlgeschlagen', detail: stderr.trim().slice(-1000) });
        return;
      }
      const analysis = JSON.parse(fs.readFileSync(result, 'utf8'));
      fs.rmSync(directory, { recursive: true, force: true });
      jsonResponse(res, 200, { ...analysis, engine: 'opencv-watershed-hough' });
    });
  });
}

http.createServer((req, res) => {
  const pathname = decodeURIComponent((req.url || '/').split('?')[0]);
  if (req.method === 'POST' && pathname === '/api/analyze') { analyzeRequest(req, res); return; }
  const requested = pathname === '/' ? '/index.html' : pathname;
  const file = path.resolve(__dirname, `.${requested}`);
  if (!file.startsWith(`${__dirname}${path.sep}`)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (error, body) => {
    if (error) { res.writeHead(404).end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
  });
}).listen(port, '0.0.0.0', () => console.log(`TraubenScan Rheinhessen läuft unter http://localhost:${port}`));
