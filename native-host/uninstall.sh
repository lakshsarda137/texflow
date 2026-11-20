#!/bin/sh
# Removes the texflow native messaging host for the current macOS user.
set -eu
HOST_NAME="com.texflow.host"
for browser_dir in \
  "Google/Chrome" "Google/Chrome Beta" "Google/Chrome Canary" "Chromium" \
  "BraveSoftware/Brave-Browser" "Microsoft Edge" "Arc/User Data"; do
  f="$HOME/Library/Application Support/$browser_dir/NativeMessagingHosts/$HOST_NAME.json"
  if [ -f "$f" ]; then rm "$f"; echo "Removed from $browser_dir"; fi
done
rm -rf "$HOME/Library/Application Support/texflow"
echo "Uninstalled."
