/**
 * electron-builder afterPack hook (runs before signing): make the app's own files readable for every account on
 * the Mac. Files in this project folder can be 0600 (for example when synced by a tool), and an app installed in
 * /Applications must also work for other users. Executables keep their x bit.
 */
const fs = require("node:fs");
const path = require("node:path");

function normalize(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      fs.chmodSync(full, 0o755);
      normalize(full);
    } else if (entry.isFile()) {
      const executable = (fs.statSync(full).mode & 0o100) !== 0;
      fs.chmodSync(full, executable ? 0o755 : 0o644);
    }
  }
}

/**
 * macOS 26 Liquid Glass icon: when build/icon/Assets.car exists (npm run icon), put it into the app and point
 * CFBundleIconName at it. The .icns (CFBundleIconFile) stays for older macOS versions.
 */
function addLiquidGlassIcon(appBundle) {
  const car = path.join(__dirname, "..", "build", "icon", "Assets.car");
  if (!fs.existsSync(car)) return;
  fs.copyFileSync(car, path.join(appBundle, "Contents", "Resources", "Assets.car"));
  fs.chmodSync(path.join(appBundle, "Contents", "Resources", "Assets.car"), 0o644);
  const plist = path.join(appBundle, "Contents", "Info.plist");
  require("node:child_process").execFileSync("/usr/bin/plutil", ["-replace", "CFBundleIconName", "-string", "Icon", plist]);
  console.log("  • added the Liquid Glass icon (Assets.car)");
}

exports.default = async function afterPack(context) {
  const appBundle = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  normalize(path.join(appBundle, "Contents", "Resources", "app"));
  if (context.electronPlatformName === "darwin") addLiquidGlassIcon(appBundle);
};
