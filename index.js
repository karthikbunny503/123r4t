require("dotenv").config();

const express = require("express");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const {
  S3Client,
  PutObjectCommand
} = require("@aws-sdk/client-s3");

const app = express();
app.use(express.json({ limit: "1mb" }));

// -----------------------------
// Configuration
// -----------------------------
const PORT = Number(process.env.PORT || 10000);
const VIDEO_WIDTH = Number(process.env.VIDEO_WIDTH || 854);
const VIDEO_HEIGHT = Number(process.env.VIDEO_HEIGHT || 480);
const PAGE_TIMEOUT_MS = Number(process.env.PAGE_TIMEOUT_MS || 60000);
const PAGE_WARMUP_MS = Number(process.env.PAGE_WARMUP_MS || 3000);
const RECORD_SECONDS = Number(process.env.RECORD_SECONDS || 30);
const URLS_FILE = process.env.URLS_FILE || "./urls.txt";
const RECORDINGS_DIR = path.resolve(
  process.env.RECORDINGS_DIR || "./recordings"
);
const AUTO_START =
  String(process.env.AUTO_START || "false").toLowerCase() === "true";
const DELETE_LOCAL_AFTER_UPLOAD =
  String(process.env.DELETE_LOCAL_AFTER_UPLOAD || "false").toLowerCase() === "true";

fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

// -----------------------------
// Runtime state
// -----------------------------
let browser = null;
let queueRunning = false;
let stopRequested = false;
let currentUrl = "";
let currentIndex = 0;
let totalUrls = 0;
let queueStartedAt = null;
let lastResult = null;
let lastError = "";
let b2Test = {
  checked: false,
  ok: null,
  message: "B2 credentials are validated when the first recording is uploaded."
};

const LOG_LIMIT = 200;
const logLines = [];

function log(message, level = "INFO") {
  const line = `[${new Date().toISOString()}] [${level}] ${message}`;
  logLines.push(line);
  if (logLines.length > LOG_LIMIT) logLines.shift();

  if (level === "ERROR") {
    console.error(line);
  } else if (level === "WARN") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

function safeFileName(input) {
  return (
    String(input || "recording")
      .replace(/[^\p{L}\p{N}\-_ ]/gu, "")
      .trim()
      .replace(/\s+/g, "_")
      .slice(0, 100) || "recording"
  );
}

function getB2Config() {
  return {
    endpoint: String(process.env.B2_ENDPOINT || "").trim().replace(/\/+$/, ""),
    region: String(process.env.B2_REGION || "").trim(),
    bucket: String(process.env.B2_BUCKET || "").trim(),
    keyId: String(process.env.B2_KEY_ID || "").trim(),
    applicationKey: String(process.env.B2_APPLICATION_KEY || "").trim()
  };
}

function missingB2Fields() {
  const c = getB2Config();
  const required = {
    B2_ENDPOINT: c.endpoint,
    B2_REGION: c.region,
    B2_BUCKET: c.bucket,
    B2_KEY_ID: c.keyId,
    B2_APPLICATION_KEY: c.applicationKey
  };

  return Object.entries(required)
    .filter(([, value]) => !value)
    .map(([key]) => key);
}

function b2Configured() {
  return missingB2Fields().length === 0;
}

function getB2Client() {
  const c = getB2Config();
  return new S3Client({
    region: c.region,
    endpoint: c.endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: c.keyId,
      secretAccessKey: c.applicationKey
    }
  });
}

async function uploadToB2(filePath, objectKey) {
  const missing = missingB2Fields();

  if (missing.length) {
    return {
      uploaded: false,
      reason: `B2 environment incomplete: ${missing.join(", ")}`
    };
  }

  try {
    const c = getB2Config();

    await getB2Client().send(
      new PutObjectCommand({
        Bucket: c.bucket,
        Key: objectKey,
        Body: fs.createReadStream(filePath),
        ContentType: "video/webm"
      })
    );

    return {
      uploaded: true,
      bucket: c.bucket,
      key: objectKey
    };
  } catch (error) {
    return {
      uploaded: false,
      reason: error?.message || String(error),
      name: error?.name || "UnknownError",
      code: error?.Code || error?.code || null,
      httpStatus: error?.$metadata?.httpStatusCode || null
    };
  }
}

