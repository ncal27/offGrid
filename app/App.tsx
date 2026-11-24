import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LayoutChangeEvent, Pressable, SafeAreaView, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import Svg, { Circle, G, Polyline, Text as SvgText } from 'react-native-svg';
// Types only (erased at build time), so the app shares the backend contract
// without bundling anything from outside this folder.
import type {
  HazardReport,
  HazardSeverity,
  HazardType,
  LatLng,
  TrailSummary,
  TripPackage,
} from '../packages/shared/src/types';

/**
 * OffGrid app (demo build). Talks to the real backend.
 *   - EXPO_PUBLIC_API_URL: backend address. On a phone this must be your
 *     laptop's LAN IP (e.g. http://192.168.1.20:4000), not localhost.
 *     "same-origin" = the address the app is served from (npm run preview).
 * Features: add trails live from OpenStreetMap, download for offline, tap the
 * route to drop a hazard, confidence tiers, a "Simulate no internet" switch
 * with an on-device queue that syncs when back online.
 * Not wired yet (see HANDOFF.md): live GPS, real map tiles, storage that
 * survives an app restart, camera/photo matching, sign-in.
 */
// "same-origin" = call the API at the address the app itself is served from
// (web builds, see .env.production and `npm run preview`).
const API_SETTING = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:4000';
const API_URL = API_SETTING === 'same-origin' ? '' : API_SETTING;

// Stand-in for sign-in (Supabase anonymous auth is the plan): one random ID per app launch.
const makeId = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
const DEVICE_HIKER_ID = makeId('hiker');

const HAZARD_TYPES: { type: HazardType; label: string }[] = [
  { type: 'downed_tree', label: 'Downed tree' },
  { type: 'flooding', label: 'Flooding' },
  { type: 'washout', label: 'Washout' },
  { type: 'bridge_out', label: 'Bridge out' },
  { type: 'other', label: 'Other' },
];
const SEVERITIES: HazardSeverity[] = ['minor', 'moderate', 'severe', 'impassable'];
const TIER_LABEL: Record<HazardReport['confidenceLevel'], string> = {
  very_low: 'Very low confidence',
  low: 'Low confidence',
  medium: 'Medium confidence',
  high: 'High confidence',
};
const TIER_COLOR: Record<HazardReport['confidenceLevel'], string> = {
  very_low: '#9e9e9e',
  low: '#f2b134',
  medium: '#ef7d22',
  high: '#d64545',
};

class OfflineError extends Error {
  constructor() {
    super('No internet (simulated)');
  }
}

/** Something done while offline, waiting to be sent. */
type QueuedUpload =
  | { kind: 'report'; trailId: string; body: Record<string, unknown>; label: string; location: LatLng }
  | { kind: 'vote'; trailId: string; body: Record<string, unknown>; label: string };

async function api<T>(offline: boolean, method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  // The "Simulate no internet" switch: no request leaves the app at all.
  if (offline) throw new OfflineError();
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.details?.[0] ?? json?.error ?? `HTTP ${res.status}`);
  return json as T;
}

function hazardPosition(h: HazardReport, pkg: TripPackage): LatLng | undefined {
  return h.location ?? pkg.trail.waypoints.find((w) => w.id === h.waypointId)?.location;
}

// ---- Map: drawn route (placeholder for real tiles), tap to pick a point ------

const MAP_W = 320;
const MAP_H = 220;
const MAP_PAD = 18;
const SNAP_MAX = 40; // view units: taps further than this from the trail are ignored

