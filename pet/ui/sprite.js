/**
 * Plays Codex / ChatGPT pet spritesheets (the hatch-pet format), so pets installed in ~/.codex/pets work here too.
 *
 * Format: 8 columns x 9 rows (some pets have 11), cells 192 x 208 px, one animation per row,
 * unused cells transparent. Timings follow the hatch-pet spec (references/animation-rows.md).
 * A single image that is not such a grid is shown as a still picture.
 */
export const ROW = { idle: 0, runRight: 1, runLeft: 2, waving: 3, jumping: 4, failed: 5, waiting: 6, running: 7, review: 8 };

const TIMING = [
  [280, 110, 110, 140, 140, 320], // idle
  [120, 120, 120, 120, 120, 120, 120, 220], // running-right
  [120, 120, 120, 120, 120, 120, 120, 220], // running-left
  [140, 140, 140, 280], // waving
  [140, 140, 140, 140, 280], // jumping
  [140, 140, 140, 140, 140, 140, 140, 240], // failed
  [150, 150, 150, 150, 150, 260], // waiting
  [120, 120, 120, 120, 120, 220], // running
  [150, 150, 150, 150, 150, 280], // review
];
const COLUMNS = 8;
const CELL_RATIO = 208 / 192;

class SpritePlayer {
  constructor(el, { grid, rows, cellW, cellH }) {
    this.el = el;
    this.grid = grid;
    this.rows = rows;
    this.cellW = cellW;
    this.cellH = cellH;
    this.row = -1;
    this.frame = 0;
    this.nextAt = 0;
    this.oneShot = null;
    this.lastPos = "";
    this.lastTransform = "";
  }

  /** Plays one row once (for example a wave when the pet wakes up), then goes back to the current state. */
  playOnce(row) {
    if (!this.grid || row >= this.rows) return;
    this.oneShot = row;
    this.row = -1;
  }

  /**
   * @param now performance.now()
   * @param baseRow row for the current state
   * @param options paused: hold the first frame; speed: >1 plays faster; lift: 0..1 bounce while speaking
   */
  update(now, baseRow, { paused = false, speed = 1, lift = 0 } = {}) {
    if (this.grid) {
      let row = this.oneShot ?? baseRow;
      if (row >= this.rows) row = ROW.idle;
      const timing = TIMING[row] ?? [150];
      if (row !== this.row) {
        this.row = row;
        this.frame = 0;
        this.nextAt = now + timing[0] / speed;
      } else if (paused) {
        this.frame = 0;
      } else if (now >= this.nextAt) {
        let next = this.frame + 1;
        if (next >= timing.length) {
          if (this.oneShot !== null) {
            this.oneShot = null;
            this.row = -1;
            this.update(now, baseRow, { paused, speed, lift });
            return;
          }
          next = 0;
        }
        this.frame = next;
        this.nextAt = now + timing[next] / speed;
      }
      const position = `${(-this.frame * this.cellW).toFixed(2)}px ${(-row * this.cellH).toFixed(2)}px`;
      if (position !== this.lastPos) {
        this.el.style.backgroundPosition = position;
        this.lastPos = position;
      }
    }
    const transform =
      lift > 0.02 ? `translateY(${(-lift * 5).toFixed(1)}px) scale(${(1 + lift * 0.03).toFixed(3)}, ${(1 + lift * 0.05).toFixed(3)})` : "";
    if (transform !== this.lastTransform) {
      this.el.style.transform = transform;
      this.lastTransform = transform;
    }
  }
}

/** Loads a spritesheet into `container`, scaled to `heightPx` tall. */
export async function loadSprite(container, url, heightPx) {
  const img = new Image();
  img.src = url;
  await img.decode();
  const width = img.naturalWidth;
  const height = img.naturalHeight;
  const cellW = width / COLUMNS;
  const cellH = cellW * CELL_RATIO;
  const rows = Math.round(height / cellH);
  const grid = Number.isInteger(cellW) && rows >= 1 && Math.abs(rows * cellH - height) <= 2;

  const scale = grid ? heightPx / cellH : heightPx / height;
  const el = document.createElement("div");
  el.className = "sprite";
  el.setAttribute("role", "img");
  el.style.width = `${((grid ? cellW : width) * scale).toFixed(2)}px`;
  el.style.height = `${heightPx}px`;
  el.style.backgroundImage = `url("${url}")`;
  el.style.backgroundSize = `${(width * scale).toFixed(2)}px ${(height * scale).toFixed(2)}px`;
  container.replaceChildren(el);
  return new SpritePlayer(el, { grid, rows: grid ? rows : 1, cellW: cellW * scale, cellH: cellH * scale });
}