function loadUrls() {
  if (!fs.existsSync(URLS_FILE)) {
    throw new Error(`Missing ${URLS_FILE}. Create it with one URL per line.`);
  }

  const lines = fs.readFileSync(URLS_FILE, "utf8")
    .split(/\r?\n/)
    .map(line => line.trim());

  const urls = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (!line || line.startsWith("#")) continue;

    try {
      const parsed = new URL(line);
      if (!["http:", "https:"].includes(parsed.protocol)) {
        throw new Error("Only HTTP/HTTPS URLs are supported.");
      }
    } catch {
      throw new Error(`Invalid URL on line ${i + 1}: ${line}`);
    }

    urls.push(line);
  }

  return urls;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function launchBrowser() {
  if (browser) return;

  const executable = chromium.executablePath();
  log(`PLAYWRIGHT_BROWSERS_PATH=${process.env.PLAYWRIGHT_BROWSERS_PATH || "(default)"}`);
  log(`Playwright executable path: ${executable}`);

  if (!executable || !fs.existsSync(executable)) {
    throw new Error(
      "Playwright Chromium is not available at runtime. In Render, set PLAYWRIGHT_BROWSERS_PATH=0 and use the build command: npm install && PLAYWRIGHT_BROWSERS_PATH=0 npx playwright install chromium"
    );
  }

  log(`Launching Chromium: ${executable}`);

  browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-background-networking",
      "--disable-extensions",
      "--disable-default-apps"
    ]
  });

  log("Chromium launched.");
}

async function restartBrowser() {
  try {
    await browser?.close();
  } catch {}

  browser = null;
  await launchBrowser();
}

async function recordOneUrl(url, index, total) {
  currentUrl = url;
  currentIndex = index;
  totalUrls = total;

  log(`[${index}/${total}] Opening ${url}`);

  let context = null;

  try {
    await launchBrowser();

    context = await browser.newContext({
      viewport: {
        width: VIDEO_WIDTH,
        height: VIDEO_HEIGHT
      },
      recordVideo: {
        dir: RECORDINGS_DIR,
        size: {
          width: VIDEO_WIDTH,
          height: VIDEO_HEIGHT
        }
      }
    });

    const page = await context.newPage();

    page.on("console", msg => {
      if (msg.type() === "error") {
        log(`[page console] ${msg.text()}`, "WARN");
      }
    });

    page.on("pageerror", error => {
      log(`[page error] ${error.message}`, "WARN");
    });

    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: PAGE_TIMEOUT_MS
    });

    log(`[${index}/${total}] Page loaded.`);
    await page.waitForTimeout(PAGE_WARMUP_MS);

    let mediaInfo = {
      videoElements: 0,
      audioElements: 0
    };

    try {
      mediaInfo = await page.evaluate(async () => {
        const videos = Array.from(document.querySelectorAll("video"));
        const audios = Array.from(document.querySelectorAll("audio"));

        for (const video of videos) {
          try {
            video.scrollIntoView({ block: "center" });
            video.muted = false;
            await video.play();
          } catch {}
        }

        return {
          videoElements: videos.length,
          audioElements: audios.length
        };
      });
    } catch (error) {
      log(
        `[${index}/${total}] Could not inspect/play HTML5 media: ${error.message}`,
        "WARN"
      );
    }

    log(
      `[${index}/${total}] Media elements: ${mediaInfo.videoElements} video, ${mediaInfo.audioElements} audio`
    );

    if (mediaInfo.videoElements === 0) {
      log(
        `[${index}/${total}] WARNING: No HTML5 <video> element was detected. The page itself will still be recorded.`,
        "WARN"
      );
    }

    const title = await page.title().catch(() => "recording");
    const recordedVideo = page.video();

    log(
      `[${index}/${total}] Recording ${RECORD_SECONDS} seconds...`
    );

    const startTime = Date.now();

    while (
      !stopRequested &&
      Date.now() - startTime < RECORD_SECONDS * 1000
    ) {
      await sleep(1000);
    }

    if (stopRequested) {
      log(`[${index}/${total}] Stop requested.`);
    }

    await context.close();

    const tempPath = await recordedVideo.path();

    if (!tempPath || !fs.existsSync(tempPath)) {
      throw new Error(
        "Playwright did not produce a video file after closing the context."
      );
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const fileName =
      `${String(index).padStart(3, "0")}_${stamp}_${safeFileName(title)}.webm`;

    const finalPath = path.join(RECORDINGS_DIR, fileName);
    fs.copyFileSync(tempPath, finalPath);

    const sizeBytes = fs.statSync(finalPath).size;
    const objectKey = `recordings/${fileName}`;

    log(
      `[${index}/${total}] Recording saved locally: ${fileName} (${(sizeBytes / 1024 / 1024).toFixed(2)} MB)`
    );

    const upload = await uploadToB2(finalPath, objectKey);

    if (upload.uploaded) {
      log(`[${index}/${total}] B2 upload OK: ${objectKey}`);

      if (DELETE_LOCAL_AFTER_UPLOAD) {
        try {
          fs.unlinkSync(finalPath);
          log(`[${index}/${total}] Local file deleted after B2 upload.`);
        } catch (error) {
          log(
            `[${index}/${total}] Could not delete local file: ${error.message}`,
            "WARN"
          );
        }
      }
    } else {
      log(
        `[${index}/${total}] B2 upload failed: ${upload.reason}`,
        "ERROR"
      );
    }

    const result = {
      ok: true,
      url,
      fileName,
      sizeBytes,
      localUrl: `/recordings/${encodeURIComponent(fileName)}`,
      b2: upload,
      mediaInfo
    };

    lastResult = result;
    return result;

  } catch (error) {
    const message = error?.message || String(error);

    log(`[${index}/${total}] FAILED: ${message}`, "ERROR");

    const result = {
      ok: false,
      url,
      error: message
    };

    lastResult = result;

    // If the browser process is dead, try a fresh instance before the next URL.
    try {
      await restartBrowser();
    } catch (restartError) {
      log(
        `Browser restart failed: ${restartError.message}`,
        "ERROR"
      );
    }

    return result;

  } finally {
    try {
      await context?.close();
    } catch {}

    currentUrl = "";
  }
}

