# Pella Render Recorder v15

Paste one or more URLs directly into the panel. **Start Recording uses exactly the URLs currently in the panel immediately** and also saves them to `urls.txt`.

`urls.txt` remains the fallback/default URL list for runs started outside the panel.

Features:
- Multiple URLs, one per line
- 240p, 360p, 480p, 540p, 720p, 1080p recording presets
- Live screen preview while recording
- Private Backblaze B2 preview, download, delete, and bulk delete


### URL behavior in v15
Manual Start Recording always uses the URLs currently pasted in the panel. The app saves the same list to `urls.txt`, but it never replaces the panel text during a run. `urls.txt` is only the saved list/fallback for non-panel starts.
