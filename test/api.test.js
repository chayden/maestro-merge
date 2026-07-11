const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadAPIClass() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'api.js'), 'utf8');
  const context = vm.createContext({ crypto });
  vm.runInContext(`${source}\nthis.SwimTopiaAPI = SwimTopiaAPI;`, context);
  return context.SwimTopiaAPI;
}

test('heat place batch accepts a successful response with no body', async () => {
  const SwimTopiaAPI = loadAPIClass();
  const api = new SwimTopiaAPI('token', '1', '2');
  api.request = async () => null;

  const results = await api.updateJudgedHeatPlaces([
    { recordId: 'record-1', judgedHeatPlace: 1 },
    { recordId: 'record-2', judgedHeatPlace: 2 },
  ]);

  assert.deepEqual(JSON.parse(JSON.stringify(results)), [
    { success: true, recordId: 'record-1', judgedHeatPlace: 1 },
    { success: true, recordId: 'record-2', judgedHeatPlace: 2 },
  ]);
});

test('heat place batch detects a conflicting place in a structured response', async () => {
  const SwimTopiaAPI = loadAPIClass();
  const api = new SwimTopiaAPI('token', '1', '2');
  api.request = async () => ({
    data: {
      type: 'eventRecordBatch',
      attributes: {
        records: [{
          type: 'eventRecord',
          id: 'record-1',
          attributes: { judgedHeatPlace: 3 },
        }],
      },
    },
  });

  const results = await api.updateJudgedHeatPlaces([
    { recordId: 'record-1', judgedHeatPlace: 1 },
  ]);

  assert.deepEqual(JSON.parse(JSON.stringify(results)), [
    { success: false, recordId: 'record-1', judgedHeatPlace: 3 },
  ]);
});

test('heat place batch treats an explicit null place as a conflicting response', async () => {
  const SwimTopiaAPI = loadAPIClass();
  const api = new SwimTopiaAPI('token', '1', '2');
  api.request = async () => ({
    included: [{
      type: 'eventRecord',
      id: 'record-1',
      attributes: { judgedHeatPlace: null },
    }],
  });

  const results = await api.updateJudgedHeatPlaces([
    { recordId: 'record-1', judgedHeatPlace: 1 },
  ]);

  assert.deepEqual(JSON.parse(JSON.stringify(results)), [
    { success: false, recordId: 'record-1', judgedHeatPlace: null },
  ]);
});
