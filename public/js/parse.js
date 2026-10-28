// Screenshot reader for the survivor.io "Member Result" panel.
//
// The old screenshotreader.html scanned the whole image and then tried to split
// each OCR line into "name + trailing number". That loses on real data:
//
//   * a member called "Player 35463705" scored 370 — the trailing-number trick
//     would happily record 35463705 as the score;
//   * the white "Member Result" heading and the white highlights on the medal
//     icons survive the white-text filter and inject phantom digits;
//   * rows half scrolled off the top or bottom get read as garbage.
//
// So instead we find the panel's geometry first and OCR the name and the score
// as two separate, tightly cropped images. Measured on the sample screenshots:
// every score read correctly, every Latin name read correctly.
//
// All coordinates are derived from the image itself (panel edges, row height,
// score box) and never hardcoded, so other phone resolutions still work.

const CDN = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';

// Colours of the panel, measured from the sample screenshots.
const ROW_BG = [0x5a, 0x62, 0x7a];
const ROW_TOLERANCE = [28, 28, 30];

// The white text filter from the original POC: keep white text, drop the rest.
const WHITE_THRESHOLD = 195;
const OCR_SCALE = 3;

let tesseractPromise = null;

export function loadTesseract() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  if (!tesseractPromise) {
    tesseractPromise = new Promise((resolve, reject) => {
      const tag = document.createElement('script');
      tag.src = CDN;
      tag.onload = () => window.Tesseract
        ? resolve(window.Tesseract)
        : reject(new Error('OCR engine loaded but did not register.'));
      tag.onerror = () => {
        tesseractPromise = null;
        reject(new Error('Could not download the OCR engine from cdn.jsdelivr.net. Check the network connection.'));
      };
      document.head.appendChild(tag);
    });
  }
  return tesseractPromise;
}

/**
 * Two pools of workers: one restricted to digits for the score, one plain
 * English for the name. Pairs are handed out to rows as they are processed.
 */
export async function createOcr({ pairs = 2, logger } = {}) {
  const Tesseract = await loadTesseract();
  const spawn = () => Tesseract.createWorker('eng', 1, { logger: logger ? (m) => logger(m) : undefined });

  const scoreWorkers = await Promise.all(Array.from({ length: pairs }, spawn));
  const nameWorkers = await Promise.all(Array.from({ length: pairs }, spawn));
  for (const worker of scoreWorkers) await worker.setParameters({ tessedit_char_whitelist: '0123456789' });

  const free = scoreWorkers.map((score, i) => ({ score, name: nameWorkers[i], busy: false }));
  const waiting = [];

  const acquire = () => new Promise((resolve) => {
    const slot = free.find((pair) => !pair.busy);
    if (slot) {
      slot.busy = true;
      return resolve(slot);
    }
    waiting.push(resolve);
  });

  const release = (slot) => {
    slot.busy = false;
    const next = waiting.shift();
    if (next) {
      slot.busy = true;
      next(slot);
    }
  };

  return {
    /** Run `fn(scoreWorker, nameWorker)` with an exclusive pair of workers. */
    async withPair(fn) {
      const slot = await acquire();
      try {
        return await fn(slot.score, slot.name);
      } finally {
        release(slot);
      }
    },
    async close() {
      await Promise.all([...scoreWorkers, ...nameWorkers].map((w) => w.terminate().catch(() => {})));
    },
  };
}

// ------------------------------------------------------------- image plumbing

async function toBitmap(file) {
  if (file.text) { /* keeps linters honest about the File interface */ }
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  if (bitmap.close) bitmap.close();
  return { canvas, ctx, width: canvas.width, height: canvas.height };
}

function pixelReader(ctx, width, height) {
  const { data } = ctx.getImageData(0, 0, width, height);
  return (x, y) => {
    const i = ((width * y) + x) << 2;
    return [data[i], data[i + 1], data[i + 2]];
  };
}

// ------------------------------------------------------------- layout finding

/**
 * Locate the rows, the panel and the score box.
 * Throws when the screenshot does not look like the Member Result panel.
 */
