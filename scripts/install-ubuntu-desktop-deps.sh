#!/usr/bin/env bash
set -euo pipefail

if ! command -v apt-get >/dev/null 2>&1; then
  echo "This installer currently supports Debian/Ubuntu hosts (apt-get required)." >&2
  exit 1
fi

SUDO=""
if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  if ! command -v sudo >/dev/null 2>&1; then
    echo "Run this script as root or install sudo first." >&2
    exit 1
  fi
  SUDO="sudo"
fi

$SUDO apt-get update
$SUDO apt-get install -y --no-install-recommends \
  xvfb \
  openbox \
  x11vnc \
  xdotool \
  scrot \
  xclip \
  x11-utils \
  dbus-x11 \
  ca-certificates

echo "EIGENT desktop dependencies installed."
echo "Start EIGENT normally; the server will manage Xvfb/openbox/x11vnc on Linux."
