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
  DeleteObjectCommand,
  DeleteObjectsCommand,
} = require('@aws-sdk/client-s3');

const PORT = Number(process.env.PORT || 10000);
const URLS_FILE = process.env.URLS_FILE || './urls.txt';
const SETTINGS_FILE = process.env.SETTINGS_FILE || './recorder-settings.json';
const RECORDINGS_DIR = process.env.RECORDINGS_DIR || './recordings';
const RECORD_SECONDS = Number(process.env.RECORD_SECONDS || 30);
const PAGE_TIMEOUT_MS = Number(process.env.PAGE_TIMEOUT_MS || 60000);
const PAGE_WARMUP_MS = Number(process.env.PAGE_WARMUP_MS || 3000);
const AUTO_START = String(process.env.AUTO_START || 'false').toLowerCase() === 'true';
const DELETE_LOCAL_AFTER_UPLOAD = String(process.env.DELETE_LOCAL_AFTER_UPLOAD || 'false').toLowerCase() === 'true';

const QUALITY_PRESETS = {
  '240p': { width: 426, height: 240 },
  '360p': { width: 640, height: 360 },
  '480p': { width: 854, height: 480 },
  '540p': { width: 960, height: 540 },
  '720p': { width: 1280, height: 720 },
  '1080p': { width: 1920, height: 1080 },
};

const DEFAULT_QUALITY = String(process.env.DEFAULT_QUALITY || '480p');
const B2_PREFIX = 'recordings/';
const APP_VERSION = '15.0.0';

fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

const rawB2Endpoint = process.env.B2_ENDPOINT || 'https://s3.us-east-005.backblazeb2.com';
const B2_ENDPOINT = String(rawB2Endpoint)
  .trim()
  .replace(/^['"]+|['"]+$/g, '')
  .replace(/\/+$/, '');
const B2_REGION = process.env.B2_REGION || 'us-east-005';
const B2_BUCKET = process.env.B2_BUCKET || '';
const B2_KEY_ID = process.env.B2_KEY_ID || '';
const B2_APPLICATION_KEY = process.env.B2_APPLICATION_KEY || '';

let settings = loadSettings();

const app = express();
app.use(express.json({ limit: '256kb' }));

let browser = null;
let stopRequested = false;
let running = false;
let currentUrl = null;
let currentIndex = null;
let lastResult = null;
let lastError = null;
let livePreviewBuffer = null;
let livePreviewUpdatedAt = null;
let activeRunUrls = null;

let b2EndpointError = null;
try {
  const parsed = new URL(B2_ENDPOINT);
  if (!/^https?:$/.test(parsed.protocol)) throw new Error('B2_ENDPOINT must use http:// or https://');
} catch (err) {
  b2EndpointError = `Invalid B2_ENDPOINT: ${B2_ENDPOINT || '(empty)'}. Use https://s3.us-east-005.backblazeb2.com exactly.`;
}

const b2Configured = Boolean(!b2EndpointError && B2_ENDPOINT && B2_REGION && B2_BUCKET && B2_KEY_ID && B2_APPLICATION_KEY);
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

function loadSettings() {
  const envQuality = QUALITY_PRESETS[DEFAULT_QUALITY] ? DEFAULT_QUALITY : '480p';
  let out = { quality: envQuality, width: QUALITY_PRESETS[envQuality].width, height: QUALITY_PRESETS[envQuality].height, recordSeconds: RECORD_SECONDS };
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      const quality = QUALITY_PRESETS[parsed.quality] ? parsed.quality : envQuality;
      out = {
        quality,
        width: QUALITY_PRESETS[quality].width,
        height: QUALITY_PRESETS[quality].height,
        recordSeconds: Number(parsed.recordSeconds) > 0 ? Math.min(Number(parsed.recordSeconds), 3600) : RECORD_SECONDS,
      };
    }
  } catch (err) {
    console.log(`Settings load warning: ${err.message}`);
  }
  return out;
}

