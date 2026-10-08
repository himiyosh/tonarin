import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const main = readFileSync(new URL("../pet/main.cjs", import.meta.url), "utf8");
const preload = readFileSync(new URL("../pet/preload.cjs", import.meta.url), "utf8");

test("packaged startup verifies retired News and gated Mail settings visibility", () => {
  assert.match(main, /report\.hiddenSettings/);
  assert.match(main, /retired or gated settings sections have the wrong visibility/);
  assert.doesNotMatch(main, /report\.news =/);
});

test("the settings bridge no longer exposes News source mutation", () => {
  assert.doesNotMatch(preload, /settings:add-news-feed|settings:remove-news-feed|settings:sync-news-feeds/);
  assert.doesNotMatch(main, /ipcMain\.handle\(\"settings:(?:add|remove|sync)-news/);
});
