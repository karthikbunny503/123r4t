require('dotenv').config();

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const { chromium } = require('playwright');
const {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  GetObjectCommand,
} = require('@aws-sdk/client-s3');

const PORT = Number(process.env.PORT || 10000);
const URLS_FILE = process.env.URLS_FILE || './urls.txt';
const RECORDINGS_DIR = process.env.RECORDINGS_DIR || './recordings';
const RECORD_SECONDS = Number(process.env.RECORD_SECONDS || 30);
const PAGE_TIMEOUT_MS = Number(process.env.PAGE_TIMEOUT_MS || 60000);
const PAGE_WARMUP_MS = Number(process.env.PAGE_WARMUP_MS || 3000);
const VIEWPORT_WIDTH = Number(process.env.VIEWPORT_WIDTH || 854);
const VIEWPORT_HEIGHT = Number(process.env.VIEWPORT_HEIGHT || 480);
const AUTO_START = String(process.env.AUTO_START || 'false').toLowerCase() === 'true';
const DELETE_LOCAL_AFTER_UPLOAD = String(process.env.DELETE_LOCAL_AFTER_UPLOAD || 'false').toLowerCase() === 'true';

const B2_ENDPOINT = process.env.B2_ENDPOINT || 'https://s3.us-east-005.backblazeb2.com';
const B2_REGION = process.env.B2_REGION || 'us-east-005';
const B2_BUCKET = process.env.B2_BUCKET || '';
const B2_KEY_ID = process.env.B2_KEY_ID || '';
const B2_APPLICATION_KEY = process.env.B2_APPLICATION_KEY || '';
const B2_PREFIX = 'recordings/';
const APP_VERSION = '11.0.0';

fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

const app = express();
app.use(express.json({ limit: '256kb' }));

let browser = null;
let stopRequested = false;
let running = false;
let currentUrl = null;
let lastResult = null;
let lastError = null;

const b2Configured = Boolean(B2_ENDPOINT && B2_REGION && B2_BUCKET && B2_KEY_ID && B2_APPLICATION_KEY);
const s3 = b2Configured
  ? new S3Client({
      region: B2_REGION,
      endpoint: B2_ENDPOINT,
      forcePathStyle: true,
      credentials: {
        accessKeyId: B2_KEY_ID,
        secretAccessKey: B2_APPLICATION_KEY,
      },
    })
  : null;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function readUrls() {
  if (!fs.existsSync(URLS_FILE)) return [];
  return fs.readFileSync(URLS_FILE, 'utf8')
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean)
    .filter(s => !s.startsWith('#'));
}

