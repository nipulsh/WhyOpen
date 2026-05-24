# IntentTab

A Chrome extension that asks **"Why are you opening this tab?"** before you browse — helping you stay intentional.

## Features

- Prompt on new tabs and website visits
- Sticky top bar showing your reason, site name, and session timer
- Per-tab sessions stored locally in IndexedDB
- Analytics dashboard with browsing insights
- Dark, minimal UI with smooth animations

## Installation

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select this project folder

## Usage

1. Open a new tab or navigate to any website
2. Enter your reason when prompted
3. Your intention stays visible in the sticky bar until you close the tab or click **Close session**
4. Click the extension icon → **Open analytics** to view your browsing patterns

## Project Structure

```
IntentTab/
├── manifest.json      # Extension manifest (MV3)
├── background.js      # Service worker — tab tracking & messaging
├── content.js         # In-page prompt & sticky bar
├── content.css        # Content script styles
├── db.js              # IndexedDB layer
├── popup.html/css/js  # Extension popup
└── dashboard.html/css/js  # Analytics page
```

## Tech Stack

- Manifest V3
- Vanilla JavaScript
- IndexedDB (native)
- Chrome message passing API

## Permissions

- `tabs` — detect new tabs and tab closure
- `scripting` — inject content scripts when needed
- `webNavigation` — track navigation events
- `<all_urls>` — run on http/https pages

## Notes

- Content scripts only run on `http://` and `https://` pages (not `chrome://` internal pages)
- Data is stored locally in your browser — nothing is sent to any server
