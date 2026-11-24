import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, SafeAreaView, ScrollView, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, G, Polyline, Text as SvgText } from 'react-native-svg';
// Types only (erased at build time), so the app shares the backend contract
// without bundling anything from outside this folder.
import type {
  HazardReport,
  HazardType,
  LatLng,
  TrailSummary,
  TripPackage,
} from '../packages/shared/src/types';

/**
 * OffGrid app, first skeleton (1.1.0 milestone). Talks to the real backend.
 *   - EXPO_PUBLIC_API_URL: backend address. On a phone this must be your
 *     laptop's LAN IP (e.g. http://192.168.1.20:4000), not localhost.
 * Not wired yet (see HANDOFF.md): live GPS, real map tiles, offline storage,
 * camera/photo matching, sign-in.
 */
const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:4000';

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

async function api<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
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

/** Draws the route, waypoints and hazards scaled to fit. Placeholder until real map tiles. */
function RouteMap({ pkg }: { pkg: TripPackage }) {
  const W = 320;
  const H = 220;
  const pad = 18;
  const pts = [...pkg.trail.routeLine, ...pkg.trail.waypoints.map((w) => w.location)];
  const lats = pts.map((p) => p.lat);
  const lngs = pts.map((p) => p.lng);
  const [minLat, maxLat, minLng, maxLng] = [Math.min(...lats), Math.max(...lats), Math.min(...lngs), Math.max(...lngs)];
  const scale = Math.min((W - 2 * pad) / (maxLng - minLng || 1e-6), (H - 2 * pad) / (maxLat - minLat || 1e-6));
  const xy = (p: LatLng) => ({ x: pad + (p.lng - minLng) * scale, y: H - pad - (p.lat - minLat) * scale });

  return (
    <Svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} style={styles.map}>
      <Polyline
        points={pkg.trail.routeLine.map((p) => `${xy(p).x},${xy(p).y}`).join(' ')}
        fill="none"
        stroke="#2e7d4f"
        strokeWidth={4}
        strokeLinejoin="round"
      />
      {pkg.trail.waypoints.map((w) => (
        <G key={w.id}>
          <Circle cx={xy(w.location).x} cy={xy(w.location).y} r={6} fill="#fff" stroke="#2e7d4f" strokeWidth={3} />
          {/* Labels on the right half go to the left of the dot so they aren't cut off. */}
          <SvgText
            x={xy(w.location).x + (xy(w.location).x > W / 2 ? -9 : 9)}
            y={xy(w.location).y + 4}
            fontSize={11}
            fill="#1b3a2a"
            textAnchor={xy(w.location).x > W / 2 ? 'end' : 'start'}
          >
            {w.name}
          </SvgText>
        </G>
      ))}
      {pkg.hazards.map((h) => {
        const p = hazardPosition(h, pkg);
        return p ? (
          <Circle key={h.id} cx={xy(p).x} cy={xy(p).y - 12} r={7} fill={TIER_COLOR[h.confidenceLevel]} stroke="#fff" strokeWidth={2} />
        ) : null;
      })}
    </Svg>
  );
}

function Button({ title, onPress, kind = 'primary' }: { title: string; onPress: () => void; kind?: 'primary' | 'secondary' | 'demo' }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.button, styles[kind], pressed && { opacity: 0.7 }]}>
      <Text style={[styles.buttonText, kind !== 'primary' && { color: '#1b3a2a' }]}>{title}</Text>
    </Pressable>
  );
}

