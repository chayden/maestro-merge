// Content script for Meet Maestro Merge Helper
// Runs on maestro.swimtopia.com
//
// Focus: detect target-based multi-source merge opportunities to reduce total heats.
// Letter-suffixed events are treated as merge destinations, never sources.

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
  let hiddenOpportunities = new Set();
  let needsOrganizationEventIds = new Set();
  let currentView = 'dashboard';
  let organizerEventId = null;
  let dashboardOpportunityTab = null;
  let operationDepth = 0;
  let organizerLabelMode = 'initials';
  let organizerHeatOrder = 'slowest-first';
  let proposedMergeAgeGroupLimit = 2;
  const meetMaestroRefreshReadDelayMs = 250;
  const reloadRestoreKey = 'mmMergeHelperRestoreAfterReload';

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

  function readReloadRestoreState() {
    try {
      const raw = window.sessionStorage?.getItem(reloadRestoreKey);
      if (!raw) return null;
      window.sessionStorage.removeItem(reloadRestoreKey);
      return JSON.parse(raw);
    } catch (err) {
      console.debug('[Merge Helper] reload restore read failed:', err);
      return null;
    }
  }

  function requestPageReload() {
    try {
      window.sessionStorage?.setItem(reloadRestoreKey, JSON.stringify({
        view: currentView,
        organizerEventId,
      }));
    } catch (err) {
      console.debug('[Merge Helper] reload restore write failed:', err);
    }
    window.location.reload();
  }

  function handleLocationChange() {
    const changed = extractIdsFromURL();
    if (!changed) return;
    api = null;
    appliedMerges = new Set();
    hiddenOpportunities = new Set();
    needsOrganizationEventIds = new Set();
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

  async function waitForPageReady(timeoutMs = 15000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      extractIdsFromURL();
      if (document.readyState === 'complete' && meetId && sessionId) return true;
      await sleep(250);
    }
    return false;
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

  async function loadData(options = {}) {
    const a = await waitForAPI(options.apiRetries, options.apiDelayMs);
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
      dashboardOpportunityTab = null;
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

  async function nudgeMeetMaestroView(a, eventIds, label = 'Refreshing Meet Maestro view...') {
    const ids = Array.from(new Set((eventIds || []).filter(Boolean)));
    if (ids.length === 0 || typeof a?.refreshEvents !== 'function') return;

    setBusyMessage(label);
    try {
      await a.refreshEvents(ids);
      await sleep(meetMaestroRefreshReadDelayMs);
      await a.refreshEvents(ids);
    } catch (err) {
      console.warn('[Merge Helper] fresh event read failed:', err);
    }
  }

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
    const preferredSixLaneOrder = [3, 4, 2, 5, 1, 6];
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

  function heatSizesForEntryCount(entryCount, laneTotal = requireLaneCount()) {
    const count = Number(entryCount);
    const lanes = Number(laneTotal);
    if (!Number.isInteger(count) || count < 0) return [];
    if (!Number.isInteger(lanes) || lanes <= 0) {
      throw new Error('Meet Maestro did not return a valid pool lane count.');
    }
    if (count === 0) return [];

    const heatCount = Math.ceil(count / lanes);
    const partial = count % lanes;
    const sizes = partial === 0
      ? Array(heatCount).fill(lanes)
      : [partial, ...Array(heatCount - 1).fill(lanes)];

    while (sizes.length > 1 && sizes[0] > 0 && sizes[0] < 3) {
      const donorIndex = sizes
        .map((size, index) => ({ size, index }))
        .reverse()
        .find(({ size, index }) => index > 0 && size - 1 >= sizes[0] + 1)?.index;
      if (donorIndex === undefined) break;
      sizes[0]++;
      sizes[donorIndex]--;
      sizes.sort((a, b) => a - b);
    }

    return sizes;
  }

  function chunkRecordsByHeatSize(records, heatSizes) {
    const chunks = [];
    let cursor = 0;
    heatSizes.forEach(size => {
      chunks.push(records.slice(cursor, cursor + size));
      cursor += size;
    });
    return chunks;
  }

  function heatSizesForOrder(entryCount, laneTotal = requireLaneCount(), heatOrder = organizerHeatOrder) {
    const sizes = heatSizesForEntryCount(entryCount, laneTotal);
    return heatOrder === 'fastest-first' ? sizes.slice().reverse() : sizes;
  }

  function balancedHeatSizes(entryCount, heatCount) {
    const count = Number(entryCount);
    const heats = Number(heatCount);
    if (!Number.isInteger(count) || count <= 0 || !Number.isInteger(heats) || heats <= 0) return [];

    const base = Math.floor(count / heats);
    const extra = count % heats;
    return Array.from({ length: heats }, (_, index) => base + (index < extra ? 1 : 0));
  }

  function planTimeHeatChunks(records, laneTotal = requireLaneCount(), heatOrder = organizerHeatOrder) {
    const sortedRecords = records.slice().sort(heatOrder === 'fastest-first' ? compareFastestFirst : compareSlowestFirst);
    return chunkRecordsByHeatSize(sortedRecords, heatSizesForOrder(sortedRecords.length, laneTotal, heatOrder))
      .map(chunkRecords => ({ records: chunkRecords }));
  }

  function splitSlowestFirstRecords(records, heatCount) {
    return chunkRecordsByHeatSize(records, balancedHeatSizes(records.length, heatCount));
  }

  function planGenderHeatChunks(records, laneTotal = requireLaneCount(), heatOrder = organizerHeatOrder) {
    const heatCount = heatSizesForEntryCount(records.length, laneTotal).length;
    if (heatCount === 0) return [];

    const groups = {
      F: records.filter(r => athleteGender(r) === 'F').sort(compareSlowestFirst),
      M: records.filter(r => athleteGender(r) === 'M').sort(compareSlowestFirst),
      O: records.filter(r => !['F', 'M'].includes(athleteGender(r))).sort(compareSlowestFirst),
    };
    const activeGenders = ['F', 'M', 'O'].filter(gender => groups[gender].length > 0);

    if (heatCount === 1 || activeGenders.length <= 1) {
      return planTimeHeatChunks(records, laneTotal, heatOrder);
    }

    const donorGender = activeGenders
      .slice()
      .sort((a, b) => groups[b].length - groups[a].length || ['F', 'M', 'O'].indexOf(a) - ['F', 'M', 'O'].indexOf(b))[0];
    let donorRecords = groups[donorGender].slice();
    const nonDonorChunks = [];

    activeGenders
      .filter(gender => gender !== donorGender)
      .forEach(gender => {
        const genderHeatCount = Math.ceil(groups[gender].length / laneTotal);
        splitSlowestFirstRecords(groups[gender], genderHeatCount).forEach(chunkRecords => {
          nonDonorChunks.push({ records: chunkRecords });
        });
      });

    const donorHeatCount = heatCount - nonDonorChunks.length;
    if (donorHeatCount < 0) {
      const sortedRecords = records.slice().sort(compareSlowestFirst);
      const chunks = splitSlowestFirstRecords(sortedRecords, heatCount).map(chunkRecords => ({ records: chunkRecords }));
      return heatOrder === 'fastest-first' ? chunks.reverse() : chunks;
    }

    const desiredMixedSize = Math.min(laneTotal, Math.ceil(records.length / heatCount));
    const minDonorRemaining = donorHeatCount === 0 ? 0 : Math.min(donorRecords.length, donorHeatCount * 3);

    nonDonorChunks.forEach(chunk => {
      while (
        chunk.records.length < desiredMixedSize &&
        chunk.records.length < laneTotal &&
        donorRecords.length > minDonorRemaining
      ) {
        chunk.records.push(donorRecords.shift());
      }
    });

    let donorHeatSizes = donorHeatCount > 0
      ? heatSizesForEntryCount(donorRecords.length, laneTotal)
      : [];
    while (donorHeatSizes.length < donorHeatCount) donorHeatSizes.unshift(0);
    if (donorHeatSizes.length > donorHeatCount) {
      donorHeatSizes = balancedHeatSizes(donorRecords.length, donorHeatCount);
    }
    const donorChunks = chunkRecordsByHeatSize(donorRecords, donorHeatSizes)
      .filter(chunkRecords => chunkRecords.length > 0)
      .map(chunkRecords => ({ records: chunkRecords }));
    const chunks = nonDonorChunks.concat(donorChunks);

    return heatOrder === 'fastest-first' ? chunks.reverse() : chunks;
  }

  function genderChunkLaneAssignments(records, laneTotal = requireLaneCount()) {
    const recordsByGender = {
      F: records.filter(r => athleteGender(r) === 'F').sort(compareFastestFirst),
      M: records.filter(r => athleteGender(r) === 'M').sort(compareFastestFirst),
      O: records.filter(r => !['F', 'M'].includes(athleteGender(r))).sort(compareFastestFirst),
    };
    const lanes = laneSeedOrder();

    if (!recordsByGender.F.length || !recordsByGender.M.length) {
      return records
        .slice()
        .sort(compareFastestFirst)
        .map((record, index) => ({ record, laneNumber: lanes[index] }));
    }

    const femaleLaneCount = recordsByGender.F.length;
    const maleLaneCount = recordsByGender.M.length;
    const femaleLanes = Array.from({ length: femaleLaneCount }, (_, index) => femaleLaneCount - index);
    const maleLanes = Array.from({ length: maleLaneCount }, (_, index) => femaleLaneCount + index + 1)
      .filter(lane => lane <= laneTotal);
    const usedLanes = new Set();
    const assignments = [];

    const assignToPreferredLanes = (genderRecords, preferredLanes) => {
      const remaining = [];
      genderRecords.forEach(record => {
        const laneNumber = preferredLanes.find(lane => !usedLanes.has(lane));
        if (!laneNumber) {
          remaining.push(record);
          return;
        }
        usedLanes.add(laneNumber);
        assignments.push({ record, laneNumber });
      });
      return remaining;
    };

    const overflowRecords = [
      ...assignToPreferredLanes(recordsByGender.F, femaleLanes),
      ...assignToPreferredLanes(recordsByGender.M, maleLanes),
      ...recordsByGender.O,
    ].sort(compareFastestFirst);

    overflowRecords.forEach(record => {
      const laneNumber = lanes.find(lane => !usedLanes.has(lane));
      if (!laneNumber) return;
      usedLanes.add(laneNumber);
      assignments.push({ record, laneNumber });
    });

    return assignments;
  }

  function lanePlacementsForEmptyHeats(sourceRecords, heatAssignments) {
    const heatSizes = heatSizesForEntryCount(sourceRecords.length);
    if (heatAssignments.length < heatSizes.length) return null;

    const lanes = laneSeedOrder();
    return chunkRecordsByHeatSize(sourceRecords.slice().sort(compareSlowestFirst), heatSizes)
      .flatMap((heatRecords, heatIndex) => {
        const heatAssignment = heatAssignments[heatIndex];
        return heatRecords
          .slice()
          .sort(compareFastestFirst)
          .map((record, laneIndex) => ({
            record,
            heatAssignment,
            laneNumber: lanes[laneIndex],
          }));
      });
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
    return (evt.attributes?.athleteGender || eventNodeFor(evt.id)?.attributes?.athleteGender || '').toUpperCase();
  }

  function eventAgeMin(evt) {
    return evt.attributes?.athleteMinAge ?? eventNodeFor(evt.id)?.attributes?.athleteMinAge ?? null;
  }

  function eventAgeMax(evt) {
    return evt.attributes?.athleteMaxAge ?? eventNodeFor(evt.id)?.attributes?.athleteMaxAge ?? null;
  }

  function eventNumber(evt) {
    const value = evt.attributes?.eventNumber ?? eventNodeFor(evt.id)?.attributes?.eventNumber;
    return value === null || value === undefined ? '' : String(value).trim();
  }

  function isMergeTarget(evt) {
    return /[A-Za-z]$/.test(eventNumber(evt));
  }

  function eventStrokeCode(evt) {
    return evt.attributes?.strokeCode ?? eventNodeFor(evt.id)?.attributes?.strokeCode ?? null;
  }

  function eventDistance(evt) {
    return evt.attributes?.distance ?? eventNodeFor(evt.id)?.attributes?.distance ?? null;
  }

  function hasRaceMetadata(evt) {
    return eventStrokeCode(evt) !== null &&
      eventStrokeCode(evt) !== undefined &&
      eventDistance(evt) !== null &&
      eventDistance(evt) !== undefined;
  }

  function hasAgeMetadata(evt) {
    return eventAgeMin(evt) !== null &&
      eventAgeMin(evt) !== undefined &&
      eventAgeMax(evt) !== null &&
      eventAgeMax(evt) !== undefined;
  }

  function ageKey(evt) {
    return `${eventAgeMin(evt)}-${eventAgeMax(evt)}`;
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

  // ---- Optimization analysis ----

  function compareAgeThenEventOrder(a, b) {
    const ageDiff = Number(eventAgeMin(a)) - Number(eventAgeMin(b));
    if (ageDiff !== 0) return ageDiff;
    const maxAgeDiff = Number(eventAgeMax(a)) - Number(eventAgeMax(b));
    if (maxAgeDiff !== 0) return maxAgeDiff;
    const genderDiff = eventGender(a).localeCompare(eventGender(b));
    if (genderDiff !== 0) return genderDiff;
    return compareEventOrder(a, b);
  }

  function isSourceCompatibleWithTarget(source, target) {
    if (source.id === target.id || isMergeTarget(source)) return false;
    if (!hasRaceMetadata(source) || !hasRaceMetadata(target) || !hasAgeMetadata(source) || !hasAgeMetadata(target)) return false;
    if (String(eventStrokeCode(source)) !== String(eventStrokeCode(target))) return false;
    if (String(eventDistance(source)) !== String(eventDistance(target))) return false;
    if (Number(eventAgeMin(target)) > Number(eventAgeMin(source))) return false;
    if (Number(eventAgeMax(target)) < Number(eventAgeMax(source))) return false;

    const targetGender = eventGender(target);
    const sourceGender = eventGender(source);
    return targetGender === 'X' || targetGender === sourceGender;
  }

  function sourceEntryCount(evt) {
    return recordsFor(evt.id).length;
  }

  function sourceHeatCount(evt) {
    if (sourceEntryCount(evt) === 0) return 0;
    return currentHeatCount(evt);
  }

  function isAgeRunContiguous(events) {
    const sorted = events.slice().sort(compareAgeThenEventOrder);
    for (let i = 1; i < sorted.length; i++) {
      const previousMax = Number(eventAgeMax(sorted[i - 1]));
      const nextMin = Number(eventAgeMin(sorted[i]));
      if (!Number.isFinite(previousMax) || !Number.isFinite(nextMin)) return false;
      if (nextMin > previousMax + 1) return false;
    }
    return true;
  }

  function contiguousRunsForGender(events) {
    const sorted = events.slice().sort(compareAgeThenEventOrder);
    const runs = [];
    for (let start = 0; start < sorted.length; start++) {
      for (let end = start; end < sorted.length; end++) {
        const runEvents = sorted.slice(start, end + 1);
        if (!isAgeRunContiguous(runEvents)) continue;
        const nonEmptyEvents = runEvents.filter(evt => sourceEntryCount(evt) > 0);
        if (nonEmptyEvents.length === 0) continue;
        runs.push({ allEvents: runEvents, nonEmptyEvents });
      }
    }
    return runs;
  }

  function uniqueEvents(events) {
    const seen = new Set();
    const unique = [];
    events.forEach(evt => {
      if (!evt?.id || seen.has(evt.id)) return;
      seen.add(evt.id);
      unique.push(evt);
    });
    return unique;
  }

  function sourceEventsKey(events) {
    return events.map(evt => evt.id).sort().join('+');
  }

  function sourceEventIdSet(opp) {
    return new Set(opp.sourceEvents.map(evt => evt.id));
  }

  function sourceEventsAreSubset(subsetOpp, supersetOpp) {
    const supersetIds = sourceEventIdSet(supersetOpp);
    return subsetOpp.sourceEvents.every(evt => supersetIds.has(evt.id));
  }

  function hasBalancedBoysGirlsSelection(nonEmptyEvents, compatibleSources) {
    const selectedIds = new Set(nonEmptyEvents.map(evt => evt.id));
    const selectedGenders = new Set(nonEmptyEvents.map(eventGender));
    if (!selectedGenders.has('M') || !selectedGenders.has('F')) return true;

    const compatibleByGenderAndAge = new Map();
    compatibleSources.forEach(evt => {
      const gender = eventGender(evt);
      if (!['M', 'F'].includes(gender)) return;
      compatibleByGenderAndAge.set(`${gender}:${ageKey(evt)}`, evt);
    });

    const selectedAges = new Set(nonEmptyEvents
      .filter(evt => ['M', 'F'].includes(eventGender(evt)))
      .map(ageKey));

    for (const key of selectedAges) {
      for (const gender of ['M', 'F']) {
        const counterpart = compatibleByGenderAndAge.get(`${gender}:${key}`);
        if (counterpart && (selectedIds.has(counterpart.id) || sourceEntryCount(counterpart) === 0)) continue;
        return false;
      }
    }

    return true;
  }

  function makeOpportunity(targetEvent, sourceEvents, raceKey) {
    const targetRecords = recordsFor(targetEvent.id);
    const sourceRecords = sourceEvents
      .slice()
      .sort(compareAgeThenEventOrder)
      .flatMap(evt => recordsFor(evt.id).slice().sort(compareFastestFirst));
    const sourceCounts = sourceEvents.map(evt => sourceEntryCount(evt));
    const sourceHeats = sourceEvents.map(evt => sourceHeatCount(evt));
    if (sourceCounts.some(count => count <= 0) || sourceHeats.some(count => count === null)) return null;

    const targetHeats = currentHeatCount(targetEvent) || 0;
    const currentHeats = sourceHeats.reduce((sum, count) => sum + count, targetHeats);
    const combinedHeats = heatsNeeded(sourceRecords.length + targetRecords.length);
    const heatsSaved = currentHeats - combinedHeats;
    if (heatsSaved <= 0) return null;

    const sortedSources = sourceEvents.slice().sort(compareAgeThenEventOrder);
    const opportunity = {
      id: `target:${targetEvent.id}|sources:${sourceEventsKey(sortedSources)}`,
      raceKey,
      raceLabel: raceLabel(targetEvent),
      sourceEvents: sortedSources,
      sourceEvent: sortedSources.length === 1 ? sortedSources[0] : null,
      targetEvent,
      sourceLabel: sortedSources.map(eventLabel).join(' + '),
      targetLabel: eventLabel(targetEvent),
      sourceSwimmerCount: sourceRecords.length,
      targetSwimmerCount: targetRecords.length,
      currentHeats,
      combinedHeats,
      heatsSaved,
      sourceRecords,
      targetRecords,
      allSourceEvents: sortedSources,
      missingHeatCount: 0,
      canApply: true,
    };
    opportunity.missingHeatCount = missingHeatCountForOpportunity(opportunity);
    return opportunity;
  }

  function generateSourceSelections(targetEvent, compatibleSources) {
    const byGender = new Map();
    compatibleSources.forEach(evt => {
      const gender = eventGender(evt) || 'U';
      if (!byGender.has(gender)) byGender.set(gender, []);
      byGender.get(gender).push(evt);
    });

    const selections = new Map();
    const addSelection = events => {
      const nonEmptyEvents = uniqueEvents(events).filter(evt => sourceEntryCount(evt) > 0).sort(compareAgeThenEventOrder);
      if (nonEmptyEvents.length < 2) return;
      if (!hasBalancedBoysGirlsSelection(nonEmptyEvents, compatibleSources)) return;
      selections.set(sourceEventsKey(nonEmptyEvents), nonEmptyEvents);
    };

    const runsByGender = new Map();
    for (const [gender, events] of byGender.entries()) {
      const runs = contiguousRunsForGender(events);
      runsByGender.set(gender, runs);
      runs.forEach(run => addSelection(run.nonEmptyEvents));
    }

    const boysRuns = runsByGender.get('M') || [];
    const girlsRuns = runsByGender.get('F') || [];
    if (boysRuns.length && girlsRuns.length) {
      boysRuns.forEach(boysRun => {
        girlsRuns.forEach(girlsRun => {
          addSelection([...boysRun.nonEmptyEvents, ...girlsRun.nonEmptyEvents]);
        });
      });
    }

    return Array.from(selections.values());
  }

  function filterStrictlyDiminishing(opportunities) {
    return opportunities.filter(opp => {
      const sourceIds = new Set(opp.sourceEvents.map(evt => evt.id));
      return !opportunities.some(other => {
        if (other.id === opp.id || other.targetEvent.id !== opp.targetEvent.id) return false;
        if (other.sourceEvents.length >= opp.sourceEvents.length) return false;
        const isSubset = other.sourceEvents.every(evt => sourceIds.has(evt.id));
        return isSubset && other.heatsSaved >= opp.heatsSaved;
      });
    });
  }

  function targetGenderSpecificity(evt) {
    return eventGender(evt) === 'X' ? 0 : 1;
  }

  function sourceAgeEnvelope(sourceEvents) {
    return sourceEvents.reduce((envelope, evt) => {
      const min = Number(eventAgeMin(evt));
      const max = Number(eventAgeMax(evt));
      if (!Number.isFinite(min) || !Number.isFinite(max)) return envelope;
      return {
        min: envelope.min === null ? min : Math.min(envelope.min, min),
        max: envelope.max === null ? max : Math.max(envelope.max, max),
      };
    }, { min: null, max: null });
  }

  function ageGroupSpanForSourceEvents(sourceEvents) {
    const envelope = sourceAgeEnvelope(sourceEvents);
    if (envelope.min === null || envelope.max === null || sourceEvents.length === 0) return 0;

    const raceKey = sourceRaceKey(sourceEvents[0]);
    const ageKeys = new Set();
    allEvents.forEach(evt => {
      if (isMergeTarget(evt) || !hasRaceMetadata(evt) || !hasAgeMetadata(evt)) return;
      if (sourceRaceKey(evt) !== raceKey) return;
      const min = Number(eventAgeMin(evt));
      const max = Number(eventAgeMax(evt));
      if (!Number.isFinite(min) || !Number.isFinite(max)) return;
      if (min < envelope.min || max > envelope.max) return;
      ageKeys.add(ageKey(evt));
    });

    sourceEvents.forEach(evt => ageKeys.add(ageKey(evt)));
    return ageKeys.size;
  }

  function filterSuggestedMergeTargetsByAgeGroupLimit(suggestions, limit = proposedMergeAgeGroupLimit) {
    const maxAgeGroups = Number(limit);
    if (!Number.isFinite(maxAgeGroups) || maxAgeGroups <= 0) return suggestions;
    return suggestions.filter(suggestion =>
      ageGroupSpanForSourceEvents(suggestion.sourceEvents) <= maxAgeGroups
    );
  }

  function sourceTargetGender(sourceEvents) {
    const genders = new Set(sourceEvents.map(eventGender));
    if (genders.has('M') && genders.has('F')) return 'X';
    if (genders.size === 1) return [...genders][0];
    return 'X';
  }

  function targetGenderLabel(gender) {
    if (gender === 'X') return 'Mixed';
    if (gender === 'M') return 'Boys';
    if (gender === 'F') return 'Girls';
    return gender || 'Unknown gender';
  }

  function targetAgeLabel(min, max) {
    if (min === null || max === null) return 'matching age';
    if (min <= 0) return `${max} & Under`;
    if (min === max) return String(min);
    return `${min}-${max}`;
  }

  function suggestedTargetLabel(evt) {
    return `${targetGenderLabel(eventGender(evt))} ${targetAgeLabel(Number(eventAgeMin(evt)), Number(eventAgeMax(evt)))} ${raceLabel(evt)}`;
  }

  function sourceRaceKey(evt) {
    return `${eventDistance(evt)}-${eventStrokeCode(evt)}`;
  }

  function makeVirtualMergeTarget(sourceEvents, raceSource, gender) {
    const envelope = sourceAgeEnvelope(sourceEvents);
    if (envelope.min === null || envelope.max === null) return null;
    const ageLabel = targetAgeLabel(envelope.min, envelope.max);
    const sourceAttributes = raceSource.attributes || {};
    const strokeLabel = sourceAttributes.strokeLabel || sourceAttributes.label || sourceAttributes.fullLabel || '';
    return {
      id: `suggested-target:${gender}:${envelope.min}-${envelope.max}:${sourceRaceKey(raceSource)}`,
      attributes: {
        eventNumber: 'Add letter-suffixed target',
        athleteGender: gender,
        athleteMinAge: envelope.min,
        athleteMaxAge: envelope.max,
        strokeCode: eventStrokeCode(raceSource),
        distance: eventDistance(raceSource),
        label: strokeLabel,
        ageGroupName: ageLabel,
        sessionIndex: eventSortValue(sourceEvents[0]) ?? eventSortValue(raceSource) ?? Number.MAX_SAFE_INTEGER,
      },
      suggestedTarget: true,
    };
  }

  function existingMergeTargetCanAccept(sourceEvents, suggestedTarget) {
    return allEvents.some(evt =>
      isMergeTarget(evt) &&
      evt.id !== suggestedTarget.id &&
      String(eventStrokeCode(evt)) === String(eventStrokeCode(suggestedTarget)) &&
      String(eventDistance(evt)) === String(eventDistance(suggestedTarget)) &&
      eventGender(evt) === eventGender(suggestedTarget) &&
      Number(eventAgeMin(evt)) === Number(eventAgeMin(suggestedTarget)) &&
      Number(eventAgeMax(evt)) === Number(eventAgeMax(suggestedTarget)) &&
      sourceEvents.every(source => isSourceCompatibleWithTarget(source, evt))
    );
  }

  function buildSuggestedTargetOpportunity(sourceEvents, raceSource) {
    const gender = sourceTargetGender(sourceEvents);
    const targetEvent = makeVirtualMergeTarget(sourceEvents, raceSource, gender);
    if (!targetEvent) return null;
    if (!sourceEvents.every(source => isSourceCompatibleWithTarget(source, targetEvent))) return null;
    if (existingMergeTargetCanAccept(sourceEvents, targetEvent)) return null;

    const opportunity = makeOpportunity(targetEvent, sourceEvents, `${sourceRaceKey(raceSource)}:suggested-target`);
    if (!opportunity) return null;
    opportunity.id = `suggested:${opportunity.id}`;
    opportunity.canApply = false;
    opportunity.suggestedTarget = {
      gender,
      ageMin: Number(eventAgeMin(targetEvent)),
      ageMax: Number(eventAgeMax(targetEvent)),
      strokeCode: eventStrokeCode(targetEvent),
      distance: eventDistance(targetEvent),
      label: suggestedTargetLabel(targetEvent),
    };
    opportunity.targetLabel = opportunity.suggestedTarget.label;
    return opportunity;
  }

  function findSuggestedMergeTargets() {
    const suggestions = new Map();
    const sourceCandidates = allEvents
      .filter(evt => !isMergeTarget(evt) && hasRaceMetadata(evt) && hasAgeMetadata(evt))
      .sort(compareAgeThenEventOrder);
    const eventsByRace = new Map();

    sourceCandidates.forEach(evt => {
      const key = sourceRaceKey(evt);
      if (!eventsByRace.has(key)) eventsByRace.set(key, []);
      eventsByRace.get(key).push(evt);
    });

    for (const raceEvents of eventsByRace.values()) {
      const raceSource = raceEvents[0];
      const raceEnvelope = sourceAgeEnvelope(raceEvents);
      if (raceEnvelope.min === null || raceEnvelope.max === null) continue;

      ['M', 'F', 'X'].forEach(gender => {
        const broadTarget = makeVirtualMergeTarget(raceEvents, raceSource, gender);
        if (!broadTarget) return;
        broadTarget.attributes.athleteMinAge = raceEnvelope.min;
        broadTarget.attributes.athleteMaxAge = raceEnvelope.max;
        broadTarget.attributes.ageGroupName = targetAgeLabel(raceEnvelope.min, raceEnvelope.max);

        const compatibleSources = raceEvents
          .filter(evt => isSourceCompatibleWithTarget(evt, broadTarget))
          .sort(compareAgeThenEventOrder);
        generateSourceSelections(broadTarget, compatibleSources).forEach(sourceEvents => {
          const suggestion = buildSuggestedTargetOpportunity(sourceEvents, raceSource);
          if (!suggestion) return;
          suggestions.set(`${sourceEventsKey(sourceEvents)}|${suggestion.suggestedTarget.gender}|${suggestion.suggestedTarget.ageMin}-${suggestion.suggestedTarget.ageMax}|${sourceRaceKey(raceSource)}`, suggestion);
        });
      });
    }

    const filteredSuggestions = filterBroaderNonImprovingTargets(filterStrictlyDiminishing(Array.from(suggestions.values())));
    filteredSuggestions.sort((a, b) => {
      if (b.heatsSaved !== a.heatsSaved) return b.heatsSaved - a.heatsSaved;
      if (b.sourceEvents.length !== a.sourceEvents.length) return b.sourceEvents.length - a.sourceEvents.length;
      const raceDiff = (a.raceLabel || '').localeCompare(b.raceLabel || '');
      if (raceDiff !== 0) return raceDiff;
      return compareAgeThenEventOrder(a.sourceEvents[0], b.sourceEvents[0]);
    });
    return filteredSuggestions;
  }

  function idealTargetDiagnostic(opp) {
    const envelope = sourceAgeEnvelope(opp.sourceEvents);
    if (envelope.min === null || envelope.max === null) return null;

    const targetMin = Number(eventAgeMin(opp.targetEvent));
    const targetMax = Number(eventAgeMax(opp.targetEvent));
    if (targetMin <= envelope.min && targetMax === envelope.max) return null;

    const expectedGender = sourceTargetGender(opp.sourceEvents);
    const expectedLabel = `${targetGenderLabel(expectedGender)} ${targetAgeLabel(0, envelope.max)} ${raceLabel(opp.targetEvent)}`;
    const narrowerMatches = allEvents.filter(evt =>
      evt.id !== opp.targetEvent.id &&
      String(eventStrokeCode(evt)) === String(eventStrokeCode(opp.targetEvent)) &&
      String(eventDistance(evt)) === String(eventDistance(opp.targetEvent)) &&
      eventGender(evt) === expectedGender &&
      Number(eventAgeMin(evt)) <= envelope.min &&
      Number(eventAgeMax(evt)) === envelope.max
    );

    if (narrowerMatches.length === 0) {
      return `No loaded ${expectedLabel} target was found. Check that it exists in this session with matching stroke, distance, gender, and age metadata.`;
    }

    const nonTargets = narrowerMatches.filter(evt => !isMergeTarget(evt));
    if (nonTargets.length > 0) {
      return `${expectedLabel} exists, but its event number does not end in a letter, so it is treated as a regular source event.`;
    }

    const compatibleTargets = narrowerMatches.filter(evt =>
      opp.sourceEvents.every(source => isSourceCompatibleWithTarget(source, evt))
    );
    if (compatibleTargets.length === 0) {
      return `${expectedLabel} exists as a merge target, but its metadata does not contain all selected source events.`;
    }

    return `${expectedLabel} exists as a merge target but was not selected. Refresh meet data; if this remains, the dominance filter needs another look.`;
  }

  function isMoreSpecificTargetForSameSources(moreSpecific, broader) {
    if (String(eventStrokeCode(moreSpecific.targetEvent)) !== String(eventStrokeCode(broader.targetEvent))) return false;
    if (String(eventDistance(moreSpecific.targetEvent)) !== String(eventDistance(broader.targetEvent))) return false;

    const moreSpecificMin = Number(eventAgeMin(moreSpecific.targetEvent));
    const moreSpecificMax = Number(eventAgeMax(moreSpecific.targetEvent));
    const broaderMin = Number(eventAgeMin(broader.targetEvent));
    const broaderMax = Number(eventAgeMax(broader.targetEvent));
    if (![moreSpecificMin, moreSpecificMax, broaderMin, broaderMax].every(Number.isFinite)) return false;

    const ageContained = moreSpecificMin >= broaderMin && moreSpecificMax <= broaderMax;
    if (!ageContained) return false;

    const ageIsNarrower = moreSpecificMin > broaderMin || moreSpecificMax < broaderMax;
    const genderIsMoreSpecific = targetGenderSpecificity(moreSpecific.targetEvent) > targetGenderSpecificity(broader.targetEvent);
    return ageIsNarrower || genderIsMoreSpecific;
  }

  function filterBroaderNonImprovingTargets(opportunities) {
    return opportunities.filter(opp => {
      return !opportunities.some(other => {
        if (other.id === opp.id) return false;
        if (other.heatsSaved < opp.heatsSaved) return false;
        if (!sourceEventsAreSubset(other, opp)) return false;
        return isMoreSpecificTargetForSameSources(other, opp);
      });
    });
  }

  function findOpportunities() {
    const opportunities = [];

    for (const targetEvent of allEvents.filter(isMergeTarget).sort(compareEventOrder)) {
      if (!hasRaceMetadata(targetEvent) || !hasAgeMetadata(targetEvent)) continue;
      const compatibleSources = allEvents
        .filter(evt => isSourceCompatibleWithTarget(evt, targetEvent))
        .sort(compareAgeThenEventOrder);
      const raceKey = `${eventDistance(targetEvent)}-${eventStrokeCode(targetEvent)}-${targetEvent.id}`;

      const targetOpportunities = generateSourceSelections(targetEvent, compatibleSources)
        .map(sourceEvents => makeOpportunity(targetEvent, sourceEvents, raceKey))
        .filter(Boolean);

      opportunities.push(...filterStrictlyDiminishing(targetOpportunities));
    }

    const filteredOpportunities = filterBroaderNonImprovingTargets(opportunities);

    filteredOpportunities.sort((a, b) => {
      if (b.heatsSaved !== a.heatsSaved) return b.heatsSaved - a.heatsSaved;
      if (b.sourceEvents.length !== a.sourceEvents.length) return b.sourceEvents.length - a.sourceEvents.length;
      const ageSpanDiff = (Number(eventAgeMax(a.targetEvent)) - Number(eventAgeMin(a.targetEvent))) -
        (Number(eventAgeMax(b.targetEvent)) - Number(eventAgeMin(b.targetEvent)));
      if (ageSpanDiff !== 0) return ageSpanDiff;
      const genderSpecificityDiff = targetGenderSpecificity(b.targetEvent) - targetGenderSpecificity(a.targetEvent);
      if (genderSpecificityDiff !== 0) return genderSpecificityDiff;
      return compareEventOrder(a.targetEvent, b.targetEvent);
    });

    return filteredOpportunities;
  }

  if (window.__mmMergeHelperTestMode) {
    window.__mmMergeHelperTestHarness = {
      setData(data = {}) {
        allEvents = data.events || [];
        allRecords = data.records || [];
        allHeats = data.heats || [];
        allAthletes = data.athletes || [];
        allEventNodes = data.eventNodes || [];
        allTeams = data.teams || [];
        laneCount = data.laneCount ?? null;
        appliedMerges = new Set();
        hiddenOpportunities = new Set();
        needsOrganizationEventIds = new Set();
        dashboardOpportunityTab = null;
      },
      findOpportunities,
      findSuggestedMergeTargets,
      filterSuggestedMergeTargetsByAgeGroupLimit,
      ageGroupSpanForSourceEvents,
      generateSourceSelections,
      heatSizesForEntryCount,
      laneSeedOrder,
      planGenderHeatChunks,
      planTimeHeatChunks,
      genderChunkLaneAssignments,
      isMergeTarget,
      isSourceCompatibleWithTarget,
      hasBalancedBoysGirlsSelection,
    };
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
          <button class="mm-btn mm-btn-sm" id="mm-reload">Refresh Data</button>
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
  }

  function renderDashboard() {
    currentView = 'dashboard';
    organizerEventId = null;
    const opportunities = findOpportunities();
    const targetSuggestions = filterSuggestedMergeTargetsByAgeGroupLimit(findSuggestedMergeTargets());
    if (!dashboardOpportunityTab) {
      dashboardOpportunityTab = opportunities.length > 0 ? 'existing' : 'suggested';
    }
    renderSummary(opportunities, targetSuggestions);
    renderOpportunities(opportunities, targetSuggestions);
  }

  function renderSummary(opportunities, targetSuggestions = []) {
    const el = document.getElementById('mm-summary');
    if (!el) return;

    const allOpportunities = opportunities.concat(targetSuggestions);
    const totalSaved = allOpportunities.reduce((s, o) => s + o.heatsSaved, 0);
    const seededEvents = allEvents.filter(e => recordsFor(e.id).length > 0).length;
    const swimmerEntries = allRecords.length;
    const heatCount = allHeats.length;
    const lanes = laneCount === null ? 'Not loaded' : laneCount;

    el.innerHTML = `
      <div class="mm-summary-stat">
        <span class="mm-stat-value">${allOpportunities.length}</span>
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

  function renderOpportunities(opportunities, targetSuggestions = filterSuggestedMergeTargetsByAgeGroupLimit(findSuggestedMergeTargets())) {
    const el = document.getElementById('mm-body');
    if (!el) return;
    if (!['existing', 'suggested', 'organize'].includes(dashboardOpportunityTab)) {
      dashboardOpportunityTab = opportunities.length > 0 ? 'existing' : 'suggested';
    }

    const organizerEvents = seededEventsForOrganizer();
    const activeTab = dashboardOpportunityTab;
    const existingActive = activeTab === 'existing';
    const suggestedActive = activeTab === 'suggested';
    const organizeActive = activeTab === 'organize';
    const tabContent = existingActive
      ? renderExistingMergeOpportunities(opportunities)
      : suggestedActive
        ? renderSuggestedMergeTargets(targetSuggestions)
        : renderSeededEvents(organizerEvents);
    const emptyContent = existingActive
      ? `<div class="mm-empty">
          <div class="mm-empty-title">No existing-target merges found</div>
          <div class="mm-empty-copy">No loaded letter-suffixed target currently saves heats with compatible source events.</div>
        </div>`
      : suggestedActive
        ? `<div class="mm-empty">
          <div class="mm-empty-title">No proposed merges found</div>
          <div class="mm-empty-copy">The loaded source events do not point to a heat-saving proposed merge within the current age-group span.</div>
          ${renderProposedMergeAgeGroupLimitControl()}
        </div>`
        : `<div class="mm-empty">
          <div class="mm-empty-title">No events to organize</div>
          <div class="mm-empty-copy">No seeded events or heats were returned for this session.</div>
        </div>`;

    el.innerHTML = `
      <div class="mm-dashboard-tabs" role="tablist" aria-label="Merge opportunity type">
        <button class="mm-tab ${existingActive ? 'is-active' : ''}" role="tab" aria-selected="${existingActive ? 'true' : 'false'}" data-dashboard-tab="existing">
          Existing Targets <span>${opportunities.length}</span>
        </button>
        <button class="mm-tab ${suggestedActive ? 'is-active' : ''}" role="tab" aria-selected="${suggestedActive ? 'true' : 'false'}" data-dashboard-tab="suggested">
          Proposed Merges <span>${targetSuggestions.length}</span>
        </button>
        <button class="mm-tab ${organizeActive ? 'is-active' : ''}" role="tab" aria-selected="${organizeActive ? 'true' : 'false'}" data-dashboard-tab="organize">
          Organize Heats <span>${organizerEvents.length}</span>
        </button>
      </div>
      ${tabContent || emptyContent}
    `;

    wireDashboardButtons(el, opportunities, targetSuggestions);
  }

  function renderExistingMergeOpportunities(opportunities) {
    if (opportunities.length === 0) return '';

    let html = `
      <div class="mm-context">
        <div class="mm-context-title">Best target-based merge options</div>
        <div class="mm-context-copy">Each card moves entries from two or more compatible source events into a predefined letter-suffixed merge target and compares current actual heats against the ${requireLaneCount()}-lane pool returned by Meet Maestro.</div>
      </div>
    `;

    let lastRaceKey = null;
    for (const opp of opportunities) {
      if (opp.raceKey !== lastRaceKey) {
        if (lastRaceKey !== null) html += '</div>';
        html += `<div class="mm-race-group">
          <div class="mm-race-header">${esc(opp.raceLabel || opp.raceKey.replace(/-/, ' '))}</div>`;
        lastRaceKey = opp.raceKey;
      }

      const applied = appliedMerges.has(opp.id);
      const hidden = hiddenOpportunities.has(opp.id);
      if (hidden) {
        html += `<div class="mm-opp-hidden" data-opp-id="${esc(opp.id)}">
          <div class="mm-hidden-main">
            <strong>Eliminates ${opp.heatsSaved} heat${opp.heatsSaved === 1 ? '' : 's'}</strong>
            <span>${esc(opp.sourceEvents.length)} source${opp.sourceEvents.length === 1 ? '' : 's'} into ${esc(opp.targetLabel)}</span>
          </div>
          <button class="mm-btn mm-btn-secondary mm-btn-sm mm-unhide-opp" data-opp-id="${esc(opp.id)}">Unhide</button>
        </div>`;
        continue;
      }

      const diagnostic = idealTargetDiagnostic(opp);
      html += `<div class="mm-opp ${applied ? 'mm-applied' : ''}" data-opp-id="${esc(opp.id)}">
          <div class="mm-opp-topline">
            <div class="mm-save-badge">Save ${opp.heatsSaved} heat${opp.heatsSaved > 1 ? 's' : ''}</div>
          </div>
          <div class="mm-merge-grid">
            <div class="mm-event-box mm-event-source">
              <span class="mm-event-box-label">Move from ${opp.sourceEvents.length} sources</span>
              <div class="mm-source-list">
                ${opp.sourceEvents.map(evt => `
                  <div class="mm-source-item">
                    <strong>${esc(eventLabel(evt))}</strong>
                    <span>${esc(heatSummary(evt))}</span>
                  </div>
                `).join('')}
              </div>
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
          ${diagnostic ? `<div class="mm-info">Why not a narrower target? ${esc(diagnostic)}</div>` : ''}
          <div class="mm-opp-actions">
            <button class="mm-btn mm-btn-secondary mm-hide-opp" data-opp-id="${esc(opp.id)}">Hide</button>
            <button class="mm-btn mm-btn-secondary mm-preview-opp" data-opp-id="${esc(opp.id)}">Preview</button>
            <button class="mm-btn mm-btn-accent mm-apply-opp" data-opp-id="${esc(opp.id)}" ${applied ? 'disabled' : ''}>
              ${applied ? 'Applied' : 'Merge'}
            </button>
          </div>
          <div class="mm-opp-detail" id="mm-detail-${esc(opp.id).replace(/[^a-zA-Z0-9]/g, '_')}" style="display:none"></div>
        </div>`;
    }
    if (lastRaceKey !== null) html += '</div>';

    return html;
  }

  function wireDashboardButtons(root, opportunities, targetSuggestions = []) {
    root.querySelectorAll('.mm-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        dashboardOpportunityTab = btn.dataset.dashboardTab || 'existing';
        renderOpportunities(opportunities, targetSuggestions);
      });
    });
    root.querySelector('.mm-proposed-age-limit')?.addEventListener('change', event => {
      const value = event.currentTarget.value;
      proposedMergeAgeGroupLimit = value === 'all' ? 'all' : Number(value);
      dashboardOpportunityTab = 'suggested';
      renderDashboard();
    });
    root.querySelectorAll('.mm-preview-opp').forEach(btn => {
      btn.addEventListener('click', () => togglePreview(btn.dataset.oppId));
    });
    root.querySelectorAll('.mm-apply-opp').forEach(btn => {
      btn.addEventListener('click', () => executeMerge(btn.dataset.oppId));
    });
    root.querySelectorAll('.mm-hide-opp').forEach(btn => {
      btn.addEventListener('click', () => {
        hiddenOpportunities.add(btn.dataset.oppId);
        renderOpportunities(opportunities, targetSuggestions);
      });
    });
    root.querySelectorAll('.mm-unhide-opp').forEach(btn => {
      btn.addEventListener('click', () => {
        hiddenOpportunities.delete(btn.dataset.oppId);
        renderOpportunities(opportunities, targetSuggestions);
      });
    });
    root.querySelectorAll('.mm-organize-event').forEach(btn => {
      btn.addEventListener('click', () => openOrganizer(btn.dataset.eventId));
    });
  }

  function renderSuggestedMergeTargets(suggestions) {
    if (!suggestions.length) return '';

    return `<div class="mm-suggestions">
      <div class="mm-context">
        <div class="mm-context-title">Proposed merges</div>
        <div class="mm-context-copy">These seeded source events would save heats if a compatible letter-suffixed merge target were added to the meet template.</div>
        ${renderProposedMergeAgeGroupLimitControl()}
      </div>
      ${suggestions.map(suggestion => {
        const hidden = hiddenOpportunities.has(suggestion.id);
        if (hidden) {
          return `<div class="mm-opp-hidden" data-opp-id="${esc(suggestion.id)}">
            <div class="mm-hidden-main">
              <strong>Could save ${suggestion.heatsSaved} heat${suggestion.heatsSaved === 1 ? '' : 's'}</strong>
              <span>Add ${esc(suggestion.suggestedTarget.label)} for ${esc(suggestion.sourceEvents.length)} eligible source${suggestion.sourceEvents.length === 1 ? '' : 's'}</span>
            </div>
            <button class="mm-btn mm-btn-secondary mm-btn-sm mm-unhide-opp" data-opp-id="${esc(suggestion.id)}">Unhide</button>
          </div>`;
        }

        return `<div class="mm-suggestion">
          <div class="mm-opp-topline">
            <div class="mm-save-badge">Could save ${suggestion.heatsSaved} heat${suggestion.heatsSaved > 1 ? 's' : ''}</div>
          </div>
          <div class="mm-merge-grid">
            <div class="mm-event-box mm-event-source">
              <span class="mm-event-box-label">Eligible sources</span>
              <div class="mm-source-list">
                ${suggestion.sourceEvents.map(evt => `
                  <div class="mm-source-item">
                    <strong>${esc(eventLabel(evt))}</strong>
                    <span>${esc(heatSummary(evt))}</span>
                  </div>
                `).join('')}
              </div>
            </div>
            <div class="mm-merge-arrow">&rarr;</div>
            <div class="mm-event-box mm-event-target">
              <span class="mm-event-box-label">Add target</span>
              <strong>${esc(suggestion.suggestedTarget.label)}</strong>
              <span>${esc(suggestion.suggestedTarget.distance)}m ${esc(suggestion.suggestedTarget.strokeCode)} · ${esc(targetGenderLabel(suggestion.suggestedTarget.gender))} · ${esc(targetAgeLabel(suggestion.suggestedTarget.ageMin, suggestion.suggestedTarget.ageMax))}</span>
            </div>
          </div>
          <div class="mm-metrics">
            <div><span>Current</span><strong>${suggestion.currentHeats} heat${suggestion.currentHeats === 1 ? '' : 's'}</strong></div>
            <div><span>With target</span><strong>${suggestion.combinedHeats} heat${suggestion.combinedHeats === 1 ? '' : 's'}</strong></div>
            <div><span>Moved entries</span><strong>${suggestion.sourceSwimmerCount}</strong></div>
          </div>
          <div class="mm-opp-actions">
            <button class="mm-btn mm-btn-secondary mm-hide-opp" data-opp-id="${esc(suggestion.id)}">Hide</button>
          </div>
        </div>`;
      }).join('')}
    </div>`;
  }

  function renderProposedMergeAgeGroupLimitControl() {
    const options = [1, 2, 3, 4, 5];
    return `<div class="mm-proposed-filter">
      <label for="mm-proposed-age-limit">Show merges across</label>
      <select id="mm-proposed-age-limit" class="mm-proposed-age-limit">
        ${options.map(value => `
          <option value="${value}" ${Number(proposedMergeAgeGroupLimit) === value ? 'selected' : ''}>${value} age group${value === 1 ? '' : 's'}</option>
        `).join('')}
        <option value="all" ${proposedMergeAgeGroupLimit === 'all' ? 'selected' : ''}>Any span</option>
      </select>
    </div>`;
  }

  function seededEventsForOrganizer() {
    return allEvents
      .filter(evt => recordsFor(evt.id).length > 0 || heatsFor(evt.id).length > 0)
      .sort(compareEventOrder);
  }

  function renderSeededEvents(seeded = seededEventsForOrganizer()) {
    if (seeded.length === 0) {
      return '<div class="mm-seeded"><div class="mm-section-title">Loaded events</div><div class="mm-muted">No seeded events or heats were returned for this session.</div></div>';
    }

    const rows = seeded.map(evt => {
      const heats = heatsFor(evt.id);
      const entries = recordsFor(evt.id);
      const needsOrganization = needsOrganizationEventIds.has(evt.id);
      const populatedMergeTarget = isMergeTarget(evt) && entries.length > 0;
      const rowClasses = [
        'mm-event-row',
        needsOrganization ? 'mm-event-needs-organization' : '',
        populatedMergeTarget ? 'mm-event-populated-target' : '',
      ].filter(Boolean).join(' ');
      const heatText = heats.length
        ? heats.map(h => {
          const count = entries.filter(r => r.relationships?.heat?.data?.id === h.id).length;
          return `H${h.attributes?.number || '?'}: ${count}`;
        }).join(' · ')
        : 'No heat resources';
      return `<div class="${rowClasses}">
        <div>
          <strong>${esc(eventLabel(evt))}</strong>
          <span>${esc(raceLabel(evt))}</span>
          ${populatedMergeTarget ? '<span class="mm-event-row-label mm-populated-target-label">Populated merge target</span>' : ''}
          ${needsOrganization ? '<span class="mm-needs-organization-label">Needs organization</span>' : ''}
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
    renderSummary(findOpportunities(), filterSuggestedMergeTargetsByAgeGroupLimit(findSuggestedMergeTargets()));
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
            <span>Heat order</span>
            <div class="mm-segmented" role="group" aria-label="Organizer heat order">
              <button class="mm-segmented-btn ${organizerHeatOrder === 'slowest-first' ? 'is-active' : ''}" data-heat-order="slowest-first">Slowest To Fastest</button>
              <button class="mm-segmented-btn ${organizerHeatOrder === 'fastest-first' ? 'is-active' : ''}" data-heat-order="fastest-first">Fastest To Slowest</button>
            </div>
          </div>
          <div>
            <button class="mm-btn mm-btn-secondary mm-sort-time">Sort By Time</button>
            <span>Use the selected heat order; fastest in each heat gets the preferred center lane.</span>
          </div>
          <div>
            <button class="mm-btn mm-btn-secondary mm-group-gender">Group Boys / Girls</button>
            <span>Use the selected heat order and fewest heats possible, then keep heats single-gender where possible. Mixed heats put girls on low lanes and boys on high lanes.</span>
          </div>
          <div>
            <button class="mm-btn mm-btn-reload mm-page-reload">Reload Page</button>
            <span>Some saved changes may not be reflected in Meet Maestro until the page is reloaded.</span>
          </div>
        </div>
      </div>
    `;

    el.querySelector('.mm-back-dashboard')?.addEventListener('click', () => renderDashboard());
    el.querySelector('.mm-sort-time')?.addEventListener('click', event => organizeByTime(eventId, event.currentTarget));
    el.querySelector('.mm-page-reload')?.addEventListener('click', () => requestPageReload());
    el.querySelector('.mm-group-gender')?.addEventListener('click', event => organizeByGender(eventId, event.currentTarget));
    el.querySelectorAll('.mm-segmented-btn').forEach(button => {
      button.addEventListener('click', () => {
        if (button.dataset.labelMode) organizerLabelMode = button.dataset.labelMode;
        if (button.dataset.heatOrder) organizerHeatOrder = button.dataset.heatOrder;
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

      await nudgeMeetMaestroView(a, [eventId]);
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

  async function organizeByTime(eventId, button) {
    const chunks = planTimeHeatChunks(recordsFor(eventId));
    const heats = heatsFor(eventId);
    const targetHeats = heats.slice(0, chunks.length);
    const lanes = laneSeedOrder();
    const assignments = [];

    if (targetHeats.length < chunks.length) {
      alert('Could not find enough heats to organize this event. Refresh meet data and try again.');
      return;
    }

    chunks.forEach((chunk, heatIndex) => {
      const heat = targetHeats[heatIndex];
      const heatNumber = heatNumberFor(heat, 'target heat');

      chunk.records.slice().sort(compareFastestFirst).forEach((record, laneIndex) => {
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
    const chunks = planGenderHeatChunks(records, laneTotal);
    const targetHeats = heats.slice(0, chunks.length);

    if (targetHeats.length < chunks.length) {
      alert('Could not find enough heats to organize this event. Refresh meet data and try again.');
      return;
    }

    const assignments = [];
    chunks.forEach((chunk, heatIndex) => {
      const heat = targetHeats[heatIndex];
      const heatNumber = heatNumberFor(heat, 'target heat');
      genderChunkLaneAssignments(chunk.records, laneTotal).forEach(({ record, laneNumber }) => {
        assignments.push(buildAssignment(record, { heatId: heat.id, heatNumber, laneNumber }));
      });
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
      await nudgeMeetMaestroView(a, [eventId]);
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
        await nudgeMeetMaestroView(a, [eventId]);
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

    const existingHeatNumbers = assignments.map(a => a.heatNum).filter(number => Number.isFinite(Number(number)));
    let nextHeatNumber = existingHeatNumbers.length ? Math.max(...existingHeatNumbers) + 1 : 1;
    for (let i = 0; i < opp.missingHeatCount; i++) {
      assignments.push({
        heatId: `preview-new-${i + 1}`,
        heatNum: nextHeatNumber++,
        lanes: {},
        isNew: true,
      });
    }

    // Add source swimmers into new/remaining lanes
    let srcSwimmers = [...opp.sourceRecords];
    let heatIdx = 0;
    let unplacedPreviewCount = 0;

    if (opp.targetRecords.length === 0) {
      const placements = lanePlacementsForEmptyHeats(opp.sourceRecords, assignments);
      if (placements) {
        placements.forEach(({ record, heatAssignment, laneNumber }) => {
          heatAssignment.lanes[laneNumber] = { ...record, _fromSource: true };
        });
        srcSwimmers = [];
      }
    }

    while (srcSwimmers.length > 0) {
      if (heatIdx >= assignments.length) {
        unplacedPreviewCount = srcSwimmers.length;
        break;
      }

      const assignment = assignments[heatIdx];
      for (const lane of laneSeedOrder()) {
        if (srcSwimmers.length === 0) break;
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
      html += `<div class="mm-warning">${unplacedPreviewCount} swimmer${unplacedPreviewCount === 1 ? '' : 's'} cannot be placed in the current target layout.</div>`;
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
      <span class="mm-legend-source">&bull;</span> Moving from source
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
      const label = 'Preparing target lanes...';
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

    if (opp.targetRecords.length === 0) {
      const placements = lanePlacementsForEmptyHeats(opp.sourceRecords, heatAssignments);
      if (placements) {
        placements.forEach(({ record, heatAssignment, laneNumber }) => {
          moves.push({
            sourceRecord: record,
            eventId: opp.targetEvent.id,
            heatId: heatAssignment.heatId,
            heatNumber: heatAssignment.heatNum,
            laneNumber,
          });
        });
        srcSwimmers.length = 0;
      }
    }

    while (srcSwimmers.length > 0) {
      if (heatIdx >= heatAssignments.length) {
        // No more existing heats — can't auto-assign without creating new heats
        console.warn('[Merge Helper] ran out of heats to assign swimmers to');
        break;
      }

      const ha = heatAssignments[heatIdx];
      for (const lane of laneSeedOrder()) {
        if (srcSwimmers.length === 0) break;
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
      alert(`Cannot merge: ${srcSwimmers.length} swimmer(s) couldn't be placed in the target layout.`);
      if (btn) { btn.disabled = false; btn.textContent = 'Merge'; }
      finish();
      return;
    }

    if (moves.length === 0) {
      if (btn) { btn.disabled = false; btn.textContent = 'Merge'; }
      finish();
      return;
    }

    try {
      setBusyMessage(`Moving ${moves.length} swimmer${moves.length === 1 ? '' : 's'} into the target event...`);
      const results = await a.batchMove(moves);
      const failures = results.filter(r => !r.success);
      const changedEventIds = cleanupEventIdsForMerge(opp);

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

      await nudgeMeetMaestroView(a, failures.length > 0 ? movedCleanupEventIds : changedEventIds);
      appliedMerges.add(oppId);
      if (opp.targetEvent?.id) needsOrganizationEventIds.add(opp.targetEvent.id);
      setBusyMessage('Refreshing meet data...');
      await loadData();
    } catch (err) {
      console.error('[Merge Helper] merge failed:', err);
      alert('Merge failed: ' + err.message);
      if (btn) { btn.disabled = false; btn.textContent = 'Merge'; }
    } finally {
      finish();
    }
  }

  const reloadRestoreState = readReloadRestoreState();
  if (reloadRestoreState) {
    (async () => {
      await waitForPageReady();
      await sleep(750);
      buildPanel();
      panelVisible = true;
      mergePanel.style.display = 'flex';
      if (reloadRestoreState.view === 'organizer' && reloadRestoreState.organizerEventId) {
        currentView = 'organizer';
        organizerEventId = reloadRestoreState.organizerEventId;
      }
      withBusy('Loading meet data...', () => loadData({ apiRetries: 30, apiDelayMs: 500 })).catch(() => {});
    })();
  }
})();
