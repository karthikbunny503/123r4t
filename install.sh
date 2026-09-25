#!/bin/sh
set -e
npm install
PLAYWRIGHT_BROWSERS_PATH=0 npx playwright install chromium
printf '\nInstalled. Run: npm start\n'
