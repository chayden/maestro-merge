# Meet Maestro Merge Helper

Chrome extension for Meet Maestro that helps inspect meet events, merge compatible events, and organize swimmers across heats and lanes.

## Build And Install Locally

Run:

```sh
npm run package
```

This creates:

- `dist/unpacked/` for local Chrome installation.
- `dist/meet-maestro-merge-helper-<version>.zip` for sharing or Chrome Web Store upload.

Then install in Chrome:

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Choose Load unpacked.
4. Select `dist/unpacked/`.
5. Open a Meet Maestro session page and click the extension icon to open the merge panel directly.

## Sharing

For another person to install without the Chrome Web Store, send them the ZIP from `dist/`. They should unzip it, then use `chrome://extensions` -> Developer mode -> Load unpacked and select the unzipped folder.

You do not need a `.crx` for local/developer installation. A `.crx` is mainly useful for Chrome Web Store or managed enterprise distribution, and Chrome generally discourages casual off-store CRX installs.

The package script uses an explicit allowlist of extension files so local HAR captures, analysis notes, and other ignored files are not included.

## Features

- Finds target-based multi-source merge opportunities that can reduce heat count.
- Loads events, heats, lanes, athletes, and seed times from the Meet Maestro API.
- Moves swimmers between events using the same event-record calls Meet Maestro uses.
- Provides an organizer view for reseating swimmers within an event.
- Supports drag-and-drop lane moves, slowest-to-fastest organization, and boys/girls grouping.

## Recommended Use

1. **Create the meet** in SwimTopia using a normal event template with age-group- and gender-specific events.
2. **Sign up swimmers** — swimmers or coaches enter the events they will swim.
3. **Lock changes** for both teams and share the meet.
4. **Apply an alternative event template** — the home team updates the meet to add mixed-gender and cross-age-group events.
5. **Enter Meet Maestro** and activate the extension.
6. **Review merge opportunities** — the extension shows a list of events that can be consolidated to save heats.
7. **Apply merges** — click "Merge" on any you want to apply. Use "Hide" to dismiss ones you don't.
8. **Organize merged events** — for each event after merging, choose how to populate heats: primarily by times, primarily by gender, or manually.
9. **Review the heat sheet** to confirm everything looks correct.
10. **Undo if needed** — return to SwimTopia and "Rebuild" the meet to restore all events to their default state.

## Privacy

The extension runs locally in the browser and does not send data to any third-party service. It reads Meet Maestro API responses in the active Meet Maestro session and uses the current browser session to make SwimTopia API requests.
