// SwimTopia API client (JSON:API format)

class SwimTopiaAPI {
  constructor(authToken, meetId, sessionId) {
    this.baseUrl = 'https://api.swimtopia.org/v3';
    this.authToken = authToken;
    this.meetId = meetId;
    this.sessionId = sessionId;
    this.clientVersion = '10.1.0+f74ce583';
  }

  async request(path, options = {}) {
    const url = `${this.baseUrl}${path}`;
    const headers = {
      'Accept': 'application/vnd.api+json',
      'X-Maestro-Client-Version': this.clientVersion,
    };
    if (this.authToken) headers.Authorization = `Bearer ${this.authToken}`;
    if (options.body) {
      headers['Content-Type'] = 'application/vnd.api+json';
    }

    const requestOptions = {
      ...options,
      headers: { ...headers, ...options.headers },
    };

    if (typeof chrome !== 'undefined' && !!chrome.runtime?.sendMessage) {
      return this.requestViaBackground(url, requestOptions);
    }

    try {
      return await this.fetchJson(url, requestOptions);
    } catch (err) {
      if (!this.canUseBackgroundFetch(err)) throw err;
      return this.requestViaBackground(url, requestOptions);
    }
  }

  async fetchJson(url, requestOptions) {
    const response = await fetch(url, requestOptions);
    const text = await response.text();

    if (!response.ok) {
      throw new Error(`API ${response.status}: ${text}`);
    }
    return text ? JSON.parse(text) : null;
  }

  canUseBackgroundFetch(err) {
    return err instanceof TypeError && typeof chrome !== 'undefined' && !!chrome.runtime?.sendMessage;
  }

