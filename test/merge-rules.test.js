const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const contentScriptPath = path.join(__dirname, '..', 'content.js');

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function loadMergeTestHarness() {
  const windowStub = {
    __mmMergeHelperTestMode: true,
    location: { href: 'https://maestro.swimtopia.com/meets/1/session/2' },
    addEventListener() {},
  };

  global.window = windowStub;
  global.history = {
    pushState() {},
    replaceState() {},
  };
  global.chrome = {
    runtime: {
      sendMessage: async () => ({}),
      onMessage: { addListener() {} },
    },
  };
  global.localStorage = {
    length: 0,
    key() { return null; },
    getItem() { return null; },
  };
  global.document = {
    createElement() {
      return {
        value: '',
        set textContent(value) { this.value = value; },
        get innerHTML() { return escapeHtml(this.value); },
      };
    },
  };
  global.SwimTopiaAPI = function SwimTopiaAPI() {};

  delete require.cache[require.resolve(contentScriptPath)];
  require(contentScriptPath);

  return windowStub.__mmMergeHelperTestHarness;
}

function meetEvent(id, overrides = {}) {
  const {
    number = id,
    gender = 'M',
    min = 7,
    max = 8,
    stroke = 'FREE',
    distance = 25,
    label = 'Freestyle',
    sessionIndex = Number.parseInt(String(number), 10) || 1,
  } = overrides;

  const attributes = {
    eventNumber: number,
    athleteGender: gender,
    athleteMinAge: min,
    athleteMaxAge: max,
    strokeCode: stroke,
    distance,
    label,
    ageGroupName: min <= 0 ? `${max} & Under` : `${min}-${max}`,
    sessionIndex,
  };

  Object.entries(attributes).forEach(([key, value]) => {
    if (value === undefined) delete attributes[key];
  });

  return { id, attributes };
}

function heat(eventId, number = 1) {
  return {
    id: `${eventId}-heat-${number}`,
    attributes: { number },
    relationships: { event: { data: { id: eventId } } },
  };
}

function record(eventId, index, laneCount, overrides = {}) {
  const {
    gender,
    seedTimeInt = 1000 + index,
    resultTimeInt,
    officialTimeInt,
    judgedHeatPlace,
    heatPlace,
    calculatedHeatPlace,
    ...attributeOverrides
  } = overrides;
  const heatNumber = Math.floor(index / laneCount) + 1;
  const laneNumber = (index % laneCount) + 1;
  const athleteId = gender ? `${eventId}-athlete-${index + 1}` : undefined;
  const attributes = {
    laneNumber,
    seedTimeInt,
    ...attributeOverrides,
  };
  if (resultTimeInt !== undefined) attributes.resultTimeInt = resultTimeInt;
  if (officialTimeInt !== undefined) attributes.officialTimeInt = officialTimeInt;
  if (judgedHeatPlace !== undefined) attributes.judgedHeatPlace = judgedHeatPlace;
  if (heatPlace !== undefined) attributes.heatPlace = heatPlace;
  if (calculatedHeatPlace !== undefined) attributes.calculatedHeatPlace = calculatedHeatPlace;

  return {
    id: `${eventId}-record-${index + 1}`,
    attributes,
    relationships: {
      event: { data: { id: eventId } },
      heat: { data: { id: `${eventId}-heat-${heatNumber}` } },
      ...(athleteId ? { athlete: { data: { id: athleteId } } } : {}),
    },
  };
}

function loadMeet(harness, { events, entries = {}, heatCounts = {}, laneCount = 4 }) {
  const allHeats = [];
  const allRecords = [];

  events.forEach(evt => {
    const entryCount = entries[evt.id] || 0;
    const eventHeatCount = heatCounts[evt.id] ?? (entryCount > 0 ? Math.ceil(entryCount / laneCount) : 0);

    for (let number = 1; number <= eventHeatCount; number++) {
      allHeats.push(heat(evt.id, number));
    }
    for (let index = 0; index < entryCount; index++) {
      allRecords.push(record(evt.id, index, laneCount));
    }
  });

  harness.setData({ events, records: allRecords, heats: allHeats, laneCount });
}

function genderedMeetRecords(eventId, laneCount, genders) {
  const records = genders.map((gender, index) => record(eventId, index, laneCount, { gender }));
  const athletes = genders.map((gender, index) => ({
    id: `${eventId}-athlete-${index + 1}`,
    attributes: { gender },
  }));
  return { records, athletes };
}

function seededGenderedMeetRecords(eventId, laneCount, entries) {
  const records = entries.map((entry, index) => record(eventId, index, laneCount, {
    gender: entry.gender,
    seedTimeInt: entry.seedTimeInt,
    resultTimeInt: entry.resultTimeInt,
    officialTimeInt: entry.officialTimeInt,
    judgedHeatPlace: entry.judgedHeatPlace,
    heatPlace: entry.heatPlace,
    calculatedHeatPlace: entry.calculatedHeatPlace,
    isDq: entry.isDq,
    isExhibition: entry.isExhibition,
    isAlternate: entry.isAlternate,
    isInvalid: entry.isInvalid,
    isNonPlacing: entry.isNonPlacing,
    laneIsNonPlacing: entry.laneIsNonPlacing,
    heatIsNonPlacing: entry.heatIsNonPlacing,
  }));
  const athletes = entries.map((entry, index) => ({
    id: `${eventId}-athlete-${index + 1}`,
    attributes: {
      gender: entry.gender,
      displayFirstName: entry.name || `${entry.gender}${index + 1}`,
    },
  }));
  return { records, athletes };
}

function chunkGenderCounts(chunk, athletes) {
  const gendersByAthleteId = new Map(athletes.map(athlete => [athlete.id, athlete.attributes.gender]));
  return chunk.records.reduce((counts, rec) => {
    const gender = gendersByAthleteId.get(rec.relationships?.athlete?.data?.id) || 'O';
    counts[gender] = (counts[gender] || 0) + 1;
    return counts;
  }, {});
}

function chunkSlowestSeedValue(chunk) {
  return Math.max(...chunk.records.map(rec => {
    const seed = rec.attributes?.seedTimeInt;
    return seed === null || seed === undefined ? Infinity : Number(seed);
  }));
}

function opportunitySourceIds(opportunity) {
  return opportunity.sourceEvents.map(evt => evt.id).sort();
}

function opportunitySourceIdSets(opportunities) {
  return opportunities
    .map(opportunity => opportunitySourceIds(opportunity).join('+'))
    .sort();
}

test('source compatibility spells out every gate before a merge can be considered', () => {
  const harness = loadMergeTestHarness();

  const boysSource = meetEvent('boys-7-8', { number: '1', gender: 'M', min: 7, max: 8 });
  const girlsSource = meetEvent('girls-7-8', { number: '2', gender: 'F', min: 7, max: 8 });
  const boysTarget = meetEvent('boys-target', { number: '1A', gender: 'M', min: 0, max: 10 });
  const mixedTarget = meetEvent('mixed-target', { number: '1B', gender: 'X', min: 0, max: 10 });

  harness.setData({ events: [boysSource, girlsSource, boysTarget, mixedTarget], laneCount: 4 });

  assert.equal(harness.isSourceCompatibleWithTarget(boysSource, boysTarget), true, 'same-gender source inside target age range is compatible');
  assert.equal(harness.isSourceCompatibleWithTarget(girlsSource, boysTarget), false, 'gender-specific targets reject the other gender');
  assert.equal(harness.isSourceCompatibleWithTarget(girlsSource, mixedTarget), true, 'mixed targets accept boys or girls');
  assert.equal(harness.isSourceCompatibleWithTarget(boysTarget, mixedTarget), false, 'letter-suffixed events are targets, not sources');
  assert.equal(harness.isSourceCompatibleWithTarget(boysSource, boysSource), false, 'an event is never compatible with itself');

  const missingStroke = meetEvent('missing-stroke', { stroke: undefined });
  const wrongStroke = meetEvent('wrong-stroke', { stroke: 'BACK' });
  const wrongDistance = meetEvent('wrong-distance', { distance: 50 });
  const targetTooYoung = meetEvent('target-too-young', { number: '1C', min: 8, max: 10 });
  const targetTooOld = meetEvent('target-too-old', { number: '1D', min: 0, max: 7 });

  assert.equal(harness.isSourceCompatibleWithTarget(missingStroke, mixedTarget), false, 'race metadata is required');
  assert.equal(harness.isSourceCompatibleWithTarget(wrongStroke, mixedTarget), false, 'stroke must match');
  assert.equal(harness.isSourceCompatibleWithTarget(wrongDistance, mixedTarget), false, 'distance must match');
  assert.equal(harness.isSourceCompatibleWithTarget(boysSource, targetTooYoung), false, 'target minimum age cannot exclude the source minimum');
  assert.equal(harness.isSourceCompatibleWithTarget(boysSource, targetTooOld), false, 'target maximum age cannot exclude the source maximum');
});

