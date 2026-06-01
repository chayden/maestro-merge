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

function record(eventId, index, laneCount) {
  const heatNumber = Math.floor(index / laneCount) + 1;
  const laneNumber = (index % laneCount) + 1;
  return {
    id: `${eventId}-record-${index + 1}`,
    attributes: {
      laneNumber,
      seedTimeInt: 1000 + index,
    },
    relationships: {
      event: { data: { id: eventId } },
      heat: { data: { id: `${eventId}-heat-${heatNumber}` } },
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