  async requestViaBackground(url, requestOptions) {
    const response = await chrome.runtime.sendMessage({
      type: 'API_REQUEST',
      url,
      options: {
        credentials: 'include',
        ...requestOptions,
      },
    });

    if (!response) throw new Error('API request failed: no background response');
    if (response.status === 0) throw new Error(`API request failed: ${response.error || 'network error'}`);
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`API ${response.status}: ${response.text || JSON.stringify(response.body)}`);
    }
    return response.body;
  }

  collectIncluded(resp, type) {
    return (resp.included || []).filter(item => item.type === type);
  }

  eventIncludeParam() {
    return [
      'heats',
      'break',
      'event-records',
      'subevents',
      'event-records.relay-position-records',
      'event-records.splits',
      'event-records.team-grouping-scores',
    ].join('%2C');
  }

  eventsPath(eventIds) {
    const ids = Array.from(new Set((eventIds || []).filter(Boolean)));
    if (ids.length === 0) throw new Error('Missing event ids.');
    return `/meets/${this.meetId}/events?filter[id]=${ids.join('%2C')}&include=${this.eventIncludeParam()}`;
  }

  async refreshEvents(eventIds) {
    return this.request(this.eventsPath(eventIds), {
      cache: 'no-store',
      headers: {
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
      },
    });
  }

  // Load all events, heats, and event records for the given session.
  async loadSessionData() {
    if (!this.sessionId) throw new Error('Missing sessionId');

    const [meetResp, athletesResp, nodesResp] = await Promise.all([
      this.request(`/meets/${this.meetId}?include=teams%2Csessions`),
      this.request(`/meets/${this.meetId}/athletes`),
      this.request(`/meets/${this.meetId}/event-nodes?filter[session_id]=${this.sessionId}&include=break`),
    ]);

    const eventNodes = nodesResp.data || [];
    const eventIds = eventNodes
      .map(n => n.relationships?.event?.data?.id)
      .filter(Boolean);

    const allEvents = [];
    const allHeats = [];
    const allRecords = [];
    const seenEvents = new Set();
    const seenHeats = new Set();
    const seenRecords = new Set();

    const chunkSize = 5;
    for (let i = 0; i < eventIds.length; i += chunkSize) {
      const chunk = eventIds.slice(i, i + chunkSize);
      const resp = await this.request(this.eventsPath(chunk));

      for (const event of resp.data || []) {
        if (!seenEvents.has(event.id)) {
          seenEvents.add(event.id);
          allEvents.push(event);
        }
      }
      if (resp.included) {
        for (const inc of resp.included) {
          if (inc.type === 'heat' && !seenHeats.has(inc.id)) {
            seenHeats.add(inc.id);
            allHeats.push(inc);
          }
          if (inc.type === 'eventRecord' && !seenRecords.has(inc.id)) {
            seenRecords.add(inc.id);
            allRecords.push(inc);
          }
        }
      }
    }

    return {
      meet: meetResp.data || null,
      sessions: this.collectIncluded(meetResp, 'session'),
      teams: this.collectIncluded(meetResp, 'team'),
      athletes: athletesResp.data || [],
      eventNodes,
      events: allEvents,
      records: allRecords,
      heats: allHeats,
    };
  }

  // Move a swimmer to a different heat/lane
  async moveEventRecord(recordId, { heatId, laneNumber, heatNumber, isExhibition = false }) {
    this.requireId(recordId, 'event record id');
    this.requireId(heatId, 'heat id');
    this.requirePositiveInteger(laneNumber, 'lane number');
    this.requirePositiveInteger(heatNumber, 'heat number');

    const payload = {
      data: {
        type: 'eventRecord',
        id: recordId,
        attributes: {
          laneNumber,
          heatNumber,
          isExhibition,
        },
        relationships: {
          heat: {
            data: { type: 'heat', id: heatId },
          },
          division: { data: null },
        },
      },
    };

    const result = await this.request(`/meets/${this.meetId}/event-records/${recordId}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
    const returnedHeatId = result?.data?.relationships?.heat?.data?.id;
    const returnedHeatNumber = result?.data?.attributes?.heatNumber;
    const returnedLaneNumber = result?.data?.attributes?.laneNumber;

    if (!returnedHeatId || returnedHeatNumber === null || returnedHeatNumber === undefined || returnedLaneNumber === null || returnedLaneNumber === undefined) {
      throw new Error('API response did not include the moved event record heat and lane.');
    }

    if (
      returnedHeatId !== heatId ||
        Number(returnedHeatNumber) !== Number(heatNumber) ||
        Number(returnedLaneNumber) !== Number(laneNumber)
    ) {
      throw new Error(
        `API returned heat ${returnedHeatNumber || '?'} lane ${returnedLaneNumber || '?'}; expected heat ${heatNumber} lane ${laneNumber}`
      );
    }

    return result;
  }

  async createEventRecord({
    recordId,
    sourceRecord,
    eventId,
    heatId,
    laneNumber,
    heatNumber,
    division = null,
  }) {
    const sourceAttrs = sourceRecord.attributes || {};
    const team = sourceRecord.relationships?.team?.data;
    const athlete = sourceRecord.relationships?.athlete?.data;

    this.requireId(recordId, 'new event record id');
    this.requireId(eventId, 'target event id');
    this.requireId(heatId, 'target heat id');
    this.requirePositiveInteger(laneNumber, 'lane number');
    this.requirePositiveInteger(heatNumber, 'heat number');
    if (!team?.id) throw new Error(`Missing team relationship for event record ${sourceRecord.id}`);
    if (!athlete?.id) throw new Error(`Missing athlete relationship for event record ${sourceRecord.id}`);

    const payload = {
      data: {
        type: 'eventRecord',
        id: recordId,
        attributes: {
          teamAbbreviation: sourceAttrs.teamAbbreviation || null,
          laneNumber,
          seedTimeInt: sourceAttrs.seedTimeInt ?? null,
          seedTimeCourseCode: sourceAttrs.seedTimeCourseCode ?? null,
          heatNumber,
          isExhibition: !!sourceAttrs.isExhibition,
        },
        relationships: {
          event: { data: { type: 'event', id: eventId } },
          team: { data: { type: 'team', id: team.id } },
          athlete: { data: { type: 'athlete', id: athlete.id } },
          heat: { data: { type: 'heat', id: heatId } },
          division: { data: division },
        },
      },
    };

    return this.request(`/meets/${this.meetId}/event-records`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  async deleteEventRecord(recordId) {
    this.requireId(recordId, 'event record id');
    return this.request(`/meets/${this.meetId}/event-records/${recordId}`, {
      method: 'DELETE',
    });
  }

  async createHeat(eventId, heatId = this.generateId()) {
    this.requireId(eventId, 'event id');
    this.requireId(heatId, 'heat id');

    const payload = {
      data: {
        type: 'heat',
        id: heatId,
        relationships: {
          event: { data: { type: 'event', id: eventId } },
        },
      },
    };

    return this.request(`/meets/${this.meetId}/heats`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  async createRemoveEmptyHeatsTask(eventId, taskId = this.generateId()) {
    this.requireId(eventId, 'event id');
    this.requireId(taskId, 'remove-empty-heats task id');

    const payload = {
      data: {
        type: 'removeEmptyHeatsTask',
        id: taskId,
        relationships: {
          event: { data: { type: 'event', id: eventId } },
        },
      },
    };

    return this.request(`/meets/${this.meetId}/remove-empty-heats-tasks`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  async getRemoveEmptyHeatsTask(taskId) {
    this.requireId(taskId, 'remove-empty-heats task id');
    return this.request(`/meets/${this.meetId}/remove-empty-heats-tasks/${taskId}`, {
      cache: 'no-store',
      headers: {
        'Cache-Control': 'no-cache',
      },
    });
  }

  async removeEmptyHeats(eventId, { pollIntervalMs = 350, timeoutMs = 10000 } = {}) {
    const taskResp = await this.createRemoveEmptyHeatsTask(eventId);
    const taskId = taskResp?.data?.id;
    if (!taskId) throw new Error('API did not return a remove-empty-heats task id.');

    const startedAt = Date.now();
    let lastState = this.requireTaskState(taskResp, taskId);

    while (Date.now() - startedAt < timeoutMs) {
      if (lastState === 'completed') return taskResp;
      if (['failed', 'errored', 'error'].includes(lastState)) {
        throw new Error(`Remove empty heats task ${taskId} ${lastState}.`);
      }

      await this.sleep(pollIntervalMs);
      const pollResp = await this.getRemoveEmptyHeatsTask(taskId);
      lastState = this.requireTaskState(pollResp, taskId);
      if (lastState === 'completed') return pollResp;
    }

    throw new Error(`Remove empty heats task ${taskId} did not complete within ${timeoutMs}ms.`);
  }

  async moveEventRecordToEvent(sourceRecord, move) {
    const newRecordId = move.recordId || this.generateId();
    await this.deleteEventRecord(sourceRecord.id);
    return this.createEventRecord({
      ...move,
      recordId: newRecordId,
      sourceRecord,
    });
  }

  generateId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      return '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, c =>
        (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)
      );
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  // Batch move multiple swimmers into a different event.
  async batchMove(moves) {
    const results = [];
    for (const move of moves) {
      try {
        const result = await this.moveEventRecordToEvent(move.sourceRecord, move);
        results.push({ success: true, recordId: move.sourceRecord.id, sourceRecord: move.sourceRecord, result });
      } catch (err) {
        results.push({ success: false, recordId: move.sourceRecord?.id, sourceRecord: move.sourceRecord, error: err.message });
        break;
      }
    }
    return results;
  }

  requireTaskState(resp, taskId) {
    const state = resp?.data?.attributes?.currentState;
    if (!state) throw new Error(`Remove empty heats task ${taskId} response did not include currentState.`);
    return state;
  }

  requireId(value, label) {
    if (!value || typeof value !== 'string') throw new Error(`Missing ${label}.`);
  }

  requirePositiveInteger(value, label) {
    const number = Number(value);
    if (!Number.isInteger(number) || number <= 0) throw new Error(`Missing ${label}.`);
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

if (typeof window !== 'undefined') {
  window.SwimTopiaAPI = SwimTopiaAPI;
}
