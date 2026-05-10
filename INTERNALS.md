# Meet Maestro Internal API Dependencies

This extension depends on undocumented SwimTopia/Meet Maestro APIs. If these endpoints change, the extension will break. This document catalogs every API call so we can assess risk and respond to breakage.

**Base URL:** `https://api.swimtopia.org/v3`

**Auth:** Bearer token in the `Authorization` header. Captured by the background service worker from outgoing requests via `chrome.webRequest.onBeforeSendHeaders`.

**Content type:** `application/vnd.api+json` (JSON:API spec). All request/response bodies use JSON:API `data`/`included`/`relationships` structure.

**Custom header:** `X-Maestro-Client-Version: 10.1.0+f74ce583` — mimics the version sent by the Meet Maestro web app. If the app updates and rejects older client versions, this will need updating.

---

## Read endpoints (data loading)

### GET `/meets/{meetId}?include=teams,sessions`

Fetches the meet record with included sessions and teams. Used to get the lane count (from `session.attributes.laneCount` or `meet.attributes.laneCount`) and team metadata.

### GET `/meets/{meetId}/athletes`

Returns all athletes for the meet. Used to resolve swimmer names and gender from event records.

### GET `/meets/{meetId}/event-nodes?filter[session_id]={sessionId}&include=break`

Returns event nodes for a session. Each event node links to an event via `relationships.event.data.id`. The event node carries `sessionIndex`, `eventNumber`, `ageGroupName`, `strokeCode`, `distance`, `athleteGender`, `athleteMinAge`, `athleteMaxAge`, and other metadata used to match compatible merge candidates.

### GET `/meets/{meetId}/events?filter[id]={id1,id2,...}&include=heats,break,event-records,subevents,event-records.relay-position-records,event-records.splits,event-records.team-grouping-scores`

Batch-fetches events (in chunks of 5 IDs) with their heats and event records. This is the main data-loading call. Returns:
- **events** — stroke, distance, gender, age range, event number, label
- **heats** (included) — heat number, linked to event
- **eventRecord** (included) — lane number, seed time, exhibition flag, linked to heat, athlete, team

---

## Write endpoints (merge and organization)

### PATCH `/meets/{meetId}/event-records/{recordId}`

Moves a swimmer to a different heat and/or lane **within the same event**. Used by the organizer (drag-to-reseat) and internally by the merge flow.

**Payload:**
```json
{
  "data": {
    "type": "eventRecord",
    "id": "<recordId>",
    "attributes": {
      "laneNumber": 3,
      "heatNumber": 2,
      "isExhibition": false
    },
    "relationships": {
      "heat": { "data": { "type": "heat", "id": "<heatId>" } },
      "division": { "data": null }
    }
  }
}
```

### POST `/meets/{meetId}/event-records`

Creates a new event record (entry). Used by the merge flow to move a swimmer into a different event. The source record is first deleted, then recreated under the target event with the same athlete, team, and seed time.

**Payload:**
```json
{
  "data": {
    "type": "eventRecord",
    "id": "<newUuid>",
    "attributes": {
      "teamAbbreviation": "TMS",
      "laneNumber": 4,
      "seedTimeInt": 3842,
      "seedTimeCourseCode": "SCY",
      "heatNumber": 1,
      "isExhibition": false
    },
    "relationships": {
      "event": { "data": { "type": "event", "id": "<targetEventId>" } },
      "team": { "data": { "type": "team", "id": "<teamId>" } },
      "athlete": { "data": { "type": "athlete", "id": "<athleteId>" } },
      "heat": { "data": { "type": "heat", "id": "<heatId>" } },
      "division": { "data": null }
    }
  }
}
```

### DELETE `/meets/{meetId}/event-records/{recordId}`

Deletes an event record. Used as the first step of moving a swimmer across events (delete from source, create in target).

### POST `/meets/{meetId}/heats`

Creates a new heat in an event. Used when merging swimmers into a target that doesn't have enough lanes, and as a temporary scratch heat during organizer swaps.

**Payload:**
```json
{
  "data": {
    "type": "heat",
    "id": "<newUuid>",
    "relationships": {
      "event": { "data": { "type": "event", "id": "<eventId>" } }
    }
  }
}
```

### POST `/meets/{meetId}/remove-empty-heats-tasks`

Initiates an async task to remove empty heats from an event. Returns a task resource with `attributes.currentState` (one of `pending`, `running`, `completed`, `failed`, `errored`).

**Payload:**
```json
{
  "data": {
    "type": "removeEmptyHeatsTask",
    "id": "<newUuid>",
    "relationships": {
      "event": { "data": { "type": "event", "id": "<eventId>" } }
    }
  }
}
```

### GET `/meets/{meetId}/remove-empty-heats-tasks/{taskId}`

Polls the status of a remove-empty-heats task. Called repeatedly until `currentState` is `completed` or `failed`.

---

## Risks and breakage indicators

| Risk | Impact | Likelihood |
|---|---|---|
| JSON:API structure changes (field names, relationship shapes) | All functionality breaks | Medium |
| Auth mechanism changes (different header, token format, session handling) | Extension cannot authenticate | Low |
| `X-Maestro-Client-Version` validation added or version rejected | All requests rejected | Medium |
| Event record move-across-events (delete + create) no longer preserves entry order or seed data | Merge produces incorrect lane assignments | Medium |
| `removeEmptyHeatsTask` endpoint removed or async contract changes | Post-merge cleanup fails; empty heats remain | Low |
| Event node metadata fields renamed (`strokeCode`, `distance`, `athleteGender`, etc.) | Merge compatibility detection breaks | Medium |
| Heat/event-record includes removed or paginated | Data loading incomplete | Medium |
