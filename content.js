// Content script for Meet Maestro Merge Helper
// Runs on maestro.swimtopia.com
//
// Focus: detect cross-event merge opportunities to reduce total heats.
// Swimmers "swim up" into the next age group's event when combining saves heats.

(function () {
  if (window.__mmMergeHelperLoaded) return;
  window.__mmMergeHelperLoaded = true;

  let authToken = null;
  let meetId = null;
  let sessionId = null;
  let api = null;
  let panelVisible = false;
  let mergePanel = null;
  let allEvents = [];
  let allRecords = [];
  let allHeats = [];
  let allAthletes = [];
  let allEventNodes = [];
  let allTeams = [];
  let laneCount = null; // Loaded from Meet Maestro metadata.
  let appliedMerges = new Set(); // track which opportunities have been applied
  let currentView = 'dashboard';
  let organizerEventId = null;
  let operationDepth = 0;
  let organizerLabelMode = 'initials';

  // ---- Auth & meet ID detection ----

  // Extract meetId and sessionId from the page URL immediately.
  function extractIdsFromURL() {
    const prevMeetId = meetId;
    const prevSessionId = sessionId;
    const m = window.location.href.match(/\/meet[s]?\/(\d+)/i);
    meetId = m ? m[1] : null;
    const s = window.location.href.match(/\/session\/(\d+)/i);
    sessionId = s ? s[1] : null;
    return prevMeetId !== meetId || prevSessionId !== sessionId;
  }

  extractIdsFromURL();

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function handleLocationChange() {
    const changed = extractIdsFromURL();
    if (!changed) return;
    api = null;
    appliedMerges = new Set();
    if (panelVisible && mergePanel) {
      withBusy('Loading meet data...', () => loadData()).catch(() => {});
    }
  }

  const originalPushState = history.pushState.bind(history);
  history.pushState = function (...args) {
    const result = originalPushState(...args);
    handleLocationChange();
    return result;
  };

  const originalReplaceState = history.replaceState.bind(history);
  history.replaceState = function (...args) {
    const result = originalReplaceState(...args);
    handleLocationChange();
    return result;
  };

  window.addEventListener('popstate', handleLocationChange);
  window.addEventListener('hashchange', handleLocationChange);

  // Get auth token: ask background script (which intercepts headers from all
  // network traffic), then fall back to localStorage scan.
  async function acquireAuthToken() {
    // 1. Ask background script — it sees all requests via webRequest API
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'GET_AUTH_TOKEN' });
      if (resp?.token) {
        authToken = resp.token;
        return authToken;
      }
    } catch (err) {
      console.debug('[Merge Helper] auth token request failed:', err);
    }

    // 2. Scan localStorage for something that looks like a hex bearer token
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const val = localStorage.getItem(localStorage.key(i));
        if (val && typeof val === 'string' && val.length > 40 && /^[a-f0-9]+$/.test(val)) {
          authToken = val;
          return authToken;
        }
      }
    } catch (err) {
      console.debug('[Merge Helper] localStorage auth scan failed:', err);
    }
    
    return null;
  }

  // Fire immediately
  acquireAuthToken();

  async function getAPI() {
    extractIdsFromURL();
    if (!meetId || !sessionId) return null;
    if (!authToken) acquireAuthToken().catch(() => {});
    if (!api || api.authToken !== authToken || api.meetId !== meetId || api.sessionId !== sessionId) {
      api = new SwimTopiaAPI(authToken, meetId, sessionId);
    }
    return api;
  }

  async function waitForAPI(retries = 10, delayMs = 500) {
    for (let attempt = 0; attempt < retries; attempt++) {
      const client = await getAPI();
      if (client) return client;
      if (attempt < retries - 1) await sleep(delayMs);
    }
    return null;
  }

  // ---- Messaging from popup ----

  chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
    if (msg.type === 'GET_STATUS') {
      acquireAuthToken().then(() => {
        respond({ connected: !!(meetId && sessionId), hasAuthToken: !!authToken, meetId, sessionId });
      });
      return true; // async respond
    } else if (msg.type === 'OPEN_MERGE_PANEL') {
      togglePanel();
      respond({ ok: true });
    } else if (msg.type === 'REFRESH_DATA') {
      withBusy('Refreshing meet data...', () => loadData())
        .then(() => respond({ ok: true }))
        .catch(err => respond({ ok: false, error: err.message }));
      return true;
    }
  });

  function togglePanel() {
    if (panelVisible && mergePanel) {
      mergePanel.style.display = 'none';
      panelVisible = false;
    } else {
      buildPanel();
      mergePanel.style.display = 'flex';
      panelVisible = true;
      withBusy('Loading meet data...', () => loadData()).catch(() => {});
    }
  }

  // ---- Data loading ----

  async function loadData() {
    const a = await waitForAPI();
    if (!a) {
      const c = document.getElementById('mm-body');
      if (c) c.innerHTML = '<div class="mm-error">Waiting for Meet Maestro session data or API auth. Give the page a moment and try again.</div>';
      throw new Error('Waiting for API connection.');
    }
    try {
      const data = await a.loadSessionData();
      allEvents = data.events || [];
      allRecords = data.records || [];
      allHeats = data.heats || [];
      allAthletes = data.athletes || [];
      allEventNodes = data.eventNodes || [];
      allTeams = data.teams || [];
      updateLaneCountFromMeet(data);
      if (currentView === 'organizer' && organizerEventId) {
        renderOrganizer(organizerEventId);
      } else {
        renderDashboard();
      }
    } catch (err) {
      console.error('[Merge Helper] load failed:', err);
      const c = document.getElementById('mm-body');
      if (c) c.innerHTML = `<div class="mm-error">Failed to load meet data: ${esc(err.message)}</div>`;
      throw err;
    }
  }

  // ---- Helpers ----

  function isOperationInFlight() {
    return operationDepth > 0;
  }

  function setBusyMessage(message) {
    const overlay = document.getElementById('mm-busy-overlay');
    if (!overlay) return;
    const messageEl = overlay.querySelector('.mm-busy-message');
    if (messageEl) messageEl.textContent = message;
  }

  function beginOperation(message) {
    operationDepth++;
    if (mergePanel) {
      mergePanel.classList.add('mm-busy');
      mergePanel.setAttribute('aria-busy', 'true');
      setPanelInteractionLocked(true);
    }
    setBusyMessage(message);

    return () => {
      operationDepth = Math.max(0, operationDepth - 1);
      if (operationDepth > 0) return;
      if (mergePanel) {
        mergePanel.classList.remove('mm-busy');
        mergePanel.removeAttribute('aria-busy');
        setPanelInteractionLocked(false);
      }
    };
  }

  function setPanelInteractionLocked(isLocked) {
    if (!mergePanel) return;

    mergePanel.querySelectorAll('button, input, select, textarea').forEach(control => {
      if (isLocked) {
        if (!control.disabled) {
          control.dataset.mmDisabledByBusy = 'true';
          control.disabled = true;
        }
      } else if (control.dataset.mmDisabledByBusy === 'true') {
        control.disabled = false;
        delete control.dataset.mmDisabledByBusy;
      }
    });

    mergePanel.querySelectorAll('[draggable="true"], [data-mm-was-draggable="true"]').forEach(el => {
      if (isLocked) {
        el.dataset.mmWasDraggable = 'true';
        el.setAttribute('draggable', 'false');
      } else if (el.dataset.mmWasDraggable === 'true') {
        el.setAttribute('draggable', 'true');
        delete el.dataset.mmWasDraggable;
      }
    });
  }

  async function withBusy(message, fn) {
    if (isOperationInFlight()) throw new Error('Another operation is already in progress.');
    const finish = beginOperation(message);
    try {
      return await fn();
    } finally {
      finish();
    }
  }

  function esc(s) {
    const d = document.createElement('span');
    d.textContent = s;
    return d.innerHTML;
  }

  function recordsFor(eventId) {
    return allRecords.filter(r => r.relationships?.event?.data?.id === eventId);
  }

  function eventNodeFor(eventId) {
    return allEventNodes.find(n => n.relationships?.event?.data?.id === eventId || n.id === eventId);
  }

  function heatsFor(eventId) {
    return allHeats
      .filter(h => h.relationships?.event?.data?.id === eventId)
      .sort((a, b) => heatSortValue(a) - heatSortValue(b));
  }

  function athleteFor(record) {
    const athleteId = record.relationships?.athlete?.data?.id;
    return allAthletes.find(a => a.id === athleteId) || null;
  }

  function teamFor(record) {
    const teamId = record.relationships?.team?.data?.id;
    return allTeams.find(t => t.id === teamId) || null;
  }

  function athleteDisplayName(athlete) {
    const a = athlete?.attributes || {};
    const first = a.displayFirstName || a.preferredFirstName || a.firstName || '';
    const last = a.lastName || '';
    return `${first} ${last}`.trim() || 'Swimmer';
  }

  function recordDisplayName(record) {
    return athleteDisplayName(athleteFor(record));
  }

  function recordTeamAbbreviation(record) {
    return record.attributes?.teamAbbreviation || teamFor(record)?.attributes?.abbreviation || '';
  }

  function recordTeamId(record) {
    return record.relationships?.team?.data?.id || recordTeamAbbreviation(record);
  }

  function teamColorFor(record) {
    const key = recordTeamId(record);
    const palette = [
      '#0f766e',
      '#b45309',
      '#7c3aed',
      '#be123c',
      '#2563eb',
      '#15803d',
      '#c2410c',
      '#9333ea',
    ];
    if (!key) return '#64748b';
    let hash = 0;
    for (let i = 0; i < key.length; i++) {
      hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
    }
    return palette[Math.abs(hash) % palette.length];
  }

  function renderTeamLegend(records) {
    const teams = [];
    const seen = new Set();
    records.forEach(record => {
      const id = recordTeamId(record);
      const abbreviation = recordTeamAbbreviation(record);
      if (!id || !abbreviation || seen.has(id)) return;
      seen.add(id);
      teams.push({ abbreviation, color: teamColorFor(record) });
    });

    if (teams.length === 0) return '';

    return `<div class="mm-team-legend">
      <span>Teams</span>
      ${teams.map(team => `
        <span class="mm-team-legend-chip" style="--mm-team-color: ${team.color};">
          <i></i>${esc(team.abbreviation)}
        </span>
      `).join('')}
    </div>`;
  }

  function athleteInitials(record) {
    const athlete = athleteFor(record);
    const a = athlete?.attributes || {};
    const first = a.displayFirstName || a.preferredFirstName || a.firstName || '';
    const last = a.lastName || '';
    const initials = `${first.charAt(0)}${last.charAt(0)}`.trim();
    return initials || '?';
  }

  function eventRankMap(eventId) {
    const ranks = new Map();
    recordsFor(eventId)
      .slice()
      .sort(compareFastestFirst)
      .forEach((record, index) => {
        ranks.set(record.id, index + 1);
      });
    return ranks;
  }

  function teamRankMap(eventId) {
    const teamRanks = new Map();
    const rankByRecordId = new Map();

    recordsFor(eventId)
      .slice()
      .sort(compareFastestFirst)
      .forEach(record => {
        const teamId = recordTeamId(record);
        const nextRank = (teamRanks.get(teamId) || 0) + 1;
        teamRanks.set(teamId, nextRank);
        rankByRecordId.set(record.id, nextRank);
      });

    return rankByRecordId;
  }

  function sexRankMap(eventId) {
    const sexRanks = new Map();
    const rankByRecordId = new Map();

    recordsFor(eventId)
      .slice()
      .sort(compareFastestFirst)
      .forEach(record => {
        const sex = athleteGender(record) || 'U';
        const nextRank = (sexRanks.get(sex) || 0) + 1;
        sexRanks.set(sex, nextRank);
        rankByRecordId.set(record.id, nextRank);
      });

    return rankByRecordId;
  }

  function organizerPrimaryLabel(record, eventId, ranks) {
    if (organizerLabelMode === 'event-rank') return String(ranks.event.get(record.id) || '?');
    if (organizerLabelMode === 'team-rank') return String(ranks.team.get(record.id) || '?');
    if (organizerLabelMode === 'sex-rank') return String(ranks.sex.get(record.id) || '?');
    return athleteInitials(record);
  }

  function athleteGenderClass(record) {
    const gender = (athleteFor(record)?.attributes?.gender || '').toUpperCase();
    if (gender === 'M') return 'mm-swimmer-boy';
    if (gender === 'F') return 'mm-swimmer-girl';
    return '';
  }

  function formatTimeInt(timeInt) {
    if (timeInt === null || timeInt === undefined) return 'NT';
    const totalHundredths = Number(timeInt);
    if (!Number.isFinite(totalHundredths)) return String(timeInt);
    const minutes = Math.floor(totalHundredths / 6000);
    const seconds = Math.floor((totalHundredths % 6000) / 100);
    const hundredths = totalHundredths % 100;
    if (minutes > 0) return `${minutes}:${String(seconds).padStart(2, '0')}.${String(hundredths).padStart(2, '0')}`;
    return `${seconds}.${String(hundredths).padStart(2, '0')}`;
  }

  function recordSeedTime(record) {
    return formatTimeInt(record.attributes?.seedTimeInt);
  }

  function seedSortValue(record) {
    const time = record.attributes?.seedTimeInt;
    return time === null || time === undefined ? Infinity : Number(time);
  }

  function compareByName(a, b) {
    return recordDisplayName(a).localeCompare(recordDisplayName(b));
  }

  function compareFastestFirst(a, b) {
    const timeDiff = seedSortValue(a) - seedSortValue(b);
    if (timeDiff !== 0) return timeDiff;
    return compareByName(a, b);
  }

  function compareSlowestFirst(a, b) {
    const aTime = seedSortValue(a);
    const bTime = seedSortValue(b);
    if (aTime === bTime) return compareByName(a, b);
    if (aTime === Infinity) return -1;
    if (bTime === Infinity) return 1;
    return bTime - aTime;
  }

  function athleteGender(record) {
    return (athleteFor(record)?.attributes?.gender || '').toUpperCase();
  }

  function requireLaneCount() {
    const count = Number(laneCount);
    if (!Number.isInteger(count) || count <= 0) {
      throw new Error('Meet Maestro did not return a valid pool lane count.');
    }
    return count;
  }

  function heatNumberFor(heat, context = 'heat') {
    const number = Number(heat?.attributes?.number);
    if (!Number.isInteger(number) || number <= 0) {
      throw new Error(`Missing heat number for ${context}.`);
    }
    return number;
  }

  function laneNumberFor(record, context = 'event record') {
    const lane = Number(record?.attributes?.laneNumber);
    if (!Number.isInteger(lane) || lane <= 0) {
      throw new Error(`Missing lane number for ${context}.`);
    }
    return lane;
  }

  function laneSeedOrder() {
    const laneTotal = requireLaneCount();
    const preferredSixLaneOrder = [4, 3, 5, 2, 6, 1];
    if (laneTotal === 6) return preferredSixLaneOrder;

    const centerHigh = Math.floor(laneTotal / 2) + 1;
    const centerLow = Math.floor((laneTotal + 1) / 2);
    const order = [];
    for (let offset = 0; order.length < laneTotal; offset++) {
      const high = centerHigh + offset;
      const low = centerLow - offset;
      if (high <= laneTotal && !order.includes(high)) order.push(high);
      if (low >= 1 && !order.includes(low)) order.push(low);
    }
    return order;
  }

  function updateLaneCountFromMeet(data) {
    const session = (data.sessions || []).find(s => s.id === sessionId);
    const apiLaneCount = session?.attributes?.laneCount || data.meet?.attributes?.laneCount;
    const count = Number(apiLaneCount);
    if (!Number.isInteger(count) || count <= 0) {
      laneCount = null;
      throw new Error('Meet Maestro did not return a valid pool lane count.');
    }
    laneCount = count;
  }

  function heatsNeeded(swimmerCount) {
    return Math.ceil(swimmerCount / requireLaneCount());
  }

  function currentHeatCount(evt) {
    const heatCount = heatsFor(evt.id).length;
    if (heatCount > 0) return heatCount;
    return null;
  }

  function eventLabel(evt) {
    const a = evt.attributes || {};
    const node = eventNodeFor(evt.id);
    const eventNumber = a.eventNumber || node?.attributes?.eventNumber;
    const ageGroup = a.ageGroupName || node?.attributes?.ageGroupName;
    const label = a.label || a.fullLabel || node?.attributes?.label;
    const parts = [];
    if (eventNumber) parts.push(`#${eventNumber}`);
    if (ageGroup) parts.push(ageGroup);
    if (label) parts.push(label);
    if (!parts.length) parts.push(evt.id.slice(0, 8));
    return parts.join(' ');
  }

  function raceLabel(evt) {
    const a = evt.attributes || {};
    const distance = a.distance ? `${a.distance}m` : '';
    const stroke = a.strokeLabel || a.label || a.fullLabel || '';
    return `${distance} ${stroke}`.trim() || evt.id.slice(0, 8);
  }

  function eventSortValue(evt) {
    const node = eventNodeFor(evt.id);
    const value = node?.attributes?.sessionIndex ?? evt.attributes?.sessionIndex;
    return Number.isFinite(Number(value)) ? Number(value) : null;
  }

  function compareEventOrder(a, b) {
    const aSort = eventSortValue(a);
    const bSort = eventSortValue(b);
    if (aSort !== null && bSort !== null && aSort !== bSort) return aSort - bSort;
    if (aSort !== null && bSort === null) return -1;
    if (aSort === null && bSort !== null) return 1;
    return eventLabel(a).localeCompare(eventLabel(b));
  }

  function heatSortValue(heat) {
    const value = Number(heat?.attributes?.number);
    return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
  }

  function eventGender(evt) {
    return evt.attributes?.athleteGender || eventNodeFor(evt.id)?.attributes?.athleteGender || '';
  }

  function eventAgeMin(evt) {
    return evt.attributes?.athleteMinAge ?? eventNodeFor(evt.id)?.attributes?.athleteMinAge ?? null;
  }

  function eventAgeMax(evt) {
    return evt.attributes?.athleteMaxAge ?? eventNodeFor(evt.id)?.attributes?.athleteMaxAge ?? null;
  }

  function heatSummary(evt) {
    const entries = recordsFor(evt.id).length;
    const heats = currentHeatCount(evt);
    if (heats === null) return `${entries} entr${entries === 1 ? 'y' : 'ies'} / no heat resources`;
    return `${entries} entr${entries === 1 ? 'y' : 'ies'} / ${heats} heat${heats === 1 ? '' : 's'}`;
  }

  function targetCapacityFor(evt) {
    return heatsFor(evt.id).length * requireLaneCount();
  }

  function openLaneCountFor(evt) {
    const occupiedSlots = new Set(
      recordsFor(evt.id)
        .map(record => {
          const heatId = record.relationships?.heat?.data?.id;
          const lane = Number(record.attributes?.laneNumber);
          return heatId && lane ? `${heatId}:${lane}` : null;
        })
        .filter(Boolean)
    );
    return Math.max(0, targetCapacityFor(evt) - occupiedSlots.size);
  }

  function missingHeatCountForOpportunity(opp) {
    const missingLanes = Math.max(0, opp.sourceSwimmerCount - openLaneCountFor(opp.targetEvent));
    return Math.ceil(missingLanes / requireLaneCount());
  }

  // Group events by stroke + distance (same "race", different age/gender)
  function groupEventsByRace() {
    const groups = {};
    for (const evt of allEvents) {
      const a = evt.attributes || {};
      const stroke = a.strokeCode ?? eventNodeFor(evt.id)?.attributes?.strokeCode;
      const distance = a.distance ?? eventNodeFor(evt.id)?.attributes?.distance;
      if (stroke === null || stroke === undefined || distance === null || distance === undefined) continue;
      const key = `${distance}-${stroke}`;
      if (!key) continue;
      if (!groups[key]) groups[key] = [];
      groups[key].push(evt);
    }
    // Filter to groups with >1 event (potential merge targets)
    return Object.entries(groups)
      .filter(([, evts]) => evts.length > 1)
      .sort(([a], [b]) => a.localeCompare(b));
  }

  // ---- Optimization analysis ----

  // For a set of events, enumerate merge opportunities.
  // A "merge" means moving all swimmers from a younger event into the next older event.
  // We prefer same-gender first, then cross-gender if it saves more heats.

  function findOpportunities() {
    const opportunities = [];
    const raceGroups = groupEventsByRace();

    for (const [raceKey, evts] of raceGroups) {
      // Sort events: prefer ordering by age group, then gender
      const completeEvents = evts.filter(evt =>
        eventAgeMin(evt) !== null &&
        eventAgeMax(evt) !== null &&
        heatsFor(evt.id).length > 0
      );
      const sorted = [...completeEvents].sort((a, b) => {
        const ageDiff = Number(eventAgeMin(a)) - Number(eventAgeMin(b));
        if (ageDiff !== 0) return ageDiff;
        const maxAgeDiff = Number(eventAgeMax(a)) - Number(eventAgeMax(b));
        if (maxAgeDiff !== 0) return maxAgeDiff;
        const genderDiff = eventGender(a).localeCompare(eventGender(b));
        if (genderDiff !== 0) return genderDiff;
        return compareEventOrder(a, b);
      });

      // Try all pair combinations (younger → older, "swim up")
      for (let i = 0; i < sorted.length; i++) {
        for (let j = i + 1; j < sorted.length; j++) {
          const srcEvt = sorted[i];
          const tgtEvt = sorted[j];
          const srcRecs = recordsFor(srcEvt.id);
          const tgtRecs = recordsFor(tgtEvt.id);
          const srcCount = srcRecs.length;
          const tgtCount = tgtRecs.length;

          if (srcCount === 0) continue;
          if (heatsFor(tgtEvt.id).length === 0) continue;

          const srcHeats = currentHeatCount(srcEvt);
          const tgtHeats = currentHeatCount(tgtEvt);
          if (srcHeats === null || tgtHeats === null) continue;
          const currentTotal = srcHeats + tgtHeats;
          const combinedHeats = heatsNeeded(srcCount + tgtCount);
          const saved = currentTotal - combinedHeats;

          if (saved > 0) {
            const srcGender = eventGender(srcEvt).toLowerCase();
            const tgtGender = eventGender(tgtEvt).toLowerCase();
            const sameGender = srcGender === tgtGender;

            opportunities.push({
              id: `${srcEvt.id}->${tgtEvt.id}`,
              raceKey,
              raceLabel: raceLabel(srcEvt),
              sourceEvent: srcEvt,
              targetEvent: tgtEvt,
              sourceLabel: eventLabel(srcEvt),
              targetLabel: eventLabel(tgtEvt),
              sourceSwimmerCount: srcCount,
              targetSwimmerCount: tgtCount,
              currentHeats: currentTotal,
              combinedHeats,
              heatsSaved: saved,
              sameGender,
              sourceRecords: srcRecs,
              targetRecords: tgtRecs,
              missingHeatCount: 0,
              canApply: true,
            });
            opportunities[opportunities.length - 1].missingHeatCount = missingHeatCountForOpportunity(opportunities[opportunities.length - 1]);
          }
        }
      }

      // Also check triple+ merges: combine all events of this race
      if (sorted.length >= 3) {
        const totalSwimmers = sorted.reduce((sum, e) => sum + recordsFor(e.id).length, 0);
        const totalHeatsSeparate = sorted.reduce((sum, e) => {
          return sum + currentHeatCount(e);
        }, 0);
        const combinedAll = heatsNeeded(totalSwimmers);
        const savedAll = totalHeatsSeparate - combinedAll;
        const target = sorted[sorted.length - 1];
        const sourceCount = totalSwimmers - recordsFor(target.id).length;

        if (savedAll > 0 && heatsFor(target.id).length > 0) {
          // Only add if it saves MORE than any pair already found
          const pairSaved = opportunities
            .filter(o => o.raceKey === raceKey)
            .reduce((max, o) => Math.max(max, o.heatsSaved), 0);

          if (savedAll > pairSaved) {
            opportunities.push({
              id: sorted.map(e => e.id).join('+'),
              raceKey,
              raceLabel: raceLabel(sorted[0]),
              sourceEvent: null, // multiple
              targetEvent: target, // oldest event as target
              sourceLabel: sorted.slice(0, -1).map(eventLabel).join(' + '),
              targetLabel: eventLabel(target),
              sourceSwimmerCount: sourceCount,
              targetSwimmerCount: recordsFor(target.id).length,
              currentHeats: totalHeatsSeparate,
              combinedHeats: combinedAll,
              heatsSaved: savedAll,
              sameGender: false,
              sourceRecords: sorted.slice(0, -1).flatMap(e => recordsFor(e.id)),
              targetRecords: recordsFor(target.id),
              allSourceEvents: sorted.slice(0, -1),
              missingHeatCount: 0,
              canApply: true,
            });
            opportunities[opportunities.length - 1].missingHeatCount = missingHeatCountForOpportunity(opportunities[opportunities.length - 1]);
          }
        }
      }
    }

    // Sort: most heats saved first, prefer same-gender
    opportunities.sort((a, b) => {
      if (b.heatsSaved !== a.heatsSaved) return b.heatsSaved - a.heatsSaved;
      if (a.sameGender !== b.sameGender) return a.sameGender ? -1 : 1;
      return 0;
    });

    return opportunities;
  }

  // ---- Rendering ----

  function buildPanel() {
    if (mergePanel) {
      mergePanel.style.display = 'flex';
      panelVisible = true;
      return;
    }

    mergePanel = document.createElement('div');
    mergePanel.id = 'mm-panel';
    mergePanel.innerHTML = `
      <div class="mm-header">
        <div>
          <h2>Meet Merge Helper</h2>
          <div class="mm-header-subtitle">${meetId ? `Meet ${esc(meetId)}` : 'Meet'}${sessionId ? ` · Session ${esc(sessionId)}` : ''}</div>
        </div>
        <div class="mm-header-actions">
          <button class="mm-btn mm-btn-sm" id="mm-reload">Refresh</button>
          <button class="mm-btn mm-btn-sm mm-btn-secondary" id="mm-page-reload">Reload Page</button>
          <button class="mm-btn mm-btn-sm" id="mm-close">&times;</button>
        </div>
      </div>
      <div id="mm-summary" class="mm-summary"></div>
      <div id="mm-body" class="mm-body">
        <div class="mm-loading">Loading meet data...</div>
      </div>
      <div id="mm-busy-overlay" class="mm-busy-overlay" aria-live="polite" aria-atomic="true">
        <div class="mm-busy-card">
          <div class="mm-spinner" aria-hidden="true"></div>
          <div class="mm-busy-title">Working</div>
          <div class="mm-busy-message">Please wait...</div>
        </div>
      </div>
    `;
    document.body.appendChild(mergePanel);

    document.getElementById('mm-close').addEventListener('click', () => {
      mergePanel.style.display = 'none';
      panelVisible = false;
    });
    document.getElementById('mm-reload').addEventListener('click', () => {
      withBusy('Refreshing meet data...', () => loadData()).catch(() => {});
    });
    document.getElementById('mm-page-reload').addEventListener('click', () => {
      window.location.reload();
    });
  }

  function renderDashboard() {
    currentView = 'dashboard';
    organizerEventId = null;
    const opportunities = findOpportunities();
    renderSummary(opportunities);
    renderOpportunities(opportunities);
  }

  function renderSummary(opportunities) {
    const el = document.getElementById('mm-summary');
    if (!el) return;

    const totalSaved = opportunities.reduce((s, o) => s + o.heatsSaved, 0);
    const seededEvents = allEvents.filter(e => recordsFor(e.id).length > 0).length;
    const swimmerEntries = allRecords.length;
    const heatCount = allHeats.length;
    const lanes = laneCount === null ? 'Not loaded' : laneCount;

    el.innerHTML = `
      <div class="mm-summary-stat">
        <span class="mm-stat-value">${opportunities.length}</span>
        <span class="mm-stat-label">Possible Merges</span>
      </div>
      <div class="mm-summary-stat mm-stat-saved">
        <span class="mm-stat-value">${totalSaved}</span>
        <span class="mm-stat-label">Heats Saved</span>
      </div>
      <div class="mm-summary-stat">
        <span class="mm-stat-value">${seededEvents}/${allEvents.length}</span>
        <span class="mm-stat-label">Events With Entries</span>
      </div>
      <div class="mm-summary-stat">
        <span class="mm-stat-value">${swimmerEntries}/${heatCount}</span>
        <span class="mm-stat-label">Entries / Heats</span>
      </div>
      <div class="mm-summary-stat">
        <span class="mm-stat-value">${esc(lanes)}</span>
        <span class="mm-stat-label">Pool Lanes</span>
      </div>
    `;
  }

  function renderOpportunities(opportunities) {
    const el = document.getElementById('mm-body');
    if (!el) return;

    if (opportunities.length === 0) {
      el.innerHTML = `
        <div class="mm-empty">
          <div class="mm-empty-title">No heat-saving merges found</div>
          <div class="mm-empty-copy">The loaded entries already fit within the current lane count, or there are no compatible seeded events to combine.</div>
        </div>
        ${renderSeededEvents()}
      `;
      el.querySelectorAll('.mm-organize-event').forEach(btn => {
        btn.addEventListener('click', () => openOrganizer(btn.dataset.eventId));
      });
      return;
    }

    let html = `
      <div class="mm-context">
        <div class="mm-context-title">Best heat-saving options</div>
        <div class="mm-context-copy">Each card moves all entries from the first event into the second event and compares current actual heats against the ${requireLaneCount()}-lane pool returned by Meet Maestro.</div>
      </div>
    `;

    // Group by race
    const byRace = {};
    for (const opp of opportunities) {
      if (!byRace[opp.raceKey]) byRace[opp.raceKey] = [];
      byRace[opp.raceKey].push(opp);
    }

    for (const [raceKey, opps] of Object.entries(byRace)) {
      html += `<div class="mm-race-group">
        <div class="mm-race-header">${esc(opps[0].raceLabel || raceKey.replace(/-/, ' '))}</div>`;

      for (const opp of opps) {
        const applied = appliedMerges.has(opp.id);
        html += `<div class="mm-opp ${applied ? 'mm-applied' : ''}" data-opp-id="${esc(opp.id)}">
          <div class="mm-opp-topline">
            <div class="mm-save-badge">Save ${opp.heatsSaved} heat${opp.heatsSaved > 1 ? 's' : ''}</div>
            <div class="mm-pill-row">
              ${!opp.sameGender ? '<span class="mm-cross-gender">Cross-gender</span>' : '<span class="mm-same-gender">Same gender</span>'}
              ${opp.missingHeatCount > 0 ? `<span class="mm-needs-space">Adds ${opp.missingHeatCount} heat${opp.missingHeatCount === 1 ? '' : 's'}</span>` : '<span class="mm-ready">Ready</span>'}
            </div>
          </div>
          <div class="mm-merge-grid">
            <div class="mm-event-box mm-event-source">
              <span class="mm-event-box-label">Move from</span>
              <strong>${esc(opp.sourceLabel)}</strong>
              <span>${esc(opp.sourceEvent ? heatSummary(opp.sourceEvent) : `${opp.sourceSwimmerCount} entries`)}</span>
            </div>
            <div class="mm-merge-arrow">&rarr;</div>
            <div class="mm-event-box mm-event-target">
              <span class="mm-event-box-label">Into</span>
              <strong>${esc(opp.targetLabel)}</strong>
              <span>${esc(heatSummary(opp.targetEvent))}</span>
            </div>
          </div>
          <div class="mm-metrics">
            <div><span>Current</span><strong>${opp.currentHeats} heat${opp.currentHeats === 1 ? '' : 's'}</strong></div>
            <div><span>After merge</span><strong>${opp.combinedHeats} heat${opp.combinedHeats === 1 ? '' : 's'}</strong></div>
            <div><span>Moved entries</span><strong>${opp.sourceSwimmerCount}</strong></div>
          </div>
          ${opp.missingHeatCount > 0 ? `<div class="mm-warning">This merge needs ${opp.missingHeatCount} more target heat${opp.missingHeatCount === 1 ? '' : 's'}. The extension will add ${opp.missingHeatCount === 1 ? 'it' : 'them'} before moving swimmers.</div>` : ''}
          <div class="mm-opp-actions">
            <button class="mm-btn mm-btn-secondary mm-preview-opp" data-opp-id="${esc(opp.id)}">Preview</button>
            <button class="mm-btn mm-btn-secondary mm-organize-event" data-event-id="${esc(opp.targetEvent.id)}">Organize Target</button>
            <button class="mm-btn mm-btn-accent mm-apply-opp" data-opp-id="${esc(opp.id)}" ${applied ? 'disabled' : ''}>
              ${applied ? 'Applied' : (opp.missingHeatCount > 0 ? 'Add Heats + Merge' : 'Apply Merge')}
            </button>
          </div>
          <div class="mm-opp-detail" id="mm-detail-${esc(opp.id).replace(/[^a-zA-Z0-9]/g, '_')}" style="display:none"></div>
        </div>`;
      }

      html += '</div>';
    }

    html += renderSeededEvents();
    el.innerHTML = html;

    // Wire up buttons
    el.querySelectorAll('.mm-preview-opp').forEach(btn => {
      btn.addEventListener('click', () => togglePreview(btn.dataset.oppId));
    });
    el.querySelectorAll('.mm-apply-opp').forEach(btn => {
      btn.addEventListener('click', () => executeMerge(btn.dataset.oppId));
    });
    el.querySelectorAll('.mm-organize-event').forEach(btn => {
      btn.addEventListener('click', () => openOrganizer(btn.dataset.eventId));
    });
  }

  function renderSeededEvents() {
    const seeded = allEvents
      .filter(e => recordsFor(e.id).length > 0 || heatsFor(e.id).length > 0)
      .sort(compareEventOrder);

    if (seeded.length === 0) {
      return '<div class="mm-seeded"><div class="mm-section-title">Loaded events</div><div class="mm-muted">No seeded events or heats were returned for this session.</div></div>';
    }

    const rows = seeded.map(evt => {
      const heats = heatsFor(evt.id);
      const entries = recordsFor(evt.id);
      const heatText = heats.length
        ? heats.map(h => {
          const count = entries.filter(r => r.relationships?.heat?.data?.id === h.id).length;
          return `H${h.attributes?.number || '?'}: ${count}`;
        }).join(' · ')
        : 'No heat resources';
      return `<div class="mm-event-row">
        <div>
          <strong>${esc(eventLabel(evt))}</strong>
          <span>${esc(raceLabel(evt))}</span>
        </div>
        <div class="mm-event-row-counts">${esc(heatSummary(evt))}<br>${esc(heatText)}</div>
        <div class="mm-event-row-actions">
          <button class="mm-btn mm-btn-secondary mm-btn-sm mm-organize-event" data-event-id="${esc(evt.id)}">Organize</button>
        </div>
      </div>`;
    }).join('');

    return `<div class="mm-seeded">
      <div class="mm-section-title">Loaded seeded events</div>
      ${rows}
    </div>`;
  }

  function openOrganizer(eventId) {
    currentView = 'organizer';
    organizerEventId = eventId;
    renderSummary(findOpportunities());
    renderOrganizer(eventId);
  }

  function renderOrganizer(eventId) {
    currentView = 'organizer';
    organizerEventId = eventId;

    const el = document.getElementById('mm-body');
    if (!el) return;

    const evt = allEvents.find(e => e.id === eventId);
    if (!evt) {
      el.innerHTML = '<div class="mm-error">Could not find this event in the loaded meet data.</div>';
      return;
    }

    const heats = heatsFor(eventId);
    const records = recordsFor(eventId);
    const laneTotal = requireLaneCount();
    const ranks = {
      event: eventRankMap(eventId),
      team: teamRankMap(eventId),
      sex: sexRankMap(eventId),
    };

    if (heats.length === 0) {
      el.innerHTML = `
        <div class="mm-organizer">
          <div class="mm-organizer-top">
            <button class="mm-btn mm-btn-back mm-back-dashboard"><span aria-hidden="true">&larr;</span> Back</button>
            <div>
              <div class="mm-organizer-title">${esc(eventLabel(evt))}</div>
              <div class="mm-organizer-subtitle">No heats were returned for this event.</div>
            </div>
          </div>
        </div>
      `;
      el.querySelector('.mm-back-dashboard')?.addEventListener('click', () => renderDashboard());
      return;
    }

    const rows = heats.map(heat => {
      const heatRecords = records.filter(r => r.relationships?.heat?.data?.id === heat.id);
      let laneHtml = '';
      for (let lane = 1; lane <= laneTotal; lane++) {
        const record = heatRecords.find(r => r.attributes?.laneNumber === lane);
        laneHtml += renderOrganizerLane(heat, lane, record, eventId, ranks);
      }
      return `<div class="mm-heat-row">
        <div class="mm-heat-label">
          <strong>Heat ${esc(heat.attributes?.number || '?')}</strong>
          <span>${heatRecords.length}/${laneTotal} entries</span>
        </div>
        <div class="mm-heat-lanes" style="grid-template-columns: repeat(${laneTotal}, minmax(54px, 1fr));">
          ${laneHtml}
        </div>
      </div>`;
    }).join('');

    el.innerHTML = `
      <div class="mm-organizer">
        <div class="mm-organizer-top">
          <button class="mm-btn mm-btn-back mm-back-dashboard"><span aria-hidden="true">&larr;</span> Back</button>
          <div>
            <div class="mm-organizer-title">${esc(eventLabel(evt))}</div>
            <div class="mm-organizer-subtitle">${records.length} entries across ${heats.length} heat${heats.length === 1 ? '' : 's'}. Drag a swimmer to another lane to reseat within this event.</div>
          </div>
        </div>
        <div class="mm-organizer-legend">
          <span class="mm-legend-chip mm-swimmer-boy"></span> Boys
          <span class="mm-legend-chip mm-swimmer-girl"></span> Girls
        </div>
        <div class="mm-organizer-display">
          <span>Tile label</span>
          <div class="mm-segmented" role="group" aria-label="Swimmer tile label mode">
            <button class="mm-segmented-btn ${organizerLabelMode === 'initials' ? 'is-active' : ''}" data-label-mode="initials">Initials</button>
            <button class="mm-segmented-btn ${organizerLabelMode === 'event-rank' ? 'is-active' : ''}" data-label-mode="event-rank">Event Rank</button>
            <button class="mm-segmented-btn ${organizerLabelMode === 'team-rank' ? 'is-active' : ''}" data-label-mode="team-rank">Team Rank</button>
            <button class="mm-segmented-btn ${organizerLabelMode === 'sex-rank' ? 'is-active' : ''}" data-label-mode="sex-rank">Sex Rank</button>
          </div>
        </div>
        ${renderTeamLegend(records)}
        <div class="mm-heat-board">${rows}</div>
        <div class="mm-organizer-actions">
          <div>
            <button class="mm-btn mm-btn-secondary mm-sort-slow">Sort Slowest To Fastest</button>
            <span>Fill heats from slowest to fastest; fastest in each heat gets the preferred center lane.</span>
          </div>
          <div>
            <button class="mm-btn mm-btn-secondary mm-group-gender">Group Boys / Girls</button>
            <span>Use the fewest heats possible, then keep heats single-gender where possible. Mixed heats put girls on low lanes and boys on high lanes.</span>
          </div>
        </div>
      </div>
    `;

    el.querySelector('.mm-back-dashboard')?.addEventListener('click', () => renderDashboard());
    el.querySelector('.mm-sort-slow')?.addEventListener('click', event => organizeSlowestToFastest(eventId, event.currentTarget));
    el.querySelector('.mm-group-gender')?.addEventListener('click', event => organizeByGender(eventId, event.currentTarget));
    el.querySelectorAll('.mm-segmented-btn').forEach(button => {
      button.addEventListener('click', () => {
        organizerLabelMode = button.dataset.labelMode || 'initials';
        renderOrganizer(eventId);
      });
    });
    wireOrganizerDragHandlers(el, eventId);
  }

  function renderOrganizerLane(heat, lane, record, eventId, ranks) {
    const heatId = heat.id;
    const heatNumber = heat.attributes?.number;

    if (!record) {
      return `<div class="mm-lane-slot mm-lane-empty" data-heat-id="${esc(heatId)}" data-heat-number="${esc(heatNumber)}" data-lane="${lane}">
        <span>Lane ${lane}</span>
      </div>`;
    }

    const name = recordDisplayName(record);
    const team = recordTeamAbbreviation(record);
    const teamColor = teamColorFor(record);
    const time = recordSeedTime(record);
    const title = `${name}${team ? ` (${team})` : ''}\nSeed: ${time}\nHeat ${heatNumber}, Lane ${lane}`;
    const primaryLabel = organizerPrimaryLabel(record, eventId, ranks);

    return `<div class="mm-lane-slot" data-heat-id="${esc(heatId)}" data-heat-number="${esc(heatNumber)}" data-lane="${lane}" data-record-id="${esc(record.id)}">
      <div class="mm-swimmer-tile ${athleteGenderClass(record)}" draggable="true" data-record-id="${esc(record.id)}" title="${esc(title)}" style="--mm-team-color: ${teamColor};">
        <strong>${esc(primaryLabel)}</strong>
        <span class="mm-seed-time">${esc(time)}</span>
        ${team ? `<span class="mm-team-badge">${esc(team)}</span>` : ''}
      </div>
    </div>`;
  }

  function wireOrganizerDragHandlers(root, eventId) {
    root.querySelectorAll('.mm-swimmer-tile').forEach(tile => {
      tile.addEventListener('dragstart', event => {
        if (isOperationInFlight()) {
          event.preventDefault();
          return;
        }
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', tile.dataset.recordId);
        tile.classList.add('mm-dragging');
      });
      tile.addEventListener('dragend', () => tile.classList.remove('mm-dragging'));
    });

    root.querySelectorAll('.mm-lane-slot').forEach(slot => {
      slot.addEventListener('dragover', event => {
        if (isOperationInFlight()) return;
        event.preventDefault();
        slot.classList.add('mm-drop-target');
      });
      slot.addEventListener('dragleave', () => slot.classList.remove('mm-drop-target'));
      slot.addEventListener('drop', async event => {
        event.preventDefault();
        slot.classList.remove('mm-drop-target');
        if (isOperationInFlight()) return;
        const sourceRecordId = event.dataTransfer.getData('text/plain');
        await moveRecordWithinOrganizer(eventId, sourceRecordId, slot);
      });
    });
  }

  async function moveRecordWithinOrganizer(eventId, sourceRecordId, targetSlot) {
    if (isOperationInFlight()) return;
    const sourceRecord = allRecords.find(r => r.id === sourceRecordId);
    if (!sourceRecord) return;

    const a = await getAPI();
    if (!a) {
      alert('Not connected to API');
      return;
    }

    const finish = beginOperation('Moving swimmer...');
    try {
      const sourceHeatId = sourceRecord.relationships?.heat?.data?.id;
      const sourceHeat = allHeats.find(h => h.id === sourceHeatId);
      const sourceHeatNumber = heatNumberFor(sourceHeat, 'source heat');
      const sourceLane = laneNumberFor(sourceRecord, 'source swimmer');
      const targetHeatId = targetSlot.dataset.heatId;
      const targetHeat = allHeats.find(h => h.id === targetHeatId);
      const targetHeatNumber = heatNumberFor(targetHeat, 'target heat');
      const targetLane = Number.parseInt(targetSlot.dataset.lane, 10);
      const targetRecord = recordsFor(eventId).find(r =>
        r.relationships?.heat?.data?.id === targetHeatId && r.attributes?.laneNumber === targetLane
      );
      const targetRecordId = targetRecord?.id;

      if (sourceHeatId === targetHeatId && sourceLane === targetLane) return;
      if (!sourceHeatId || !targetHeatId || !Number.isInteger(targetLane) || targetLane <= 0) {
        throw new Error('Could not determine the source or target lane for this move.');
      }

      targetSlot.classList.add('mm-saving');
      if (targetRecordId && targetRecordId !== sourceRecordId) {
        setBusyMessage('Swapping occupied lanes...');
        const assignments = [
          buildAssignment(targetRecord, {
            heatId: sourceHeatId,
            heatNumber: sourceHeatNumber,
            laneNumber: sourceLane,
          }),
          buildAssignment(sourceRecord, {
            heatId: targetHeatId,
            heatNumber: targetHeatNumber,
            laneNumber: targetLane,
          }),
        ];
        const targetByRecordId = new Map(assignments.map(({ record, heatId, heatNumber, laneNumber }) => [
          record.id,
          { heatId, heatNumber, laneNumber },
        ]));
        await applyOrganizerAssignmentsSafely(eventId, a, assignments, targetByRecordId, null, 'Swapping occupied lanes...');
      } else {
        setBusyMessage('Saving lane change...');
        await a.moveEventRecord(sourceRecord.id, {
          heatId: targetHeatId,
          heatNumber: targetHeatNumber,
          laneNumber: targetLane,
          isExhibition: !!sourceRecord.attributes?.isExhibition,
        });
      }

      setBusyMessage('Refreshing meet data...');
      await loadData();
    } catch (err) {
      console.error('[Merge Helper] organizer move failed:', err);
      alert('Could not move swimmer: ' + err.message);
      targetSlot.classList.remove('mm-saving');
    } finally {
      finish();
    }
  }

  function heatLaneTargets(eventId) {
    return heatsFor(eventId).flatMap(heat => {
      const heatNumber = heatNumberFor(heat, 'target heat');
      return laneSeedOrder().map(lane => ({ heatId: heat.id, heatNumber, laneNumber: lane }));
    });
  }

  function buildAssignment(record, target) {
    return {
      record,
      heatId: target.heatId,
      heatNumber: target.heatNumber,
      laneNumber: target.laneNumber,
    };
  }

  function slotKey(slot) {
    return `${slot.heatId}:${Number(slot.laneNumber)}`;
  }

  function sameSlot(a, b) {
    return a?.heatId === b?.heatId && Number(a?.laneNumber) === Number(b?.laneNumber);
  }

  function recordCurrentSlot(record) {
    const heatId = record.relationships?.heat?.data?.id;
    const laneNumber = Number(record.attributes?.laneNumber);
    if (!heatId || !laneNumber) return null;
    const heat = allHeats.find(h => h.id === heatId);
    return {
      heatId,
      heatNumber: heatNumberFor(heat, `heat for event record ${record.id}`),
      laneNumber,
    };
  }

  function allSlotsForHeats(heats) {
    return heats.flatMap(heat => {
      const heatNumber = heatNumberFor(heat, 'event heat');
      return [...Array(requireLaneCount())].map((_, index) => ({
        heatId: heat.id,
        heatNumber,
        laneNumber: index + 1,
      }));
    });
  }

  function findEmptyNonFinalSlot(eventId, occupancy, finalSlotKeys) {
    return allSlotsForHeats(heatsFor(eventId)).find(slot =>
      !occupancy.has(slotKey(slot)) && !finalSlotKeys.has(slotKey(slot))
    ) || null;
  }

  async function organizeSlowestToFastest(eventId, button) {
    const sortedRecords = recordsFor(eventId).slice().sort(compareSlowestFirst);
    const heats = heatsFor(eventId);
    const lanes = laneSeedOrder();
    const assignments = [];

    heats.forEach((heat, heatIndex) => {
      const heatNumber = heatNumberFor(heat, 'target heat');
      const heatRecords = sortedRecords
        .slice(heatIndex * requireLaneCount(), heatIndex * requireLaneCount() + requireLaneCount())
        .sort(compareFastestFirst);

      heatRecords.forEach((record, laneIndex) => {
        assignments.push(buildAssignment(record, {
          heatId: heat.id,
          heatNumber,
          laneNumber: lanes[laneIndex],
        }));
      });
    });

    await applyOrganizerAssignments(eventId, assignments, button, 'Sorting...');
  }

  async function organizeByGender(eventId, button) {
    const heats = heatsFor(eventId);
    const records = recordsFor(eventId);
    const laneTotal = requireLaneCount();
    const heatCountNeeded = Math.ceil(records.length / laneTotal);
    const targetHeats = heats.slice(0, heatCountNeeded);
    const groups = {
      F: records.filter(r => athleteGender(r) === 'F').sort(compareFastestFirst),
      M: records.filter(r => athleteGender(r) === 'M').sort(compareFastestFirst),
      O: records.filter(r => !['F', 'M'].includes(athleteGender(r))).sort(compareFastestFirst),
    };

    const chunks = [];
    for (const gender of ['F', 'M', 'O']) {
      for (let i = 0; i < groups[gender].length; i += laneTotal) {
        chunks.push({ genders: new Set([gender]), records: groups[gender].slice(i, i + laneTotal) });
      }
    }

    while (chunks.length > targetHeats.length) {
      const partialIndexes = chunks
        .map((chunk, index) => ({ chunk, index }))
        .filter(({ chunk }) => chunk.records.length < laneTotal)
        .sort((a, b) => a.chunk.records.length - b.chunk.records.length);

      let merged = false;
      for (let i = 0; i < partialIndexes.length && !merged; i++) {
        for (let j = i + 1; j < partialIndexes.length && !merged; j++) {
          const a = partialIndexes[i];
          const b = partialIndexes[j];
          if (a.chunk.records.length + b.chunk.records.length > laneTotal) continue;
          const firstIndex = Math.min(a.index, b.index);
          const secondIndex = Math.max(a.index, b.index);
          chunks[firstIndex] = {
            genders: new Set([...a.chunk.genders, ...b.chunk.genders]),
            records: [...a.chunk.records, ...b.chunk.records],
          };
          chunks.splice(secondIndex, 1);
          merged = true;
        }
      }

      if (!merged) break;
    }

    if (chunks.length > targetHeats.length) {
      alert('Could not build a gender grouping that fits in the minimum heat count. No swimmers were moved.');
      return;
    }

    const assignments = [];
    chunks.slice(0, targetHeats.length).forEach((chunk, heatIndex) => {
      const heat = targetHeats[heatIndex];
      const heatNumber = heatNumberFor(heat, 'target heat');
      const recordsByGender = {
        F: chunk.records.filter(r => athleteGender(r) === 'F').sort(compareFastestFirst),
        M: chunk.records.filter(r => athleteGender(r) === 'M').sort(compareFastestFirst),
        O: chunk.records.filter(r => !['F', 'M'].includes(athleteGender(r))).sort(compareFastestFirst),
      };

      if (recordsByGender.F.length && recordsByGender.M.length) {
        const femaleLanes = laneSeedOrder()
          .filter(lane => lane <= Math.ceil(laneTotal / 2))
          .concat([...Array(laneTotal)].map((_, index) => index + 1).filter(lane => lane > Math.ceil(laneTotal / 2)));
        const maleLanes = laneSeedOrder()
          .filter(lane => lane > Math.ceil(laneTotal / 2))
          .concat([...Array(laneTotal)].map((_, index) => index + 1).filter(lane => lane <= Math.ceil(laneTotal / 2)).reverse());
        const usedLanes = new Set();

        recordsByGender.F.forEach((record, index) => {
          const laneNumber = femaleLanes.find(lane => !usedLanes.has(lane));
          usedLanes.add(laneNumber);
          assignments.push(buildAssignment(record, { heatId: heat.id, heatNumber, laneNumber }));
        });
        recordsByGender.M.forEach((record, index) => {
          const laneNumber = maleLanes.find(lane => !usedLanes.has(lane));
          usedLanes.add(laneNumber);
          assignments.push(buildAssignment(record, { heatId: heat.id, heatNumber, laneNumber }));
        });
        recordsByGender.O.forEach((record, index) => {
          const laneNumber = laneSeedOrder().find(lane => !usedLanes.has(lane));
          usedLanes.add(laneNumber);
          assignments.push(buildAssignment(record, { heatId: heat.id, heatNumber, laneNumber }));
        });
      } else {
        const lanes = laneSeedOrder();
        chunk.records.slice().sort(compareFastestFirst).forEach((record, index) => {
          assignments.push(buildAssignment(record, { heatId: heat.id, heatNumber, laneNumber: lanes[index] }));
        });
      }
    });

    await applyOrganizerAssignments(eventId, assignments, button, 'Grouping...');
  }

  async function applyOrganizerAssignments(eventId, assignments, button, savingLabel) {
    if (isOperationInFlight()) return;
    const targetByRecordId = new Map(assignments.map(({ record, heatId, heatNumber, laneNumber }) => [
      record.id,
      { heatId, heatNumber, laneNumber },
    ]));
    const moves = assignments.filter(({ record, heatId, laneNumber }) => {
      const current = recordCurrentSlot(record);
      return !sameSlot(current, { heatId, laneNumber });
    });

    if (moves.length === 0) return;

    const a = await getAPI();
    if (!a) {
      alert('Not connected to API');
      return;
    }

    const originalText = button?.textContent;
    const finish = beginOperation(savingLabel);
    if (button) {
      button.disabled = true;
      button.textContent = savingLabel;
    }

    try {
      await applyOrganizerAssignmentsSafely(eventId, a, assignments, targetByRecordId, button, savingLabel);
      setBusyMessage('Refreshing meet data...');
      await loadData();
    } catch (err) {
      console.error('[Merge Helper] organizer bulk move failed:', err);
      alert('Could not organize swimmers: ' + err.message);
      if (button) {
        button.disabled = false;
        button.textContent = originalText;
      }
    } finally {
      finish();
    }
  }

  async function applyOrganizerAssignmentsSafely(eventId, a, assignments, targetByRecordId, button, savingLabel) {
    const eventRecords = recordsFor(eventId);
    const recordById = new Map(eventRecords.map(record => [record.id, record]));
    const currentByRecordId = new Map();
    const occupancy = new Map();

    eventRecords.forEach(record => {
      const slot = recordCurrentSlot(record);
      if (!slot) return;
      currentByRecordId.set(record.id, slot);
      occupancy.set(slotKey(slot), record.id);
    });

    const finalSlotKeys = new Set(assignments.map(({ heatId, laneNumber }) => slotKey({ heatId, laneNumber })));
    const pending = new Set(
      assignments
        .filter(({ record }) => !sameSlot(currentByRecordId.get(record.id), targetByRecordId.get(record.id)))
        .map(({ record }) => record.id)
    );

    let scratchSlot = findEmptyNonFinalSlot(eventId, occupancy, finalSlotKeys);
    let scratchCreated = false;
    let guard = 0;
    const maxSteps = Math.max(20, assignments.length * 4);

    while (pending.size > 0) {
      if (++guard > maxSteps) throw new Error('Could not find a safe order for organizer moves.');

      let moved = false;
      for (const recordId of Array.from(pending)) {
        const target = targetByRecordId.get(recordId);
        if (!target || occupancy.has(slotKey(target))) continue;

        const record = recordById.get(recordId);
        await moveOrganizerRecord(a, record, target, occupancy, currentByRecordId);
        if (sameSlot(currentByRecordId.get(recordId), target)) pending.delete(recordId);
        moved = true;
        break;
      }
      if (moved) continue;

      if (!scratchSlot) {
        if (button) button.textContent = 'Adding scratch heat...';
        setBusyMessage('Adding scratch heat...');
        const resp = await a.createHeat(eventId);
        const heat = resp?.data;
        if (!heat?.id) throw new Error('API did not return the new scratch heat.');
        allHeats.push(heat);
        scratchSlot = {
          heatId: heat.id,
          heatNumber: heatNumberFor(heat, 'scratch heat'),
          laneNumber: 1,
        };
        scratchCreated = true;
      }

      if (occupancy.has(slotKey(scratchSlot))) {
        throw new Error('Scratch lane is occupied before the move cycle could be resolved.');
      }

      const busyLabel = scratchCreated ? 'Using scratch heat...' : savingLabel;
      if (button) button.textContent = busyLabel;
      setBusyMessage(busyLabel);
      let recordId = null;
      for (const pendingRecordId of pending) {
        const targetOccupantId = occupancy.get(slotKey(targetByRecordId.get(pendingRecordId)));
        if (targetOccupantId && pending.has(targetOccupantId)) {
          recordId = targetOccupantId;
          break;
        }
      }
      if (!recordId) {
        throw new Error('Could not identify a move cycle to break with the scratch lane.');
      }
      const record = recordById.get(recordId);
      await moveOrganizerRecord(a, record, scratchSlot, occupancy, currentByRecordId);
    }

    if (scratchCreated) {
      if (button) button.textContent = 'Removing scratch heat...';
      setBusyMessage('Removing scratch heat...');
      await a.removeEmptyHeats(eventId);
    }
  }

  async function moveOrganizerRecord(a, record, target, occupancy, currentByRecordId) {
    if (!record) throw new Error('Missing event record for organizer move.');
    const current = currentByRecordId.get(record.id);
    setBusyMessage(`Moving swimmer to heat ${target.heatNumber}, lane ${target.laneNumber}...`);
    await a.moveEventRecord(record.id, {
      heatId: target.heatId,
      heatNumber: target.heatNumber,
      laneNumber: target.laneNumber,
      isExhibition: !!record.attributes?.isExhibition,
    });

    if (current) occupancy.delete(slotKey(current));
    occupancy.set(slotKey(target), record.id);
    currentByRecordId.set(record.id, target);
  }

  function cleanupEventIdsForMerge(opp) {
    const ids = new Set();
    (opp.allSourceEvents || [opp.sourceEvent]).forEach(evt => {
      if (evt?.id) ids.add(evt.id);
    });
    if (opp.targetEvent?.id) ids.add(opp.targetEvent.id);
    return Array.from(ids);
  }

  function cleanupEventIdsForMovedRecords(results, targetEventId) {
    const ids = new Set();
    results
      .filter(result => result.success)
      .forEach(result => {
        const sourceEventId = result.sourceRecord?.relationships?.event?.data?.id;
        if (sourceEventId) ids.add(sourceEventId);
      });
    if (targetEventId) ids.add(targetEventId);
    return Array.from(ids);
  }

  async function removeEmptyHeatsForEvents(a, eventIds) {
    const failures = [];
    for (let i = 0; i < eventIds.length; i++) {
      const eventId = eventIds[i];
      setBusyMessage(`Removing empty heats (${i + 1}/${eventIds.length})...`);
      try {
        await a.removeEmptyHeats(eventId);
      } catch (err) {
        failures.push({ eventId, error: err.message });
      }
    }
    return failures;
  }

  function togglePreview(oppId) {
    const opp = findOpportunities().find(o => o.id === oppId);
    if (!opp) return;

    const detailId = 'mm-detail-' + oppId.replace(/[^a-zA-Z0-9]/g, '_');
    const detail = document.getElementById(detailId);
    if (!detail) return;

    if (detail.style.display !== 'none') {
      detail.style.display = 'none';
      return;
    }

    // Build preview showing proposed lane assignments
    const tgtHeats = heatsFor(opp.targetEvent.id);
    const maxLane = requireLaneCount();

    // Current target swimmers by heat
    const assignments = []; // { heatId, heatNum, lanes: { laneNum: record } }

    for (const heat of tgtHeats) {
      const entry = { heatId: heat.id, heatNum: heatNumberFor(heat, 'target heat'), lanes: {} };
      const heatRecs = opp.targetRecords.filter(r => r.relationships?.heat?.data?.id === heat.id);
      for (const r of heatRecs) {
        const lane = r.attributes?.laneNumber;
        if (lane) entry.lanes[lane] = r;
      }
      assignments.push(entry);
    }

    // Add source swimmers into new/remaining lanes
    let srcSwimmers = [...opp.sourceRecords];
    let heatIdx = 0;
    let unplacedPreviewCount = 0;

    while (srcSwimmers.length > 0) {
      if (heatIdx >= assignments.length) {
        unplacedPreviewCount = srcSwimmers.length;
        break;
      }

      const assignment = assignments[heatIdx];
      for (let lane = 1; lane <= maxLane && srcSwimmers.length > 0; lane++) {
        if (!assignment.lanes[lane]) {
          const rec = srcSwimmers.shift();
          assignment.lanes[lane] = { ...rec, _fromSource: true };
        }
      }
      heatIdx++;
    }

    // Render
    let html = '<div class="mm-preview"><div class="mm-preview-title">Preview: target heat layout after merge</div>';
    if (unplacedPreviewCount > 0) {
      const missingHeatCount = missingHeatCountForOpportunity(opp);
      if (missingHeatCount > 0) {
        html += `<div class="mm-warning">${unplacedPreviewCount} swimmer${unplacedPreviewCount === 1 ? '' : 's'} need ${missingHeatCount} new target heat${missingHeatCount === 1 ? '' : 's'}. The merge flow will add ${missingHeatCount === 1 ? 'it' : 'them'} automatically.</div>`;
      } else {
        html += `<div class="mm-warning">${unplacedPreviewCount} swimmer${unplacedPreviewCount === 1 ? '' : 's'} cannot be placed in the current target heats.</div>`;
      }
    }

    for (const a of assignments) {
      const count = Object.keys(a.lanes).length;
      html += `<div class="mm-preview-heat ${a.isNew ? 'mm-new-heat' : ''}">
        <div class="mm-pheat-header">Heat ${a.heatNum} ${a.isNew ? '(new)' : ''} &mdash; ${count} swimmers</div>
        <div class="mm-pheat-lanes">`;

      for (let lane = 1; lane <= maxLane; lane++) {
        const rec = a.lanes[lane];
        if (rec) {
          const name = recordDisplayName(rec);
          const team = recordTeamAbbreviation(rec);
          html += `<div class="mm-plane ${rec._fromSource ? 'mm-source-swimmer' : 'mm-target-swimmer'}">
            <span class="mm-plane-lane">L${lane}</span>
            <span class="mm-plane-name">${esc(name)}</span>
            ${team ? `<span class="mm-plane-team">${esc(team)}</span>` : ''}
          </div>`;
        } else {
          html += `<div class="mm-plane mm-empty-lane">L${lane}</div>`;
        }
      }

      html += '</div></div>';
    }

    html += `<div class="mm-preview-legend">
      <span class="mm-legend-target">&bull;</span> Existing &nbsp;
      <span class="mm-legend-source">&bull;</span> Swimming up
    </div></div>`;

    detail.innerHTML = html;
    detail.style.display = 'block';
  }

  async function executeMerge(oppId) {
    if (isOperationInFlight()) return;
    const opp = findOpportunities().find(o => o.id === oppId);
    if (!opp) return;

    const btn = document.querySelector(`.mm-apply-opp[data-opp-id="${CSS.escape(oppId)}"]`);
    const finish = beginOperation('Preparing merge...');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Merging...';
    }

    const a = await getAPI();
    if (!a) {
      alert('Not connected to API');
      finish();
      return;
    }

    // Build the moves: assign source swimmers into target event's heats
    const tgtHeats = heatsFor(opp.targetEvent.id);
    const laneTotal = requireLaneCount();
    const moves = [];

    // Current lane occupancy in target heats
    const heatAssignments = [];
    for (const heat of tgtHeats) {
      const occupied = new Set();
      const heatRecs = opp.targetRecords.filter(r => r.relationships?.heat?.data?.id === heat.id);
      for (const r of heatRecs) {
        const lane = r.attributes?.laneNumber;
        if (lane) occupied.add(lane);
      }
      heatAssignments.push({ heatId: heat.id, heatNum: heatNumberFor(heat, 'target heat'), occupied });
    }

    if (opp.missingHeatCount > 0) {
      const label = `Adding ${opp.missingHeatCount} target heat${opp.missingHeatCount === 1 ? '' : 's'}...`;
      if (btn) btn.textContent = label;
      setBusyMessage(label);
      for (let i = 0; i < opp.missingHeatCount; i++) {
        const resp = await a.createHeat(opp.targetEvent.id);
        const heat = resp?.data;
        if (!heat?.id) throw new Error('API did not return a new target heat.');
        heatAssignments.push({
          heatId: heat.id,
          heatNum: heatNumberFor(heat, 'new target heat'),
          occupied: new Set(),
        });
      }
      heatAssignments.sort((aHeat, bHeat) => aHeat.heatNum - bHeat.heatNum);
    }

    // Place source swimmers into available lanes
    let heatIdx = 0;
    const srcSwimmers = [...opp.sourceRecords];

    while (srcSwimmers.length > 0) {
      if (heatIdx >= heatAssignments.length) {
        // No more existing heats — can't auto-assign without creating new heats
        console.warn('[Merge Helper] ran out of heats to assign swimmers to');
        break;
      }

      const ha = heatAssignments[heatIdx];
      for (let lane = 1; lane <= laneTotal && srcSwimmers.length > 0; lane++) {
        if (!ha.occupied.has(lane)) {
          const rec = srcSwimmers.shift();
          moves.push({
            sourceRecord: rec,
            eventId: opp.targetEvent.id,
            heatId: ha.heatId,
            heatNumber: ha.heatNum,
            laneNumber: lane,
          });
          ha.occupied.add(lane);
        }
      }
      heatIdx++;
    }

    if (srcSwimmers.length > 0) {
      alert(`Cannot merge: ${srcSwimmers.length} swimmer(s) couldn't be placed. The target event may need more heats created first.`);
      if (btn) { btn.disabled = false; btn.textContent = 'Apply Merge'; }
      finish();
      return;
    }

    if (moves.length === 0) {
      if (btn) { btn.disabled = false; btn.textContent = 'Apply Merge'; }
      finish();
      return;
    }

    try {
      setBusyMessage(`Moving ${moves.length} swimmer${moves.length === 1 ? '' : 's'} into the target event...`);
      const results = await a.batchMove(moves);
      const failures = results.filter(r => !r.success);

      if (failures.length > 0) {
        console.error('[Merge Helper] some moves failed:', failures);
        alert(`${failures.length} of ${moves.length} moves failed. Check the console for details.`);
      } else {
        if (btn) btn.textContent = 'Removing empty heats...';
        const cleanupFailures = await removeEmptyHeatsForEvents(a, cleanupEventIdsForMerge(opp));
        if (cleanupFailures.length > 0) {
          console.error('[Merge Helper] empty heat cleanup failed:', cleanupFailures);
          alert(`${cleanupFailures.length} empty-heat cleanup task(s) failed. The swimmers were moved; refresh and try cleanup again if empty heats remain.`);
        }
      }

      const movedCleanupEventIds = cleanupEventIdsForMovedRecords(results, opp.targetEvent.id);
      if (failures.length > 0 && movedCleanupEventIds.length > 0) {
        if (btn) btn.textContent = 'Removing empty heats...';
        const cleanupFailures = await removeEmptyHeatsForEvents(a, movedCleanupEventIds);
        if (cleanupFailures.length > 0) {
          console.error('[Merge Helper] empty heat cleanup failed:', cleanupFailures);
        }
      }

      appliedMerges.add(oppId);
      setBusyMessage('Refreshing meet data...');
      await loadData();
    } catch (err) {
      console.error('[Merge Helper] merge failed:', err);
      alert('Merge failed: ' + err.message);
      if (btn) { btn.disabled = false; btn.textContent = 'Apply Merge'; }
    } finally {
      finish();
    }
  }
})();
