// Browser copy of lib/text.js plus the fuzzy roster matching that only the
// review screen needs. Keep the shared helpers in sync with the server.

export function cleanName(name) {
  return String(name ?? '')
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
}

export function normalizeName(name) {
  return cleanName(name).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

export function editDistance(a, b, limit = 4) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > limit) return limit + 1;
    prev = cur;
  }
  return prev[b.length];
}

export function editBudget(len) {
  if (len < 4) return 0;
  if (len < 7) return 1;
  if (len < 12) return 2;
  return 3;
}

/**
 * Find the roster entry an OCR reading most likely refers to. Exact matches
 * win outright; otherwise a small edit distance is accepted so that
 * "Trickyyy" lands on "Tr1ckyyy" and "NEMESIS999" on "NEMESIS_999".
 */
export function matchRoster(name, roster) {
  const needle = normalizeName(cleanName(name));
  if (!needle) return { match: null, distance: null, ambiguous: false, alternatives: [] };

  const exact = roster.find((p) => normalizeName(p.name) === needle);
  if (exact) return { match: exact, distance: 0, ambiguous: false, alternatives: [exact] };

  const scored = [];
  for (const player of roster) {
    const candidate = normalizeName(player.name);
    if (!candidate) continue;
    const budget = editBudget(needle.length);
    const distance = editDistance(needle, candidate, budget);
    if (distance <= budget) scored.push({ player, distance });
  }
  scored.sort((a, b) => a.distance - b.distance || a.player.name.localeCompare(b.player.name));
  return {
    match: scored.length ? scored[0].player : null,
    distance: scored.length ? scored[0].distance : null,
    ambiguous: scored.length > 1 && scored[0].distance === scored[1].distance,
    alternatives: scored.slice(0, 5).map((s) => ({ ...s.player, distance: s.distance })),
  };
}

export const formatNumber = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('en-US'));

export const formatSigned = (n) => (n > 0 ? `+${n.toLocaleString('en-US')}` : n.toLocaleString('en-US'));

export const formatPct = (n) =>
  n === null || n === undefined ? '—' : `${n > 0 ? '+' : ''}${n.toFixed(1)}%`;