test('six-lane assignments use the Meet Maestro lane preference order', () => {
  const harness = loadMergeTestHarness();

  harness.setData({ laneCount: 6 });

  assert.deepEqual(harness.laneSeedOrder(), [3, 4, 2, 5, 1, 6]);
});

test('heat sizing keeps smaller heats slow and avoids one or two swimmer heats when possible', () => {
  const harness = loadMergeTestHarness();

  assert.deepEqual(harness.heatSizesForEntryCount(8, 6), [3, 5]);
  assert.deepEqual(harness.heatSizesForEntryCount(7, 6), [3, 4]);
  assert.deepEqual(harness.heatSizesForEntryCount(13, 6), [3, 5, 5]);
  assert.deepEqual(harness.heatSizesForEntryCount(12, 6), [6, 6]);
  assert.deepEqual(harness.heatSizesForEntryCount(5, 4), [2, 3], 'a two-swimmer heat remains only when it cannot be avoided with the minimum heat count');
});

test('time organizer heat order can run slow-to-fast or fast-to-slow', () => {
  const harness = loadMergeTestHarness();
  const eventId = 'mixed-target';
  const records = Array.from({ length: 10 }, (_, index) => record(eventId, index, 4));

  harness.setData({ records, laneCount: 4 });

  assert.deepEqual(
    harness.planTimeHeatChunks(records, 4, 'slowest-first').map(chunk => chunk.records.length),
    [3, 3, 4],
  );
  assert.deepEqual(
    harness.planTimeHeatChunks(records, 4, 'fastest-first').map(chunk => chunk.records.length),
    [4, 3, 3],
  );
  assert.deepEqual(
    harness.planTimeHeatChunks(records, 4, 'fastest-first')[0].records.map(rec => rec.id),
    ['mixed-target-record-1', 'mixed-target-record-2', 'mixed-target-record-3', 'mixed-target-record-4'],
  );
});

test('age-group organizer uses the minimum heat count without splitting age groups unnecessarily', () => {
  const harness = loadMergeTestHarness();
  const sixUnder = meetEvent('six-under', { number: '1', gender: 'M', min: 0, max: 6 });
  const sevenEight = meetEvent('seven-eight', { number: '2', gender: 'M', min: 7, max: 8 });
  const records = [
    ...Array.from({ length: 3 }, (_, index) => record(sixUnder.id, index, 4)),
    ...Array.from({ length: 3 }, (_, index) => record(sevenEight.id, index, 4)),
  ];

  harness.setData({ events: [sixUnder, sevenEight], records, laneCount: 4 });

  const chunks = harness.planAgeGroupHeatChunks(records, 4, 'slowest-first');
  assert.deepEqual(chunks.map(chunk => chunk.records.length), [3, 3]);
  assert.deepEqual(
    chunks.map(chunk => [...new Set(chunk.records.map(rec => rec.relationships.event.data.id))]),
    [[sixUnder.id], [sevenEight.id]],
  );
});

test('age-group organizer combines whole age groups when they fit the minimum heat count', () => {
  const harness = loadMergeTestHarness();
  const sixUnder = meetEvent('six-under', { number: '1', gender: 'M', min: 0, max: 6 });
  const sevenEight = meetEvent('seven-eight', { number: '2', gender: 'M', min: 7, max: 8 });
  const nineTen = meetEvent('nine-ten', { number: '3', gender: 'M', min: 9, max: 10 });
  const records = [sixUnder, sevenEight, nineTen].flatMap(evt =>
    Array.from({ length: 2 }, (_, index) => record(evt.id, index, 4))
  );

  harness.setData({ events: [sixUnder, sevenEight, nineTen], records, laneCount: 4 });

  const chunks = harness.planAgeGroupHeatChunks(records, 4, 'slowest-first');
  assert.deepEqual(chunks.map(chunk => chunk.records.length), [2, 4]);
  assert.deepEqual(
    chunks.map(chunk => [...new Set(chunk.records.map(rec => rec.relationships.event.data.id))]),
    [[sixUnder.id], [sevenEight.id, nineTen.id]],
  );
});

test('age-group labels use source event groups and can infer merged target records from athlete age', () => {
  const harness = loadMergeTestHarness();
  const sevenEight = meetEvent('seven-eight', { number: '2', gender: 'M', min: 7, max: 8 });
  const target = meetEvent('mixed-target', { number: '2A', gender: 'X', min: 0, max: 10 });
  const sourceRecord = record(sevenEight.id, 0, 4);
  const targetRecord = record(target.id, 0, 4, { gender: 'M' });
  const athletes = [{
    id: targetRecord.relationships.athlete.data.id,
    attributes: { gender: 'M', age: 7 },
  }];

  harness.setData({ events: [sevenEight, target], records: [sourceRecord, targetRecord], athletes, laneCount: 4 });

  assert.equal(harness.originalAgeGroupTileLabel(sourceRecord, sevenEight.id), '7-8');
  assert.equal(harness.originalAgeGroupTileLabel(targetRecord, target.id), '7-8');
});

test('original age-group cache record keys include the meet id', () => {
  const harness = loadMergeTestHarness();

  assert.equal(harness.originalAgeGroupRecordKey('target-event', 'athlete-1'), '1:target-event:athlete-1');
});

test('lane insertion shifts swimmers toward the side the dragged swimmer came from', () => {
  const harness = loadMergeTestHarness();
  const event = meetEvent('target', { number: '2A', gender: 'X', min: 0, max: 10 });
  const records = Array.from({ length: 4 }, (_, index) => record(event.id, index, 6));

  harness.setData({ events: [event], records, heats: [heat(event.id, 1)], laneCount: 6 });

  const plan = harness.buildLaneInsertAssignments(event.id, records[1], {
    heatId: `${event.id}-heat-1`,
    leftLane: 4,
    rightLane: 5,
  });

  assert.deepEqual(
    plan.assignments.map(({ record: rec, laneNumber }) => [rec.id, laneNumber]),
    [
      [`${event.id}-record-3`, 2],
      [`${event.id}-record-4`, 3],
      [`${event.id}-record-2`, 4],
    ],
  );
});

test('lane insertion shifts right when the dragged swimmer came from the right', () => {
  const harness = loadMergeTestHarness();
  const event = meetEvent('target', { number: '2A', gender: 'X', min: 0, max: 10 });
  const records = Array.from({ length: 6 }, (_, index) => record(event.id, index, 6));

  harness.setData({ events: [event], records, heats: [heat(event.id, 1)], laneCount: 6 });

  const plan = harness.buildLaneInsertAssignments(event.id, records[5], {
    heatId: `${event.id}-heat-1`,
    leftLane: 2,
    rightLane: 3,
  });

  assert.deepEqual(
    plan.assignments.map(({ record: rec, laneNumber }) => [rec.id, laneNumber]),
    [
      [`${event.id}-record-5`, 6],
      [`${event.id}-record-4`, 5],
      [`${event.id}-record-3`, 4],
      [`${event.id}-record-6`, 3],
    ],
  );
});

test('lane insertion from the same lane in another heat picks the side with room', () => {
  const harness = loadMergeTestHarness();
  const event = meetEvent('target', { number: '2A', gender: 'X', min: 0, max: 10 });
  const records = [
    record(event.id, 0, 4),
    record(event.id, 1, 4),
    record(event.id, 2, 4),
    record(event.id, 5, 4),
  ];

  harness.setData({ events: [event], records, heats: [heat(event.id, 1), heat(event.id, 2)], laneCount: 4 });

  const plan = harness.buildLaneInsertAssignments(event.id, records[3], {
    heatId: `${event.id}-heat-1`,
    leftLane: 2,
    rightLane: 3,
  });

  assert.deepEqual(
    plan.assignments.map(({ record: rec, laneNumber }) => [rec.id, laneNumber]),
    [
      [`${event.id}-record-3`, 4],
      [`${event.id}-record-6`, 3],
    ],
  );
});

