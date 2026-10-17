import React, { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import {
  ArrowUp,
  ArrowUpRight,
  ArrowUpLeft,
  ArrowDown,
  ArrowRight,
  ArrowLeft,
  CornerUpLeft,
  CornerUpRight,
  Navigation,
  Volume2,
  VolumeX,
  Sun,
  MapPin,
  Play,
  Pause,
  X,
  Check,
  Route,
  LocateFixed,
  Plus,
  Share2,
  Settings2,
  ChevronDown,
  RotateCcw,
  Flag,
  Compass,
  Expand,
  Download,
  CheckCircle2,
} from 'lucide-react';
import {
  compileRoute,
  advance,
  positionAt,
  nextStep,
  instruction,
  distanceLabel,
  meters,
} from './navigation.js';
import { RecoveryController } from './rerouting.js';
import './style.css';
const DEFAULT_LABELS = [
  '399 Arguello Blvd',
  'Arguello → Fulton',
  'Parnassus Avenue',
  'Laguna Honda',
  'Portola overlook stretch',
  'Upper Market',
  'Franklin Street',
  'Bush Street',
  'Montgomery & Sutter',
];
const DEFAULT_COORDS = [
  [-122.459039, 37.783305],
  [-122.458451, 37.775109],
  [-122.456, 37.76404],
  [-122.461558, 37.751366],
  [-122.444089, 37.74789],
  [-122.435021, 37.762723],
  [-122.422, 37.7803],
  [-122.413473, 37.78957],
  [-122.402306, 37.790461],
];
const defaultPoints = DEFAULT_COORDS.map((coord, i) => ({
  coord,
  name: DEFAULT_LABELS[i],
}));
function validPlan(p) {
  return (
    Array.isArray(p) &&
    p.length >= 2 &&
    p.length <= 20 &&
    p.every(
      (x) =>
        Array.isArray(x.coord) &&
        x.coord.length === 2 &&
        x.coord.every(Number.isFinite) &&
        Math.abs(x.coord[0]) <= 180 &&
        Math.abs(x.coord[1]) <= 85 &&
        typeof x.name === 'string' &&
        x.name.length < 120,
    )
  );
}
function TurnIcon({ step, size = 44 }) {
  let Icon = ArrowUp;
  const m = step?.modifier || '';
  if (step?.type === 'arrive') Icon = Flag;
  else if (m === 'uturn') Icon = RotateCcw;
  else if (m.includes('slight'))
    Icon = m.includes('left') ? ArrowUpLeft : ArrowUpRight;
  else if (m.includes('left')) Icon = CornerUpLeft;
  else if (m.includes('right')) Icon = CornerUpRight;
  return <Icon size={size} strokeWidth={2.6} />;
}
export default function App() {
  const [raw, setRaw] = useState(null),
    [route, setRoute] = useState(null),
    [points, setPoints] = useState(defaultPoints),
    [draft, setDraft] = useState(defaultPoints),
    [dirty, setDirty] = useState(false),
    [editing, setEditing] = useState(false),
    [mapMode, setMapMode] = useState(null),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [toast, setToast] = useState('');
  const [mode, setMode] = useState('plan'),
    [nav, setNav] = useState({ progress: 0, locked: false, status: 'ready' }),
    [voice, setVoice] = useState(true),
    [wake, setWake] = useState(false),
    [follow, setFollow] = useState(true),
    [paused, setPaused] = useState(false),
    [details, setDetails] = useState(false),
    [settings, setSettings] = useState(false),
    [tileError, setTileError] = useState(false);
  const mapEl = useRef(),
    map = useRef(),
    line = useRef(),
    markers = useRef(),
    rider = useRef(),
    track = useRef(),
    watch = useRef(null),
    lock = useRef(null),
    navRef = useRef(nav),
    modeRef = useRef(mode),
    spoken = useRef(new Set()),
    voiceRef = useRef(voice),
    routeRef = useRef(route),
    lastFix = useRef(0),
    mapModeRef = useRef(null),
    toastTimer = useRef(),
    routeAbort = useRef(),
    plannedRoute = useRef(null),
    recovery = useRef(null);
  navRef.current = nav;
  modeRef.current = mode;
  voiceRef.current = voice;
  routeRef.current = route;
  mapModeRef.current = mapMode;
  const notify = (t) => {
    setToast(t);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 5000);
  };
  function speak(text) {
    if (!('speechSynthesis' in window) || !voiceRef.current) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 0.95;
    u.lang = 'en-US';
    window.speechSynthesis.speak(u);
  }
  function accept(data, pts) {
    const compiled = compileRoute(data);
    plannedRoute.current = compiled;
    setRaw(data);
    setRoute(compiled);
    setPoints(pts);
    setDraft(pts);
    setDirty(false);
    setError('');
    setNav({ progress: 0, locked: false, status: 'ready' });
  }
  async function calculate(pts) {
    setBusy(true);
    setError('');
    routeAbort.current?.abort();
    const controller = new AbortController();
    routeAbort.current = controller;
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const url = `https://router.project-osrm.org/route/v1/driving/${pts.map((p) => p.coord.join(',')).join(';')}?overview=full&geometries=geojson&steps=true&continue_straight=true`;
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok)
        throw new Error(
          'Routing service is unavailable. Your previous route is still here.',
        );
      const data = await res.json();
      if (data.waypoints?.some((w, i) => w.distance > 180))
        throw new Error(
          'A point is too far from a drivable road. Move it closer and try again.',
        );
      accept(data, pts);
      try {
        localStorage.setItem(
          'flow-plan',
          JSON.stringify({ points: pts, raw: data }),
        );
      } catch {}
      setEditing(false);
      setMapMode(null);
      notify('Route ready. All middle points are pass-throughs.');
    } catch (e) {
      setError(
        e.name === 'AbortError'
          ? 'Routing timed out. Try again when connected.'
          : e.message,
      );
    } finally {
      clearTimeout(timeout);
      setBusy(false);
    }
  }
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        let shared = null;
        try {
          if (location.hash.startsWith('#route='))
            shared = JSON.parse(decodeURIComponent(location.hash.slice(7)));
        } catch {}
        const data = await fetch('/scenic-route.json').then((r) => {
          if (!r.ok)
            throw new Error('Could not load the ride. Reload to try again.');
          return r.json();
        });
        if (!active) return;
        accept(data, defaultPoints);
        let saved;
        try {
          saved = JSON.parse(localStorage.getItem('flow-plan'));
        } catch {}
        if (validPlan(shared)) {
          setDraft(shared);
          setDirty(true);
          setEditing(true);
          notify('Shared route loaded. Tap Build route to calculate it.');
        } else if (saved && validPlan(saved.points) && saved.raw) {
          try {
            accept(saved.raw, saved.points);
          } catch {}
        }
      } catch (e) {
        if (active) setError(e.message);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (!mapEl.current || map.current) return;
    const m = L.map(mapEl.current, {
      zoomControl: false,
      attributionControl: true,
    }).setView([37.768, -122.438], 13);
    map.current = m;
    const tiles = L.tileLayer(
      'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      {
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        maxZoom: 19,
      },
    ).addTo(m);
    let failures = 0;
    tiles.on('tileerror', () => {
      if (++failures > 5) setTileError(true);
    });
    tiles.on('tileload', () => {
      setTileError(false);
    });
    markers.current = L.layerGroup().addTo(m);
    line.current = L.polyline([], {
      color: '#fff',
      weight: 10,
      opacity: 0.9,
      lineCap: 'round',
    }).addTo(m);
    track.current = L.polyline([], {
      color: '#db683d',
      weight: 5,
      opacity: 1,
      lineCap: 'round',
    }).addTo(m);
    m.on('dragstart', () => setFollow(false));
    m.on('click', (e) => {
      const action = mapModeRef.current;
      if (!action || modeRef.current !== 'plan') return;
      const coord = [e.latlng.lng, e.latlng.lat];
      setDraft((old) => {
        if (action === 'start')
          return [{ coord, name: 'Custom start' }, ...old.slice(1)];
        if (action === 'finish')
          return [...old.slice(0, -1), { coord, name: 'Custom finish' }];
        if (old.length >= 20) {
          notify('Maximum 18 pass-through points per route.');
          return old;
        }
        return [
          ...old.slice(0, -1),
          { coord, name: `Pass-through ${old.length - 1}` },
          old.at(-1),
        ];
      });
      setDirty(true);
      setMapMode(null);
      notify('Point added. Build route to use it.');
    });
    const resize = new ResizeObserver(() => m.invalidateSize());
    resize.observe(mapEl.current);
    return () => {
      resize.disconnect();
      m.remove();
      map.current = null;
    };
  }, []);
  useEffect(() => {
    if (!route || !map.current) return;
    const ll = route.coords.map((c) => [c[1], c[0]]);
    line.current.setLatLngs(ll);
    track.current.setLatLngs(ll);
    if (modeRef.current === 'plan')
      map.current.fitBounds(track.current.getBounds(), {
        padding: [45, 65],
        maxZoom: 15,
      });
  }, [route]);
  useEffect(() => {
    if (!map.current || !markers.current) return;
    markers.current.clearLayers();
    const list = editing ? draft : points;
    list.forEach((p, i) => {
      const endpoint = i === 0 || i === list.length - 1,
        passed =
          mode !== 'plan' &&
          i > 0 &&
          i < list.length - 1 &&
          route?.passes[i - 1] < nav.progress;
      const html = endpoint ? (i === 0 ? 'A' : 'B') : passed ? '✓' : String(i);
      L.marker([p.coord[1], p.coord[0]], {
        icon: L.divIcon({
          className: `route-marker ${endpoint ? 'endpoint' : ''} ${passed ? 'passed' : ''}`,
          html,
          iconSize: endpoint ? [30, 30] : [23, 23],
          iconAnchor: endpoint ? [15, 15] : [11.5, 11.5],
        }),
      })
        .bindTooltip(p.name, { direction: 'top' })
        .addTo(markers.current);
    });
  }, [points, draft, editing, route, nav.progress, mode]);
  useEffect(() => {
    if (!map.current) return;
    if (nav.point && mode !== 'plan') {
      const ll = [nav.point[1], nav.point[0]];
      if (!rider.current)
        rider.current = L.marker(ll, {
          zIndexOffset: 1000,
          icon: L.divIcon({
            className: 'rider',
            html: '<span></span>',
            iconSize: [30, 30],
            iconAnchor: [15, 15],
          }),
        }).addTo(map.current);
      else rider.current.setLatLng(ll);
      if (follow) map.current.setView(ll, 16, { animate: false });
    } else if (rider.current) {
      rider.current.remove();
      rider.current = null;
    }
  }, [nav.point, mode, follow]);
  async function wakeScreen() {
    if (!('wakeLock' in navigator)) {
      setWake(false);
      return;
    }
    try {
      lock.current = await navigator.wakeLock.request('screen');
      setWake(true);
      lock.current.addEventListener('release', () => setWake(false));
    } catch {
      setWake(false);
    }
  }
  function stop() {
    recovery.current?.reset();
    if (plannedRoute.current) {
      routeRef.current = plannedRoute.current;
      setRoute(plannedRoute.current);
    }
    if (watch.current !== null) {
      navigator.geolocation.clearWatch(watch.current);
      watch.current = null;
    }
    lock.current?.release().catch(() => {});
    window.speechSynthesis?.cancel();
    modeRef.current = 'plan';
    setMode('plan');
    setNav({ progress: 0, locked: false, status: 'ready' });
    setPaused(false);
    spoken.current.clear();
    if (route && map.current)
      map.current.fitBounds(track.current.getBounds(), { padding: [40, 60] });
  }
  function start(kind) {
    recovery.current?.reset();
    setError('');
    setSettings(false);
    setDetails(false);
    setEditing(false);
    setMapMode(null);
    setFollow(true);
    setPaused(false);
    spoken.current.clear();
    const initial = {
      progress: 0,
      locked: false,
      status: kind === 'live' ? 'locating' : 'tracking',
    };
    navRef.current = initial;
    setNav(initial);
    modeRef.current = kind;
    setMode(kind);
    wakeScreen();
    if (kind === 'demo') {
      notify('Demo ride — simulated location, not your GPS.');
      return;
    }
    if (!navigator.geolocation) {
      setError(
        'Location is unavailable in this browser. Open this page directly in Chrome or Safari.',
      );
      modeRef.current = 'plan';
      setMode('plan');
      lock.current?.release();
      return;
    }
    lastFix.current = Date.now();
    speak('Flow Ride started. Waiting for your location.');
    watch.current = navigator.geolocation.watchPosition(
      (pos) => {
        lastFix.current = Date.now();
        handleFix({
          point: [pos.coords.longitude, pos.coords.latitude],
          accuracy: pos.coords.accuracy,
          timestamp: pos.timestamp,
          heading: pos.coords.heading,
          speed: pos.coords.speed,
        });
      },
      (err) => {
        recovery.current?.cancel();
        setNav((s) => ({ ...s, status: err.code === 1 ? 'denied' : 'stale' }));
        setError(
          err.code === 1
            ? 'Location access is off. Allow location for this site in your browser settings, then end and restart the ride.'
            : err.code === 2
              ? 'GPS is unavailable. Waiting for a location fix.'
              : 'GPS is taking longer than expected. Keep this screen open.',
        );
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 12000 },
    );
  }
  function setNavigation(value) {
    navRef.current = value;
    setNav(value);
  }
  if (!recovery.current)
    recovery.current = new RecoveryController({
      getRoute: () => routeRef.current,
      getNavigation: () => navRef.current,
      onStatus: (status) => {
        if (modeRef.current !== 'plan')
          setNavigation({ ...navRef.current, status });
      },
      onRoute: (newRoute, newNav) => {
        if (modeRef.current === 'plan') return;
        routeRef.current = newRoute;
        setRoute(newRoute);
        setNavigation(newNav);
        spoken.current.clear();
        setError('');
        notify('Route updated. Your remaining scenic roads are preserved.');
        if (modeRef.current === 'live')
          speak('Route updated. Rejoining your scenic ride.');
      },
      onError: (message) => {
        if (modeRef.current !== 'plan') setError(message);
      },
    });
  function handleFix(fix) {
    if (modeRef.current === 'plan') return;
    const r = routeRef.current,
      updated = advance(r, navRef.current, fix);
    if (updated.status === 'offroute') updated.point = fix.point;
    setNavigation(updated);
    recovery.current.observe(fix, updated.status);
    if (updated.status !== 'tracking') window.speechSynthesis?.cancel();
    if (updated.status === 'tracking') {
      setError('');
      const step = nextStep(r, updated.progress),
        d = step.at - updated.progress;
      const phase = d < 45 ? 'now' : d < 230 ? 'soon' : null;
      if (phase && modeRef.current === 'live') {
        const key = `${step.at}-${phase}`;
        if (!spoken.current.has(key)) {
          spoken.current.add(key);
          speak(
            `${phase === 'now' ? '' : `In ${distanceLabel(d)}, `}${instruction(step)}`,
          );
        }
      }
    }
    if (updated.status === 'arrived' && !spoken.current.has('arrived')) {
      spoken.current.add('arrived');
      if (modeRef.current === 'live')
        speak('You have arrived. Find legal parking nearby.');
    }
  }
  // A visible demo control exercises the same off-route detector and routing request
  // with a simulated missed turn on Fulton, without requesting real location access.
  async function demoMissedTurn() {
    if (!plannedRoute.current || modeRef.current !== 'demo') return;
    recovery.current.reset();
    setPaused(true);
    setError('');
    const base = plannedRoute.current;
    const turn = base.steps.find(
      (s) => s.type === 'turn' && s.name === 'Stanyan Street',
    );
    if (!turn) return;
    routeRef.current = base;
    setRoute(base);
    setNavigation({
      progress: turn.at - 5,
      locked: true,
      status: 'tracking',
      timestamp: Date.now() - 1000,
    });
    const id = recovery.current.epoch;
    for (let i = 0; i < 3; i++) {
      if (i) await new Promise((resolve) => setTimeout(resolve, 2100));
      if (modeRef.current !== 'demo' || recovery.current.epoch !== id) return;
      handleFix({
        point: [-122.4516, 37.77536],
        accuracy: 5,
        timestamp: Date.now(),
        heading: 90,
        speed: 5,
      });
    }
  }
  useEffect(() => {
    if (mode !== 'demo' || paused || !route) return;
    let current = navRef.current.progress;
    const timer = setInterval(() => {
      current = Math.min(route.total, current + 55);
      const n = {
        progress: current,
        point: positionAt(route, current),
        accuracy: 5,
        locked: true,
        status: current >= route.total ? 'arrived' : 'tracking',
      };
      navRef.current = n;
      setNav(n);
      if (current >= route.total) clearInterval(timer);
    }, 300);
    return () => clearInterval(timer);
  }, [mode, paused, route]);
  useEffect(() => {
    const timer = setInterval(() => {
      if (modeRef.current === 'live' && Date.now() - lastFix.current > 15000) {
        recovery.current?.cancel();
        setNav((s) => (s.status === 'denied' ? s : { ...s, status: 'stale' }));
      }
    }, 3000);
    const vis = () => {
      if (
        document.visibilityState === 'visible' &&
        modeRef.current !== 'plan'
      ) {
        wakeScreen();
        if (modeRef.current === 'live') {
          recovery.current?.cancel();
          setNav((s) => ({ ...s, status: 'stale' }));
          window.speechSynthesis?.cancel();
        }
      }
    };
    document.addEventListener('visibilitychange', vis);
    return () => {
      recovery.current?.cancel();
      clearInterval(timer);
      document.removeEventListener('visibilitychange', vis);
      if (watch.current !== null)
        navigator.geolocation.clearWatch(watch.current);
      lock.current?.release();
    };
  }, []);
  const isScenic = JSON.stringify(points) === JSON.stringify(defaultPoints);
  const active = mode !== 'plan',
    progress = nav.progress || 0,
    remaining = route ? Math.max(0, route.total - progress) : 0,
    step = route ? nextStep(route, progress) : null,
    passed = route ? route.passes.filter((p) => p <= progress).length : 0,
    allPassed = points.length - 2;
  const gpsTitles = {
    locating: 'Finding your location',
    weak: 'Waiting for better GPS',
    stale: 'GPS signal paused',
    offroute: 'Reconnecting your ride',
    rerouting: 'Finding a way back',
    denied: 'Location access needed',
    arrived: 'You’ve arrived',
  };
  const gpsHints = {
    locating: 'Keep this screen open. Guidance starts on the route.',
    weak: 'Turn progress is paused until accuracy improves.',
    stale: 'Keep the app visible. Waiting for a fresh position.',
    offroute: 'Checking your position. We’ll keep the remaining scenic roads.',
    rerouting: 'Calculating a connection to your scenic route…',
    denied: 'Allow location in your browser settings.',
    arrived: 'Find legal parking nearby. Your ride is complete.',
  };
  const bad = active && nav.status !== 'tracking';
  async function share() {
    const url =
      location.origin +
      location.pathname +
      '#route=' +
      encodeURIComponent(JSON.stringify(points));
    try {
      if (navigator.share)
        await navigator.share({
          title: 'Ride with Flow',
          text: 'A scenic route with automatic pass-through points.',
          url,
        });
      else {
        await navigator.clipboard.writeText(url);
        notify('Route link copied.');
      }
    } catch (e) {
      if (e.name !== 'AbortError')
        notify('Could not share. Try copying the page address.');
    }
  }
  function exportGPX() {
    if (!route) return;
    const xml = `<?xml version="1.0"?><gpx version="1.1" creator="Flow Ride" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>Flow Ride</name><trkseg>${route.coords.map((c) => `<trkpt lat="${c[1]}" lon="${c[0]}"/>`).join('')}</trkseg></trk></gpx>`;
    const url = URL.createObjectURL(
      new Blob([xml], { type: 'application/gpx+xml' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = 'flow-ride.gpx';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  return (
    <div className={`app ${active ? 'riding' : ''}`}>
      <header className="header">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            if (active) stop();
          }}
        >
          <img src="/icon.svg" alt="" />
          <span>
            flow<span className="brand-light">ride</span>
            <small>TAKE THE LONG WAY</small>
          </span>
        </a>
        <div className="header-center">
          <span className="status-dot" /> BUILT FOR THE RIDE
        </div>
        <div className="header-actions">
          <button
            className="icon-btn"
            title="Share route"
            aria-label="Share route"
            onClick={share}
            disabled={!route}
          >
            <Share2 size={19} />
          </button>
          <button
            className="icon-btn"
            title="Settings"
            aria-label="Settings"
            onClick={() => setSettings(!settings)}
          >
            <Settings2 size={19} />
          </button>
        </div>
      </header>
      <main className="layout">
        <aside className="sidebar">
          <div className="eyebrow">
            <span className="tiny-line" /> YOUR NEXT RIDE
          </div>
          <h1>
            {isScenic ? 'Southbound.' : 'Your route.'}
            <br />
            <em>{isScenic ? 'Scenic all the way.' : 'Keep it flowing.'}</em>
          </h1>
          <p className="intro">
            The hills, the views, the road home.
            <br />
            Keep moving. We’ll take care of the points.
          </p>
          <div className="ride-metrics">
            <div>
              <strong>
                {route ? `${Math.ceil((route.seconds * 1.3) / 60)}` : '—'}
                <small> min</small>
              </strong>
              <span>estimated ride</span>
            </div>
            <div>
              <strong>
                {route ? (route.total / 1609.344).toFixed(1) : '—'}
                <small> mi</small>
              </strong>
              <span>the scenic way</span>
            </div>
            <div>
              <strong>
                {allPassed}
                <small> points</small>
              </strong>
              <span>no stops required</span>
            </div>
          </div>
          <div className="route-card">
            <div className="location-row">
              <span className="location-dot start" />
              <div>
                <small>START</small>
                <strong>{points[0].name}</strong>
              </div>
            </div>
            <div className="pass-preview">
              <span className="dashed" />
              <span>
                {isScenic
                  ? 'Via Parnassus, Portola & Upper Market'
                  : `${points.length - 2} automatic pass-through points`}
              </span>
              <span className="auto-tag">AUTO</span>
            </div>
            <div className="location-row">
              <span className="location-dot end" />
              <div>
                <small>FINISH</small>
                <strong>{points.at(-1).name}</strong>
                <span className="destination-note">
                  {isScenic
                    ? 'Near 582 Market St · park, then walk'
                    : 'Find legal parking near your destination'}
                </span>
              </div>
            </div>
          </div>
          <div className="flow-note">
            <span className="flow-symbol">
              <Route size={22} />
            </span>
            <div>
              <strong>Pass through. Don’t tap through.</strong>
              <p>
                Points clear as you pass. Miss a turn and we’ll reconnect you to
                the scenic ride.
              </p>
            </div>
          </div>
          <div className="route-tools">
            <button
              onClick={() => {
                setEditing(!editing);
                setDetails(false);
                setMapMode(null);
              }}
              aria-expanded={editing}
            >
              <Settings2 size={16} /> Shape your route <ChevronDown size={15} />
            </button>
            <button
              onClick={() => {
                setDetails(!details);
                setEditing(false);
                setMapMode(null);
              }}
              aria-expanded={details}
            >
              <Route size={16} /> Turns
            </button>
          </div>
          {editing && (
            <section className="editor">
              <p>
                Tap a mode, then tap the map. Middle points never require
                confirmation.
              </p>
              <div className="edit-modes">
                {[
                  ['start', 'Start'],
                  ['add', '+ Pass-through'],
                  ['finish', 'Finish'],
                ].map(([m, l]) => (
                  <button
                    key={m}
                    className={mapMode === m ? 'selected' : ''}
                    onClick={() => setMapMode(mapMode === m ? null : m)}
                  >
                    {l}
                  </button>
                ))}
              </div>
              <ol>
                {draft.map((p, i) => (
                  <li key={i}>
                    <span>
                      {i === 0 ? 'A' : i === draft.length - 1 ? 'B' : i}
                    </span>
                    <div>
                      {p.name}
                      <small>
                        {i === 0
                          ? 'Start of ride'
                          : i === draft.length - 1
                            ? 'End of ride'
                            : 'Pass through automatically'}
                      </small>
                    </div>
                    {i > 0 && i < draft.length - 1 && (
                      <>
                        <button
                          aria-label={`Move ${p.name} earlier`}
                          disabled={i === 1}
                          onClick={() => {
                            setDraft((old) => {
                              const n = [...old];
                              [n[i], n[i - 1]] = [n[i - 1], n[i]];
                              return n;
                            });
                            setDirty(true);
                          }}
                        >
                          <ArrowUp size={14} />
                        </button>
                        <button
                          aria-label={`Remove ${p.name}`}
                          onClick={() => {
                            setDraft((old) => old.filter((_, j) => j !== i));
                            setDirty(true);
                          }}
                        >
                          <X size={14} />
                        </button>
                      </>
                    )}
                  </li>
                ))}
              </ol>
              <button
                className="primary small"
                disabled={busy || !dirty}
                onClick={() => calculate(draft)}
              >
                {busy ? 'Finding roads…' : 'Build route'}
                <ArrowRight size={17} />
              </button>
              <button
                className="text-btn"
                disabled={busy}
                onClick={async () => {
                  const data = await fetch('/scenic-route.json').then((r) =>
                    r.json(),
                  );
                  accept(data, defaultPoints);
                  try {
                    localStorage.removeItem('flow-plan');
                  } catch {}
                  setEditing(false);
                  setMapMode(null);
                  history.replaceState(null, '', location.pathname);
                }}
              >
                Reset to southbound ride
              </button>
            </section>
          )}
          {details && route && (
            <ol className="turn-list">
              {route.steps.map((s, i) => (
                <li key={i}>
                  <TurnIcon step={s} size={18} />
                  <span>
                    {instruction(s)}
                    <small>{distanceLabel(s.at)} from start</small>
                  </span>
                </li>
              ))}
            </ol>
          )}
          <div className="start-area">
            <button
              className="primary"
              onClick={() => start('live')}
              disabled={!route || busy || dirty}
            >
              <Navigation size={21} /> Start ride <ArrowRight size={20} />
            </button>
            <button
              className="demo-btn"
              onClick={() => start('demo')}
              disabled={!route || busy || dirty}
            >
              <Play size={15} /> Preview a demo ride
            </button>
            <p className="footnote">
              Keep this page open with the screen on.
              <br />
              Estimates exclude live traffic and road closures.
            </p>
          </div>
          <div className="sidebar-footer">
            <span>MADE FOR TWO WHEELS</span>
            <Compass size={17} />
          </div>
        </aside>
        <section className="map-wrap">
          <div
            ref={mapEl}
            className="map"
            aria-label="Map of your scenic motorcycle route"
          />
          {!active && (
            <>
              <div className="map-label">
                <span className="status-dot" />
                <span>SAN FRANCISCO</span>
                <small>City hills / road views</small>
              </div>
              <div
                className="map-caption"
                style={!isScenic ? { display: 'none' } : undefined}
              >
                <div className="caption-icon">
                  <Sun size={23} />
                </div>
                <div>
                  <span>THE SCENIC STRETCH</span>
                  <strong>Portola → Upper Market</strong>
                  <p>Open views. Sweeping descent.</p>
                </div>
              </div>
            </>
          )}
          {mapMode && (
            <div className="map-prompt">
              <MapPin size={18} /> Tap the road to place{' '}
              {mapMode === 'add' ? 'a pass-through' : `your ${mapMode}`}
              <button
                aria-label="Cancel map placement"
                onClick={() => setMapMode(null)}
              >
                <X size={18} />
              </button>
            </div>
          )}
          {active && (
            <>
              <div className={`maneuver ${bad ? 'attention' : ''}`}>
                <div className="maneuver-icon">
                  {bad ? <Navigation size={40} /> : <TurnIcon step={step} />}
                </div>
                <div>
                  <div className="distance">
                    {bad
                      ? gpsTitles[nav.status]
                      : distanceLabel(Math.max(0, step.at - progress))}
                  </div>
                  <strong>
                    {bad ? gpsHints[nav.status] : instruction(step)}
                  </strong>
                </div>
              </div>
              <div className="ride-status">
                <span className={`status-dot ${bad ? 'amber' : ''}`} />
                {mode === 'demo'
                  ? 'DEMO · SIMULATED RIDE'
                  : nav.status === 'tracking'
                    ? `GPS ±${Math.round(nav.accuracy || 0)} m`
                    : nav.status === 'rerouting'
                      ? 'REROUTING'
                      : nav.status === 'offroute'
                        ? 'OFF ROUTE'
                        : 'WAITING FOR GPS'}
                <span className="sep">·</span>
                {wake ? 'SCREEN AWAKE' : 'KEEP SCREEN ON'}
                {mode === 'demo' && (
                  <button
                    aria-label={paused ? 'Resume demo' : 'Pause demo'}
                    disabled={
                      nav.status === 'rerouting' || nav.status === 'offroute'
                    }
                    onClick={() => setPaused(!paused)}
                  >
                    {paused ? <Play size={15} /> : <Pause size={15} />}
                  </button>
                )}
              </div>
              <div className="ride-dock">
                <div className="ride-progress">
                  <i
                    style={{
                      width: `${route ? (progress / route.total) * 100 : 0}%`,
                    }}
                  />
                </div>
                <div className="dock-content">
                  <div className="remaining">
                    <strong>
                      {Math.ceil(
                        ((((route?.seconds || 0) * remaining) /
                          (route?.total || 1)) *
                          1.3) /
                          60,
                      )}
                      <small> min</small>
                    </strong>
                    <span>{distanceLabel(remaining)} remaining</span>
                  </div>
                  <div className="passed">
                    <CheckCircle2 size={20} />
                    <strong>
                      {passed}/{allPassed}
                    </strong>
                    <span>points passed</span>
                  </div>
                  <button
                    className="icon-btn"
                    aria-label={voice ? 'Mute directions' : 'Enable directions'}
                    onClick={() => {
                      setVoice(!voice);
                      if (voice) window.speechSynthesis?.cancel();
                      else {
                        voiceRef.current = true;
                        speak('Spoken directions on.');
                      }
                    }}
                  >
                    {voice ? <Volume2 size={23} /> : <VolumeX size={23} />}
                  </button>
                  <button className="end-btn" onClick={stop}>
                    {nav.status === 'arrived' ? 'Done' : 'End ride'}
                  </button>
                </div>
                {mode === 'demo' && (
                  <div className="demo-recovery">
                    <button
                      disabled={!isScenic || nav.status === 'rerouting'}
                      onClick={demoMissedTurn}
                    >
                      Try a missed turn
                    </button>
                    <span>
                      {route?.rejoinAt && progress < route.rejoinAt
                        ? 'Rejoining · scenic route kept'
                        : 'Automatic rerouting preview'}
                    </span>
                  </div>
                )}
                {mode === 'demo' && (
                  <input
                    className="demo-slider"
                    aria-label="Demo ride progress"
                    disabled={
                      nav.status === 'rerouting' || nav.status === 'offroute'
                    }
                    type="range"
                    min="0"
                    max={route?.total || 1}
                    value={progress}
                    onChange={(e) => {
                      const d = Number(e.target.value);
                      setPaused(true);
                      setNav({
                        progress: d,
                        point: positionAt(route, d),
                        status: route.total - d < 3 ? 'arrived' : 'tracking',
                        locked: true,
                        accuracy: 5,
                      });
                    }}
                  />
                )}
              </div>
            </>
          )}
          <div className="map-controls">
            <button
              aria-label="Show whole route"
              title="Show whole route"
              onClick={() => {
                if (route) {
                  setFollow(false);
                  map.current.fitBounds(track.current.getBounds(), {
                    padding: active ? [60, 160] : [40, 60],
                  });
                }
              }}
            >
              <Expand size={20} />
            </button>
            {active && (
              <button
                aria-label="Follow rider"
                className={follow ? 'selected' : ''}
                onClick={() => setFollow(true)}
              >
                <LocateFixed size={20} />
              </button>
            )}
            <button aria-label="Zoom in" onClick={() => map.current.zoomIn()}>
              <Plus size={21} />
            </button>
            <button aria-label="Zoom out" onClick={() => map.current.zoomOut()}>
              <span className="minus">−</span>
            </button>
          </div>
          {tileError && (
            <div className="tile-warning">
              Map tiles unavailable. Route guidance is still loaded.
            </div>
          )}
          {loading && <div className="loading">Loading your ride…</div>}
        </section>
      </main>
      {error && (
        <div className="error-toast" role="alert">
          <span>{error}</span>
          <button aria-label="Dismiss message" onClick={() => setError('')}>
            <X size={18} />
          </button>
        </div>
      )}
      {toast && (
        <div className="toast" role="status">
          <Check size={17} />
          {toast}
        </div>
      )}
      {settings && (
        <div className="modal-backdrop" onClick={() => setSettings(false)}>
          <section
            className="settings-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Ride settings"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-heading">
              <h2>Your ride, uninterrupted.</h2>
              <button
                className="icon-btn"
                aria-label="Close settings"
                onClick={() => setSettings(false)}
              >
                <X size={21} />
              </button>
            </div>
            <label className="setting">
              <span>
                <Volume2 size={21} />
                <b>
                  Spoken directions
                  <small>Uses your phone’s voice and audio output</small>
                </b>
              </span>
              <input
                type="checkbox"
                checked={voice}
                onChange={(e) => {
                  setVoice(e.target.checked);
                  voiceRef.current = e.target.checked;
                  if (!e.target.checked) window.speechSynthesis?.cancel();
                }}
              />
            </label>
            <button
              className="secondary"
              onClick={() => {
                voiceRef.current = true;
                setVoice(true);
                speak('In 300 feet, turn right onto Parnassus Avenue.');
              }}
            >
              Test voice
            </button>
            <div className="settings-info">
              <Sun size={21} />
              <div>
                <strong>Screen awake while riding</strong>
                <p>
                  We request a screen wake lock when supported. Keep this page
                  visible; locked-screen and background navigation aren’t
                  supported.
                </p>
              </div>
            </div>
            <div className="settings-info">
              <LocateFixed size={21} />
              <div>
                <strong>Location & routing</strong>
                <p>
                  GPS progress is processed on your phone. When rerouting, your
                  current location and a rejoin point are sent to OSRM. Editing
                  sends the selected route points. Flow Ride does not save your
                  GPS history. Map tiles come from OpenStreetMap.
                </p>
              </div>
            </div>
            <div className="settings-info">
              <Route size={21} />
              <div>
                <strong>Automatic rerouting, same scenic ride</strong>
                <p>
                  After several accurate off-route readings, we calculate a
                  connection ahead and keep the remaining scenic roads. Internet
                  is needed; failed requests retry automatically. No live
                  traffic or closure detection. Follow posted signs.
                </p>
              </div>
            </div>
            <button className="secondary" onClick={exportGPX}>
              <Download size={17} /> Export route as GPX
            </button>
          </section>
        </div>
      )}
    </div>
  );
}
