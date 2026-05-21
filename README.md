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

## Setup Merge Events

Before using the extension, you need to define **merge target events** in your meet's alternative event template. A merge target is an event whose event number ends with a letter (e.g., `1A`, `2B`, `15C`). The extension recognizes these letter-suffixed events as destinations for merging swimmers from other compatible events.

### Rules for merge targets

1. **Event number must end with a letter** — e.g., `1A`, `5B`, `10C`. Events without a trailing letter are treated as source events, not targets.
2. **Stroke and distance must match** — a target can only accept swimmers from source events with the same stroke code and distance.
3. **Age range must be inclusive** — the target's age range must be at least as wide as any source event being merged into it. For example, a target with ages 6–18 can accept swimmers from a 9–10 source, but a 9–10 target cannot accept swimmers from a 6–18 source.
4. **Gender must be compatible** — a target with gender `X` (mixed/open) can accept swimmers from any gender-specific source. A gender-specific target (`M` or `F`) can only accept swimmers of the same gender.

### Example

Say your normal event template has separate events by age and gender:

| # | Event | Stroke | Distance | Ages | Gender |
|---|-------|--------|----------|------|--------|
| 5 | 9-10 Girls 50 Free | Free | 50 | 9–10 | F |
| 6 | 9-10 Boys 50 Free | Free | 50 | 9–10 | M |
| 7 | 11-12 Girls 50 Free | Free | 50 | 11–12 | F |
| 8 | 11-12 Boys 50 Free | Free | 50 | 11–12 | M |

To consolidate these into fewer heats, add merge target events to the alternative template:

| # | Event | Stroke | Distance | Ages | Gender |
|---|-------|--------|----------|------|--------|
| 5A | Mixed 50 Free | Free | 50 | 9–12 | X |

When you activate the extension, it will identify events 5–8 as merge sources and 5A as a merge target. Clicking "Merge" moves swimmers from the source events into the targets, reducing the total number of heats.

Create as many letter-suffixed targets as you need to hold the expected number of swimmers (each heat holds one swimmer per lane).

## Recommended Use — Merge Events for a Meet

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