function useProjection(pkg: TripPackage) {
  return useMemo(() => {
    const pts = [...pkg.trail.routeLine, ...pkg.trail.waypoints.map((w) => w.location)];
    const lats = pts.map((p) => p.lat);
    const lngs = pts.map((p) => p.lng);
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);
    const minLng = Math.min(...lngs);
    const maxLng = Math.max(...lngs);
    // Shrink longitude by cos(latitude) so the shape isn't stretched east-west.
    const kx = Math.cos(((minLat + maxLat) / 2) * (Math.PI / 180));
    const scale = Math.min(
      (MAP_W - 2 * MAP_PAD) / (((maxLng - minLng) * kx) || 1e-6),
      (MAP_H - 2 * MAP_PAD) / ((maxLat - minLat) || 1e-6),
    );
    const toXY = (p: LatLng) => ({ x: MAP_PAD + (p.lng - minLng) * kx * scale, y: MAP_H - MAP_PAD - (p.lat - minLat) * scale });
    const toLatLng = (x: number, y: number): LatLng => ({
      lat: minLat + (MAP_H - MAP_PAD - y) / scale,
      lng: minLng + (x - MAP_PAD) / (kx * scale),
    });
    return { toXY, toLatLng };
  }, [pkg]);
}

/** Nearest point on the route (in map units) to a tap, or null if the tap is too far from the trail. */
function snapToRoute(x: number, y: number, route: { x: number; y: number }[]) {
  let best: { x: number; y: number; d: number } | null = null;
  for (let i = 0; i < route.length - 1; i++) {
    const a = route[i];
    const b = route[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / len2));
    const px = a.x + t * dx;
    const py = a.y + t * dy;
    const d = Math.hypot(x - px, y - py);
    if (!best || d < best.d) best = { x: px, y: py, d };
  }
  return best && best.d <= SNAP_MAX ? best : null;
}

function RouteMap({
  pkg,
  picked,
  queued,
  onPick,
  onMiss,
}: {
  pkg: TripPackage;
  picked: LatLng | null;
  queued: LatLng[];
  onPick: (p: LatLng) => void;
  onMiss: () => void;
}) {
  const { toXY, toLatLng } = useProjection(pkg);
  const size = useRef({ w: MAP_W, h: MAP_H });
  const route = pkg.trail.routeLine.map(toXY);

  const onTap = (e: { nativeEvent: { locationX?: number; locationY?: number; offsetX?: number; offsetY?: number } }) => {
    // Phones report the tap position as locationX/Y. On the web a click is a
    // plain browser event with offsetX/Y instead (locationX is undefined there),
    // both relative to this transparent layer.
    const tapX = e.nativeEvent.locationX ?? e.nativeEvent.offsetX;
    const tapY = e.nativeEvent.locationY ?? e.nativeEvent.offsetY;
    if (tapX === undefined || tapY === undefined) return onMiss();
    // The SVG scales its viewBox to fit (keeping proportions, centred), so undo that.
    const { w, h } = size.current;
    const s = Math.min(w / MAP_W, h / MAP_H);
    const x = (tapX - (w - MAP_W * s) / 2) / s;
    const y = (tapY - (h - MAP_H * s) / 2) / s;
    const snapped = snapToRoute(x, y, route);
    if (snapped) onPick(toLatLng(snapped.x, snapped.y));
    else onMiss();
  };

  return (
    <View style={styles.mapWrap}>
      <Svg width="100%" height={MAP_H} viewBox={`0 0 ${MAP_W} ${MAP_H}`}>
        <Polyline
          points={route.map((p) => `${p.x},${p.y}`).join(' ')}
          fill="none"
          stroke="#2e7d4f"
          strokeWidth={4}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {pkg.trail.waypoints.map((w) => {
          const p = toXY(w.location);
          const right = p.x > MAP_W / 2;
          return (
            <G key={w.id}>
              <Circle cx={p.x} cy={p.y} r={6} fill="#fff" stroke="#2e7d4f" strokeWidth={3} />
              <SvgText x={p.x + (right ? -9 : 9)} y={p.y + 4} fontSize={11} fill="#1b3a2a" textAnchor={right ? 'end' : 'start'}>
                {w.name}
              </SvgText>
            </G>
          );
        })}
        {pkg.hazards.map((h) => {
          const pos = hazardPosition(h, pkg);
          if (!pos) return null;
          const p = toXY(pos);
          return <Circle key={h.id} cx={p.x} cy={p.y - 12} r={7} fill={TIER_COLOR[h.confidenceLevel]} stroke="#fff" strokeWidth={2} />;
        })}
        {queued.map((q, i) => {
          const p = toXY(q);
          return <Circle key={`q${i}`} cx={p.x} cy={p.y - 12} r={7} fill="#fff" stroke="#5d6f64" strokeWidth={2} strokeDasharray="3,2" />;
        })}
        {picked && (
          <G>
            <Circle cx={toXY(picked).x} cy={toXY(picked).y} r={10} fill="none" stroke="#1565c0" strokeWidth={3} />
            <Circle cx={toXY(picked).x} cy={toXY(picked).y} r={3} fill="#1565c0" />
          </G>
        )}
      </Svg>
      {/* Transparent layer on top catches taps, so tap positions are always
          measured relative to the map itself (reliable on phones and web). */}
      <Pressable
        accessibilityLabel="Trail map: tap the trail to place a hazard"
        style={StyleSheet.absoluteFill}
        onLayout={(e: LayoutChangeEvent) => {
          size.current = { w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height };
        }}
        onPress={onTap}
      />
    </View>
  );
}