function safeFilePart(value) {
  return String(value)
    .replace(/^https?:\/\//i, '')
    .replace(/[^a-z0-9._-]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 100) || 'page';
}

function makeLocalFilename(index, url) {
  const stamp = new Date().toISOString().replace(/:/g, '-');
  let title = 'page';
  try {
    title = new URL(url).hostname;
  } catch (_) {}
  return `${String(index + 1).padStart(3, '0')}_${stamp}_${safeFilePart(title)}.webm`;
}

async function uploadToB2(localPath, key) {
  if (!s3) {
    throw new Error('B2 is not configured. Set B2_ENDPOINT, B2_REGION, B2_BUCKET, B2_KEY_ID and B2_APPLICATION_KEY.');
  }

  const body = fs.createReadStream(localPath);
  await s3.send(new PutObjectCommand({
    Bucket: B2_BUCKET,
    Key: key,
    Body: body,
    ContentType: 'video/webm',
    ServerSideEncryption: 'AES256',
  }));
}

async function recordUrl(url, index) {
  if (!browser) {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
  }

  const filename = makeLocalFilename(index, url);
  const localPath = path.resolve(RECORDINGS_DIR, filename);

  const context = await browser.newContext({
    viewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT },
    recordVideo: { dir: RECORDINGS_DIR, size: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT } },
  });

  const page = await context.newPage();
  currentUrl = url;

  try {
    page.on('console', msg => {
      if (msg.type() === 'error') console.log(`Page console error: ${msg.text()}`);
    });

    page.on('pageerror', err => console.log(`Page error: ${err.message}`));

    console.log(`Loading: ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT_MS });
    console.log(`Page loaded: ${url}`);

    const videos = await page.locator('video').count().catch(() => 0);
    const audios = await page.locator('audio').count().catch(() => 0);
    console.log(`Detected media: ${videos} video, ${audios} audio`);

    if (PAGE_WARMUP_MS > 0) await sleep(PAGE_WARMUP_MS);

    console.log(`Recording for ${RECORD_SECONDS}s: ${url}`);
    const startedAt = Date.now();
    while (!stopRequested && Date.now() - startedAt < RECORD_SECONDS * 1000) {
      await sleep(500);
    }
  } catch (err) {
    console.log(`Recording error for ${url}: ${err.message}`);
    throw err;
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }

  // Playwright chooses the final WebM filename when the context closes.
  // Find the newest .webm and rename it to our predictable filename.
  const candidates = fs.readdirSync(RECORDINGS_DIR)
    .filter(name => name.toLowerCase().endsWith('.webm'))
    .map(name => ({ name, full: path.join(RECORDINGS_DIR, name), mtime: fs.statSync(path.join(RECORDINGS_DIR, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  const source = candidates[0];
  if (!source) throw new Error('Playwright did not produce a WebM recording.');

  if (source.full !== localPath) {
    fs.renameSync(source.full, localPath);
  }

  const key = `${B2_PREFIX}${filename}`;
  console.log(`Recording saved locally: ${localPath}`);

  if (b2Configured) {
    await uploadToB2(localPath, key);
    console.log(`B2 upload OK: ${key}`);
    if (DELETE_LOCAL_AFTER_UPLOAD) {
      fs.unlinkSync(localPath);
    }
  } else {
    console.log('B2 upload skipped: B2 is not configured.');
  }

  return {
    url,
    filename,
    localPath,
    key,
    uploaded: b2Configured,
    finishedAt: new Date().toISOString(),
  };
}

async function runRecorder() {
  if (running) return;
  running = true;
  stopRequested = false;
  lastError = null;

  try {
    const urls = readUrls();
    if (!urls.length) throw new Error(`No URLs found in ${URLS_FILE}`);

    console.log(`Recorder starting. ${urls.length} URL(s).`);

    for (let i = 0; i < urls.length && !stopRequested; i++) {
      try {
        lastResult = await recordUrl(urls[i], i);
      } catch (err) {
        lastError = `${urls[i]}: ${err.message}`;
        console.error(lastError);
      }
    }
  } finally {
    running = false;
    currentUrl = null;
    stopRequested = false;
    console.log('Recorder finished.');
  }
}


async function listB2Files() {
  if (!b2Configured) throw new Error('B2 is not configured.');
  const out = await s3.send(new ListObjectsV2Command({
    Bucket: B2_BUCKET,
    Prefix: B2_PREFIX,
    MaxKeys: 1000,
  }));
  return (out.Contents || [])
    .filter(item => item.Key && item.Key.toLowerCase().endsWith('.webm'))
    .sort((a, b) => new Date(b.LastModified || 0) - new Date(a.LastModified || 0))
    .map(item => ({
      key: item.Key,
      filename: item.Key.slice(B2_PREFIX.length),
      size: item.Size || 0,
      lastModified: item.LastModified || null,
      downloadUrl: `/api/download?key=${encodeURIComponent(item.Key)}`,
    }));
}

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    running,
    currentUrl,
    b2Configured,
    bucket: B2_BUCKET || null,
    region: B2_REGION,
    playwrightBrowsersPath: process.env.PLAYWRIGHT_BROWSERS_PATH || null,
    lastResult,
    lastError,
  });
});

app.get('/api/status', (_req, res) => {
  res.json({
    running,
    currentUrl,
    urls: readUrls(),
    recordSeconds: RECORD_SECONDS,
    viewport: `${VIEWPORT_WIDTH}x${VIEWPORT_HEIGHT}`,
    b2Configured,
    bucket: B2_BUCKET || null,
    prefix: B2_PREFIX,
    lastResult,
    lastError,
  });
});

app.post('/api/start', (_req, res) => {
  if (running) return res.status(409).json({ ok: false, error: 'Recorder is already running.' });
  runRecorder().catch(err => console.error(`Recorder fatal error: ${err.message}`));
  res.json({ ok: true, started: true });
});

app.post('/api/stop', (_req, res) => {
  if (!running) return res.json({ ok: true, stopped: false });
  stopRequested = true;
  res.json({ ok: true, stopped: true });
});

app.get('/api/files', async (_req, res) => {
  try {
    const files = await listB2Files();
    res.json({ ok: true, bucket: B2_BUCKET, files });
  } catch (err) {
    console.error(`B2 list error: ${err.message}`);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/download', async (req, res) => {
  const key = String(req.query.key || '');

  if (!key || !key.startsWith(B2_PREFIX) || key.includes('..')) {
    return res.status(400).send('Invalid recording key.');
  }
  if (!b2Configured) return res.status(503).send('B2 is not configured.');

  try {
    const out = await s3.send(new GetObjectCommand({
      Bucket: B2_BUCKET,
      Key: key,
    }));

    const filename = path.basename(key);
    res.status(200);
    res.setHeader('Content-Type', out.ContentType || 'video/webm');
    if (out.ContentLength != null) res.setHeader('Content-Length', String(out.ContentLength));
    res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/"/g, '')}"`);

    if (out.Body && typeof out.Body.pipe === 'function') {
      out.Body.pipe(res);
    } else {
      const bytes = await out.Body.transformToByteArray();
      res.end(Buffer.from(bytes));
    }
  } catch (err) {
    console.error(`B2 download error for ${key}: ${err.message}`);
    if (!res.headersSent) res.status(500).send(`Download failed: ${err.message}`);
  }
});

