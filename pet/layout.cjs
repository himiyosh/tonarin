/**
 * Where the pet window goes, built around the pet (pure math, tested on its own).
 *
 * The pet's spot on screen is what the user chose by dragging. With no bubble the window is just the pet plus a small
 * margin above it, so the pet can sit anywhere, right up to the top of the screen. A bubble opens on the side with
 * room: above the pet, or below it when the pet is near the top. While a bubble is open it stays on its side as long as
 * it fits. The window is as wide as a bubble needs, centered on the pet but always inside the screen: near the left or
 * right edge the pet sits off-center in the window (`petLeft`), and the page puts the bubble next to it.
 */

/**
 * @param {object} input
 * @param {{x: number, y: number}} input.pet  top-left of the pet on screen (clamped to the work area in the result)
 * @param {number} input.size  pet width and height
 * @param {{x: number, y: number, width: number, height: number}} input.workArea  the pet's display, minus menu bar/Dock
 * @param {number} input.bubble  height the bubble needs, 0 while hidden
 * @param {"above" | "below"} input.placement  the side the bubble is on now
 * @param {number} input.maxBubble  tallest the bubble area may get
 * @param {number} input.minWidth  window width that fits a bubble
 * @param {number} input.marginTop  room above the pet for its bob and effects
 */
function layoutFor({ pet, size, workArea, bubble, placement, maxBubble, minWidth, marginTop }) {
  const x0 = Math.round(Math.min(Math.max(pet.x, workArea.x), workArea.x + workArea.width - size));
  const y0 = Math.round(Math.min(Math.max(pet.y, workArea.y), workArea.y + workArea.height - size));
  const above = y0 - workArea.y;
  const below = workArea.y + workArea.height - (y0 + size);
  const room = (side) => Math.max(0, Math.min(side === "above" ? above : below, maxBubble));

  let side = placement === "below" ? "below" : "above";
  if (bubble > 0) {
    if (room(side) < bubble) side = room("above") >= bubble ? "above" : room("below") >= bubble ? "below" : above >= below ? "above" : "below";
  } else {
    side = above >= Math.min(220, below) ? "above" : "below"; // ready for the next bubble
  }

  const need = Math.min(bubble, room(side));
  const width = Math.max(minWidth, size + 40);
  const x = Math.round(Math.min(Math.max(x0 + size / 2 - width / 2, workArea.x), workArea.x + workArea.width - width));
  let y;
  let height;
  if (side === "above") {
    y = Math.max(workArea.y, y0 - Math.max(need, marginTop));
    height = y0 + size - y;
  } else {
    y = Math.max(workArea.y, y0 - marginTop);
    height = y0 - y + size + need;
  }
  return {
    pet: { x: x0, y: y0 },
    placement: side,
    bounds: { x, y, width, height },
    petTop: y0 - y,
    petLeft: x0 - x,
    room: room(side),
  };
}

module.exports = { layoutFor };
