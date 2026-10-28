// Text helpers shared by score matching.
// Keep in sync with public/js/text.js (the browser copy of this file).

/** Control characters and odd spaces out; collapse runs of whitespace. */
export function cleanName(name) {
  return String(name ?? '')
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
}

/**
 * Aggressive form used only for comparing names, never for display:
 * lowercase and drop everything that is not a letter or digit, so that
 * "NEMESIS_999", "NEMESIS 999" and "nemesis999" all collapse together.
 */
export function normalizeName(name) {
  return cleanName(name).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

const MAX_EDITS = 2;

/** Bounded Levenshtein distance; returns `limit + 1` when farther apart. */
export function editDistance(a, b, limit = MAX_EDITS) {
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

/**
 * How many character edits we tolerate when treating two OCR readings of a
 * name as the same player. Long names get one extra chance because a single
 * misread character is much less surprising there.
 */
export function editBudget(len) {
  if (len < 4) return 0;
  if (len < 7) return 1;
  if (len < 12) return 2;
  return 3;
}
