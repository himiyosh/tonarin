// The only bridge between the app's pages (pet and settings) and Electron. The pages get no Node.js access.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("pet", {
  platform: process.platform, // "darwin" or "win32": some wording and styling differ

  // pet window
  config: () => ipcRenderer.invoke("pet:config"),
  codexPets: () => ipcRenderer.invoke("pet:codex-pets"),
  moveBy: (dx, dy) => ipcRenderer.send("pet:move", dx, dy),
  setScale: (scale) => ipcRenderer.send("pet:set-scale", scale),
  setBubbleSpace: (px) => ipcRenderer.send("pet:set-bubble-space", px),
  ignoreMouse: (ignore) => ipcRenderer.send("pet:ignore-mouse", ignore),
  showMenu: (state) => ipcRenderer.send("pet:menu", state),
  reportState: (state) => ipcRenderer.send("pet:state", state),
  onCommand: (callback) => ipcRenderer.on("pet:command", (_event, command) => callback(command)),

  // settings (both windows)
  settings: {
    get: () => ipcRenderer.invoke("settings:get"),
    set: (patch) => ipcRenderer.invoke("settings:set", patch),
    setGeminiKey: (key) => ipcRenderer.invoke("settings:set-gemini-key", key),
    clearGeminiKey: () => ipcRenderer.invoke("settings:clear-gemini-key"),
    testGeminiKey: (key) => ipcRenderer.invoke("settings:test-gemini-key", key),
    open: (target) => ipcRenderer.invoke("settings:open", target),
    installPet: () => ipcRenderer.invoke("settings:install-pet"),
    restartProxy: () => ipcRenderer.invoke("settings:restart-proxy"),
    reconnect: () => ipcRenderer.invoke("settings:reconnect"),
    onChanged: (callback) => ipcRenderer.on("settings:changed", (_event, snapshot) => callback(snapshot)),
    onSection: (callback) => ipcRenderer.on("settings:section", (_event, section) => callback(section)),
    usage: () => ipcRenderer.invoke("settings:usage"),
    github: {
      signIn: (input) => ipcRenderer.invoke("settings:github-signin", input),
      cancel: () => ipcRenderer.invoke("settings:github-cancel"),
      onEvent: (callback) => ipcRenderer.on("settings:github-auth", (_event, payload) => callback(payload)),
    },
    mcp: {
      list: () => ipcRenderer.invoke("settings:mcp-list"),
      save: (input) => ipcRenderer.invoke("settings:mcp-save", input),
      remove: (id) => ipcRenderer.invoke("settings:mcp-delete", id),
      setTool: (id, tool, enabled) => ipcRenderer.invoke("settings:mcp-set-tool", id, tool, enabled),
      enable: (id, enabled) => ipcRenderer.invoke("settings:mcp-enable", id, enabled),
      reconnect: (id) => ipcRenderer.invoke("settings:mcp-reconnect", id),
      test: (id, tool) => ipcRenderer.invoke("settings:mcp-test", id, tool),
      onChanged: (callback) => ipcRenderer.on("settings:mcp-changed", () => callback()),
    },
    automations: {
      list: () => ipcRenderer.invoke("settings:automations"),
      save: (automation) => ipcRenderer.invoke("settings:automation-save", automation),
      remove: (id) => ipcRenderer.invoke("settings:automation-delete", id),
      run: (id) => ipcRenderer.invoke("settings:automation-run", id),
      clearHistory: () => ipcRenderer.invoke("settings:automation-clear-history"),
      onChanged: (callback) => ipcRenderer.on("settings:automations-changed", () => callback()),
    },
  },
});
