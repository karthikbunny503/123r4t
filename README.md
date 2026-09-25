# Pella + Render + Playwright + Backblaze B2 Recorder v9

## Render settings

Language: Node

Build Command:
    npm install && PLAYWRIGHT_BROWSERS_PATH=0 npx playwright install chromium

Start Command:
    npm start

Health Check Path:
    /health

## Render environment variables

Set these on the Render service itself (or link an Environment Group):

    PORT=10000
    PLAYWRIGHT_BROWSERS_PATH=0

    B2_ENDPOINT=https://s3.us-east-005.backblazeb2.com
    B2_REGION=us-east-005
    B2_BUCKET=wispbyte-recordings-2026
    B2_KEY_ID=YOUR_NEW_KEY_ID
    B2_APPLICATION_KEY=YOUR_NEW_APPLICATION_KEY

    VIDEO_WIDTH=854
    VIDEO_HEIGHT=480
    RECORD_SECONDS=30
    PAGE_TIMEOUT_MS=60000
    PAGE_WARMUP_MS=3000
    URLS_FILE=./urls.txt
    RECORDINGS_DIR=./recordings
    AUTO_START=false
    DELETE_LOCAL_AFTER_UPLOAD=false

Never put a real application key into source control.

## URLs

Edit urls.txt. One authorized webpage URL per line:

    https://wispbyte.com/

Comments beginning with # are ignored.

## Start

Open the Render URL and click Start Queue.

## What to expect in logs

    B2 configured: true
    PLAYWRIGHT_BROWSERS_PATH=0
    Playwright executable path: .../node_modules/playwright-core/.local-browsers/...
    Chromium launched.
    [1/1] Opening https://wispbyte.com/
    [1/1] Page loaded.
    [1/1] Recording 30 seconds...
    [1/1] Recording saved locally: ...webm
    [1/1] B2 upload OK: recordings/...

## If B2 configured is false

The Render Environment section is missing at least one of:

    B2_ENDPOINT
    B2_REGION
    B2_BUCKET
    B2_KEY_ID
    B2_APPLICATION_KEY

Add them to the Render service Environment variables and redeploy.

## Backblaze key

Use a normal restricted Application Key, not the Master Application Key.
Recommended scope for this recorder:
- bucket: your recording bucket only
- read/write
- listAllBucketNames enabled if shown
- file prefix: recordings/

## Important limitations

This records the rendered webpage with Playwright/Chromium. It does not extract a hidden video URL or bypass DRM, paywalls, login restrictions, bot protection, or other access controls. Normal Playwright page video recording does not provide synchronized browser-tab/system audio.
