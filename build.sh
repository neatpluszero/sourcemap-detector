#!/usr/bin/env bash
set -euo pipefail

TARGET="${1:-both}"

build_firefox() {
  echo "Building Firefox extension..."
  rm -rf dist/firefox
  mkdir -p dist/firefox/{shared,background,content,popup,icons}

  cp src/shared/*.js dist/firefox/shared/
  cp src/background/background.js dist/firefox/background/
  cp src/background/background-firefox.js dist/firefox/background/
  cp src/content/content.js dist/firefox/content/
  cp src/popup/* dist/firefox/popup/
  cp src/icons/* dist/firefox/icons/
  cp manifests/firefox/manifest.json dist/firefox/

  echo "  -> dist/firefox/"
}

build_chrome() {
  echo "Building Chrome extension..."
  rm -rf dist/chrome
  mkdir -p dist/chrome/{background,content,popup,icons}

  # Bundle background: shared modules + background controller + chrome entry
  cat src/shared/constants.js \
      src/shared/utils.js \
      src/shared/detector.js \
      src/background/background.js \
      src/background/background-chrome.js \
      > dist/chrome/background/background-chrome-bundle.js

  # Bundle content: shared modules + content script
  cat src/shared/constants.js \
      src/shared/utils.js \
      src/shared/detector.js \
      src/content/content.js \
      > dist/chrome/content/content-bundle.js

  cp src/popup/* dist/chrome/popup/
  cp src/icons/* dist/chrome/icons/
  cp manifests/chrome/manifest.json dist/chrome/

  echo "  -> dist/chrome/"
}

package_firefox() {
  build_firefox
  echo "Packaging Firefox extension..."
  (cd dist/firefox && zip -r ../sourcemap-detector-firefox.zip .)
  echo "  -> dist/sourcemap-detector-firefox.zip"
}

package_chrome() {
  build_chrome
  echo "Packaging Chrome extension..."
  (cd dist/chrome && zip -r ../sourcemap-detector-chrome.zip .)
  echo "  -> dist/sourcemap-detector-chrome.zip"
}

case "$TARGET" in
  firefox)         build_firefox ;;
  chrome)          build_chrome ;;
  both)            build_firefox; build_chrome ;;
  package-firefox) package_firefox ;;
  package-chrome)  package_chrome ;;
  package)         package_firefox; package_chrome ;;
  *)
    echo "Usage: $0 {firefox|chrome|both|package-firefox|package-chrome|package}"
    exit 1
    ;;
esac

echo "Done."