async function runQueue() {
  if (queueRunning) return;

  queueRunning = true;
  stopRequested = false;
  queueStartedAt = Date.now();
  lastResult = null;
  lastError = "";

  try {
    const urls = loadUrls();

    totalUrls = urls.length;

    if (!urls.length) {
      throw new Error(`${URLS_FILE} contains no URLs.`);
    }

    log(`Queue loaded: ${urls.length} URL(s).`);

    await launchBrowser();

    for (let i = 0; i < urls.length; i++) {
      if (stopRequested) break;

      await recordOneUrl(urls[i], i + 1, urls.length);
    }

    if (stopRequested) {
      log("Queue stopped by user.", "WARN");
    } else {
      log("Queue finished.");
    }

  } catch (error) {
    lastError = error?.message || String(error);
    log(`QUEUE ERROR: ${lastError}`, "ERROR");

  } finally {
    queueRunning = false;
    currentUrl = "";
    currentIndex = 0;
  }
}

// -----------------------------
// Web UI
// -----------------------------
app.get("/", (req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Video Recorder</title>
<style>
body{font-family:Arial,sans-serif;background:#101218;color:#eee;max-width:950px;margin:30px auto;padding:20px}
.card{background:#191d25;border:1px solid #303744;border-radius:16px;padding:22px;margin-bottom:16px}
h1{margin-top:0}
button{width:100%;padding:13px;margin:7px 0;border:0;border-radius:9px;cursor:pointer;font-weight:700}
.start{background:#1fa463;color:#fff}.stop{background:#c94e4e;color:#fff}.refresh{background:#374151;color:#fff}
pre{background:#0b0e13;border-radius:10px;padding:14px;white-space:pre-wrap;overflow:auto}
.ok{color:#62d892}.bad{color:#ff7777}.warn{color:#ffc766}
</style>
</head>
<body>
<div class="card">
<h1>Render Web Video Recorder</h1>
<p>URLs are loaded from <code>${URLS_FILE}</code>. No URL input is required.</p>
<button class="start" onclick="startQueue()">Start Queue</button>
<button class="stop" onclick="stopQueue()">Stop Queue</button>
<button class="refresh" onclick="refresh()">Refresh Status</button>
</div>

<div class="card">
<h2>Status</h2>
<pre id="status">Loading...</pre>
</div>

<div class="card">
<h2>Diagnostics</h2>
<pre id="diagnostics">Loading...</pre>
</div>

<div class="card">
<h2>Logs</h2>
<pre id="logs">Loading...</pre>
</div>

<script>
async function fetchJson(url, options) {
  const r = await fetch(url, options);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || ("HTTP " + r.status));
  return data;
}

async function startQueue() {
  try {
    const d = await fetchJson("/api/start", {method:"POST"});
    document.getElementById("status").textContent = d.message;
  } catch (e) {
    document.getElementById("status").textContent = "ERROR: " + e.message;
  }
  refresh();
}

async function stopQueue() {
  try {
    const d = await fetchJson("/api/stop", {method:"POST"});
    document.getElementById("status").textContent = d.message;
  } catch (e) {
    document.getElementById("status").textContent = "ERROR: " + e.message;
  }
  refresh();
}

async function refresh() {
  try {
    const [status, diag, logs] = await Promise.all([
      fetchJson("/api/status"),
      fetchJson("/api/diagnostics"),
      fetchJson("/api/logs")
    ]);

    document.getElementById("status").textContent =
      JSON.stringify(status, null, 2);

    document.getElementById("diagnostics").textContent =
      JSON.stringify(diag, null, 2);

    document.getElementById("logs").textContent =
      logs.lines.join("\\n");
  } catch (e) {
    document.getElementById("status").textContent =
      "Dashboard error: " + e.message;
  }
}

refresh();
setInterval(refresh, 3000);
</script>
</body>
</html>`);
});

// -----------------------------
// Health/status/diagnostics
// -----------------------------
app.get("/health", (req, res) => {
  res.status(200).type("text").send("OK");
});

app.get("/api/status", (req, res) => {
  let urlCount = 0;

  try {
    urlCount = loadUrls().length;
  } catch {}

  res.json({
    ok: true,
    running: queueRunning,
    currentUrl,
    currentIndex,
    totalUrls,
    urlCount,
    startedAt: queueStartedAt,
    b2Configured: b2Configured(),
    b2Test,
    lastError,
    lastResult
  });
});

app.get("/api/diagnostics", async (req, res) => {
  let urls = [];
  let urlsError = "";

  try {
    urls = loadUrls();
  } catch (error) {
    urlsError = error.message || String(error);
  }

  const b2 = {
    configured: b2Configured(),
    missingFields: missingB2Fields(),
    message: b2Configured()
      ? "B2 environment variables are present. Actual upload will test the credentials."
      : `Missing: ${missingB2Fields().join(", ")}`
  };

  let chromiumInstalled = false;
  let chromiumPath = "";

  try {
    chromiumPath = chromium.executablePath();
    chromiumInstalled = Boolean(
      chromiumPath && fs.existsSync(chromiumPath)
    );
  } catch {}

  let disk = null;

  try {
    const stat = fs.statSync(RECORDINGS_DIR);
    disk = {
      recordingsDir: RECORDINGS_DIR,
      exists: stat.isDirectory()
    };
  } catch {}

  res.json({
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    port: PORT,
    bindAddress: "0.0.0.0",
    video: {
      width: VIDEO_WIDTH,
      height: VIDEO_HEIGHT,
      secondsPerUrl: RECORD_SECONDS
    },
    chromium: {
      installed: chromiumInstalled,
      executablePath: chromiumPath
    },
    urls: {
      file: URLS_FILE,
      count: urls.length,
      error: urlsError || null,
      values: urls
    },
    b2: {
      configured: b2.configured,
      missingFields: b2.missingFields,
      message: b2.message
    },
    recordings: disk,
    autoStart: AUTO_START,
    deleteLocalAfterUpload: DELETE_LOCAL_AFTER_UPLOAD
  });
});

app.get("/api/logs", (req, res) => {
  res.json({ lines: logLines });
});

// -----------------------------
// Queue controls
// -----------------------------
app.post("/api/start", (req, res) => {
  if (queueRunning) {
    return res.status(409).json({
      ok: false,
      error: "Queue is already running."
    });
  }

  // Start in background; report errors in the dashboard and Render logs.
  runQueue().catch(error => {
    lastError = error?.message || String(error);
    log(`Queue worker rejected: ${lastError}`, "ERROR");
  });

  return res.json({
    ok: true,
    message: "Queue started. Open Diagnostics/Logs for progress."
  });
});

app.post("/api/stop", (req, res) => {
  if (!queueRunning) {
    return res.json({
      ok: true,
      message: "Queue is not running."
    });
  }

  stopRequested = true;

  return res.json({
    ok: true,
    message:
      "Stop requested. The current recording will finish its current second and then stop."
  });
});

// Serve saved local recordings while they exist.
app.use("/recordings", express.static(RECORDINGS_DIR));

// -----------------------------
// Start server
// -----------------------------
app.listen(PORT, "0.0.0.0", async () => {
  log("==============================================");
  log("Pella + Render + Playwright + Backblaze B2 Recorder");
  log(`Port: ${PORT}`);
  log(`Video: ${VIDEO_WIDTH}x${VIDEO_HEIGHT}`);
  log(`URL file: ${URLS_FILE}`);
  log(`B2 configured: ${b2Configured()}`);
  log(`Auto start: ${AUTO_START}`);
  log("==============================================");

  if (AUTO_START) {
    setTimeout(() => {
      runQueue().catch(error => {
        lastError = error?.message || String(error);
        log(`AUTO-START ERROR: ${lastError}`, "ERROR");
      });
    }, 2000);
  }
});

async function shutdown(signal) {
  log(`Received ${signal}. Shutting down...`, "WARN");
  stopRequested = true;

  try {
    await browser?.close();
  } catch {}

  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
