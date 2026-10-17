const R = 6371000;
const rad = Math.PI / 180;
export const meters = (a, b) => {
  const dlat = (b[1] - a[1]) * rad,
    dlon = (b[0] - a[0]) * rad;
  const h =
    Math.sin(dlat / 2) ** 2 +
    Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dlon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
};
export function compileRoute(response) {
  const route = response.routes?.[0];
  if (response.code !== 'Ok' || !route?.legs?.length)
    throw new Error('No drivable route found. Try a point on a nearby road.');
  const coords = [],
    cumulative = [],
    steps = [],
    passes = [];
  let total = 0;
  route.legs.forEach((leg, li) => {
    leg.steps.forEach((step, si) => {
      const c = step.geometry.coordinates;
      if (!c.length) return;
      if (!coords.length) {
        coords.push(c[0]);
        cumulative.push(0);
      } else if (meters(coords.at(-1), c[0]) > 0.1) {
        total += meters(coords.at(-1), c[0]);
        coords.push(c[0]);
        cumulative.push(total);
      }
      const type = step.maneuver.type;
      if (
        (type !== 'arrive' || li === route.legs.length - 1) &&
        (type !== 'depart' || li === 0)
      ) {
        const last = steps.at(-1);
        if (!(
          type === 'fork' &&
          step.name === last?.name &&
          ['straight', 'slight left', 'slight right'].includes(
            step.maneuver.modifier,
          )
        ))
          steps.push({
            at: total,
            name: step.name || step.ref || 'the road',
            type,
            modifier: step.maneuver.modifier || 'straight',
            exit: step.maneuver.exit,
            bearing: step.maneuver.bearing_after,
            location: c[0],
          });
      }
      for (let i = 1; i < c.length; i++) {
        const d = meters(coords.at(-1), c[i]);
        if (d > 0.01) {
          total += d;
          coords.push(c[i]);
          cumulative.push(total);
        }
      }
    });
    if (li < route.legs.length - 1) passes.push(total);
  });
  return { coords, cumulative, steps, passes, total, seconds: route.duration };
}
export function projectPosition(
  route,
  point,
  { min = 0, max = Infinity } = {},
) {
  let best = null;
  const scaleX = R * rad * Math.cos(point[1] * rad),
    scaleY = R * rad;
  for (let i = 0; i < route.coords.length - 1; i++) {
    if (route.cumulative[i + 1] < min || route.cumulative[i] > max) continue;
    const a = route.coords[i],
      b = route.coords[i + 1];
    const ax = (a[0] - point[0]) * scaleX,
      ay = (a[1] - point[1]) * scaleY;
    const dx = (b[0] - a[0]) * scaleX,
      dy = (b[1] - a[1]) * scaleY;
    const t = Math.max(
      0,
      Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy || 1)),
    );
    const distance = Math.hypot(ax + dx * t, ay + dy * t),
      along =
        route.cumulative[i] +
        t * (route.cumulative[i + 1] - route.cumulative[i]);
    if (along < min || along > max) continue;
    if (!best || distance < best.distance)
      best = {
        distance,
        along,
        point: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t],
        index: i,
      };
  }
  return best;
}
export function advance(route, state, fix) {
  if (!Number.isFinite(fix.accuracy) || fix.accuracy > 40)
    return { ...state, status: 'weak', accuracy: fix.accuracy };
  if (!Number.isFinite(fix.timestamp) || Date.now() - fix.timestamp > 15000)
    return { ...state, status: 'stale' };
  const elapsed = state.timestamp
    ? Math.max(0, (fix.timestamp - state.timestamp) / 1000)
    : 0;
  if (state.timestamp && fix.timestamp <= state.timestamp) return state;
  const max = state.locked
    ? state.progress + Math.max(160, Math.min(1500, elapsed * 40 + 80))
    : Infinity;
  const p = projectPosition(route, fix.point, {
    min: state.locked ? Math.max(0, state.progress - 45) : 0,
    max,
  });
  if (!p || p.distance > 50)
    return { ...state, status: 'offroute', accuracy: fix.accuracy };
  const progress = Math.max(state.progress || 0, p.along);
  const arrived =
    route.total - progress < 22 && meters(fix.point, route.coords.at(-1)) < 30;
  return {
    progress,
    status: arrived ? 'arrived' : 'tracking',
    locked: true,
    timestamp: fix.timestamp,
    accuracy: fix.accuracy,
    point: p.point,
  };
}
export function positionAt(route, along) {
  let i = route.cumulative.findIndex((d) => d >= along);
  if (i < 0) return route.coords.at(-1);
  if (i === 0) return route.coords[0];
  const a = route.coords[i - 1],
    b = route.coords[i],
    t =
      (along - route.cumulative[i - 1]) /
      (route.cumulative[i] - route.cumulative[i - 1]);
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}
export function nextStep(route, progress) {
  return (
    route.steps.find((s) => s.type !== 'depart' && s.at >= progress - 12) ||
    route.steps.at(-1)
  );
}
export function instruction(step) {
  if (!step) return 'Follow the highlighted route';
  if (step.type === 'arrive') return 'Arrive near your destination';
  if (step.type === 'depart') return `Head onto ${step.name}`;
  if (step.type === 'roundabout' || step.type === 'rotary')
    return `Take exit ${step.exit || ''} onto ${step.name}`;
  if (step.modifier === 'uturn') return `Make a U-turn onto ${step.name}`;
  if (step.type === 'new name' || step.modifier === 'straight')
    return `Continue onto ${step.name}`;
  if (step.type === 'fork' || step.type === 'merge')
    return `Keep ${step.modifier.includes('left') ? 'left' : 'right'} onto ${step.name}`;
  return `Turn ${step.modifier} onto ${step.name}`;
}
export const distanceLabel = (m) =>
  m >= 1609
    ? `${(m / 1609.344).toFixed(1)} mi`
    : `${Math.max(0, Math.round((m * 3.28084) / 50) * 50)} ft`;
