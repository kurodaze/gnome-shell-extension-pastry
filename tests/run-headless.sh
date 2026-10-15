#!/bin/sh
# Runs headless.js in a throwaway headless GNOME Shell with the given extension zip.
# PASTRY_TEST_MONITOR (default 2560x1600) and PASTRY_TEST_SCALE (default 1) pick the screen.
# Everything (settings, data, D-Bus, runtime dir) lives in a temp dir that is
# removed afterwards. No X11, no connection to the logged-in session.
set -eu

ZIP=$(realpath "$1")
SCRIPT=$(realpath "$(dirname "$0")/headless.js")
T=$(mktemp -d /tmp/pastry-headless.XXXXXX)
trap 'rm -rf "$T"' EXIT
mkdir -m 700 "$T/run"
mkdir -p "$T/config/glib-2.0/settings"
printf '[org/gnome/shell]\nenabled-extensions=["pastry@kurodaze.net"]\n' \
    > "$T/config/glib-2.0/settings/keyfile"

env -u DISPLAY -u WAYLAND_DISPLAY -u DBUS_SESSION_BUS_ADDRESS \
    XDG_RUNTIME_DIR="$T/run" \
    XDG_CACHE_HOME="$T/cache" XDG_CONFIG_HOME="$T/config" \
    XDG_DATA_HOME="$T/data" XDG_STATE_HOME="$T/state" \
    GSETTINGS_BACKEND=keyfile \
    MUTTER_WM_CLASS_FILTER=Gnome-shell-perf-helper \
    dbus-run-session -- sh -c '
        gnome-extensions install --force "$1" &&
        timeout 120 gnome-shell --headless --no-x11 --virtual-monitor "$3" \
            --wayland-display pastry-test --automation-script "$2"
    ' sh "$ZIP" "$SCRIPT" "${PASTRY_TEST_MONITOR:-2560x1600}" > "$T/shell.log" 2>&1 && status=0 || status=$?

grep -E 'PASTRY TEST|Pastry|JS ERROR|Script failed|assertion|Error:' "$T/shell.log" | head -60 || true
echo "shell exit status: $status"
exit "$status"