test('lane insertion direction follows pointer side when both shifts are possible', () => {
  const harness = loadMergeTestHarness();
  const event = meetEvent('target', { number: '2A', gender: 'X', min: 0, max: 10 });
  const records = [
    record(event.id, 1, 6),
    record(event.id, 2, 6),
    record(event.id, 3, 6),
    record(event.id, 7, 6),
  ];
  const boundary = {
    heatId: `${event.id}-heat-1`,
    leftLane: 3,
    rightLane: 4,
    indicatorX: 100,
  };

  harness.setData({ events: [event], records, heats: [heat(event.id, 1), heat(event.id, 2)], laneCount: 6 });

  const leftPlan = harness.chooseLaneInsertPlan(event.id, records[3], boundary, 96);
  const rightPlan = harness.chooseLaneInsertPlan(event.id, records[3], boundary, 104);

  assert.equal(leftPlan.direction, 'left');
  assert.deepEqual(
    leftPlan.assignments.map(({ record: rec, laneNumber }) => [rec.id, laneNumber]),
    [
      [`${event.id}-record-2`, 1],
      [`${event.id}-record-3`, 2],
      [`${event.id}-record-8`, 3],
    ],
  );
  assert.equal(rightPlan.direction, 'right');
  assert.deepEqual(
    rightPlan.assignments.map(({ record: rec, laneNumber }) => [rec.id, laneNumber]),
    [
      [`${event.id}-record-4`, 5],
      [`${event.id}-record-8`, 4],
    ],
  );
});

test('lane insertion supports the left edge of the first lane', () => {
  const harness = loadMergeTestHarness();
  const event = meetEvent('target', { number: '2A', gender: 'X', min: 0, max: 10 });
  const records = [
    record(event.id, 0, 4),
    record(event.id, 1, 4),
    record(event.id, 3, 4),
  ];

  harness.setData({ events: [event], records, heats: [heat(event.id, 1)], laneCount: 4 });

  const plan = harness.buildLaneInsertAssignments(event.id, records[2], {
    heatId: `${event.id}-heat-1`,
    leftLane: 0,
    rightLane: 1,
  });

  assert.equal(plan.direction, 'right');
  assert.deepEqual(
    plan.assignments.map(({ record: rec, laneNumber }) => [rec.id, laneNumber]),
    [
      [`${event.id}-record-2`, 3],
      [`${event.id}-record-1`, 2],
      [`${event.id}-record-4`, 1],
    ],
  );
});

test('lane insertion supports the right edge of the last lane', () => {
  const harness = loadMergeTestHarness();
  const event = meetEvent('target', { number: '2A', gender: 'X', min: 0, max: 10 });
  const records = [
    record(event.id, 0, 4),
    record(event.id, 2, 4),
    record(event.id, 3, 4),
  ];

  harness.setData({ events: [event], records, heats: [heat(event.id, 1)], laneCount: 4 });

  const plan = harness.buildLaneInsertAssignments(event.id, records[0], {
    heatId: `${event.id}-heat-1`,
    leftLane: 4,
    rightLane: 5,
  });

  assert.equal(plan.direction, 'left');
  assert.deepEqual(
    plan.assignments.map(({ record: rec, laneNumber }) => [rec.id, laneNumber]),
    [
      [`${event.id}-record-3`, 2],
      [`${event.id}-record-4`, 3],
      [`${event.id}-record-1`, 4],
    ],
  );
});

test('gender organizer fits 7 boys and 4 girls into two eight-lane heats', () => {
  const harness = loadMergeTestHarness();
  const eventId = 'mixed-target';
  const { records, athletes } = genderedMeetRecords(eventId, 8, [
    'M', 'M', 'M', 'M', 'M', 'M', 'M',
    'F', 'F', 'F', 'F',
  ]);

  harness.setData({ records, athletes, laneCount: 8 });

  const slowFirstChunks = harness.planGenderHeatChunks(records, 8, 'slowest-first');
  assert.deepEqual(slowFirstChunks.map(chunk => chunk.records.length), [6, 5]);
  assert.deepEqual(chunkGenderCounts(slowFirstChunks[0], athletes), { F: 4, M: 2 });
  assert.deepEqual(chunkGenderCounts(slowFirstChunks[1], athletes), { M: 5 });
  assert.deepEqual(
    slowFirstChunks[0].records.filter(rec => rec.id.includes('record-6') || rec.id.includes('record-7')).map(rec => rec.id).sort(),
    ['mixed-target-record-6', 'mixed-target-record-7'],
  );

  const fastFirstChunks = harness.planGenderHeatChunks(records, 8, 'fastest-first');
  assert.deepEqual(fastFirstChunks.map(chunk => chunk.records.length), [5, 6]);
  assert.deepEqual(chunkGenderCounts(fastFirstChunks[0], athletes), { M: 5 });
  assert.deepEqual(chunkGenderCounts(fastFirstChunks[1], athletes), { F: 4, M: 2 });
});

test('gender organizer uses normal time sorting when all swimmers share one gender', () => {
  const harness = loadMergeTestHarness();
  const eventId = 'boys-target';
  const { records, athletes } = genderedMeetRecords(eventId, 4, Array(10).fill('M'));

  harness.setData({ records, athletes, laneCount: 4 });

  const slowFirstChunks = harness.planGenderHeatChunks(records, 4, 'slowest-first');
  assert.deepEqual(slowFirstChunks.map(chunk => chunk.records.length), [3, 3, 4]);
  assert.deepEqual(
    slowFirstChunks[2].records.map(rec => rec.id),
    ['boys-target-record-4', 'boys-target-record-3', 'boys-target-record-2', 'boys-target-record-1'],
  );

  const fastFirstChunks = harness.planGenderHeatChunks(records, 4, 'fastest-first');
  assert.deepEqual(fastFirstChunks.map(chunk => chunk.records.length), [4, 3, 3]);
  assert.deepEqual(
    fastFirstChunks[0].records.map(rec => rec.id),
    ['boys-target-record-1', 'boys-target-record-2', 'boys-target-record-3', 'boys-target-record-4'],
  );
});

test('organizer event navigation follows seeded event order and skips empty events', () => {
  const harness = loadMergeTestHarness();
  const first = meetEvent('event-1', { number: '1' });
  const empty = meetEvent('event-2', { number: '2' });
  const middle = meetEvent('event-3', { number: '3' });
  const last = meetEvent('event-4', { number: '4' });

  loadMeet(harness, {
    events: [last, empty, middle, first],
    entries: {
      [first.id]: 1,
      [middle.id]: 1,
      [last.id]: 1,
    },
    laneCount: 4,
  });

  assert.deepEqual(harness.organizerEventNeighbors(first.id), { previous: null, next: middle });
  assert.deepEqual(harness.organizerEventNeighbors(middle.id), { previous: first, next: last });
  assert.deepEqual(harness.organizerEventNeighbors(last.id), { previous: middle, next: null });
});

test('mixed gender award summaries list boys and girls in populated mixed target heats', () => {
  const harness = loadMergeTestHarness();
  const target = meetEvent('mixed-target', { number: '1A', gender: 'X' });
  const regularMixed = meetEvent('regular-mixed', { number: '2', gender: 'X' });
  const boysTarget = meetEvent('boys-target', { number: '3A', gender: 'M' });
  const targetRecords = seededGenderedMeetRecords(target.id, 4, [
    { gender: 'F', seedTimeInt: 1010, name: 'Alice' },
    { gender: 'M', seedTimeInt: 1020, name: 'Ben' },
    { gender: 'M', seedTimeInt: 1030, name: 'Cam' },
    { gender: 'F', seedTimeInt: 1040, name: 'Dana' },
    { gender: 'M', seedTimeInt: 1050, name: 'Eli' },
    { gender: 'M', seedTimeInt: 1060, name: 'Finn' },
    { gender: 'F', seedTimeInt: 1070, name: 'Gia' },
    { gender: 'F', seedTimeInt: 1080, name: 'Hope' },
  ]);
  const regularRecords = genderedMeetRecords(regularMixed.id, 4, ['F', 'M']);
  const boysRecords = genderedMeetRecords(boysTarget.id, 4, ['M', 'M']);

  harness.setData({
    events: [regularMixed, boysTarget, target],
    records: [...targetRecords.records, ...regularRecords.records, ...boysRecords.records],
    athletes: [...targetRecords.athletes, ...regularRecords.athletes, ...boysRecords.athletes],
    heats: [heat(target.id, 1), heat(target.id, 2), heat(regularMixed.id, 1), heat(boysTarget.id, 1)],
    laneCount: 4,
  });

  const summaries = harness.collectMixedGenderAwardSummaries();
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].eventId, target.id);
  assert.deepEqual(summaries[0].mixedHeats.map(heatSummary => heatSummary.heatNumber), [1, 2]);
  assert.deepEqual(summaries[0].mixedHeats[0].girls.map(swimmer => swimmer.laneNumber), [1, 4]);
  assert.deepEqual(summaries[0].mixedHeats[0].boys.map(swimmer => swimmer.laneNumber), [2, 3]);
  assert.deepEqual(summaries[0].mixedHeats[1].girls.map(swimmer => swimmer.laneNumber), [3, 4]);
  assert.deepEqual(summaries[0].mixedHeats[1].boys.map(swimmer => swimmer.laneNumber), [1, 2]);

  const report = harness.formatMixedGenderAwardReport(summaries);
  assert.match(report, /Mixed Gender Award Heats/);
  assert.match(report, /#1A 7-8 Freestyle/);
  assert.match(report, /  Heat 1\n  Boys\n    L2  Ben  10\.20\n    L3  Cam  10\.30\n  Girls\n    L1  Alice  10\.10\n    L4  Dana  10\.40/);
  assert.match(report, /  Heat 2\n  Boys\n    L1  Eli  10\.50\n    L2  Finn  10\.60\n  Girls\n    L3  Gia  10\.70\n    L4  Hope  10\.80/);
});