export function detectLayout(width, height, rgb) {
  const isRowBg = (x, y) => {
    const [r, g, b] = rgb(x, y);
    return Math.abs(r - ROW_BG[0]) < ROW_TOLERANCE[0]
      && Math.abs(g - ROW_BG[1]) < ROW_TOLERANCE[1]
      && Math.abs(b - ROW_BG[2]) < ROW_TOLERANCE[2];
  };
  const isDark = (x, y) => {
    const [r, g, b] = rgb(x, y);
    return r < 90 && g < 95 && b < 120; // the score sits in a near-black box
  };

  // 1. Rows: horizontal bands that are mostly "row background" coloured.
  const probeStart = Math.round(width * 0.52);
  const probeEnd = Math.round(width * 0.60);
  const probeWidth = Math.max(1, probeEnd - probeStart);
  const minRowHeight = Math.max(60, Math.round(height * 0.035));

  const rows = [];
  let open = false;
  let rowStart = 0;
  for (let y = 0; y < height; y++) {
    let hits = 0;
    for (let x = probeStart; x < probeEnd; x++) if (isRowBg(x, y)) hits++;
    const on = hits > probeWidth * 0.45;
    if (on && !open) { open = true; rowStart = y; }
    if (!on && open) {
      open = false;
      if (y - rowStart >= minRowHeight) rows.push({ y0: rowStart, y1: y - 1 });
    }
  }
  if (open && height - rowStart >= minRowHeight) rows.push({ y0: rowStart, y1: height - 1 });

  if (rows.length === 0) {
    throw new Error('No member rows found. Upload a screenshot of the "Member Result" list inside Clan Expedition Phases.');
  }

  // 2. Panel: the columns that are row background in most of the rows.
  const columns = [];
  for (let x = 0; x < width; x++) {
    let good = 0;
    for (const row of rows) {
      let hits = 0;
      for (let y = row.y0 + 10; y < row.y1 - 10; y += 4) if (isRowBg(x, y)) hits++;
      if (hits > 4) good++;
    }
    if (good > rows.length * 0.7) columns.push(x);
  }
  if (columns.length < width * 0.2) throw new Error('Could not find the panel edges in this screenshot.');
  const panelX0 = columns[0];
  const panelX1 = columns[columns.length - 1];
  const panelW = panelX1 - panelX0;

  // 3. Score box: the dark rectangle on the right of each row. The white
  //    digits split it into runs, so take the outer edges of all runs.
  const starts = [];
  const ends = [];
  for (const row of rows) {
    const y = Math.round((row.y0 + row.y1) / 2);
    const runs = [];
    let inRun = false;
    let runStart = 0;
    for (let x = panelX0 + Math.round(panelW * 0.55); x < panelX1 - 4; x++) {
      const dark = isDark(x, y);
      if (dark && !inRun) { inRun = true; runStart = x; }
      if (!dark && inRun) { inRun = false; runs.push([runStart, x]); }
    }
    if (inRun) runs.push([runStart, panelX1 - 4]);
    const wide = runs.filter((r) => r[1] - r[0] > 8);
    if (wide.length) {
      starts.push(wide[0][0]);
      ends.push(wide[wide.length - 1][1]);
    }
  }
  if (!starts.length) throw new Error('Could not find the score column in this screenshot.');
  const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

  return {
    width,
    height,
    rows,
    panel: { x0: panelX0, x1: panelX1, w: panelW },
    scoreBox: { x0: median(starts), x1: median(ends) },
  };
}

/** Row name column: after the avatar, before the medal. */
function nameRect(layout, row) {
  const pad = Math.round((row.y1 - row.y0) * 0.2);
  return {
    x0: layout.panel.x0 + Math.round(layout.panel.w * 0.24),
    x1: layout.panel.x0 + Math.round(layout.panel.w * 0.60),
    y0: row.y0 + pad,
    y1: row.y1 - pad,
  };
}

/** Score digits inside the dark box. */
function scoreRect(layout, row) {
  const pad = Math.round((row.y1 - row.y0) * 0.18);
  const inset = Math.max(3, Math.round(layout.panel.w * 0.006));
  return {
    x0: layout.scoreBox.x0 + inset,
    x1: layout.scoreBox.x1 - inset,
    y0: row.y0 + pad,
    y1: row.y1 - pad,
  };
}

/** Crop, apply the white-text filter and blow it up for OCR. */
function toOcrCanvas(rgb, rect, scale = OCR_SCALE) {
  const w = rect.x1 - rect.x0;
  const h = rect.y1 - rect.y0;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, w * scale);
  canvas.height = Math.max(1, h * scale);
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(canvas.width, canvas.height);
  for (let y = 0; y < canvas.height; y++) {
    const sourceY = rect.y0 + Math.floor(y / scale);
    for (let x = 0; x < canvas.width; x++) {
      const [r, g, b] = rgb(rect.x0 + Math.floor(x / scale), sourceY);
      const white = r > WHITE_THRESHOLD && g > WHITE_THRESHOLD && b > WHITE_THRESHOLD;
      const value = white ? 0 : 255;
      const i = ((canvas.width * y) + x) << 2;
      image.data[i] = image.data[i + 1] = image.data[i + 2] = value;
      image.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

function rowThumbnail(source, layout, row) {
  const height = row.y1 - row.y0;
  const scale = Math.min(1.5, 460 / layout.panel.w);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(layout.panel.w * scale);
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext('2d');
  ctx.drawImage(
    source.canvas,
    layout.panel.x0, row.y0, layout.panel.w, height,
    0, 0, canvas.width, canvas.height,
  );
  return canvas.toDataURL('image/jpeg', 0.75);
}

const cleanOcrName = (text) => text.replace(/\r/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Read every member row of one screenshot.
 * Returns [{ name, score, scoreConfidence, nameConfidence, thumbnail, row }]
 */
export async function readScreenshot(file, ocr, onRow) {
  const source = await toBitmap(file);
  const rgb = pixelReader(source.ctx, source.width, source.height);
  const layout = detectLayout(source.width, source.height, rgb);

  const results = [];
  for (const [index, row] of layout.rows.entries()) {
    const { score, name } = await ocr.withPair(async (scoreWorker, nameWorker) => {
      const scoreCanvas = toOcrCanvas(rgb, scoreRect(layout, row));
      const nameCanvas = toOcrCanvas(rgb, nameRect(layout, row));
      const [scoreResult, nameResult] = await Promise.all([
        scoreWorker.recognize(scoreCanvas),
        nameWorker.recognize(nameCanvas),
      ]);
      return { score: scoreResult.data, name: nameResult.data };
    });

    const digits = String(score.text ?? '').replace(/\D/g, '');
    results.push({
      name: cleanOcrName(name.text),
      score: digits === '' ? null : Number(digits),
      nameConfidence: Math.round(name.confidence ?? 0),
      scoreConfidence: Math.round(score.confidence ?? 0),
      thumbnail: rowThumbnail(source, layout, row),
      rowIndex: index,
    });
    onRow?.({ image: file.name, row: index + 1, of: layout.rows.length });
  }
  return results;
}
