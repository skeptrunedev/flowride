import { advance, compileRoute, meters, positionAt } from './navigation.js';

function bearing(a, b) {
  const rad = Math.PI / 180,
    dl = (b[0] - a[0]) * rad;
  return (
    ((Math.atan2(
      Math.sin(dl) * Math.cos(b[1] * rad),
      Math.cos(a[1] * rad) * Math.sin(b[1] * rad) -
        Math.sin(a[1] * rad) * Math.cos(b[1] * rad) * Math.cos(dl),
    ) *
      180) /
      Math.PI +
      360) %
    360
  );
}

// Rejoin ahead of the last matched position, never beyond an unvisited scenic point.
// Choose a geometry vertex so the rest of the route can be kept exactly as planned.
export function rejoinTarget(route, progress) {
  const nextPass = route.passes.find((p) => p > progress + 1) ?? route.total;
  const along = Math.min(progress + 150, nextPass, route.total);
  let index = route.cumulative.findIndex((d) => d >= along - 0.01);
  if (index < 0) index = route.coords.length - 1;
  const at = route.cumulative[index],
    point = route.coords[index];
  const ahead = positionAt(route, Math.min(route.total, at + 30));
  const behind = positionAt(route, Math.max(0, at - 30));
  return {
    index,
    at,
    point,
    bearing:
      Math.round(
        bearing(
          meters(point, ahead) > 3 ? point : behind,
          meters(point, ahead) > 3 ? ahead : point,
        ),
      ) % 360,
  };
}

export function stitchRecovery(route, connector, target, progress) {
  const gap = meters(connector.coords.at(-1), target.point);
  if (gap > 20)
    throw new Error('Could not connect to the scenic road. Retrying shortly.');
  const coords = [...connector.coords],
    cumulative = [...connector.cumulative];
  let length = connector.total;
  if (gap > 0.01) {
    coords.push(target.point);
    length += gap;
    cumulative.push(length);
  }
  const rejoinAt = length;
  // Preserve the original suffix, including every turn and unvisited pass-through.
  for (let i = target.index + 1; i < route.coords.length; i++) {
    coords.push(route.coords[i]);
    cumulative.push(rejoinAt + route.cumulative[i] - target.at);
  }
  const total = rejoinAt + route.total - target.at;
  const connectorSteps = connector.steps.filter((s) => s.type !== 'arrive');
  const rejoinStep = {
    at: rejoinAt,
    name: 'the scenic route',
    type: 'new name',
    modifier: 'straight',
    location: target.point,
  };
  const suffix = route.steps
    .filter((s) => s.at > target.at + 0.01)
    .map((s) => ({ ...s, at: rejoinAt + s.at - target.at }));
  const steps = [...connectorSteps, rejoinStep, ...suffix];
  if (!steps.some((s) => s.type === 'arrive'))
    steps.push({
      at: total,
      name: 'your destination',
      type: 'arrive',
      modifier: 'straight',
      location: coords.at(-1),
    });
  return {
    coords,
    cumulative,
    steps,
    total,
    rejoinAt,
    seconds:
      connector.seconds +
      (route.seconds * Math.max(0, route.total - target.at)) / route.total,
    passes: route.passes.map((p) =>
      p <= progress ? -1 : rejoinAt + Math.max(0, p - target.at),
    ),
  };
}

export async function fetchRecovery(
  route,
  progress,
  fix,
  { signal, fetcher = fetch } = {},
) {
  const target = rejoinTarget(route, progress);
  const startBearing =
    Number.isFinite(fix.heading) && fix.speed > 2
      ? `${Math.round(fix.heading) % 360},60`
      : '';
  const query = new URLSearchParams({
    overview: 'full',
    geometries: 'geojson',
    steps: 'true',
    continue_straight: 'true',
    radiuses: '35;20',
    bearings: `${startBearing};${target.bearing},40`,
  });
  const url = `https://router.project-osrm.org/route/v1/driving/${fix.point.join(',')};${target.point.join(',')}?${query}`;
  const response = await fetcher(url, { signal });
  if (!response.ok)
    throw new Error(
      'Rerouting is temporarily unavailable. Retrying automatically.',
    );
  const data = await response.json();
  if (data.code !== 'Ok' || data.waypoints?.length !== 2)
    throw new Error('No connection found yet. Retrying automatically.');
  if (
    data.waypoints.some(
      (p, i) =>
        !Number.isFinite(p.distance) || p.distance > (i === 0 ? 35 : 20),
    )
  )
    throw new Error('Waiting for a clearer road position before rerouting.');
  return stitchRecovery(route, compileRoute(data), target, progress);
}

// Own the asynchronous lifecycle independently of React. A stopped ride, weak GPS,
// or return to the old route invalidates any in-flight network response.
export class RecoveryController {
  constructor({
    getRoute,
    getNavigation,
    onStatus,
    onRoute,
    onError,
    request = fetchRecovery,
    now = Date.now,
  }) {
    Object.assign(this, {
      getRoute,
      getNavigation,
      onStatus,
      onRoute,
      onError,
      request,
      now,
    });
    this.epoch = 0;
    this.lastAttempt = -Infinity;
    this.pending = null;
    this.since = null;
    this.count = 0;
    this.latest = null;
  }
  cancel() {
    this.epoch++;
    this.pending?.controller.abort();
    clearTimeout(this.pending?.timer);
    this.pending = null;
    this.since = null;
    this.count = 0;
    this.latest = null;
  }
  reset() {
    this.cancel();
    this.lastAttempt = -Infinity;
  }
  observe(fix, status) {
    if (
      !Number.isFinite(fix.timestamp) ||
      this.now() - fix.timestamp > 15000 ||
      fix.accuracy > 30 ||
      !Number.isFinite(fix.accuracy) ||
      status !== 'offroute'
    ) {
      this.cancel();
      return;
    }
    if (this.latest && fix.timestamp <= this.latest.timestamp) return;
    this.latest = fix;
    if (this.since === null) this.since = fix.timestamp;
    this.count++;
    if (this.pending) {
      this.onStatus('rerouting');
      return;
    }
    if (
      this.count < 3 ||
      fix.timestamp - this.since < 4000 ||
      this.now() - this.lastAttempt < 15000
    )
      return;
    this.run(fix);
  }
  async run(fix) {
    const route = this.getRoute(),
      progress = this.getNavigation().progress || 0,
      epoch = ++this.epoch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    this.pending = { controller, timer };
    this.lastAttempt = this.now();
    this.onStatus('rerouting');
    try {
      const newRoute = await this.request(route, progress, fix, {
        signal: controller.signal,
      });
      if (epoch !== this.epoch || controller.signal.aborted) return;
      const latest = this.latest;
      // Do not install directions calculated for a location the rider has already left.
      if (
        !latest ||
        this.now() - latest.timestamp > 15000 ||
        meters(fix.point, latest.point) > 100
      ) {
        this.onStatus('offroute');
        return;
      }
      const newNav = advance(newRoute, { progress: 0, locked: false }, latest);
      if (!['tracking', 'arrived'].includes(newNav.status)) {
        this.onStatus('offroute');
        return;
      }
      this.onRoute(newRoute, newNav);
      this.since = null;
      this.count = 0;
    } catch (error) {
      if (epoch !== this.epoch) return;
      this.onStatus('offroute');
      this.onError(
        error.name === 'AbortError'
          ? 'Rerouting timed out. Retrying automatically.'
          : error.message,
      );
    } finally {
      clearTimeout(timer);
      if (epoch === this.epoch) this.pending = null;
    }
  }
}