test('mixed heat place assignment candidates require result times and missing per-gender places', () => {
  const harness = loadMergeTestHarness();
  const target = meetEvent('mixed-target', { number: '1A', gender: 'X' });
  const mixedRecords = seededGenderedMeetRecords(target.id, 4, [
    { gender: 'F', resultTimeInt: 1000, judgedHeatPlace: 1 },
    { gender: 'M', resultTimeInt: 1100, judgedHeatPlace: 2 },
    { gender: 'F', resultTimeInt: 1200, judgedHeatPlace: 3 },
    { gender: 'M', resultTimeInt: 1300, judgedHeatPlace: 4 },
  ]);

  harness.setData({
    events: [target],
    records: mixedRecords.records,
    athletes: mixedRecords.athletes,
    heats: [heat(target.id, 1)],
    laneCount: 4,
  });

  const candidates = harness.findMixedHeatsNeedingPlaceAssignment();
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].heatId, `${target.id}-heat-1`);
  assert.deepEqual(candidates[0].malePlaces, [2, 4]);
  assert.deepEqual(candidates[0].femalePlaces, [1, 3]);

  const updates = harness.placeUpdatesForMixedHeat(mixedRecords.records)
    .map(update => [update.record.id, update.judgedHeatPlace]);
  assert.deepEqual(updates, [
    [`${target.id}-record-2`, 1],
    [`${target.id}-record-4`, 2],
    [`${target.id}-record-1`, 1],
    [`${target.id}-record-3`, 2],
  ]);
});

test('mixed heat place assignment candidates use effective heatPlace when judgedHeatPlace is empty', () => {
  const harness = loadMergeTestHarness();
  const target = meetEvent('mixed-target', { number: '1A', gender: 'X' });
  const mixedRecords = seededGenderedMeetRecords(target.id, 4, [
    { gender: 'F', resultTimeInt: 1000, heatPlace: 1 },
    { gender: 'F', resultTimeInt: 1100, heatPlace: 2 },
    { gender: 'M', resultTimeInt: 1200, heatPlace: 5 },
    { gender: 'M', resultTimeInt: 1300, heatPlace: 6 },
  ]);

  harness.setData({
    events: [target],
    records: mixedRecords.records,
    athletes: mixedRecords.athletes,
    heats: [heat(target.id, 1)],
    laneCount: 4,
  });

  const candidates = harness.findMixedHeatsNeedingPlaceAssignment();
  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0].malePlaces, [5, 6]);
  assert.deepEqual(candidates[0].femalePlaces, [1, 2]);

  assert.deepEqual(
    harness.placeUpdatesForMixedHeat(mixedRecords.records)
      .map(update => [update.record.id, update.judgedHeatPlace]),
    [
      [`${target.id}-record-3`, 1],
      [`${target.id}-record-4`, 2],
      [`${target.id}-record-1`, 1],
      [`${target.id}-record-2`, 2],
    ],
  );
});

test('mixed heat place assignment preserves ties within each gender', () => {
  const harness = loadMergeTestHarness();
  const target = meetEvent('mixed-target', { number: '1A', gender: 'X' });
  const mixedRecords = seededGenderedMeetRecords(target.id, 6, [
    { gender: 'F', resultTimeInt: 1000, judgedHeatPlace: 1 },
    { gender: 'M', resultTimeInt: 1100, judgedHeatPlace: 2 },
    { gender: 'F', resultTimeInt: 1000, judgedHeatPlace: 3 },
    { gender: 'M', resultTimeInt: 1100, judgedHeatPlace: 4 },
    { gender: 'F', resultTimeInt: 1200, judgedHeatPlace: 5 },
    { gender: 'M', resultTimeInt: 1300, judgedHeatPlace: 6 },
  ]);

  harness.setData({
    events: [target],
    records: mixedRecords.records,
    athletes: mixedRecords.athletes,
    heats: [heat(target.id, 1)],
    laneCount: 6,
  });

  assert.equal(harness.findMixedHeatsNeedingPlaceAssignment().length, 1);
  assert.deepEqual(
    harness.placeUpdatesForMixedHeat(mixedRecords.records)
      .map(update => [update.record.id, update.judgedHeatPlace]),
    [
      [`${target.id}-record-2`, 1],
      [`${target.id}-record-4`, 1],
      [`${target.id}-record-6`, 3],
      [`${target.id}-record-1`, 1],
      [`${target.id}-record-3`, 1],
      [`${target.id}-record-5`, 3],
    ],
  );
});

test('mixed heat place assignment candidates skip already-separated ties', () => {
  const harness = loadMergeTestHarness();
  const target = meetEvent('mixed-target', { number: '1A', gender: 'X' });
  const mixedRecords = seededGenderedMeetRecords(target.id, 6, [
    { gender: 'F', resultTimeInt: 1000, judgedHeatPlace: 1 },
    { gender: 'M', resultTimeInt: 1100, judgedHeatPlace: 1 },
    { gender: 'F', resultTimeInt: 1000, judgedHeatPlace: 1 },
    { gender: 'M', resultTimeInt: 1100, judgedHeatPlace: 1 },
    { gender: 'F', resultTimeInt: 1200, judgedHeatPlace: 3 },
    { gender: 'M', resultTimeInt: 1300, judgedHeatPlace: 3 },
  ]);

  harness.setData({
    events: [target],
    records: mixedRecords.records,
    athletes: mixedRecords.athletes,
    heats: [heat(target.id, 1)],
    laneCount: 6,
  });

  assert.deepEqual(harness.findMixedHeatsNeedingPlaceAssignment(), []);
});

test('mixed heat place assignment candidates skip unscored or already-separated heats', () => {
  const harness = loadMergeTestHarness();
  const unscored = meetEvent('unscored-mixed', { number: '1', gender: 'X' });
  const separated = meetEvent('separated-mixed', { number: '2', gender: 'X' });
  const boysOnly = meetEvent('boys-only', { number: '3', gender: 'M' });
  const unscoredRecords = seededGenderedMeetRecords(unscored.id, 4, [
    { gender: 'F', seedTimeInt: 1000, judgedHeatPlace: 1 },
    { gender: 'M', seedTimeInt: 1100, judgedHeatPlace: 2 },
  ]);
  const separatedRecords = seededGenderedMeetRecords(separated.id, 4, [
    { gender: 'F', resultTimeInt: 1000, judgedHeatPlace: 1 },
    { gender: 'M', resultTimeInt: 1100, judgedHeatPlace: 1 },
    { gender: 'F', resultTimeInt: 1200, judgedHeatPlace: 2 },
    { gender: 'M', resultTimeInt: 1300, judgedHeatPlace: 2 },
  ]);
  const boysRecords = seededGenderedMeetRecords(boysOnly.id, 4, [
    { gender: 'M', resultTimeInt: 1000, judgedHeatPlace: 1 },
    { gender: 'M', resultTimeInt: 1100, judgedHeatPlace: 2 },
  ]);

  harness.setData({
    events: [unscored, separated, boysOnly],
    records: [...unscoredRecords.records, ...separatedRecords.records, ...boysRecords.records],
    athletes: [...unscoredRecords.athletes, ...separatedRecords.athletes, ...boysRecords.athletes],
    heats: [heat(unscored.id, 1), heat(separated.id, 1), heat(boysOnly.id, 1)],
    laneCount: 4,
  });

  assert.deepEqual(harness.findMixedHeatsNeedingPlaceAssignment(), []);
});