function Button({
  title,
  onPress,
  kind = 'primary',
  disabled,
}: {
  title: string;
  onPress: () => void;
  kind?: 'primary' | 'secondary' | 'demo' | 'selected';
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [styles.button, styles[kind], (pressed || disabled) && { opacity: 0.5 }]}
    >
      <Text style={[styles.buttonText, (kind === 'secondary' || kind === 'demo') && { color: '#1b3a2a' }]}>{title}</Text>
    </Pressable>
  );
}

// ---- App ----------------------------------------------------------------------

export default function App() {
  const [accepted, setAccepted] = useState(false);
  const [offline, setOffline] = useState(false);
  const [trails, setTrails] = useState<TrailSummary[] | null>(null);
  const [packages, setPackages] = useState<Record<string, TripPackage>>({});
  const [openTrailId, setOpenTrailId] = useState<string | null>(null);
  const [queue, setQueue] = useState<QueuedUpload[]>([]);
  const [picked, setPicked] = useState<LatLng | null>(null);
  const [severity, setSeverity] = useState<HazardSeverity>('moderate');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');

  const pkg = openTrailId ? packages[openTrailId] ?? null : null;

  const run = useCallback(async (fn: () => Promise<void>) => {
    setError('');
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof OfflineError ? 'You are offline. Turn off "Simulate no internet" to do this.' : e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const loadTrails = useCallback(
    () => run(async () => setTrails(await api<TrailSummary[]>(offline, 'GET', '/trails/search'))),
    [offline, run],
  );
  useEffect(() => {
    if (accepted && !offline) loadTrails();
  }, [accepted, offline, loadTrails]);

  const fetchPackage = async (trailId: string) => {
    const p = await api<TripPackage>(offline, 'POST', `/trails/${encodeURIComponent(trailId)}/package`, {});
    setPackages((prev) => ({ ...prev, [trailId]: p }));
    return p;
  };

  const openTrail = (trailId: string) =>
    run(async () => {
      setPicked(null);
      if (!packages[trailId]) {
        await fetchPackage(trailId);
        setStatus('Downloaded. This trail now works with no internet.');
      } else if (!offline) {
        await fetchPackage(trailId); // refresh hazards while we have signal
        setStatus('');
      } else {
        setStatus('Opened from this device (no internet needed).');
      }
      setOpenTrailId(trailId);
    });

  const importTrail = () =>
    run(async () => {
      const t = await api<TrailSummary>(offline, 'POST', '/trails/import', { query });
      setQuery('');
      setStatus(`Added "${t.name}" from OpenStreetMap (${(t.distanceMeters / 1609).toFixed(1)} mi).`);
      await loadTrails();
    });

  /** Sends a report/vote now, or queues it on the device if offline. */
  const send = (item: QueuedUpload) =>
    run(async () => {
      if (offline) {
        setQueue((q) => [...q, item]);
        setStatus(`Saved on this device: ${item.label}. It will sync when you're back online.`);
        return;
      }
      const ack = await api<{ message?: string }>(offline, 'POST', item.kind === 'report' ? '/hazards/reports' : '/hazards/votes', item.body);
      setStatus(ack.message ?? `${item.label}: sent.`);
      await fetchPackage(item.trailId);
    });

  const reportAt = (type: HazardType) => {
    if (!pkg || !picked) return;
    const label = `${HAZARD_TYPES.find((t) => t.type === type)?.label} (${severity})`;
    send({
      kind: 'report',
      trailId: pkg.trailId,
      label,
      location: picked,
      body: {
        id: makeId('report'),
        trailId: pkg.trailId,
        hazardType: type,
        severity,
        reportedAt: new Date().toISOString(),
        location: picked, // TODO: also attach the phone's real GPS fix (expo-location)
        gpsWeakOrMissing: false,
        reporterId: DEVICE_HIKER_ID,
      },
    });
    setPicked(null);
  };

  const voteOn = (h: HazardReport, vote: 'still_there' | 'not_there', voterId: string) => {
    if (!pkg) return;
    send({
      kind: 'vote',
      trailId: pkg.trailId,
      label: vote === 'not_there' ? '"Not there"' : 'simulated hiker confirmation',
      body: {
        id: makeId('vote'),
        incidentId: h.id,
        trailId: pkg.trailId,
        vote,
        observedAt: new Date().toISOString(),
        location: hazardPosition(h, pkg),
        gpsWeakOrMissing: false,
        voterId,
      },
    });
  };

  /** Back online: send everything queued, in order; stop at the first failure and keep the rest. */
  const goOnline = () => {
    setOffline(false);
    if (queue.length === 0) return;
    run(async () => {
      let sent = 0;
      const touched = new Set<string>();
      for (const item of queue) {
        try {
          await api(false, 'POST', item.kind === 'report' ? '/hazards/reports' : '/hazards/votes', item.body);
        } catch (e) {
          setQueue(queue.slice(sent));
          throw new Error(`Synced ${sent} of ${queue.length}; the rest will retry. (${e instanceof Error ? e.message : e})`);
        }
        sent++;
        touched.add(item.trailId);
      }
      setQueue([]);
      for (const id of touched) {
        const p = await api<TripPackage>(false, 'POST', `/trails/${encodeURIComponent(id)}/package`, {});
        setPackages((prev) => ({ ...prev, [id]: p }));
      }
      setStatus(`Back online: synced ${sent} saved change${sent === 1 ? '' : 's'}.`);
    });
  };

  const header = (
    <View style={styles.header}>
      <Text style={styles.title}>OffGrid</Text>
      <Text style={styles.subtitle}>Plan online. Hike offline.</Text>
    </View>
  );

  if (!accepted) {
    return (
      <SafeAreaView style={styles.screen}>
        <StatusBar style="dark" />
        {header}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Before you go</Text>
          <Text style={styles.body}>
            OffGrid is a student project. Trail and hazard information is community-reported and may be wrong or
            out of date. Always use your own judgment, carry a paper map, and follow posted signs and park rules.
          </Text>
          <Button title="I understand" onPress={() => setAccepted(true)} />
        </View>
      </SafeAreaView>
    );
  }

  const visibleTrails: TrailSummary[] = offline
    ? Object.values(packages).map((p) => p.trail)
    : trails ?? [];
  const queuedHere = queue.filter((q): q is Extract<QueuedUpload, { kind: 'report' }> => q.kind === 'report' && q.trailId === pkg?.trailId);

  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar style="dark" />
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        {header}

        <View style={[styles.netBar, offline && styles.netBarOffline]}>
          <View style={{ flex: 1 }}>
            <Text style={styles.netTitle}>{offline ? 'No internet (simulated)' : 'Online'}</Text>
            <Text style={styles.meta}>
              {offline
                ? `${queue.length} change${queue.length === 1 ? '' : 's'} saved on this device, waiting to sync`
                : 'Flip the switch to show the app working with no signal'}
            </Text>
          </View>
          <Text style={styles.meta}>Simulate no internet</Text>
          <Switch
            accessibilityLabel="Simulate no internet"
            value={offline}
            onValueChange={(v) => (v ? setOffline(true) : goOnline())}
          />
        </View>

        {!!error && <Text style={styles.error}>{error}</Text>}
        {!!status && <Text style={styles.status}>{status}</Text>}

        {!pkg && (
          <>
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Add a trail</Text>
              <Text style={styles.meta}>Any named trail around Wellesley/MetroWest, from OpenStreetMap.</Text>
              <View style={styles.row}>
                <TextInput
                  accessibilityLabel="Trail name"
                  value={query}
                  onChangeText={setQuery}
                  placeholder="e.g. Rocky Ledges"
                  maxLength={60}
                  style={styles.input}
                  onSubmitEditing={importTrail}
                  editable={!offline}
                />
                <Button title="Add" onPress={importTrail} disabled={offline || busy || query.trim().length < 2} />
              </View>
            </View>

            <View style={styles.card}>
              <Text style={styles.cardTitle}>{offline ? 'Downloaded trails' : 'Trails'}</Text>
              {!offline && trails === null && !error && <Text style={styles.body}>Loading…</Text>}
              {offline && visibleTrails.length === 0 && (
                <Text style={styles.body}>Nothing downloaded. Go online and open a trail to download it.</Text>
              )}
              {visibleTrails.map((t) => (
                <Pressable key={t.id} onPress={() => openTrail(t.id)} style={styles.trailRow}>
                  <Text style={styles.trailName}>
                    {t.name}
                    {packages[t.id] ? '  ✓ downloaded' : ''}
                  </Text>
                  <Text style={styles.meta}>
                    {(t.distanceMeters / 1609).toFixed(1)} mi
                    {t.elevationGainMeters ? ` · +${t.elevationGainMeters} m` : ''} · {t.region}
                    {t.dataSource === 'openstreetmap' ? ' · OpenStreetMap' : ''}
                  </Text>
                </Pressable>
              ))}
            </View>
          </>
        )}

        {pkg && (
          <>
            <View style={styles.card}>
              <Text style={styles.cardTitle}>{pkg.trail.name}</Text>
              <Text style={styles.meta}>
                {(pkg.trail.distanceMeters / 1609).toFixed(1)} mi · version {pkg.trailVersion} · saved on this device
              </Text>
              <RouteMap
                pkg={pkg}
                picked={picked}
                queued={queuedHere.map((q) => q.location)}
                onPick={(p) => {
                  setPicked(p);
                  setError('');
                }}
                onMiss={() => setError('Tap on (or right next to) the trail to place a hazard.')}
              />
              <Text style={styles.meta}>Tap anywhere on the trail to report a hazard there.</Text>
              <Button title="← All trails" kind="secondary" onPress={() => { setOpenTrailId(null); setPicked(null); setStatus(''); }} />
            </View>

            {picked && (
              <View style={[styles.card, styles.pickCard]}>
                <Text style={styles.cardTitle}>Report a hazard here</Text>
                <Text style={styles.meta}>
                  {picked.lat.toFixed(5)}, {picked.lng.toFixed(5)}
                </Text>
                <Text style={styles.label}>How bad?</Text>
                <View style={styles.wrap}>
                  {SEVERITIES.map((s) => (
                    <Button key={s} title={s} kind={s === severity ? 'selected' : 'secondary'} onPress={() => setSeverity(s)} />
                  ))}
                </View>
                <Text style={styles.label}>What is it?</Text>
                <View style={styles.wrap}>
                  {HAZARD_TYPES.map((t) => (
                    <Button key={t.type} title={t.label} kind="secondary" onPress={() => reportAt(t.type)} />
                  ))}
                </View>
                <Button title="Cancel" kind="secondary" onPress={() => setPicked(null)} />
              </View>
            )}

            <View style={styles.card}>
              <Text style={styles.cardTitle}>Hazards ({pkg.hazards.length})</Text>
              {pkg.hazards.length === 0 && <Text style={styles.body}>None reported.</Text>}
              {queuedHere.length > 0 && (
                <Text style={styles.meta}>+ {queuedHere.length} reported offline, shown dashed on the map until synced</Text>
              )}
              {pkg.hazards.map((h) => (
                <View key={h.id} style={styles.hazard}>
                  <View style={[styles.dot, { backgroundColor: TIER_COLOR[h.confidenceLevel] }]} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.trailName}>
                      {HAZARD_TYPES.find((x) => x.type === h.hazardType)?.label} · {h.severity}
                    </Text>
                    <Text style={styles.meta}>
                      {h.verifiedBy === 'reviewer'
                        ? 'Confirmed by a ranger/reviewer'
                        : `${TIER_LABEL[h.confidenceLevel]} · ${h.confirmations} ${h.confirmations === 1 ? 'report' : 'hikers'}`}
                      {h.denials ? ` · ${h.denials} said not there` : ''}
                    </Text>
                    <View style={styles.row}>
                      <Button title="Not there" kind="secondary" onPress={() => voteOn(h, 'not_there', DEVICE_HIKER_ID)} />
                      <Button title="Demo: simulate another hiker" kind="demo" onPress={() => voteOn(h, 'still_there', makeId('sim-hiker'))} />
                    </View>
                  </View>
                </View>
              ))}
            </View>
          </>
        )}
        <Text style={styles.footer}>Map data © OpenStreetMap contributors · demo build</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#f3f6f2' },
  header: { paddingHorizontal: 16, paddingTop: 24, paddingBottom: 8 },
  title: { fontSize: 28, fontWeight: '800', color: '#1b3a2a' },
  subtitle: { fontSize: 14, color: '#4f6b5a' },
  netBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 16,
    marginTop: 8,
    padding: 12,
    borderRadius: 12,
    backgroundColor: '#e3ece5',
  },
  netBarOffline: { backgroundColor: '#fdecc8' },
  netTitle: { fontSize: 15, fontWeight: '700', color: '#1b3a2a' },
  card: { backgroundColor: '#fff', marginHorizontal: 16, marginTop: 12, padding: 16, borderRadius: 14, gap: 10 },
  pickCard: { borderWidth: 2, borderColor: '#1565c0' },
  cardTitle: { fontSize: 18, fontWeight: '700', color: '#1b3a2a' },
  body: { fontSize: 15, lineHeight: 21, color: '#2b3a31' },
  meta: { fontSize: 13, color: '#5d6f64' },
  label: { fontSize: 13, fontWeight: '700', color: '#1b3a2a', marginTop: 4 },
  input: {
    flex: 1,
    minWidth: 160,
    borderWidth: 1,
    borderColor: '#c9d5cc',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    backgroundColor: '#fff',
  },
  trailRow: { paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth, borderColor: '#d5ded7' },
  trailName: { fontSize: 16, fontWeight: '600', color: '#1b3a2a' },
  mapWrap: { backgroundColor: '#e8efe6', borderRadius: 10, overflow: 'hidden' },
  hazard: { flexDirection: 'row', gap: 10, paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth, borderColor: '#d5ded7' },
  dot: { width: 14, height: 14, borderRadius: 7, marginTop: 4 },
  row: { flexDirection: 'row', gap: 8, marginTop: 4, flexWrap: 'wrap', alignItems: 'center' },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  button: { paddingVertical: 10, paddingHorizontal: 14, borderRadius: 10, alignItems: 'center' },
  primary: { backgroundColor: '#2e7d4f' },
  secondary: { backgroundColor: '#e3ece5' },
  selected: { backgroundColor: '#1565c0' },
  demo: { backgroundColor: '#fdf0d5', borderWidth: 1, borderColor: '#f2b134', borderStyle: 'dashed' },
  buttonText: { color: '#fff', fontWeight: '600' },
  status: { marginHorizontal: 16, marginTop: 8, color: '#2e7d4f' },
  error: { marginHorizontal: 16, marginTop: 8, color: '#b3261e' },
  footer: { textAlign: 'center', marginTop: 24, fontSize: 11, color: '#7b8b81' },
});
