// Window layout around the pet (pet/layout.cjs).
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { layoutFor } = require("../pet/layout.cjs");

const workArea = { x: 0, y: 33, width: 1512, height: 900 }; // menu bar 33 px, Dock hidden
const base = { size: 190, workArea, maxBubble: 420, minWidth: 320, marginTop: 12 };

test("no bubble: the pet can sit at the very top, window starts at the work area", () => {
  const r = layoutFor({ ...base, pet: { x: 600, y: 33 }, bubble: 0, placement: "above" });
  assert.deepEqual(r.pet, { x: 600, y: 33 });
  assert.deepEqual([r.bounds.y, r.bounds.height, r.petTop], [33, 190, 0]);
  assert.equal(r.placement, "below"); // ready to open below
});

test("no bubble in the middle: pet plus a 12 px margin, ready to open above", () => {
  const r = layoutFor({ ...base, pet: { x: 600, y: 400 }, bubble: 0, placement: "above" });
  assert.deepEqual([r.bounds.y, r.bounds.height, r.placement], [388, 202, "above"]);
});

test("bubble above: the window grows upward and the pet stays", () => {
  const r = layoutFor({ ...base, pet: { x: 600, y: 600 }, bubble: 150, placement: "above" });
  assert.equal(r.placement, "above");
  assert.deepEqual([r.bounds.y, r.bounds.y + r.bounds.height], [450, 790]);
  assert.deepEqual(r.pet, { x: 600, y: 600 });
});

test("pet near the top: the bubble opens below and the window grows downward", () => {
  const r = layoutFor({ ...base, pet: { x: 600, y: 60 }, bubble: 150, placement: "below" });
  assert.deepEqual([r.placement, r.bounds.y, r.petTop, r.bounds.height], ["below", 48, 12, 12 + 190 + 150]);
});

test("an open bubble keeps its side while it fits and flips when it does not", () => {
  assert.equal(layoutFor({ ...base, pet: { x: 600, y: 300 }, bubble: 150, placement: "below" }).placement, "below");
  assert.equal(layoutFor({ ...base, pet: { x: 600, y: 100 }, bubble: 150, placement: "above" }).placement, "below");
});

test("neither side fits: the roomier side, window on screen, room reported", () => {
  const small = { x: 0, y: 25, width: 800, height: 400 };
  const r = layoutFor({ ...base, workArea: small, pet: { x: 300, y: 150 }, bubble: 300, placement: "above" });
  assert.deepEqual([r.placement, r.room, r.bounds.y, r.bounds.height], ["above", 125, 25, 125 + 190]);
});

test("a pet dragged off screen is clamped back", () => {
  const r = layoutFor({ ...base, pet: { x: -50, y: 2000 }, bubble: 0, placement: "above" });
  assert.deepEqual(r.pet, { x: 0, y: 33 + 900 - 190 });
});

test("near the left or right edge the window stays on screen and the pet sits off-center", () => {
  const left = layoutFor({ ...base, pet: { x: 0, y: 500 }, bubble: 100, placement: "above" });
  assert.deepEqual([left.bounds.width, left.bounds.x, left.petLeft], [320, 0, 0]);
  const right = layoutFor({ ...base, pet: { x: 1512 - 190, y: 500 }, bubble: 100, placement: "above" });
  assert.deepEqual([right.bounds.x, right.petLeft], [1512 - 320, 130]);
  assert.equal(layoutFor({ ...base, pet: { x: 600, y: 500 }, bubble: 0, placement: "above" }).petLeft, 65);
});

test("a large pet widens the window", () => {
  assert.equal(layoutFor({ ...base, size: 380, pet: { x: 500, y: 400 }, bubble: 0, placement: "above" }).bounds.width, 420);
});

test("works on a display left of the main one", () => {
  const leftDisplay = { x: -1920, y: 0, width: 1920, height: 1055 };
  const r = layoutFor({ ...base, workArea: leftDisplay, pet: { x: -1000, y: 0 }, bubble: 200, placement: "above" });
  assert.equal(r.placement, "below");
  assert.equal(r.bounds.y, 0);
  assert.ok(r.bounds.x >= -1920 && r.bounds.x + r.bounds.width <= 0);
});