export default function App() {
  const [accepted, setAccepted] = useState(false);
  const [trails, setTrails] = useState<TrailSummary[] | null>(null);
  const [pkg, setPkg] = useState<TripPackage | null>(null);
  const [status, setStatus] = useState<string>('');
  const [error, setError] = useState<string>('');

  const run = useCallback(async (fn: () => Promise<void>) => {
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    if (accepted) run(async () => setTrails(await api<TrailSummary[]>('GET', '/trails/search')));
  }, [accepted, run]);

  const download = (trailId: string) =>
    run(async () => {
      setPkg(await api<TripPackage>('POST', `/trails/${encodeURIComponent(trailId)}/package`, {}));
      setStatus('Trip package downloaded.');
    });

  const refresh = async () => pkg && setPkg(await api<TripPackage>('POST', `/trails/${encodeURIComponent(pkg.trailId)}/package`, {}));

  const report = (type: HazardType) =>
    run(async () => {
      if (!pkg) return;
      const wp = pkg.trail.waypoints[0];
      const ack = await api<{ message: string }>('POST', '/hazards/reports', {
        id: makeId('report'),
        trailId: pkg.trailId,
        waypointHintId: wp.id,
        hazardType: type,
        severity: 'moderate',
        reportedAt: new Date().toISOString(),
        location: wp.location, // TODO: real GPS fix from expo-location
        gpsWeakOrMissing: false,
        reporterId: DEVICE_HIKER_ID,
      });
      setStatus(ack.message);
      await refresh();
    });

  const voteOn = (h: HazardReport, vote: 'still_there' | 'not_there', voterId: string) =>
    run(async () => {
      if (!pkg) return;
      await api('POST', '/hazards/votes', {
        id: makeId('vote'),
        incidentId: h.id,
        trailId: pkg.trailId,
        vote,
        observedAt: new Date().toISOString(),
        location: hazardPosition(h, pkg),
        gpsWeakOrMissing: false,
        voterId,
      });
      setStatus(vote === 'not_there' ? 'Marked "not there".' : 'Simulated hiker confirmed it.');
      await refresh();
    });

  const header = useMemo(
    () => (
      <View style={styles.header}>
        <Text style={styles.title}>OffGrid</Text>
        <Text style={styles.subtitle}>Plan online. Hike offline.</Text>
      </View>
    ),
    [],
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

  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar style="dark" />
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        {header}
        {!!error && <Text style={styles.error}>Couldn't reach OffGrid: {error} (API: {API_URL})</Text>}
        {!!status && <Text style={styles.status}>{status}</Text>}

        {!pkg && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Trails</Text>
            {trails === null && !error && <Text style={styles.body}>Loading…</Text>}
            {trails?.map((t) => (
              <Pressable key={t.id} onPress={() => download(t.id)} style={styles.trailRow}>
                <Text style={styles.trailName}>{t.name}</Text>
                <Text style={styles.meta}>
                  {(t.distanceMeters / 1609).toFixed(1)} mi · +{t.elevationGainMeters} m · {t.region}
                </Text>
              </Pressable>
            ))}
          </View>
        )}

        {pkg && (
          <>
            <View style={styles.card}>
              <Text style={styles.cardTitle}>{pkg.trail.name}</Text>
              <Text style={styles.meta}>
                Version {pkg.trailVersion} · {pkg.trail.waypoints.length} waypoints · {pkg.landmarkPhotos.length} reference photos
              </Text>
              <RouteMap pkg={pkg} />
              <Button title="← All trails" kind="secondary" onPress={() => { setPkg(null); setStatus(''); }} />
            </View>

            <View style={styles.card}>
              <Text style={styles.cardTitle}>Hazards ({pkg.hazards.length})</Text>
              {pkg.hazards.length === 0 && <Text style={styles.body}>None reported.</Text>}
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

            <View style={styles.card}>
              <Text style={styles.cardTitle}>Report a hazard at {pkg.trail.waypoints[0]?.name}</Text>
              <View style={styles.wrap}>
                {HAZARD_TYPES.map((t) => (
                  <Button key={t.type} title={t.label} kind="secondary" onPress={() => report(t.type)} />
                ))}
              </View>
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
  card: { backgroundColor: '#fff', marginHorizontal: 16, marginTop: 12, padding: 16, borderRadius: 14, gap: 10 },
  cardTitle: { fontSize: 18, fontWeight: '700', color: '#1b3a2a' },
  body: { fontSize: 15, lineHeight: 21, color: '#2b3a31' },
  meta: { fontSize: 13, color: '#5d6f64' },
  trailRow: { paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth, borderColor: '#d5ded7' },
  trailName: { fontSize: 16, fontWeight: '600', color: '#1b3a2a' },
  map: { backgroundColor: '#e8efe6', borderRadius: 10 },
  hazard: { flexDirection: 'row', gap: 10, paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth, borderColor: '#d5ded7' },
  dot: { width: 14, height: 14, borderRadius: 7, marginTop: 4 },
  row: { flexDirection: 'row', gap: 8, marginTop: 8, flexWrap: 'wrap' },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  button: { paddingVertical: 10, paddingHorizontal: 14, borderRadius: 10, alignItems: 'center' },
  primary: { backgroundColor: '#2e7d4f' },
  secondary: { backgroundColor: '#e3ece5' },
  demo: { backgroundColor: '#fdf0d5', borderWidth: 1, borderColor: '#f2b134', borderStyle: 'dashed' },
  buttonText: { color: '#fff', fontWeight: '600' },
  status: { marginHorizontal: 16, marginTop: 8, color: '#2e7d4f' },
  error: { marginHorizontal: 16, marginTop: 8, color: '#b3261e' },
  footer: { textAlign: 'center', marginTop: 24, fontSize: 11, color: '#7b8b81' },
});
