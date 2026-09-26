# Pella Render Recorder v13

A Render-friendly Playwright webpage recorder with:

- Multiple URLs entered directly in the dashboard (one URL per line)
- Selectable recording quality: 240p, 360p, 480p, 540p, 720p, 1080p
- Configurable seconds per URL
- Live screen preview while recording
- Private Backblaze B2 recording list
- Inline WebM playback in the panel
- Download from B2 through Render
- Delete individual recordings or multiple selected recordings
- B2 server-side encryption on upload

## Render

Build command:

```text
npm install && PLAYWRIGHT_BROWSERS_PATH=0 npx playwright install chromium
```

Start command:

```text
npm start
```

Keep these environment variables in Render:

```text
PORT=10000
PLAYWRIGHT_BROWSERS_PATH=0
URLS_FILE=./urls.txt
SETTINGS_FILE=./recorder-settings.json
RECORDINGS_DIR=./recordings
RECORD_SECONDS=30
PAGE_TIMEOUT_MS=60000
PAGE_WARMUP_MS=3000
DEFAULT_QUALITY=480p
AUTO_START=false
DELETE_LOCAL_AFTER_UPLOAD=false
B2_ENDPOINT=https://s3.us-east-005.backblazeb2.com
B2_REGION=us-east-005
B2_BUCKET=wispbyte-recordings-2026
B2_KEY_ID=YOUR_APPLICATION_KEY_ID
B2_APPLICATION_KEY=YOUR_APPLICATION_KEY
```

The B2 Application Key needs permissions to list, read, write, and delete the recording objects in the `recordings/` prefix. For S3-compatible delete calls, Backblaze documents using both `writeFiles` and `deleteFiles` capabilities. A bucket-restricted key should also have `listAllBucketNames` enabled for S3 SDK compatibility.

The dashboard preview plays the WebM directly from B2 through Render. The selected quality is used for the next recording run; it does not transcode an already-uploaded recording.

## Notes

- Selecting 720p or 1080p changes the Playwright viewport and WebM recording size for the next run.
- 1080p uses substantially more CPU, memory, and storage than lower presets.
- Multiple URLs are recorded sequentially in the order shown in the dashboard.
- The recorder records the rendered webpage. It is not intended to bypass DRM, paywalls, login restrictions, bot protection, or other access controls.