function saveSettings(next) {
  settings = { ...settings, ...next };
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

function normalizeUrls(input) {
  const arr = Array.isArray(input) ? input : String(input || '').split(/\r?\n/);
  const result = [];
  const seen = new Set();
  for (const raw of arr) {
    const value = String(raw || '').trim();
    if (!value || value.startsWith('#')) continue;
    let parsed;
    try {
      parsed = new URL(value);
    } catch (_) {
      throw new Error(`Invalid URL: ${value}`);
    }
    if (!/^https?:$/.test(parsed.protocol)) {
      throw new Error(`Only http:// and https:// URLs are allowed: ${value}`);
    }
    const normalized = parsed.toString();
    if (!seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }
  return result;
}

function readUrls() {
  if (!fs.existsSync(URLS_FILE)) return [];
  return normalizeUrls(fs.readFileSync(URLS_FILE, 'utf8').split(/\r?\n/));
}

function writeUrls(urls) {
  fs.writeFileSync(URLS_FILE, `${urls.join('\n')}${urls.length ? '\n' : ''}`);
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

function validateKey(key) {
  const value = String(key || '');
  if (!value || !value.startsWith(B2_PREFIX) || value.includes('..') || !value.toLowerCase().endsWith('.webm')) {
    throw new Error('Invalid recording key.');
  }
  return value;
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

async function captureLivePreview(page) {
  try {
    livePreviewBuffer = await page.screenshot({ type: 'jpeg', quality: 60, animations: 'disabled' });
    livePreviewUpdatedAt = new Date().toISOString();
  } catch (_) {}
}

async function recordUrl(url, index, runSettings) {
  if (!browser) {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
  }

  const filename = makeLocalFilename(index, url);
  const localPath = path.resolve(RECORDINGS_DIR, filename);

  const context = await browser.newContext({
    viewport: { width: runSettings.width, height: runSettings.height },
    recordVideo: { dir: RECORDINGS_DIR, size: { width: runSettings.width, height: runSettings.height } },
  });

  const page = await context.newPage();
  currentUrl = url;
  currentIndex = index;
  livePreviewBuffer = null;
  livePreviewUpdatedAt = null;

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
    await captureLivePreview(page);

    console.log(`Recording for ${runSettings.recordSeconds}s at ${runSettings.quality}: ${url}`);
    const startedAt = Date.now();
    let nextPreview = 0;
    while (!stopRequested && Date.now() - startedAt < runSettings.recordSeconds * 1000) {
      if (Date.now() >= nextPreview) {
        await captureLivePreview(page);
        nextPreview = Date.now() + 1000;
      }
      await sleep(250);
    }
  } catch (err) {
    console.log(`Recording error for ${url}: ${err.message}`);
    throw err;
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    livePreviewBuffer = null;
    livePreviewUpdatedAt = null;
  }

  const candidates = fs.readdirSync(RECORDINGS_DIR)
    .filter(name => name.toLowerCase().endsWith('.webm'))
    .map(name => ({ name, full: path.join(RECORDINGS_DIR, name), mtime: fs.statSync(path.join(RECORDINGS_DIR, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  const source = candidates[0];
  if (!source) throw new Error('Playwright did not produce a WebM recording.');
  if (source.full !== localPath) fs.renameSync(source.full, localPath);

  const key = `${B2_PREFIX}${filename}`;
  console.log(`Recording saved locally: ${localPath}`);

  if (b2Configured) {
    await uploadToB2(localPath, key);
    console.log(`B2 upload OK: ${key}`);
    if (DELETE_LOCAL_AFTER_UPLOAD) fs.unlinkSync(localPath);
  } else {
    console.log('B2 upload skipped: B2 is not configured.');
  }

  return {
    url,
    filename,
    localPath,
    key,
    quality: runSettings.quality,
    width: runSettings.width,
    height: runSettings.height,
    uploaded: b2Configured,
    finishedAt: new Date().toISOString(),
  };
}

async function runRecorder(urlsOverride = null) {
  if (running) return;
  running = true;
  stopRequested = false;
  lastError = null;

  const runSettings = { ...settings };
  try {
    const urls = Array.isArray(urlsOverride) ? normalizeUrls(urlsOverride) : readUrls();
    if (!urls.length) throw new Error(`No URLs provided. Paste one or more links in the panel or add them to ${URLS_FILE}.`);
    activeRunUrls = urls.slice();
    writeUrls(urls);
    console.log(`Recorder starting. ${urls.length} URL(s). Quality: ${runSettings.quality} (${runSettings.width}x${runSettings.height}), ${runSettings.recordSeconds}s each.`);

    for (let i = 0; i < urls.length && !stopRequested; i++) {
      try {
        lastResult = await recordUrl(urls[i], i, runSettings);
      } catch (err) {
        lastError = `${urls[i]}: ${err.message}`;
        console.error(lastError);
      }
    }
  } finally {
    running = false;
    currentUrl = null;
    currentIndex = null;
    stopRequested = false;
    livePreviewBuffer = null;
    livePreviewUpdatedAt = null;
    activeRunUrls = null;
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
      previewUrl: `/api/preview?key=${encodeURIComponent(item.Key)}`,
      deleteUrl: `/api/delete?key=${encodeURIComponent(item.Key)}`,
    }));
}

async function streamB2Object(req, res, key, disposition) {
  const range = req.headers.range;
  const command = {
    Bucket: B2_BUCKET,
    Key: key,
  };
  if (range) command.Range = range;

  const out = await s3.send(new GetObjectCommand(command));
  res.status(range ? 206 : 200);
  res.setHeader('Content-Type', out.ContentType || 'video/webm');
  res.setHeader('Accept-Ranges', 'bytes');
  if (out.ContentLength != null) res.setHeader('Content-Length', String(out.ContentLength));
  if (out.ContentRange) res.setHeader('Content-Range', out.ContentRange);
  if (disposition === 'attachment') {
    const filename = path.basename(key).replace(/"/g, '');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  } else {
    res.setHeader('Content-Disposition', 'inline');
  }

  if (out.Body && typeof out.Body.pipe === 'function') {
    out.Body.on?.('error', err => {
      if (!res.headersSent) res.status(500);
      res.end();
    });
    out.Body.pipe(res);
  } else {
    const bytes = await out.Body.transformToByteArray();
    res.end(Buffer.from(bytes));
  }
}

function removeLocalRecording(filename) {
  const localPath = path.resolve(RECORDINGS_DIR, filename);
  try {
    if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
  } catch (err) {
    console.log(`Local delete warning for ${filename}: ${err.message}`);
  }
}

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    running,
    currentUrl,
    currentIndex,
    settings,
    b2Configured,
    bucket: B2_BUCKET || null,
    region: B2_REGION,
    b2Endpoint: B2_ENDPOINT || null,
    b2EndpointError,
    playwrightBrowsersPath: process.env.PLAYWRIGHT_BROWSERS_PATH || null,
    lastResult,
    lastError,
  });
});

app.get('/api/status', (_req, res) => {
  let savedUrls = [];
  try { savedUrls = readUrls(); } catch (err) { lastError = `URL file error: ${err.message}`; }
  res.json({
    running,
    currentUrl,
    currentIndex,
    urls: activeRunUrls || savedUrls,
    savedUrls,
    runSource: activeRunUrls ? 'panel' : 'urls.txt',
    settings,
    qualityPresets: QUALITY_PRESETS,
    b2Configured,
    bucket: B2_BUCKET || null,
    prefix: B2_PREFIX,
    b2Endpoint: B2_ENDPOINT || null,
    b2EndpointError,
    lastResult,
    lastError,
    livePreviewUpdatedAt,
  });
});

app.post('/api/start', (req, res) => {
  if (running) return res.status(409).json({ ok: false, error: 'Recorder is already running.' });
  try {
    // IMPORTANT: a manual Start Recording request must use ONLY the URLs supplied by the panel.
    // urls.txt is only the fallback when the recorder is started by AUTO_START or another non-panel caller.
    const input = Array.isArray(req.body?.urls) ? req.body.urls : req.body?.text;
    const urls = normalizeUrls(input);
    if (!urls.length) return res.status(400).json({ ok: false, error: 'Paste at least one URL in the panel before starting.' });

    writeUrls(urls);
    activeRunUrls = urls.slice();
    console.log(`Panel start requested with ${urls.length} URL(s):`);
    urls.forEach((u, i) => console.log(`  [${i + 1}] ${u}`));

    // Pass the validated panel snapshot directly into the recorder.
    runRecorder(urls).catch(err => console.error(`Recorder fatal error: ${err.message}`));
    res.json({ ok: true, started: true, urls, source: 'panel', settings });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post('/api/stop', (_req, res) => {
  if (!running) return res.json({ ok: true, stopped: false });
  stopRequested = true;
  res.json({ ok: true, stopped: true });
});

app.post('/api/settings', (req, res) => {
  try {
    const quality = String(req.body?.quality || settings.quality);
    if (!QUALITY_PRESETS[quality]) return res.status(400).json({ ok: false, error: `Unsupported quality: ${quality}` });
    const recordSeconds = Number(req.body?.recordSeconds || settings.recordSeconds);
    if (!Number.isFinite(recordSeconds) || recordSeconds < 1 || recordSeconds > 3600) {
      return res.status(400).json({ ok: false, error: 'recordSeconds must be between 1 and 3600.' });
    }
    const preset = QUALITY_PRESETS[quality];
    saveSettings({ quality, width: preset.width, height: preset.height, recordSeconds: Math.round(recordSeconds) });
    res.json({ ok: true, settings });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/urls', (_req, res) => {
  try {
    res.json({ ok: true, urls: readUrls() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/urls', (req, res) => {
  try {
    const input = Array.isArray(req.body?.urls) ? req.body.urls : req.body?.text;
    const urls = normalizeUrls(input);
    writeUrls(urls);
    res.json({ ok: true, urls });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.get('/api/files', async (_req, res) => {
  if (b2EndpointError) return res.status(500).json({ ok: false, error: b2EndpointError });
  try {
    const files = await listB2Files();
    res.json({ ok: true, bucket: B2_BUCKET, files });
  } catch (err) {
    console.error(`B2 list error: ${err.message}`);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/live-preview', (_req, res) => {
  if (!livePreviewBuffer) return res.status(404).send('No live preview available.');
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.end(livePreviewBuffer);
});

app.get('/api/preview', async (req, res) => {
  try {
    const key = validateKey(req.query.key);
    if (b2EndpointError) return res.status(500).send(b2EndpointError);
    if (!b2Configured) return res.status(503).send('B2 is not configured.');
    await streamB2Object(req, res, key, 'inline');
  } catch (err) {
    console.error(`B2 preview error: ${err.message}`);
    if (!res.headersSent) res.status(500).send(`Preview failed: ${err.message}`);
  }
});

app.get('/api/download', async (req, res) => {
  try {
    const key = validateKey(req.query.key);
    if (b2EndpointError) return res.status(500).send(b2EndpointError);
    if (!b2Configured) return res.status(503).send('B2 is not configured.');
    await streamB2Object(req, res, key, 'attachment');
  } catch (err) {
    console.error(`B2 download error for ${req.query.key}: ${err.message}`);
    if (!res.headersSent) res.status(500).send(`Download failed: ${err.message}`);
  }
});

app.post('/api/delete', async (req, res) => {
  try {
    const key = validateKey(req.body?.key);
    if (b2EndpointError) return res.status(500).json({ ok: false, error: b2EndpointError });
    if (!b2Configured) return res.status(503).json({ ok: false, error: 'B2 is not configured.' });
    await s3.send(new DeleteObjectCommand({ Bucket: B2_BUCKET, Key: key }));
    removeLocalRecording(path.basename(key));
    res.json({ ok: true, deleted: key });
  } catch (err) {
    console.error(`B2 delete error: ${err.message}`);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/delete-many', async (req, res) => {
  try {
    const keys = Array.from(new Set((Array.isArray(req.body?.keys) ? req.body.keys : []).map(validateKey)));
    if (!keys.length) return res.status(400).json({ ok: false, error: 'No files selected.' });
    if (b2EndpointError) return res.status(500).json({ ok: false, error: b2EndpointError });
    if (!b2Configured) return res.status(503).json({ ok: false, error: 'B2 is not configured.' });
    await s3.send(new DeleteObjectsCommand({
      Bucket: B2_BUCKET,
      Delete: { Objects: keys.map(Key => ({ Key })) },
    }));
    for (const key of keys) removeLocalRecording(path.basename(key));
    res.json({ ok: true, deleted: keys });
  } catch (err) {
    console.error(`B2 bulk delete error: ${err.message}`);
    res.status(500).json({ ok: false, error: err.message });
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
    filesError = b2EndpointError || 'B2 is not configured. Check B2_ENDPOINT, B2_REGION, B2_BUCKET, B2_KEY_ID and B2_APPLICATION_KEY.';
  }

  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const fmtBytes = n => {
    if (!n) return '0 B';
    const units = ['B','KB','MB','GB'];
    const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
    return (n / Math.pow(1024, i)).toFixed(i ? 1 : 0) + ' ' + units[i];
  };

  const qualityOptions = Object.entries(QUALITY_PRESETS)
    .map(([label, p]) => `<option value="${label}" ${label === settings.quality ? 'selected' : ''}>${label} — ${p.width}×${p.height}</option>`)
    .join('');

  const fileRows = files.length ? files.map((f, i) => `
    <div class="file-card" data-key="${esc(f.key)}">
      <div class="file-head">
        <label class="check-wrap"><input class="file-check" type="checkbox" value="${esc(f.key)}"> <span>Select</span></label>
        <div class="file-name" title="${esc(f.filename)}">${esc(f.filename)}</div>
        <div class="file-meta">${fmtBytes(f.size)} · ${f.lastModified ? esc(new Date(f.lastModified).toLocaleString()) : ''}</div>
      </div>
      <video class="preview-video" controls preload="metadata" src="${esc(f.previewUrl)}"></video>
      <div class="file-actions">
        <a class="btn" href="${esc(f.downloadUrl)}">Download</a>
        <button class="btn danger" onclick="deleteFile(${JSON.stringify(f.key)})">Delete</button>
      </div>
    </div>`).join('') : (filesError ? `<div class="error-box">B2 file list error: ${esc(filesError)}</div>` : `<div class="empty">No WebM recordings found.</div>`);

  res.type('html').send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pella Render Recorder</title>
<style>
:root { color-scheme: light; font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
* { box-sizing: border-box; }
body { margin: 0; background: #f4f6f9; color: #14171a; }
main { max-width: 1180px; margin: 0 auto; padding: 24px 16px 60px; }
.top { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; flex-wrap: wrap; }
h1 { margin: 0 0 8px; font-size: 28px; }
h2 { margin: 0 0 12px; font-size: 19px; }
.card { background: #fff; border: 1px solid #dfe3e8; border-radius: 14px; padding: 18px; margin-bottom: 16px; box-shadow: 0 2px 12px rgba(0,0,0,.04); }
.status { font-size: 14px; color: #55606b; }
.status.ok { color: #0a6d4a; }
.status.error { color: #a32323; }
.actions, .file-actions, .inline { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
button, a.btn, select, input, textarea { font: inherit; }
button, a.btn { display: inline-flex; align-items: center; justify-content: center; padding: 10px 13px; border-radius: 9px; border: 1px solid #b9c0c7; background: #fff; color: #111; text-decoration: none; cursor: pointer; }
button.primary { background: #111827; color: #fff; border-color: #111827; }
button.danger { background: #fff2f2; color: #a11; border-color: #efb2b2; }
button:hover, a.btn:hover { background: #f0f2f4; }
button.primary:hover { background: #222a38; }
textarea, input[type=text], input[type=number], select { border: 1px solid #c8cdd3; border-radius: 9px; padding: 10px 12px; background: #fff; width: 100%; }
textarea { min-height: 150px; resize: vertical; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.field { display: grid; gap: 6px; }
label { font-size: 13px; font-weight: 600; }
.help, .small { color: #69737d; font-size: 13px; }
.preview-wrap { background: #111; border-radius: 12px; overflow: hidden; min-height: 240px; display: flex; align-items: center; justify-content: center; }
#livePreview { max-width: 100%; width: 100%; display: block; background: #111; }
.live-empty { color: #cbd0d6; padding: 40px; text-align: center; }
.file-tools { display: flex; justify-content: space-between; gap: 12px; align-items: center; flex-wrap: wrap; margin-bottom: 12px; }
.recordings { display: grid; gap: 14px; }
.file-card { border: 1px solid #e0e4e8; border-radius: 12px; padding: 12px; background: #fbfcfd; }
.file-head { display: grid; grid-template-columns: auto 1fr auto; gap: 10px; align-items: center; margin-bottom: 10px; }
.check-wrap { display: flex; align-items: center; gap: 6px; font-weight: 500; }
.file-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.file-meta { color: #6b737d; font-size: 13px; white-space: nowrap; }
.preview-video { display: block; width: 100%; max-height: 420px; background: #000; border-radius: 10px; }
.error-box { padding: 12px; background: #fff1f1; border: 1px solid #efb4b4; color: #992020; border-radius: 10px; }
.empty { padding: 18px; color: #6d7680; border: 1px dashed #cbd1d7; border-radius: 10px; text-align: center; }
.badge { display: inline-block; padding: 4px 8px; border-radius: 999px; background: #edf1f5; font-size: 12px; margin-right: 5px; }
@media (max-width: 760px) { .grid2 { grid-template-columns: 1fr; } .file-head { grid-template-columns: 1fr; } .file-meta { white-space: normal; } }
</style>
</head>
<body>
<main>
  <section class="card">
    <div class="top">
      <div>
        <h1>Pella Render Recorder</h1>
        <div id="status" class="status">Running: ${running ? 'YES' : 'NO'}${currentUrl ? ` · Current: ${esc(currentUrl)}` : ''} · B2: ${b2Configured ? 'configured' : 'not configured'} · Bucket: ${esc(B2_BUCKET || 'not set')} · Version: ${APP_VERSION}</div>
        <div class="small" style="margin-top:6px">Selected quality: <span id="statusQuality" class="badge">${esc(settings.quality)}</span> ${settings.width}×${settings.height} · ${settings.recordSeconds}s per URL · Panel URLs are used on manual start</div>
      </div>
      <div class="actions">
        <button class="primary" onclick="startRecorder()">Start Recording</button>
        <button onclick="stopRecorder()">Stop</button>
        <button onclick="refreshAll()">Refresh</button>
      </div>
    </div>
  </section>

  <section class="card">
    <h2>Recording Settings</h2>
    <div class="grid2">
      <div class="field">
        <label for="quality">Video quality</label>
        <select id="quality">${qualityOptions}</select>
        <div class="help">Lower resolutions use less CPU and storage. 720p and 1080p produce larger recordings and need more Render resources.</div>
      </div>
      <div class="field">
        <label for="recordSeconds">Seconds per URL</label>
        <input id="recordSeconds" type="number" min="1" max="3600" value="${settings.recordSeconds}">
        <div class="help">The selected quality is applied to the next recording run.</div>
      </div>
    </div>
    <div class="actions" style="margin-top:12px"><button onclick="saveSettings()">Save Recording Settings</button></div>
  </section>

  <section class="card">
    <h2>URLs to Record</h2>
    <div class="field">
      <label for="urls">Multiple links — one URL per line</label>
      <textarea id="urls">${esc(urls.join('\n'))}</textarea>
      <div class="help">Paste one or more links here. <b>Start Recording always uses these panel links.</b> urls.txt is only the saved copy / fallback.</div>
    </div>
    <div class="inline" style="margin-top:10px">
      <input id="newUrl" type="text" placeholder="https://example.com/video-page">
      <button onclick="addUrl()">Add URL</button>
      <button onclick="saveUrls()">Save URL List</button>
      <button onclick="loadSavedUrls()">Load urls.txt</button>
    </div>
  </section>

  <section class="card">
    <div class="top"><div><h2>Live Screen Preview</h2><div id="liveText" class="small">Start a recording to see the current page here.</div></div><span id="liveQuality" class="badge">${esc(settings.quality)} · ${settings.width}×${settings.height}</span></div>
    <div class="preview-wrap" style="margin-top:12px"><div id="liveEmpty" class="live-empty">No active recording preview.</div><img id="livePreview" alt="Live recording preview" style="display:none"></div>
  </section>

  <section class="card">
    <div class="file-tools">
      <div><h2 style="margin-bottom:4px">B2 Recordings</h2><div class="small">Preview, download, or delete recordings stored in your private Backblaze bucket.</div></div>
      <div class="actions"><button onclick="selectAllFiles()">Select All</button><button class="danger" onclick="deleteSelected()">Delete Selected</button></div>
    </div>
    <div id="files" class="recordings">${fileRows}</div>
  </section>
</main>
<script>
async function api(url, options) {
  const r = await fetch(url, options);
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = { error: text }; }
  if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
  return data;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function fmtBytes(n) {
  if (!n) return '0 B';
  const units = ['B','KB','MB','GB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  return (n / Math.pow(1024, i)).toFixed(i ? 1 : 0) + ' ' + units[i];
}
function updateLivePreview(status) {
  const img = document.getElementById('livePreview');
  const empty = document.getElementById('liveEmpty');
  const text = document.getElementById('liveText');
  const quality = document.getElementById('liveQuality');
  if (quality) quality.textContent = status.settings.quality + ' · ' + status.settings.width + '×' + status.settings.height;
  if (status.running && status.currentUrl) {
    img.src = '/api/live-preview?ts=' + Date.now();
    img.style.display = 'block';
    empty.style.display = 'none';
    text.textContent = 'Recording: ' + status.currentUrl + ' · URL #' + (Number(status.currentIndex) + 1);
  } else {
    img.style.display = 'none';
    empty.style.display = 'block';
    text.textContent = 'Start a recording to see the current page here.';
  }
}
async function refreshStatus() {
  try {
    const s = await api('/api/status');
    const el = document.getElementById('status');
    el.textContent = 'Running: ' + (s.running ? 'YES' : 'NO') + (s.currentUrl ? ' · Current: ' + s.currentUrl : '') + ' · Source: ' + (s.runSource || 'panel') + ' · B2: ' + (s.b2Configured ? 'configured' : 'not configured') + (s.bucket ? ' · Bucket: ' + s.bucket : '') + ' · Version: ' + '${APP_VERSION}';
    el.className = 'status ' + (s.lastError ? 'error' : 'ok');
    document.getElementById('statusQuality').textContent = s.settings.quality;
    updateLivePreview(s);
    document.getElementById('quality').value = s.settings.quality;
    document.getElementById('recordSeconds').value = s.settings.recordSeconds;
  } catch (e) {
    const el = document.getElementById('status');
    el.textContent = 'Status error: ' + e.message;
    el.className = 'status error';
  }
}
async function refreshFiles() {
  try {
    const data = await api('/api/files');
    const html = data.files.length ? data.files.map(function(f) {
      return '<div class="file-card" data-key="' + escapeHtml(f.key) + '">' +
        '<div class="file-head">' +
          '<label class="check-wrap"><input class="file-check" type="checkbox" value="' + escapeHtml(f.key) + '"> <span>Select</span></label>' +
          '<div class="file-name" title="' + escapeHtml(f.filename) + '">' + escapeHtml(f.filename) + '</div>' +
          '<div class="file-meta">' + fmtBytes(f.size) + ' · ' + (f.lastModified ? escapeHtml(new Date(f.lastModified).toLocaleString()) : '') + '</div>' +
        '</div>' +
        '<video class="preview-video" controls preload="metadata" src="' + escapeHtml(f.previewUrl) + '"></video>' +
        '<div class="file-actions" style="margin-top:10px"><a class="btn" href="' + escapeHtml(f.downloadUrl) + '">Download</a><button class="btn danger" onclick='deleteFile(' + JSON.stringify(f.key).replace(/'/g, '&#39;') + ')'>Delete</button></div>' +
      '</div>';
    }).join('') : '<div class="empty">No WebM recordings found.</div>';
    document.getElementById('files').innerHTML = html;
  } catch (e) {
    document.getElementById('files').innerHTML = '<div class="error-box">B2 file list error: ' + escapeHtml(e.message) + '</div>';
  }
}
async function loadSavedUrls() {
  try {
    const data = await api('/api/urls');
    document.getElementById('urls').value = data.urls.join('\n');
  } catch (e) { alert('Could not load urls.txt: ' + e.message); }
}
async function refreshAll(initial = false) {
  await Promise.all([refreshStatus(), refreshFiles()]);
  // Never overwrite unsaved text in the panel during a recording. Only load saved URLs on first page load.
  if (initial) await loadSavedUrls();
}
async function startRecorder() {
  const startBtn = document.querySelector('button.primary');
  try {
    const raw = document.getElementById('urls').value;
    const panelUrls = raw.split(/\r?\n/).map(v => v.trim()).filter(Boolean);
    if (!panelUrls.length) throw new Error('Paste at least one URL in the panel before starting.');

    await saveSettings(true);
    startBtn.disabled = true;
    startBtn.textContent = 'Starting…';
    const data = await api('/api/start', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ urls: panelUrls })
    });
    document.getElementById('urls').value = data.urls.join('\n');
    await refreshAll(false);
  } catch (e) {
    alert(e.message);
  } finally {
    startBtn.disabled = false;
    startBtn.textContent = 'Start Recording';
  }
}
async function stopRecorder() {
  try { await api('/api/stop', {method:'POST'}); await refreshStatus(); }
  catch (e) { alert(e.message); }
}
async function saveSettings(silent) {
  try {
    const data = await api('/api/settings', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ quality:document.getElementById('quality').value, recordSeconds:Number(document.getElementById('recordSeconds').value) }) });
    document.getElementById('statusQuality').textContent = data.settings.quality;
    if (!silent) alert('Recording settings saved.');
    return data;
  } catch (e) { if (!silent) alert(e.message); throw e; }
}
async function saveUrls(silent) {
  try {
    const text = document.getElementById('urls').value;
    const data = await api('/api/urls', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ text }) });
    document.getElementById('urls').value = data.urls.join('\n');
    if (!silent) alert('URL list saved: ' + data.urls.length + ' link(s).');
    return data;
  } catch (e) { if (!silent) alert(e.message); throw e; }
}
function addUrl() {
  const input = document.getElementById('newUrl');
  const value = input.value.trim();
  if (!value) return;
  try {
    const u = new URL(value);
    if (!/^https?:$/.test(u.protocol)) throw new Error('Only http:// and https:// are allowed.');
  } catch (e) {
    alert('Invalid URL: ' + e.message);
    return;
  }
  const box = document.getElementById('urls');
  box.value = box.value.trim() ? box.value.trim() + '\n' + value : value;
  input.value = '';
}
function selectAllFiles() {
  const boxes = Array.from(document.querySelectorAll('.file-check'));
  const shouldCheck = boxes.some(b => !b.checked);
  boxes.forEach(b => b.checked = shouldCheck);
}
async function deleteFile(key) {
  if (!confirm('Delete this recording from Backblaze B2?\n\n' + key)) return;
  try {
    await api('/api/delete', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ key }) });
    await refreshFiles();
  } catch (e) { alert('Delete failed: ' + e.message); }
}
async function deleteSelected() {
  const keys = Array.from(document.querySelectorAll('.file-check:checked')).map(x => x.value);
  if (!keys.length) return alert('Select at least one recording.');
  if (!confirm('Delete ' + keys.length + ' selected recording(s) from Backblaze B2?')) return;
  try {
    await api('/api/delete-many', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ keys }) });
    await refreshFiles();
  } catch (e) { alert('Delete failed: ' + e.message); }
}
setInterval(() => { refreshStatus(); }, 2000);
setInterval(() => { refreshFiles(); }, 7000);
refreshAll(true);
</script>
</body>
</html>`);
});

const server = http.createServer(app);
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Recorder dashboard listening on 0.0.0.0:${PORT}`);
  console.log(`B2 configured: ${b2Configured}`);
  console.log(`B2 bucket: ${B2_BUCKET || '(not set)'}`);
  console.log(`B2 endpoint: ${B2_ENDPOINT || '(not set)'}`);
  if (b2EndpointError) console.log(b2EndpointError);
  console.log(`PLAYWRIGHT_BROWSERS_PATH=${process.env.PLAYWRIGHT_BROWSERS_PATH || '(not set)'}`);
  console.log(`URLS_FILE=${URLS_FILE}`);
  console.log(`Recorder settings: ${settings.quality} (${settings.width}x${settings.height}), ${settings.recordSeconds}s per URL`);
  if (AUTO_START) runRecorder().catch(err => console.error(`Auto-start error: ${err.message}`));
});

async function shutdown() {
  stopRequested = true;
  try { if (browser) await browser.close(); } catch (_) {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
