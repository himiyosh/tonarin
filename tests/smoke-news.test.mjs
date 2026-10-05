import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const main = readFileSync(new URL("../pet/main.cjs", import.meta.url), "utf8");
const script = /report\.news = await settingsWin\.webContents\.executeJavaScript\(`([\s\S]*?)`\);/.exec(main)?.[1];

async function probe(render) {
  assert.ok(script, "the packaged startup checks the News settings page");
  const empty = { hidden: true };
  const url = { value: "" };
  const error = { textContent: "" };
  const page = {
    hidden: false,
    querySelector(selector) {
      switch (selector) {
        case '[data-news-empty-category="science"] .desc': return { textContent: "No sources available" };
        case "input.news-url": return url;
        case ".news-empty": return render === "missing" ? null : empty;
        case ".news-add-controls button": return { click: () => { error.textContent = "Enter an HTTPS URL"; } };
        case ".message.error": return error;
        default: throw new Error(`Unexpected selector: ${selector}`);
      }
    },
    querySelectorAll(selector) {
      switch (selector) {
        case 'input[role="switch"]': return { length: 27 };
        case ".news-add-controls select": return { length: 2 };
        default: throw new Error(`Unexpected selector: ${selector}`);
      }
    },
  };
  const document = {
    querySelector(selector) {
      assert.equal(selector, '[data-section="news"]');
      return { click() {} };
    },
    getElementById(id) {
      assert.equal(id, "section-news");
      return page;
    },
  };
  const window = { pet: { settings: {
    set: async ({ feeds }) => {
      if (Array.isArray(feeds) && feeds.length === 0) {
        if (render === "immediate") empty.hidden = false;
        if (render === "next-turn" || render === "missing") {
          setImmediate(() => setImmediate(() => { empty.hidden = false; }));
        }
      }
      return { values: { feeds } };
    },
  } } };
  return runInNewContext(script, { document, window, setTimeout: (callback) => setImmediate(callback) });
}

test("News startup smoke waits for the renderer to show the saved empty selection", async () => {
  for (const render of ["immediate", "next-turn"]) {
    const news = await probe(render);
    assert.equal(news.emptyVisible, true, `${render} rendering is observed`);
    assert.equal(news.invalidUrlVisible, true);
  }
});

test("News startup smoke still fails when the empty state never appears or is absent", async () => {
  assert.match(main, /!report\.news\.emptyVisible/, "the startup smoke still rejects a missing empty state");
  for (const render of ["never", "missing"]) {
    const news = await probe(render);
    assert.equal(news.emptyVisible, false, `${render} rendering must not pass`);
  }
});