test('mixed heat place assignment candidates are evaluated per heat within an event', () => {
  const harness = loadMergeTestHarness();
  const target = meetEvent('mixed-target', { number: '1A', gender: 'X' });
  const targetRecords = seededGenderedMeetRecords(target.id, 4, [
    { gender: 'F', resultTimeInt: 1000, judgedHeatPlace: 1 },
    { gender: 'M', resultTimeInt: 1100, judgedHeatPlace: 2 },
    { gender: 'F', resultTimeInt: 1200, judgedHeatPlace: 3 },
    { gender: 'M', resultTimeInt: 1300, judgedHeatPlace: 4 },
    { gender: 'F', resultTimeInt: 2000, judgedHeatPlace: 1 },
    { gender: 'M', resultTimeInt: 2100, judgedHeatPlace: 1 },
    { gender: 'F', resultTimeInt: 2200, judgedHeatPlace: 2 },
    { gender: 'M', resultTimeInt: 2300, judgedHeatPlace: 2 },
  ]);

  harness.setData({
    events: [target],
    records: targetRecords.records,
    athletes: targetRecords.athletes,
    heats: [heat(target.id, 1), heat(target.id, 2)],
    laneCount: 4,
  });

  const candidates = harness.findMixedHeatsNeedingPlaceAssignment();
  assert.deepEqual(candidates.map(candidate => candidate.heatNumber), [1]);
});

test('mixed heat place assignment ignores records that cannot receive a place', () => {
  const harness = loadMergeTestHarness();
  const target = meetEvent('mixed-target', { number: '1A', gender: 'X' });
  const mixedRecords = seededGenderedMeetRecords(target.id, 6, [
    { gender: 'F', resultTimeInt: 1000, judgedHeatPlace: 1 },
    { gender: 'M', resultTimeInt: 1100, judgedHeatPlace: 2 },
    { gender: 'F', resultTimeInt: 1200, judgedHeatPlace: 3 },
    { gender: 'M', resultTimeInt: 1300, judgedHeatPlace: 4 },
    { gender: 'M', resultTimeInt: 500, judgedHeatPlace: 5, isDq: true },
    { gender: 'F', resultTimeInt: 600, judgedHeatPlace: 6, isExhibition: true },
  ]);

  harness.setData({
    events: [target],
    records: mixedRecords.records,
    athletes: mixedRecords.athletes,
    heats: [heat(target.id, 1)],
    laneCount: 6,
  });

  const candidates = harness.findMixedHeatsNeedingPlaceAssignment();
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].boyCount, 2);
  assert.equal(candidates[0].girlCount, 2);
  assert.deepEqual(
    harness.placeUpdatesForMixedHeat(mixedRecords.records)
      .map(update => [update.record.id, update.judgedHeatPlace]),
    [
      [`${target.id}-record-2`, 1],
      [`${target.id}-record-4`, 2],
      [`${target.id}-record-1`, 1],
      [`${target.id}-record-3`, 2],
    ],
  );
});

test('mixed heat place assignment skips non-placing heats', () => {
  const harness = loadMergeTestHarness();
  const target = meetEvent('mixed-target', { number: '1A', gender: 'X' });
  const mixedRecords = seededGenderedMeetRecords(target.id, 2, [
    { gender: 'F', resultTimeInt: 1000, judgedHeatPlace: 1 },
    { gender: 'M', resultTimeInt: 1100, judgedHeatPlace: 2 },
  ]);
  const nonPlacingHeat = heat(target.id, 1);
  nonPlacingHeat.attributes.isNonPlacing = true;

  harness.setData({
    events: [target],
    records: mixedRecords.records,
    athletes: mixedRecords.athletes,
    heats: [nonPlacingHeat],
    laneCount: 2,
  });

  assert.deepEqual(harness.findMixedHeatsNeedingPlaceAssignment(), []);
});

test('gender organizer preserves fastest donor swimmers together after filling a mixed heat', () => {
  const harness = loadMergeTestHarness();
  const eventId = 'mixed-target';
  const { records, athletes } = genderedMeetRecords(eventId, 8, [
    'M', 'M', 'M', 'M', 'M', 'M', 'M', 'M',
    'M', 'M', 'M', 'M', 'M', 'M',
    'F', 'F', 'F', 'F',
  ]);

  harness.setData({ records, athletes, laneCount: 8 });

  const slowFirstChunks = harness.planGenderHeatChunks(records, 8, 'slowest-first');
  assert.deepEqual(slowFirstChunks.map(chunk => chunk.records.length), [6, 4, 8]);
  assert.deepEqual(chunkGenderCounts(slowFirstChunks[0], athletes), { F: 4, M: 2 });
  assert.deepEqual(chunkGenderCounts(slowFirstChunks[1], athletes), { M: 4 });
  assert.deepEqual(chunkGenderCounts(slowFirstChunks[2], athletes), { M: 8 });
  assert.deepEqual(
    slowFirstChunks[2].records.map(rec => rec.id),
    [
      'mixed-target-record-8',
      'mixed-target-record-7',
      'mixed-target-record-6',
      'mixed-target-record-5',
      'mixed-target-record-4',
      'mixed-target-record-3',
      'mixed-target-record-2',
      'mixed-target-record-1',
    ],
  );

  const fastFirstChunks = harness.planGenderHeatChunks(records, 8, 'fastest-first');
  assert.deepEqual(fastFirstChunks.map(chunk => chunk.records.length), [8, 4, 6]);
  assert.deepEqual(chunkGenderCounts(fastFirstChunks[0], athletes), { M: 8 });
  assert.deepEqual(chunkGenderCounts(fastFirstChunks[2], athletes), { F: 4, M: 2 });
});

test('minimized gender organizer uses zero combined heats when genders already fit separate heats', () => {
  const harness = loadMergeTestHarness();
  const eventId = 'mixed-target';
  const { records, athletes } = genderedMeetRecords(eventId, 6, [
    'M', 'M', 'M', 'M', 'M', 'M',
    'M', 'M', 'M', 'M', 'M', 'M',
    'F', 'F', 'F', 'F', 'F', 'F',
    'F', 'F', 'F', 'F', 'F', 'F',
  ]);

  harness.setData({ records, athletes, laneCount: 6 });

  const chunks = harness.planGenderHeatChunks(records, 6, 'slowest-first', 'minimize');
  assert.deepEqual(chunks.map(chunk => chunk.records.length), [6, 6, 6, 6]);
  assert.deepEqual(
    chunks.map(chunk => Object.keys(chunkGenderCounts(chunk, athletes))),
    [['F'], ['F'], ['M'], ['M']],
  );
});

test('balanced gender organizer uses the first two slow heats as three-and-three mixed heats when possible', () => {
  const harness = loadMergeTestHarness();
  const eventId = 'mixed-target';
  const { records, athletes } = genderedMeetRecords(eventId, 8, [
    'M', 'M', 'M', 'M', 'M', 'M', 'M',
    'M', 'M', 'M', 'M', 'M', 'M', 'M',
    'F', 'F', 'F', 'F', 'F', 'F',
  ]);

  harness.setData({ records, athletes, laneCount: 8 });

  const chunks = harness.planGenderHeatChunks(records, 8, 'slowest-first', 'balanced');
  assert.deepEqual(chunks.map(chunk => chunk.records.length), [6, 6, 8]);
  assert.deepEqual(chunkGenderCounts(chunks[0], athletes), { F: 3, M: 3 });
  assert.deepEqual(chunkGenderCounts(chunks[1], athletes), { F: 3, M: 3 });
  assert.deepEqual(chunkGenderCounts(chunks[2], athletes), { M: 8 });
  assert.deepEqual(
    chunks[0].records.map(rec => rec.id),
    [
      'mixed-target-record-20',
      'mixed-target-record-19',
      'mixed-target-record-18',
      'mixed-target-record-14',
      'mixed-target-record-13',
      'mixed-target-record-12',
    ],
  );
});

test('balanced gender organizer splits limited minority swimmers across both combined heats', () => {
  const harness = loadMergeTestHarness();
  const eventId = 'mixed-target';
  const { records, athletes } = genderedMeetRecords(eventId, 8, [
    'M', 'M', 'M', 'M', 'M', 'M', 'M',
    'F', 'F', 'F', 'F',
  ]);

  harness.setData({ records, athletes, laneCount: 8 });

  const chunks = harness.planGenderHeatChunks(records, 8, 'slowest-first', 'balanced');
  assert.deepEqual(chunks.map(chunk => chunk.records.length), [5, 6]);
  assert.deepEqual(chunkGenderCounts(chunks[0], athletes), { F: 2, M: 3 });
  assert.deepEqual(chunkGenderCounts(chunks[1], athletes), { F: 2, M: 4 });
});

