# Sourcemap Detector

A browser extension for Firefox and Chrome that finds JavaScript and CSS sourcemaps exposed by the sites you visit and checks which ones can actually be downloaded.

![Screenshot](screenshot.png)

## Install

- **Firefox:** [Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/sourcemap-detector/)
- **Chrome:** [Chrome Web Store](https://chromewebstore.google.com/detail/hnpmmdmhodhmenohiloleboobgcjikja)

## Features

- Detects `SourceMap` / `X-SourceMap` response headers on scripts and stylesheets
- Detects `//# sourceMappingURL=` (JS) and `/*# sourceMappingURL= */` (CSS) comments, including in chunks loaded lazily after the page loads
- Detects the same comments in inline `<script>` and `<style>` blocks, including inline data URI maps
- Fetches each referenced map and checks that it is a valid sourcemap
- Groups results by domain, so third-party scripts can be skipped
- Copies all map URLs to the clipboard or exports them to a text file
- Explorer: browse each map's original source files as a tree and download them as a ZIP, with no separate tool needed
- Preserve log: keep a tab's results when it navigates to another page

## Statuses

| Status | Meaning |
| --- | --- |
| Exposed · N sources (+ code) | Valid sourcemap. "+ code" means it includes `sourcesContent`, the original source |
| Embedded | Inline data URI map |
| HTTP *nnn* | Referenced, but the server returns an error |
| Not a sourcemap | The URL responds, but not with a sourcemap (e.g. a soft 404 page) |
| Fetch failed | Network error or timeout |
| Redirects (not followed) | The map URL redirects. Redirects are never followed |
| Not checked (private host) | The map is on localhost or a private network address but the page isn't, so it isn't fetched |
| Too large to check | Over 30 MB |

The toolbar badge is red with the number of exposed maps, or grey with the number of references when none are confirmed. Skipped domains don't count.

## Using the popup

- The domain bar at the top lists every domain that references a sourcemap, with its count. Click a domain to skip it, and click it again to include it. The **\*** button beside a subdomain skips its whole domain, such as everything under `medallia.eu`; hover it to see which domain that is. Skipped domains are hidden from the list and left out of the badge, Copy All and Export on every site.
- Groups for the current site start expanded, other domains start collapsed. Click a group header to toggle it.
- With **Only exposed** ticked (the default), Copy All and Export include only maps confirmed downloadable.
- The count in the header shows how many maps Copy All and Export will include, out of the total found.
- **Preserve log** keeps each tab's results when it navigates to another page, until the tab is closed. Entries from an earlier page show which page they were found on. **Clear** empties the current tab's results.
- **Explorer ↗** opens the explorer for the current tab.

Skipped domains, Only exposed and Preserve log are remembered.

## Explorer

The explorer opens in its own tab and lists the current tab's sourcemaps by domain. Expand a map to download it and browse its original source files as a folder tree; select a file to view, copy or download it. Files the map lists without including their source are shown greyed out.

**ZIP** on a domain or map row, or **Download all as ZIP**, saves the original sources as `<domain>/<map name>/<source path>`. Download all follows the popup's skipped domains and Only exposed setting. Each archive includes an `index.txt` listing every map, its URL, and any files or maps that couldn't be included.

Source paths come from the website, so they are cleaned before use: `webpack://` prefixes become folders, `..` can't leave the map's folder, and characters that aren't valid in file names are replaced.

Maps are downloaded again when you open them, with the same limits as the checks: no cookies, no redirects, nothing on private hosts from public pages. A map inline in a page's own `<script>` or `<style>` is read back from the open page, so it can only be opened while that page is still loaded in the tab.

## Privacy

To read file contents, the extension downloads each script and stylesheet a second time, plus every sourcemap they reference. These requests are made without cookies. The extension collects no data and sends nothing anywhere other than the sites you visit. Settings are stored locally in your browser.

Public pages can't make the extension request localhost or private network addresses, and it never follows redirects. This check uses hostnames only, so a public DNS name that resolves to a private address is not caught.

Only use it on sites you are authorized to assess.

## Building

Requires Node.js.

```sh
npm run build            # builds dist/firefox and dist/chrome
npm run package:firefox  # dist/sourcemap-detector-firefox.zip (needs zip)
npm run package:chrome   # dist/sourcemap-detector-chrome.zip (needs zip)
npm test
```

## Loading an unpacked build

- **Chrome:** open `chrome://extensions`, enable Developer mode, click **Load unpacked** and select `dist/chrome`.
- **Firefox:** open `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on** and select `dist/firefox/manifest.json`.

## Project layout

```
src/shared/      detection, sourcemap validation and URL helpers
src/background/  request monitoring, fetching and verification
src/content/     page scanning for inline blocks and loaded resources
src/popup/       popup UI
src/explorer/    explorer page and ZIP export
manifests/       Firefox (MV2) and Chrome (MV3) manifests
test/            unit tests (node --test)
```