app.get('/', async (_req, res) => {
  const urls = readUrls();
  let files = [];
  let filesError = '';
  if (b2Configured) {
    try {
      files = await listB2Files();
    } catch (err) {
      filesError = err.message;
      console.error(`Dashboard B2 list error: ${err.message}`);
    }
  } else {
    filesError = 'B2 is not configured. Check B2_ENDPOINT, B2_REGION, B2_BUCKET, B2_KEY_ID and B2_APPLICATION_KEY.';
  }

  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
  const fmtBytes = (n) => {
    if (!n) return '0 B';
    const units = ['B','KB','MB','GB'];
    const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
    return (n / Math.pow(1024, i)).toFixed(i ? 1 : 0) + ' ' + units[i];
  };
  const fileRows = files.length
    ? `<table><thead><tr><th>File</th><th>Size</th><th>Last modified</th><th>Action</th></tr></thead><tbody>${files.map(f =>
        `<tr><td>${esc(f.filename)}</td><td>${fmtBytes(f.size)}</td><td>${f.lastModified ? esc(new Date(f.lastModified).toLocaleString()) : ''}</td><td><a class="btn" href="${esc(f.downloadUrl)}">Download</a></td></tr>`
      ).join('')}</tbody></table>`
    : (filesError ? `<div class="error">B2 file list error: ${esc(filesError)}</div>` : `<div class="small">No WebM recordings found.</div>`);

  res.type('html').send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pella Render Recorder</title>
<style>
body { font-family: Arial, sans-serif; margin: 0; background: #f5f6f8; color: #111; }
main { max-width: 1000px; margin: 0 auto; padding: 28px 18px 60px; }
.card { background: #fff; border: 1px solid #ddd; border-radius: 12px; padding: 18px; margin-bottom: 18px; }
h1 { margin-top: 0; }
button, a.btn { display: inline-block; padding: 10px 14px; border-radius: 8px; border: 1px solid #bbb; background: #fff; color: #111; text-decoration: none; cursor: pointer; }
button:hover, a.btn:hover { background: #f0f0f0; }
pre { background: #111; color: #eee; padding: 12px; border-radius: 8px; overflow: auto; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 10px; border-bottom: 1px solid #eee; vertical-align: top; }
.small { color: #666; font-size: 14px; }
.error { color: #a00; }
.ok { color: #075; }
</style>
</head>
<body>
<main>
  <div class="card">
    <h1>Pella Render Recorder</h1>
    <p id="status" class="${lastError ? 'error' : 'ok'}">Running: ${running ? 'YES' : 'NO'}${currentUrl ? ` | Current: ${esc(currentUrl)}` : ''} | B2: ${b2Configured ? 'configured' : 'not configured'}${B2_BUCKET ? ` | Bucket: ${esc(B2_BUCKET)}` : ''} | Version: ${APP_VERSION}</p>
    <button onclick="startRecorder()">Start Recording</button>
    <button onclick="stopRecorder()">Stop</button>
    <button onclick="location.reload()">Refresh</button>
  </div>

  <div class="card">
    <h2>URLs</h2>
    <pre id="urls">${esc(urls.join('\n') || '(none)')}</pre>
  </div>

  <div class="card">
    <h2>B2 Recordings</h2>
    <p class="small">Downloads are streamed through Render from the private Backblaze bucket.</p>
    <div id="files">${fileRows}</div>
  </div>
</main>
<script>
async function api(url, options) {
  const r = await fetch(url, options);
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = { error: text }; }
  if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
  return data;
}
async function refreshStatus() {
  try {
    const s = await api('/api/status');
    const el = document.getElementById('status');
    el.textContent = 'Running: ' + (s.running ? 'YES' : 'NO') + (s.currentUrl ? ' | Current: ' + s.currentUrl : '') + ' | B2: ' + (s.b2Configured ? 'configured' : 'not configured') + (s.bucket ? ' | Bucket: ' + s.bucket : '') + ' | Version: ${APP_VERSION}';
    el.className = s.lastError ? 'error' : 'ok';
  } catch (e) {
    const el = document.getElementById('status');
    el.textContent = 'Status error: ' + e.message;
    el.className = 'error';
  }
}
async function startRecorder() {
  try { await api('/api/start', {method:'POST'}); await refreshStatus(); } catch (e) { alert(e.message); }
}
async function stopRecorder() {
  try { await api('/api/stop', {method:'POST'}); await refreshStatus(); } catch (e) { alert(e.message); }
}
setInterval(refreshStatus, 5000);
</script>
</body>
</html>`);
});

const server = http.createServer(app);
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Recorder dashboard listening on 0.0.0.0:${PORT}`);
  console.log(`B2 configured: ${b2Configured}`);
  console.log(`B2 bucket: ${B2_BUCKET || '(not set)'}`);
  console.log(`PLAYWRIGHT_BROWSERS_PATH=${process.env.PLAYWRIGHT_BROWSERS_PATH || '(not set)'}`);
  console.log(`URLS_FILE=${URLS_FILE}`);

  if (AUTO_START) {
    runRecorder().catch(err => console.error(`Auto-start error: ${err.message}`));
  }
});

async function shutdown() {
  stopRequested = true;
  try { if (browser) await browser.close(); } catch (_) {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