test('balanced gender organizer avoids leaving a one-swimmer single-gender heat when another split fits', () => {
  const harness = loadMergeTestHarness();
  const eventId = 'mixed-target';
  const { records, athletes } = genderedMeetRecords(eventId, 4, [
    'F', 'F', 'F', 'F',
    'M', 'M', 'M', 'M', 'M',
  ]);

  harness.setData({ records, athletes, laneCount: 4 });

  const chunks = harness.planGenderHeatChunks(records, 4, 'slowest-first', 'balanced');
  const counts = chunks.map(chunk => chunkGenderCounts(chunk, athletes));
  assert.equal(chunks.length, 3);
  assert.equal(counts.filter(count => count.F && count.M).length, 2);
  assert.equal(
    counts.some(count => (!count.F && count.M === 1) || (!count.M && count.F === 1)),
    false,
  );
});

test('balanced gender organizer orders heats by the slowest swimmer in each heat', () => {
  const harness = loadMergeTestHarness();
  const eventId = 'mixed-target';
  const { records, athletes } = seededGenderedMeetRecords(eventId, 8, [
    { gender: 'M', seedTimeInt: 1000 },
    { gender: 'M', seedTimeInt: 1100 },
    { gender: 'M', seedTimeInt: 1200 },
    { gender: 'M', seedTimeInt: 1300 },
    { gender: 'M', seedTimeInt: 1400 },
    { gender: 'M', seedTimeInt: 1500 },
    { gender: 'M', seedTimeInt: 1600 },
    { gender: 'M', seedTimeInt: 1700 },
    { gender: 'M', seedTimeInt: 1800 },
    { gender: 'M', seedTimeInt: 1900 },
    { gender: 'M', seedTimeInt: null },
    { gender: 'M', seedTimeInt: null },
    { gender: 'F', seedTimeInt: 1000 },
    { gender: 'F', seedTimeInt: 1100 },
    { gender: 'F', seedTimeInt: 1200 },
    { gender: 'F', seedTimeInt: 1300 },
    { gender: 'F', seedTimeInt: 1400 },
    { gender: 'F', seedTimeInt: 1500 },
  ]);

  harness.setData({ records, athletes, laneCount: 6 });

  const slowFirstValues = harness.planGenderHeatChunks(records, 6, 'slowest-first', 'balanced')
    .map(chunkSlowestSeedValue);
  assert.equal(slowFirstValues[0], Infinity, 'NT heat is ordered as the slowest heat');
  assert.deepEqual(slowFirstValues, slowFirstValues.slice().sort((a, b) => b - a));

  const fastFirstValues = harness.planGenderHeatChunks(records, 6, 'fastest-first', 'balanced')
    .map(chunkSlowestSeedValue);
  assert.deepEqual(fastFirstValues, fastFirstValues.slice().sort((a, b) => a - b));
});

test('gender organizer places fastest boy and girl next to each other in mixed heats', () => {
  const harness = loadMergeTestHarness();
  const eventId = 'mixed-target';
  const { records, athletes } = genderedMeetRecords(eventId, 6, [
    'F', 'F', 'F', 'F', 'M', 'F',
  ]);

  harness.setData({ records, athletes, laneCount: 6 });

  const laneByRecordId = new Map(
    harness.genderChunkLaneAssignments(records, 6)
      .map(({ record, laneNumber }) => [record.id, laneNumber])
  );

  assert.equal(laneByRecordId.get('mixed-target-record-1'), 5, 'fastest girl gets the boundary lane on the girls side');
  assert.equal(laneByRecordId.get('mixed-target-record-5'), 6, 'fastest boy gets the adjacent boundary lane on the boys side');
  assert.equal(laneByRecordId.get('mixed-target-record-2'), 4, 'next girl moves outward on the girls side');
  assert.equal(laneByRecordId.get('mixed-target-record-3'), 3);
  assert.equal(laneByRecordId.get('mixed-target-record-4'), 2);
  assert.equal(laneByRecordId.get('mixed-target-record-6'), 1);
});

test('gender organizer keeps faster girls closer to center than NT girls in a four-girl two-boy mixed heat', () => {
  const harness = loadMergeTestHarness();
  const eventId = 'mixed-target';
  const { records, athletes } = seededGenderedMeetRecords(eventId, 6, [
    { gender: 'F', seedTimeInt: null, name: 'A Nt Girl' },
    { gender: 'F', seedTimeInt: 5000, name: 'B Fifty Girl' },
    { gender: 'F', seedTimeInt: 4900, name: 'C Forty Nine Girl' },
    { gender: 'F', seedTimeInt: null, name: 'D Nt Girl' },
    { gender: 'M', seedTimeInt: null, name: 'E Nt Boy' },
    { gender: 'M', seedTimeInt: null, name: 'F Nt Boy' },
  ]);

  harness.setData({ records, athletes, laneCount: 6 });

  const laneByRecordId = new Map(
    harness.genderChunkLaneAssignments(records, 6)
      .map(({ record, laneNumber }) => [record.id, laneNumber])
  );

  assert.equal(laneByRecordId.get('mixed-target-record-3'), 4, 'fastest girl gets the boundary lane on the girls side');
  assert.equal(laneByRecordId.get('mixed-target-record-5'), 5, 'fastest boy gets the adjacent boundary lane on the boys side');
  assert.equal(laneByRecordId.get('mixed-target-record-2'), 3, 'second-fastest girl is closer to the boundary than NT girls');
  assert.equal(laneByRecordId.get('mixed-target-record-6'), 6, 'second boy stays on the boys side');
  assert.equal(laneByRecordId.get('mixed-target-record-1'), 2);
  assert.equal(laneByRecordId.get('mixed-target-record-4'), 1);
});

test('findOpportunities considers only letter-suffixed targets with at least two non-empty compatible sources', () => {
  const harness = loadMergeTestHarness();
  const boys = meetEvent('boys-7-8', { number: '1', gender: 'M', min: 7, max: 8 });
  const girls = meetEvent('girls-7-8', { number: '2', gender: 'F', min: 7, max: 8 });
  const target = meetEvent('mixed-target', { number: '1A', gender: 'X', min: 0, max: 10 });

  loadMeet(harness, {
    events: [boys, girls, target],
    entries: { [boys.id]: 2, [girls.id]: 2 },
  });

  const [opportunity] = harness.findOpportunities();
  assert.equal(opportunity.targetEvent.id, target.id);
  assert.deepEqual(opportunitySourceIds(opportunity), [boys.id, girls.id].sort());
  assert.equal(opportunity.heatsSaved, 1);

  loadMeet(harness, {
    events: [boys, girls, meetEvent('not-a-target', { number: '3', gender: 'X', min: 0, max: 10 })],
    entries: { [boys.id]: 2, [girls.id]: 2 },
  });

  assert.deepEqual(harness.findOpportunities(), [], 'regular event numbers are never considered as merge targets');

  loadMeet(harness, {
    events: [boys, target],
    entries: { [boys.id]: 5 },
    heatCounts: { [boys.id]: 3 },
  });

  assert.deepEqual(harness.findOpportunities(), [], 'a single source is not offered even when moving it alone would reduce heats');
});

test('missing target suggestions describe the event metadata that would enable a merge', () => {
  const harness = loadMergeTestHarness();
  const boys = meetEvent('boys-7-8', { number: '1', gender: 'M', min: 7, max: 8 });
  const girls = meetEvent('girls-7-8', { number: '2', gender: 'F', min: 7, max: 8 });

  loadMeet(harness, {
    events: [boys, girls],
    entries: { [boys.id]: 2, [girls.id]: 2 },
  });

  assert.deepEqual(harness.findOpportunities(), [], 'no real opportunity exists without a letter-suffixed target');

  const [suggestion] = harness.findSuggestedMergeTargets();
  assert.ok(suggestion, 'a target suggestion should be produced from the current merge rules');
  assert.deepEqual(opportunitySourceIds(suggestion), [boys.id, girls.id].sort());
  assert.equal(suggestion.suggestedTarget.gender, 'X');
  assert.equal(suggestion.suggestedTarget.ageMin, 7);
  assert.equal(suggestion.suggestedTarget.ageMax, 8);
  assert.equal(suggestion.suggestedTarget.label, 'Mixed 7-8 25m Freestyle');
  assert.equal(suggestion.heatsSaved, 1);
  assert.equal(suggestion.canApply, false);
  assert.equal(harness.ageGroupSpanForSourceEvents(suggestion.sourceEvents), 1);
  assert.equal(harness.filterSuggestedMergeTargetsByAgeGroupLimit([suggestion], 1).length, 1);
});

