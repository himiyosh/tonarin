#!/bin/sh
# Builds "Tonarin (dev).app" in the project folder. Double-click it (or keep it in the Dock) to start the desktop pet.
# It starts the pet with Electron through LaunchServices, so macOS asks for microphone access for "Electron"
# once, and the pet starts the proxy by itself. Quit from the pet's right-click menu.
#
#   npm run launcher
set -e
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
APP="$ROOT/Tonarin (dev).app"
ELECTRON_APP="$ROOT/node_modules/electron/dist/Electron.app"
TMP="$(mktemp -d)"

if [ ! -d "$ELECTRON_APP" ]; then
  echo "Electron is not installed yet: run npm install and node node_modules/electron/install.js first." >&2
  exit 1
fi

cat > "$TMP/launcher.applescript" <<APPLESCRIPT
on run
	set projectDir to "$ROOT"
	-- "[p]et" so that pgrep does not match this very shell command
	set isRunning to do shell script "pgrep -f '[p]et/main.cjs' >/dev/null && echo yes || echo no"
	if isRunning is "yes" then
		display notification "もう起動しています。止めるときはペットを右クリック →「終了」" with title "Tonarin"
	else
		do shell script "cd " & quoted form of projectDir & " && mkdir -p logs && open -n -g -a " & quoted form of (projectDir & "/node_modules/electron/dist/Electron.app") & " --stdout " & quoted form of (projectDir & "/logs/pet.log") & " --stderr " & quoted form of (projectDir & "/logs/pet.log") & " --args " & quoted form of (projectDir & "/pet/main.cjs")
	end if
end run
APPLESCRIPT

rm -rf "$APP"
osacompile -o "$APP" "$TMP/launcher.applescript"

if [ -f assets/icon.png ]; then
  ICONSET="$TMP/icon.iconset"
  mkdir "$ICONSET"
  for size in 16 32 128 256 512; do
    sips -z "$size" "$size" assets/icon.png --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
    double=$((size * 2))
    sips -z "$double" "$double" assets/icon.png --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
  done
  iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/applet.icns"
  # Newer osacompile applets take their icon from Assets.car (CFBundleIconName); use applet.icns instead.
  rm -f "$APP/Contents/Resources/Assets.car"
  /usr/libexec/PlistBuddy -c "Delete :CFBundleIconName" "$APP/Contents/Info.plist" >/dev/null 2>&1 || true
fi

# Re-sign ad hoc after changing the bundle, so macOS keeps accepting it.
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true
touch "$APP"
rm -rf "$TMP"
echo "Created: $APP"
