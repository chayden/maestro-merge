# Meet Maestro Merge Helper

Chrome extension for Meet Maestro that helps inspect meet events, merge compatible events, and organize swimmers across heats and lanes.

## Install Locally

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Choose Load unpacked.
4. Select this directory.
5. Open a Meet Maestro session page and click the extension icon to open the merge panel directly.

## Package

Run:

```sh
npm run package
```

The packaged extension is written to `dist/`. The package script uses an explicit allowlist of extension files so local HAR captures, analysis notes, and other ignored files are not included.

## Features

- Finds event merge opportunities that can reduce heat count.
- Loads events, heats, lanes, athletes, and seed times from the Meet Maestro API.
- Moves swimmers between events using the same event-record calls Meet Maestro uses.
- Provides an organizer view for reseating swimmers within an event.
- Supports drag-and-drop lane moves, slowest-to-fastest organization, and boys/girls grouping.

## Privacy

The extension runs locally in the browser and does not send data to any third-party service. It reads Meet Maestro API responses in the active Meet Maestro session and uses the current browser session to make SwimTopia API requests.
