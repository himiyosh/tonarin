// Picks the page language before the first paint, so the other language never flashes: ?lang=ja|en in the address,
// else the visitor's earlier choice, else the first of the browser's languages that is Japanese or English.
// app.js wires the switch.
(() => {
  let lang = new URLSearchParams(location.search).get("lang");
  if (lang !== "ja" && lang !== "en") {
    try {
      lang = localStorage.getItem("tonarin.lang");
    } catch {
      // storage blocked: follow the browser
    }
  }
  if (lang !== "ja" && lang !== "en") {
    const wanted = (navigator.languages?.length ? navigator.languages : [navigator.language]).map((l) => String(l).toLowerCase());
    lang = wanted.find((l) => l.startsWith("ja") || l.startsWith("en"))?.startsWith("ja") ? "ja" : "en";
  }
  document.documentElement.lang = lang;
  document.documentElement.dataset.lang = lang;
})();
