import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { compileRoute, positionAt } from '../src/navigation.js';
import {
  rejoinTarget,
  stitchRecovery,
  fetchRecovery,
  RecoveryController,
} from '../src/rerouting.js';
const scenic = compileRoute(
  JSON.parse(fs.readFileSync('public/scenic-route.json')),
);
const progress =
  scenic.steps.find((s) => s.name === 'Stanyan Street' && s.type === 'turn')
    .at - 5;
const missed = [-122.4516, 37.77536];
function response(a, b) {
  return {
    code: 'Ok',
    waypoints: [
      { location: a, distance: 0 },
      { location: b, distance: 0 },
    ],
    routes: [
      {
        duration: 80,
        legs: [
          {
            steps: [
              {
                name: 'Connection road',
                maneuver: { type: 'depart', modifier: 'straight' },
                geometry: { coordinates: [a, b] },
              },
              {
                name: 'Connection road',
                maneuver: { type: 'arrive' },
                geometry: { coordinates: [b] },
              },
            ],
          },
        ],
      },
    ],
  };
}
function recoveryRoute() {
  const target = rejoinTarget(scenic, progress);
  return stitchRecovery(
    scenic,
    compileRoute(response(missed, target.point)),
    target,
    progress,
  );
}
test('only the connection changes; scenic suffix geometry and turns stay identical', () => {
  const target = rejoinTarget(scenic, progress),
    next = recoveryRoute();
  const suffixIndex = next.cumulative.findIndex((d) => d === next.rejoinAt);
  assert.deepEqual(
    next.coords.slice(suffixIndex),
    scenic.coords.slice(target.index),
  );
  const oldSteps = scenic.steps.filter((s) => s.at > target.at + 0.01);
  assert.deepEqual(
    next.steps.slice(-oldSteps.length).map((s) => ({ ...s, at: 0 })),
    oldSteps.map((s) => ({ ...s, at: 0 })),
  );
  assert.equal(next.steps.filter((s) => s.type === 'arrive').length, 1);
  assert.equal(next.passes.length, scenic.passes.length);
  assert.equal(next.passes[0], -1);
  for (let i = 1; i < scenic.passes.length; i++)
    assert.deepEqual(
      positionAt(next, next.passes[i]),
      positionAt(scenic, scenic.passes[i]),
    );
});
test('rejoin never jumps past an unvisited scenic point', () => {
  const p = scenic.passes[2] - 40,
    target = rejoinTarget(scenic, p);
  assert.ok(target.at >= p);
  assert.ok(Math.abs(target.at - scenic.passes[2]) < 0.01);
});
test('successive recoveries preserve completed points and the remaining scenic suffix', () => {
  const first = recoveryRoute(),
    p = first.rejoinAt + 600,
    target = rejoinTarget(first, p);
  const second = stitchRecovery(
    first,
    compileRoute(response(missed, target.point)),
    target,
    p,
  );
  assert.equal(second.passes[0], -1);
  const firstUnvisited = first.passes.findIndex((x) => x > p);
  for (let i = firstUnvisited; i < first.passes.length; i++)
    assert.deepEqual(
      positionAt(second, second.passes[i]),
      positionAt(first, first.passes[i]),
    );
  assert.deepEqual(second.coords.at(-1), scenic.coords.at(-1));
});
test('routing request contains only current location and rejoin, with heading constraints', async () => {
  let url;
  const next = await fetchRecovery(
    scenic,
    progress,
    { point: missed, heading: 90, speed: 8 },
    {
      fetcher: async (input) => {
        url = new URL(input);
        return {
          ok: true,
          json: async () =>
            response(missed, rejoinTarget(scenic, progress).point),
        };
      },
    },
  );
  assert.equal(url.pathname.split('/').at(-1).split(';').length, 2);
  assert.match(url.searchParams.get('bearings'), /^90,60;/);
  assert.equal(next.passes.length, 7);
});
test('unconnected routing responses do not invent a straight-line shortcut', () => {
  assert.throws(
    () =>
      stitchRecovery(
        scenic,
        compileRoute(response(missed, [-122.49, 37.78])),
        rejoinTarget(scenic, progress),
        progress,
      ),
    /Could not connect/,
  );
});
const flush = () => new Promise((resolve) => setImmediate(resolve));
function harness(request) {
  let clock = Date.now(),
    calls = 0;
  const routes = [],
    errors = [],
    statuses = [];
  const controller = new RecoveryController({
    getRoute: () => scenic,
    getNavigation: () => ({ progress }),
    now: () => clock,
    onStatus: (s) => statuses.push(s),
    onRoute: (r, n) => routes.push({ r, n }),
    onError: (e) => errors.push(e),
    request: async (...args) => {
      calls++;
      return request ? request(...args) : recoveryRoute();
    },
  });
  const observe = (delta, status = 'offroute', options = {}) => {
    clock += delta;
    controller.observe(
      { point: missed, accuracy: 5, timestamp: clock, ...options },
      status,
    );
  };
  return {
    controller,
    observe,
    routes,
    errors,
    statuses,
    get calls() {
      return calls;
    },
  };
}
test('GPS noise is ignored; three accurate readings over four seconds trigger one reroute', async () => {
  const h = harness();
  h.observe(0);
  h.observe(1000);
  assert.equal(h.calls, 0);
  h.observe(1000, 'weak', { accuracy: 80 });
  h.observe(1000);
  h.observe(2100);
  assert.equal(h.calls, 0);
  h.observe(2100);
  await flush();
  assert.equal(h.calls, 1);
  assert.equal(h.routes.length, 1);
  assert.equal(h.routes[0].n.status, 'tracking');
  h.controller.reset();
});
test('ending a ride invalidates a late response even if the provider ignores abort', async () => {
  let resolve;
  const h = harness(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  h.observe(0);
  h.observe(2000);
  h.observe(2000);
  h.controller.reset();
  resolve(recoveryRoute());
  await flush();
  assert.equal(h.routes.length, 0);
});
test('rejoining the old route cancels a pending reroute', async () => {
  let resolve;
  const h = harness(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  h.observe(0);
  h.observe(2000);
  h.observe(2000);
  h.observe(1000, 'tracking');
  resolve(recoveryRoute());
  await flush();
  assert.equal(h.routes.length, 0);
});
test('failed requests keep the route and retry without rapid repeated requests', async () => {
  const h = harness(async () => {
    throw new Error('Offline');
  });
  h.observe(0);
  h.observe(2000);
  h.observe(2000);
  await flush();
  assert.equal(h.errors.length, 1);
  assert.equal(h.routes.length, 0);
  h.observe(1000);
  h.observe(3000);
  assert.equal(h.calls, 1);
  h.observe(12000);
  await flush();
  assert.equal(h.calls, 2);
  h.controller.reset();
});
test('a response for a location more than 100m behind the rider is discarded', async () => {
  let resolve;
  const h = harness(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  h.observe(0);
  h.observe(2000);
  h.observe(2000);
  h.observe(1000, 'offroute', { point: [-122.448, 37.77536] });
  resolve(recoveryRoute());
  await flush();
  assert.equal(h.routes.length, 0);
  assert.equal(h.statuses.at(-1), 'offroute');
  h.controller.reset();
});