test('missing target suggestions are suppressed when a compatible merge target already exists', () => {
  const harness = loadMergeTestHarness();
  const boys = meetEvent('boys-7-8', { number: '1', gender: 'M', min: 7, max: 8 });
  const girls = meetEvent('girls-7-8', { number: '2', gender: 'F', min: 7, max: 8 });
  const target = meetEvent('mixed-target', { number: '1A', gender: 'X', min: 7, max: 8 });

  loadMeet(harness, {
    events: [boys, girls, target],
    entries: { [boys.id]: 2, [girls.id]: 2 },
  });

  assert.equal(harness.findOpportunities().length, 1);
  assert.deepEqual(harness.findSuggestedMergeTargets(), []);
});

test('missing target suggestions are not suppressed by a broader compatible merge target', () => {
  const harness = loadMergeTestHarness();
  const boys = meetEvent('boys-7-8', { number: '1', gender: 'M', min: 7, max: 8 });
  const girls = meetEvent('girls-7-8', { number: '2', gender: 'F', min: 7, max: 8 });
  const broadTarget = meetEvent('mixed-10u-target', { number: '1A', gender: 'X', min: 0, max: 10 });

  loadMeet(harness, {
    events: [boys, girls, broadTarget],
    entries: { [boys.id]: 2, [girls.id]: 2 },
  });

  assert.equal(harness.findOpportunities().length, 1);

  const suggestions = harness.findSuggestedMergeTargets();
  assert.equal(suggestions.length, 1);
  assert.deepEqual(opportunitySourceIds(suggestions[0]), [boys.id, girls.id].sort());
  assert.equal(suggestions[0].suggestedTarget.ageMin, 7);
  assert.equal(suggestions[0].suggestedTarget.ageMax, 8);
});

test('missing target suggestions can coexist with real merge opportunities for other sources', () => {
  const harness = loadMergeTestHarness();
  const boysSevenEight = meetEvent('boys-7-8', { number: '1', gender: 'M', min: 7, max: 8 });
  const boysNineTen = meetEvent('boys-9-10', { number: '2', gender: 'M', min: 9, max: 10 });
  const girlsSevenEight = meetEvent('girls-7-8', { number: '3', gender: 'F', min: 7, max: 8 });
  const girlsNineTen = meetEvent('girls-9-10', { number: '4', gender: 'F', min: 9, max: 10 });
  const boysTarget = meetEvent('boys-target', { number: '1A', gender: 'M', min: 7, max: 10 });

  loadMeet(harness, {
    events: [boysSevenEight, boysNineTen, girlsSevenEight, girlsNineTen, boysTarget],
    entries: {
      [boysSevenEight.id]: 2,
      [boysNineTen.id]: 2,
      [girlsSevenEight.id]: 2,
      [girlsNineTen.id]: 2,
    },
  });

  assert.equal(harness.findOpportunities().length, 1);

  const [suggestion] = harness.findSuggestedMergeTargets();
  assert.deepEqual(opportunitySourceIds(suggestion), [
    boysSevenEight.id,
    boysNineTen.id,
    girlsSevenEight.id,
    girlsNineTen.id,
  ].sort());
  assert.equal(suggestion.suggestedTarget.gender, 'X');
  assert.equal(suggestion.suggestedTarget.ageMin, 7);
  assert.equal(suggestion.suggestedTarget.ageMax, 10);
});

test('missing target suggestions use current contiguous age and gender-balance rules', () => {
  const harness = loadMergeTestHarness();
  const boysSevenEight = meetEvent('boys-7-8', { number: '1', gender: 'M', min: 7, max: 8 });
  const girlsSevenEightEmpty = meetEvent('girls-7-8-empty', { number: '2', gender: 'F', min: 7, max: 8 });
  const boysNineTenEmpty = meetEvent('boys-9-10-empty', { number: '3', gender: 'M', min: 9, max: 10 });
  const girlsNineTen = meetEvent('girls-9-10', { number: '4', gender: 'F', min: 9, max: 10 });

  loadMeet(harness, {
    events: [boysSevenEight, girlsSevenEightEmpty, boysNineTenEmpty, girlsNineTen],
    entries: { [boysSevenEight.id]: 2, [girlsNineTen.id]: 2 },
  });

  const [suggestion] = harness.findSuggestedMergeTargets();
  assert.deepEqual(opportunitySourceIds(suggestion), [boysSevenEight.id, girlsNineTen.id].sort());
  assert.equal(suggestion.suggestedTarget.gender, 'X');
  assert.equal(suggestion.suggestedTarget.ageMin, 7);
  assert.equal(suggestion.suggestedTarget.ageMax, 10);
});

test('missing target suggestions can be filtered by source age-group span', () => {
  const harness = loadMergeTestHarness();
  const sixUnder = meetEvent('boys-6u', { number: '1', gender: 'M', min: 0, max: 6 });
  const sevenEightEmpty = meetEvent('boys-7-8-empty', { number: '2', gender: 'M', min: 7, max: 8 });
  const nineTen = meetEvent('boys-9-10', { number: '3', gender: 'M', min: 9, max: 10 });

  loadMeet(harness, {
    events: [sixUnder, sevenEightEmpty, nineTen],
    entries: { [sixUnder.id]: 2, [nineTen.id]: 2 },
  });

  const suggestions = harness.findSuggestedMergeTargets();
  const bridgedSuggestion = suggestions.find(suggestion =>
    opportunitySourceIds(suggestion).join('+') === [sixUnder.id, nineTen.id].sort().join('+')
  );

  assert.ok(bridgedSuggestion);
  assert.equal(harness.ageGroupSpanForSourceEvents(bridgedSuggestion.sourceEvents), 3);
  assert.equal(harness.filterSuggestedMergeTargetsByAgeGroupLimit([bridgedSuggestion], 2).length, 0);
  assert.equal(harness.filterSuggestedMergeTargetsByAgeGroupLimit([bridgedSuggestion], 3).length, 1);
});

test('compatible sources become a merge opportunity only when the merge saves at least one heat', () => {
  const harness = loadMergeTestHarness();
  const boys = meetEvent('boys-7-8', { number: '1', gender: 'M', min: 7, max: 8 });
  const girls = meetEvent('girls-7-8', { number: '2', gender: 'F', min: 7, max: 8 });
  const target = meetEvent('mixed-target', { number: '1A', gender: 'X', min: 0, max: 10 });

  loadMeet(harness, {
    events: [boys, girls, target],
    entries: {
      [boys.id]: 2,
      [girls.id]: 2,
    },
  });

  const [opportunity] = harness.findOpportunities();

  assert.equal(opportunity.targetEvent.id, target.id);
  assert.deepEqual(opportunitySourceIds(opportunity), [boys.id, girls.id].sort());
  assert.equal(opportunity.currentHeats, 2);
  assert.equal(opportunity.combinedHeats, 1);
  assert.equal(opportunity.heatsSaved, 1);

  loadMeet(harness, {
    events: [boys, girls, target],
    entries: {
      [boys.id]: 3,
      [girls.id]: 3,
    },
  });

  assert.deepEqual(harness.findOpportunities(), [], 'compatible sources are ignored when merged entries need the same number of heats');
});

test('age runs must be contiguous, but empty compatible events can bridge the age run', () => {
  const harness = loadMergeTestHarness();
  const sixUnder = meetEvent('boys-6u', { number: '1', gender: 'M', min: 0, max: 6 });
  const sevenEight = meetEvent('boys-7-8-empty', { number: '2', gender: 'M', min: 7, max: 8 });
  const nineTen = meetEvent('boys-9-10', { number: '3', gender: 'M', min: 9, max: 10 });
  const target = meetEvent('boys-target', { number: '1A', gender: 'M', min: 0, max: 10 });

  loadMeet(harness, {
    events: [sixUnder, nineTen, target],
    entries: { [sixUnder.id]: 2, [nineTen.id]: 2 },
  });

  assert.deepEqual(harness.findOpportunities(), [], '6 & under plus 9-10 has an age gap, so it is not considered');

  loadMeet(harness, {
    events: [sixUnder, sevenEight, nineTen, target],
    entries: { [sixUnder.id]: 2, [nineTen.id]: 2 },
  });

  const [opportunity] = harness.findOpportunities();
  assert.deepEqual(opportunitySourceIds(opportunity), [sixUnder.id, nineTen.id].sort());
  assert.equal(opportunity.heatsSaved, 1);
});

