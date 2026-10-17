import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  compileRoute,
  advance,
  positionAt,
  nextStep,
  projectPosition,
} from '../src/navigation.js';
const r = compileRoute(JSON.parse(fs.readFileSync('public/scenic-route.json')));
const stamp = Date.now();
test('intermediate arrivals are silent, final arrival remains', () => {
  assert.equal(r.steps.filter((s) => s.type === 'arrive').length, 1);
  assert.equal(r.steps.filter((s) => s.type === 'depart').length, 1);
  assert.equal(r.passes.length, 7);
  assert.ok(r.total > 13000 && r.total < 16000);
});
test('a complete simulated ride crosses every pass-through without confirmation', () => {
  let state = { progress: 0, locked: false };
  let passed = 0;
  for (let d = 0; d <= r.total; d += 18) {
    state = advance(r, state, {
      point: positionAt(r, d),
      accuracy: 5,
      timestamp: stamp + (d * 1000) / 9,
    });
    assert.notEqual(state.status, 'offroute');
    passed = r.passes.filter((p) => p < state.progress).length;
  }
  state = advance(r, state, {
    point: r.coords.at(-1),
    accuracy: 5,
    timestamp: stamp + ((r.total + 20) * 1000) / 9,
  });
  assert.equal(passed, 7);
  assert.equal(state.status, 'arrived');
});
test('weak GPS, stale fixes and off-route positions cannot advance turns', () => {
  const s = { progress: 500, locked: true, timestamp: stamp };
  assert.equal(
    advance(r, s, {
      point: positionAt(r, 700),
      accuracy: 100,
      timestamp: stamp + 1000,
    }).progress,
    500,
  );
  assert.equal(
    advance(r, s, {
      point: positionAt(r, 700),
      accuracy: 5,
      timestamp: stamp - 30000,
    }).status,
    'stale',
  );
  assert.equal(
    advance(r, s, {
      point: [-122.48, 37.8],
      accuracy: 5,
      timestamp: stamp + 1000,
    }).status,
    'offroute',
  );
  assert.equal(
    advance(r, s, {
      point: r.coords.at(-1),
      accuracy: 5,
      timestamp: stamp + 1000,
    }).progress,
    500,
  );
});
test('joining mid-route skips prior shaping points', () => {
  const state = advance(
    r,
    { progress: 0, locked: false },
    { point: positionAt(r, 8000), accuracy: 6, timestamp: stamp },
  );
  assert.ok(state.progress > 7950);
  assert.ok(nextStep(r, state.progress).at > state.progress);
});
test('projection handles zero progress and respects bounded search', () => {
  assert.ok(projectPosition(r, r.coords[0]).distance < 1);
  assert.equal(
    projectPosition(r, r.coords.at(-1), { max: 100 }).along <= 100,
    true,
  );
});
test('turn instruction remains until the rider has passed the intersection', () => {
  const turn = r.steps.find((s) => s.type === 'turn');
  assert.equal(nextStep(r, turn.at - 3), turn);
  assert.equal(nextStep(r, turn.at + 5), turn);
  assert.notEqual(nextStep(r, turn.at + 15), turn);
});
test('out-of-order GPS updates cannot rewind route progress', () => {
  const state = {
    progress: 500,
    locked: true,
    timestamp: stamp + 1000,
    status: 'tracking',
  };
  assert.equal(
    advance(r, state, {
      point: positionAt(r, 450),
      accuracy: 5,
      timestamp: stamp,
    }),
    state,
  );
});
