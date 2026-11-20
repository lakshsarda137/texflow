#!/bin/sh
# Installs the texflow native messaging host for the current macOS user.
# Re-run after changing Python. Safe to run repeatedly.
set -eu

HOST_NAME="com.texflow.host"
EXTENSION_ID="${1:-pfbfelhdpdmgifcfcpdapkpgfjphefcn}"
SRC_DIR="$(dirname "$0")"
APP_DIR="$HOME/Library/Application Support/texflow"

PYTHON="$(command -v python3 || true)"
if [ -z "$PYTHON" ]; then
  echo "python3 not found. Install it (e.g. 'xcode-select --install' or Homebrew) and re-run." >&2
  exit 1
fi

# Copy the host out of the repo so moving/deleting the clone does not break it.
mkdir -p "$APP_DIR"
cp "$SRC_DIR/texflow_host.py" "$APP_DIR/texflow_host.py"

# Chrome starts hosts with a minimal PATH, so pin the interpreter explicitly.
cat > "$APP_DIR/texflow-host" <<WRAP
#!/bin/sh
exec "$PYTHON" "$APP_DIR/texflow_host.py" "\$@"
WRAP
chmod +x "$APP_DIR/texflow-host"

MANIFEST=$(cat <<JSON
{
  "name": "$HOST_NAME",
  "description": "texflow: saves compiled PDFs to local folders",
  "path": "$APP_DIR/texflow-host",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXTENSION_ID/"]
}
JSON
)

installed=0
for browser_dir in \
  "Google/Chrome" "Google/Chrome Beta" "Google/Chrome Canary" "Chromium" \
  "BraveSoftware/Brave-Browser" "Microsoft Edge" "Arc/User Data"; do
  base="$HOME/Library/Application Support/$browser_dir"
  # Always install for Chrome; for others only if the browser is present.
  if [ "$browser_dir" = "Google/Chrome" ] || [ -d "$base" ]; then
    mkdir -p "$base/NativeMessagingHosts"
    printf '%s\n' "$MANIFEST" > "$base/NativeMessagingHosts/$HOST_NAME.json"
    echo "Installed for $browser_dir"
    installed=$((installed + 1))
  fi
done

echo "Done ($installed browser(s)). Extension ID: $EXTENSION_ID"
echo "Reload the texflow extension in chrome://extensions if it is already loaded."