test('mixed boys and girls selections must be balanced by age, unless the counterpart event is empty', () => {
  const harness = loadMergeTestHarness();
  const boysSevenEight = meetEvent('boys-7-8', { number: '1', gender: 'M', min: 7, max: 8 });
  const girlsSevenEightEmpty = meetEvent('girls-7-8-empty', { number: '2', gender: 'F', min: 7, max: 8 });
  const boysNineTenEmpty = meetEvent('boys-9-10-empty', { number: '3', gender: 'M', min: 9, max: 10 });
  const girlsNineTen = meetEvent('girls-9-10', { number: '4', gender: 'F', min: 9, max: 10 });
  const target = meetEvent('mixed-target', { number: '1A', gender: 'X', min: 0, max: 10 });

  loadMeet(harness, {
    events: [boysSevenEight, girlsNineTen, target],
    entries: { [boysSevenEight.id]: 2, [girlsNineTen.id]: 2 },
  });

  assert.deepEqual(harness.findOpportunities(), [], 'non-empty boys 7-8 plus girls 9-10 is unbalanced and not considered');

  loadMeet(harness, {
    events: [boysSevenEight, girlsSevenEightEmpty, boysNineTenEmpty, girlsNineTen, target],
    entries: { [boysSevenEight.id]: 2, [girlsNineTen.id]: 2 },
  });

  const [opportunity] = harness.findOpportunities();
  assert.deepEqual(opportunitySourceIds(opportunity), [boysSevenEight.id, girlsNineTen.id].sort());
  assert.equal(opportunity.heatsSaved, 1);
});

test('broader non-improving targets are dropped in favor of the more specific target', () => {
  const harness = loadMergeTestHarness();
  const boys = meetEvent('boys-7-8', { number: '1', gender: 'M', min: 7, max: 8 });
  const girls = meetEvent('girls-7-8', { number: '2', gender: 'F', min: 7, max: 8 });
  const preciseTarget = meetEvent('mixed-10u-target', { number: '1A', gender: 'X', min: 0, max: 10 });
  const broadTarget = meetEvent('mixed-18u-target', { number: '1B', gender: 'X', min: 0, max: 18 });

  loadMeet(harness, {
    events: [boys, girls, preciseTarget, broadTarget],
    entries: { [boys.id]: 2, [girls.id]: 2 },
  });

  assert.deepEqual(harness.findOpportunities().map(opp => opp.targetEvent.id), [preciseTarget.id]);
});

test('gender-specific targets win over mixed targets for the same boys-only sources', () => {
  const harness = loadMergeTestHarness();
  const boysSevenEight = meetEvent('boys-7-8', { number: '1', gender: 'M', min: 7, max: 8 });
  const boysNineTen = meetEvent('boys-9-10', { number: '2', gender: 'M', min: 9, max: 10 });
  const boysTarget = meetEvent('boys-target', { number: '1A', gender: 'M', min: 0, max: 10 });
  const mixedTarget = meetEvent('mixed-target', { number: '1B', gender: 'X', min: 0, max: 10 });

  loadMeet(harness, {
    events: [boysSevenEight, boysNineTen, boysTarget, mixedTarget],
    entries: { [boysSevenEight.id]: 2, [boysNineTen.id]: 2 },
  });

  assert.deepEqual(harness.findOpportunities().map(opp => opp.targetEvent.id), [boysTarget.id]);
});

test('overlapping two-way and three-way runs can all be offered for the same target when each saves heats', () => {
  const harness = loadMergeTestHarness();
  const sixUnder = meetEvent('boys-6u', { number: '1', gender: 'M', min: 0, max: 6 });
  const sevenEight = meetEvent('boys-7-8', { number: '2', gender: 'M', min: 7, max: 8 });
  const nineTen = meetEvent('boys-9-10', { number: '3', gender: 'M', min: 9, max: 10 });
  const target = meetEvent('boys-10u-target', { number: '1A', gender: 'M', min: 0, max: 10 });

  loadMeet(harness, {
    events: [sixUnder, sevenEight, nineTen, target],
    entries: {
      [sixUnder.id]: 2,
      [sevenEight.id]: 2,
      [nineTen.id]: 2,
    },
    heatCounts: {
      [sixUnder.id]: 2,
      [sevenEight.id]: 2,
      [nineTen.id]: 2,
    },
  });

  const opportunities = harness.findOpportunities();

  assert.deepEqual(opportunitySourceIdSets(opportunities), [
    `${sixUnder.id}+${sevenEight.id}`,
    `${sevenEight.id}+${nineTen.id}`,
    `${sixUnder.id}+${sevenEight.id}+${nineTen.id}`,
  ].sort());
  assert.deepEqual(opportunities.map(opp => opp.heatsSaved).sort((a, b) => a - b), [3, 3, 4]);
});

test('a larger run is filtered when a smaller subset saves the same number of heats', () => {
  const harness = loadMergeTestHarness();
  const sixUnder = meetEvent('boys-6u', { number: '1', gender: 'M', min: 0, max: 6 });
  const sevenEight = meetEvent('boys-7-8', { number: '2', gender: 'M', min: 7, max: 8 });
  const nineTen = meetEvent('boys-9-10', { number: '3', gender: 'M', min: 9, max: 10 });
  const target = meetEvent('boys-10u-target', { number: '1A', gender: 'M', min: 0, max: 10 });

  loadMeet(harness, {
    events: [sixUnder, sevenEight, nineTen, target],
    entries: {
      [sixUnder.id]: 2,
      [sevenEight.id]: 2,
      [nineTen.id]: 2,
    },
  });

  const opportunities = harness.findOpportunities();

  assert.deepEqual(opportunitySourceIdSets(opportunities), [
    `${sixUnder.id}+${sevenEight.id}`,
    `${sevenEight.id}+${nineTen.id}`,
  ].sort());
  assert.deepEqual(opportunities.map(opp => opp.heatsSaved), [1, 1]);
});

test('a larger run remains when it saves more heats than every smaller subset', () => {
  const harness = loadMergeTestHarness();
  const sixUnder = meetEvent('boys-6u', { number: '1', gender: 'M', min: 0, max: 6 });
  const sevenEight = meetEvent('boys-7-8', { number: '2', gender: 'M', min: 7, max: 8 });
  const nineTen = meetEvent('boys-9-10', { number: '3', gender: 'M', min: 9, max: 10 });
  const target = meetEvent('boys-10u-target', { number: '1A', gender: 'M', min: 0, max: 10 });

  loadMeet(harness, {
    events: [sixUnder, sevenEight, nineTen, target],
    entries: {
      [sixUnder.id]: 2,
      [sevenEight.id]: 2,
      [nineTen.id]: 2,
    },
    heatCounts: {
      [sixUnder.id]: 2,
      [sevenEight.id]: 2,
      [nineTen.id]: 2,
    },
  });

  const threeWayOpportunity = harness.findOpportunities()
    .find(opp => opportunitySourceIds(opp).length === 3);

  assert.ok(threeWayOpportunity, 'the three-way run should still be offered');
  assert.deepEqual(opportunitySourceIds(threeWayOpportunity), [sixUnder.id, sevenEight.id, nineTen.id].sort());
  assert.equal(threeWayOpportunity.heatsSaved, 4);
});

test('target entries and target heats are included when deciding whether a merge saves heats', () => {
  const harness = loadMergeTestHarness();
  const boys = meetEvent('boys-7-8', { number: '1', gender: 'M', min: 7, max: 8 });
  const girls = meetEvent('girls-7-8', { number: '2', gender: 'F', min: 7, max: 8 });
  const target = meetEvent('mixed-target', { number: '1A', gender: 'X', min: 0, max: 10 });

  loadMeet(harness, {
    events: [boys, girls, target],
    entries: {
      [boys.id]: 2,
      [girls.id]: 2,
      [target.id]: 3,
    },
  });

  const [opportunity] = harness.findOpportunities();

  assert.equal(opportunity.targetSwimmerCount, 3);
  assert.equal(opportunity.currentHeats, 3);
  assert.equal(opportunity.combinedHeats, 2);
  assert.equal(opportunity.heatsSaved, 1);
});
