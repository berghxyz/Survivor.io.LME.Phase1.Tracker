// Storage layer. One SQLite file, accessed through Node's built-in
// node:sqlite module, so the app has no runtime dependencies at all.

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { cleanName, normalizeName, editDistance, editBudget } from './text.js';
import { weekLabel, weekRange, isWeekKey } from './week.js';

export const ROLES = ['leader', 'vice', 'glory', 'member'];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS players (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  role       TEXT NOT NULL DEFAULT 'member',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scores (
  week       TEXT    NOT NULL,
  player_id  INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  score      INTEGER NOT NULL,
  updated_at TEXT    NOT NULL,
  PRIMARY KEY (week, player_id)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_scores_week ON scores(week);

CREATE TABLE IF NOT EXISTS uploads (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  week       TEXT    NOT NULL,
  filename   TEXT    NOT NULL,
  path       TEXT,
  rows       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;
`;

function nowIso() {
  return new Date().toISOString();
}

export function createStore({ root }) {
  const dataDir = path.join(root, 'data');
  const uploadDir = path.join(dataDir, 'uploads', 'phase1');
  fs.mkdirSync(uploadDir, { recursive: true });

  const db = new DatabaseSync(path.join(dataDir, 'birds.db'));
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);

  const getSetting = (key, fallback) => {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : fallback;
  };
  const setSetting = (key, value) => {
    db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run(key, String(value));
  };

  // ---------------------------------------------------------------- players

  function findPlayerByName(name) {
    const clean = cleanName(name);
    if (!clean) return null;
    const exact = db.prepare('SELECT * FROM players WHERE name = ? COLLATE NOCASE').get(clean);
    if (exact) return exact;
    // Tolerate punctuation/spaces the OCR drops (or invents) but nothing else:
    // the server only ever auto-links a name it is sure about. Fuzzy guesses
    // happen in the review screen, where a human confirms them.
    const needle = normalizeName(clean);
    if (!needle) return null;
    for (const player of db.prepare('SELECT * FROM players').all()) {
      if (normalizeName(player.name) === needle) return player;
    }
    return null;
  }

  function listPlayers(week = null) {
    const players = db.prepare('SELECT * FROM players ORDER BY name COLLATE NOCASE').all();
    const counts = new Map(
      db.prepare('SELECT player_id, COUNT(*) AS n, MAX(score) AS best FROM scores GROUP BY player_id')
        .all()
        .map((r) => [r.player_id, r]),
    );
    let current = new Map();
    if (week && isWeekKey(week)) {
      current = new Map(
        db.prepare('SELECT player_id, score FROM scores WHERE week = ?').all(week).map((r) => [r.player_id, r.score]),
      );
    }
    return players.map((p) => ({
      ...p,
      weeks: counts.get(p.id)?.n ?? 0,
      best: counts.get(p.id)?.best ?? null,
      score_this_week: current.has(p.id) ? current.get(p.id) : null,
    }));
  }

  function addPlayer(name, role = 'member') {
    const clean = cleanName(name);
    if (!clean) return { error: 'Player name is empty.' };
    if (!ROLES.includes(role)) return { error: `Unknown role "${role}".` };
    const existing = findPlayerByName(clean);
    if (existing) return { error: `"${existing.name}" already exists.`, player: existing };
    const info = db.prepare('INSERT INTO players (name, role, created_at) VALUES (?, ?, ?)')
      .run(clean, role, nowIso());
    return { player: db.prepare('SELECT * FROM players WHERE id = ?').get(info.lastInsertRowid) };
  }

  function updatePlayer(id, { name, role } = {}) {
    const player = db.prepare('SELECT * FROM players WHERE id = ?').get(id);
    if (!player) return { error: 'No such player.' };
    let nextName = player.name;
    if (name !== undefined) {
      nextName = cleanName(name);
      if (!nextName) return { error: 'Player name is empty.' };
      const clash = db.prepare('SELECT * FROM players WHERE id <> ? AND name = ? COLLATE NOCASE').get(id, nextName);
      if (clash) return { error: `"${clash.name}" already exists (id ${clash.id}). Merge them instead.` };
    }
    if (role !== undefined && !ROLES.includes(role)) return { error: `Unknown role "${role}".` };
    db.prepare('UPDATE players SET name = ?, role = ? WHERE id = ?')
      .run(nextName, role ?? player.role, id);
    return { player: db.prepare('SELECT * FROM players WHERE id = ?').get(id) };
  }

  function deletePlayer(id) {
    const player = db.prepare('SELECT * FROM players WHERE id = ?').get(id);
    if (!player) return { error: 'No such player.' };
    db.prepare('DELETE FROM scores WHERE player_id = ?').run(id);
    db.prepare('DELETE FROM players WHERE id = ?').run(id);
    return { deleted: player };
  }

  /** Fold one player's history into another and drop the duplicate. */
  function mergePlayers(fromId, intoId) {
    const from = db.prepare('SELECT * FROM players WHERE id = ?').get(fromId);
    const into = db.prepare('SELECT * FROM players WHERE id = ?').get(intoId);
    if (!from || !into) return { error: 'Both players must exist.' };
    if (fromId === intoId) return { error: 'Pick two different players.' };
    db.exec('BEGIN');
    try {
      const source = db.prepare('SELECT week, score FROM scores WHERE player_id = ?').all(fromId);
      for (const row of source) {
        db.prepare(
          `INSERT INTO scores (week, player_id, score, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(week, player_id) DO UPDATE SET
             score = MAX(score, excluded.score), updated_at = excluded.updated_at`,
        ).run(row.week, intoId, row.score, nowIso());
      }
      db.prepare('DELETE FROM scores WHERE player_id = ?').run(fromId);
      db.prepare('DELETE FROM players WHERE id = ?').run(fromId);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return { merged: from.name, into: into.name };
  }

  // ------------------------------------------------------------ week lookup

  function weeksWithScores() {
    return db.prepare(
      `SELECT week, COUNT(*) AS player_count, SUM(score) AS total_score, MAX(score) AS top_score,
              MAX(updated_at) AS updated_at
       FROM scores GROUP BY week ORDER BY week DESC`,
    ).all();
  }

  /** Most recent week strictly before `week` that actually holds data. */
  function previousDataWeek(week) {
    const row = db.prepare('SELECT week FROM scores WHERE week < ? GROUP BY week ORDER BY week DESC LIMIT 1')
      .get(week);
    return row ? row.week : null;
  }

  function weekExists(week) {
    const row = db.prepare('SELECT COUNT(*) AS n FROM scores WHERE week = ?').get(week);
    return (row?.n ?? 0) > 0;
  }

  // ------------------------------------------------------------------ stats

  /**
   * Score, gain and gain percentage for a week, ranked by score.
   * Gain relative to the previous week *that has data*, so a skipped week
   * does not wipe everybody's progress. A player missing from that week
   * starts at zero gain, and their percentage stays null ("new").
   */
  function weekStats(week) {
    const rows = db.prepare(
      `SELECT p.id, p.name, p.role, s.score
       FROM scores s JOIN players p ON p.id = s.player_id
       WHERE s.week = ?`,
    ).all(week);

    const prevWeek = previousDataWeek(week);
    const prev = new Map(
      prevWeek
        ? db.prepare('SELECT player_id, score FROM scores WHERE week = ?').all(prevWeek).map((r) => [r.player_id, r.score])
        : [],
    );

    const players = rows
      .map((r) => {
        const prevScore = prev.has(r.id) ? prev.get(r.id) : null;
        const gain = prevScore === null ? 0 : r.score - prevScore;
        const gainPct = prevScore === null || prevScore === 0 ? null : (gain / prevScore) * 100;
        return { ...r, prev_score: prevScore, gain, gain_pct: gainPct };
      })
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'en', { numeric: true }));

    players.forEach((p, i) => { p.rank = i + 1; });

    const totalScore = players.reduce((sum, p) => sum + p.score, 0);
    return {
      week,
      label: weekLabel(week),
      range: weekRange(week),
      prev_week: prevWeek,
      prev_label: prevWeek ? weekLabel(prevWeek) : null,
      glory_count: gloryCount(),
      players,
      totals: {
        players: players.length,
        total_score: totalScore,
        avg_score: players.length ? Math.round(totalScore / players.length) : 0,
        new_players: players.filter((p) => p.prev_score === null).length,
        total_gain: players.reduce((sum, p) => sum + p.gain, 0),
      },
    };
  }

  // ------------------------------------------------------------------ saves

  /**
   * Store parsed rows for a week, keeping the best score per player: a higher
   * score uploaded later in the same week upgrades the entry, a lower one is
   * reported and ignored. Names that cannot be matched with confidence are
   * created as new players, which the review screen has already warned about.
   */
  function saveScores(week, rows) {
    if (!isWeekKey(week)) return { error: `Bad week key "${week}". Expected a value like 2026-W44.` };
    if (!Array.isArray(rows) || rows.length === 0) return { error: 'No rows to save.' };

    const results = [];
    db.exec('BEGIN');
    try {
      for (const raw of rows) {
        const name = cleanName(raw?.name);
        const score = Number(raw?.score);
        if (!name) { results.push({ ...raw, status: 'invalid', reason: 'empty name' }); continue; }
        if (!Number.isInteger(score) || score < 0 || score > 1_000_000) {
          results.push({ name, score: raw?.score, status: 'invalid', reason: 'bad score' });
          continue;
        }

        let player = null;
        if (raw.player_id) player = db.prepare('SELECT * FROM players WHERE id = ?').get(raw.player_id);
        if (!player) player = findPlayerByName(name);
        let created = false;
        if (!player) {
          const added = addPlayer(name, 'member');
          if (added.error) { results.push({ name, score, status: 'invalid', reason: added.error }); continue; }
          player = added.player;
          created = true;
        }

        const existing = db.prepare('SELECT score FROM scores WHERE week = ? AND player_id = ?')
          .get(week, player.id);

        if (!existing) {
          db.prepare('INSERT INTO scores (week, player_id, score, updated_at) VALUES (?, ?, ?, ?)')
            .run(week, player.id, score, nowIso());
          results.push({ name: player.name, score, status: 'new', player_id: player.id, newly_created: created });
        } else if (score > existing.score) {
          db.prepare('UPDATE scores SET score = ?, updated_at = ? WHERE week = ? AND player_id = ?')
            .run(score, nowIso(), week, player.id);
          results.push({
            name: player.name, score, status: 'raised', player_id: player.id,
            old_score: existing.score, newly_created: created,
          });
        } else if (score === existing.score) {
          results.push({ name: player.name, score, status: 'unchanged', player_id: player.id });
        } else {
          results.push({
            name: player.name, score, status: 'lower', player_id: player.id,
            old_score: existing.score,
          });
        }
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return { week, results };
  }

  function deleteWeek(week) {
    if (!isWeekKey(week)) return { error: `Bad week key "${week}".` };
    const info = db.prepare('DELETE FROM scores WHERE week = ?').run(week);
    db.prepare('DELETE FROM uploads WHERE week = ?').run(week);
    return { week, removed: info.changes };
  }

  // ------------------------------------------------------------------ glory

  function gloryCount() {
    return Math.max(0, Number(getSetting('glory_count', '5')) || 0);
  }

  /**
   * Roll the Glory slots from a week's ranking. Leaders and Vice Leaders are
   * left alone; everyone else is Glory while inside the slots and a plain
   * Member once they fall out of them.
   */
  function applyGlory(week, count = gloryCount()) {
    const stats = weekStats(week);
    if (!stats.players.length) return { error: `No scores recorded for ${week}.` };
    const slots = Math.max(0, Number(count) || 0);
    const promoted = [];
    const demoted = [];

    db.exec('BEGIN');
    try {
      stats.players.forEach((p, index) => {
        if (p.role === 'leader' || p.role === 'vice') return;
        const shouldBeGlory = index < slots;
        if (shouldBeGlory && p.role !== 'glory') {
          db.prepare("UPDATE players SET role = 'glory' WHERE id = ?").run(p.id);
          promoted.push(p.name);
        } else if (!shouldBeGlory && p.role === 'glory') {
          db.prepare("UPDATE players SET role = 'member' WHERE id = ?").run(p.id);
          demoted.push(p.name);
        }
      });
      setSetting('glory_count', slots);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return { week, slots, promoted, demoted };
  }

  // -------------------------------------------------------------- suggestions

  /** Closest roster name for an OCR reading, for the review screen. */
  function suggestPlayers(queries) {
    const players = db.prepare('SELECT id, name FROM players').all();
    return queries.map((query) => {
      const needle = normalizeName(query?.name ?? '');
      if (!needle) return { query: query?.name ?? '', match: null, distance: null, ambiguous: false };

      const exact = players.find((p) => normalizeName(p.name) === needle);
      if (exact) return { query: query.name, match: exact, distance: 0, ambiguous: false };

      let best = [];
      for (const p of players) {
        const candidate = normalizeName(p.name);
        if (!candidate) continue;
        const distance = editDistance(needle, candidate, editBudget(needle.length));
        if (distance <= editBudget(needle.length)) best.push({ player: p, distance });
      }
      best.sort((a, b) => a.distance - b.distance || a.player.name.localeCompare(b.player.name));
      const ambiguous = best.length > 1 && best[0].distance === best[1].distance;
      return {
        query: query?.name ?? '',
        match: best.length ? best[0].player : null,
        distance: best.length ? best[0].distance : null,
        ambiguous,
        alternatives: best.slice(0, 4).map((b) => ({ ...b.player, distance: b.distance })),
      };
    });
  }

  // ---------------------------------------------------------------- uploads

  function addUpload(week, filename, filePath, rowCount) {
    const info = db.prepare('INSERT INTO uploads (week, filename, path, rows, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(week, filename, filePath, rowCount, nowIso());
    return db.prepare('SELECT * FROM uploads WHERE id = ?').get(info.lastInsertRowid);
  }

  function listUploads(week) {
    return db.prepare('SELECT * FROM uploads WHERE week = ? ORDER BY created_at').all(week);
  }

  return {
    dataDir,
    uploadDir,
    roles: ROLES,
    getSetting,
    setSetting,
    gloryCount,
    listPlayers,
    addPlayer,
    updatePlayer,
    deletePlayer,
    mergePlayers,
    findPlayerByName,
    weeksWithScores,
    previousDataWeek,
    weekExists,
    weekStats,
    saveScores,
    deleteWeek,
    applyGlory,
    suggestPlayers,
    addUpload,
    listUploads,
  };
}
