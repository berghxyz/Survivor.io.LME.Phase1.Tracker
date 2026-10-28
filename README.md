# Survivor.io LME Phase 1 Tracker

A small zero-dependency web app for tracking weekly scores in the Survivor.io
LME Phase 1 event. Scores are parsed from in-game screenshots, stored in a
local SQLite database, and can be exported as CSV.

## Run

Requires Node.js 22.5+ (uses the built-in [`node:sqlite`](https://nodejs.org/api/sqlite.html) module); Node 24 is recommended.

```sh
node server.js        # -> http://127.0.0.1:8787
```

Configure with `PORT` and `HOST` environment variables if needed.

All runtime data lives in `data/` (git-ignored):

- `data/birds.db` — the SQLite database
- `data/uploads/phase1/<week>/` — uploaded screenshots

## Layout

- `server.js` — HTTP server, static file serving, and API routes
- `lib/` — storage (`db.js`), week helpers (`week.js`), text parsing (`text.js`)
- `public/` — frontend (HTML/CSS/JS, no build step)

## API

- `GET  /api/weeks` — list weeks
- `GET  /api/weeks/:week` — one week
- `POST /api/weeks/:week/scores` — `{ rows: [{ name, score, player_id? }] }`
- `POST /api/weeks/:week/uploads?name=file.png` — raw image bytes
- `POST /api/weeks/:week/glory` — `{ count }`
- `GET  /api/weeks/:week/export.csv` — CSV export
- `GET/POST/PATCH/DELETE /api/players...` — player management and merging
- `POST /api/suggest` — name suggestions for parsed rows
- `GET  /api/settings`
