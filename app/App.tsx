import { StatusBar } from 'expo-status-bar';
import * as ImagePicker from 'expo-image-picker';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Image,
  LayoutChangeEvent,
  Linking,
  Modal,
  PanResponder,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Svg, { Circle, G, Polyline, Text as SvgText } from 'react-native-svg';
// Types only (erased at build time), so the app shares the backend contract
// without bundling anything from outside this folder.
import type {
  HazardReport,
  HazardSeverity,
  HazardType,
  LandmarkPhoto,
  LatLng,
  Season,
  TrailSummary,
  TripPackage,
  Waypoint,
} from '../packages/shared/src/types';
// Shared, platform-agnostic offline photo matching (resolved via metro.config.js).
import { confidenceLevel, decodeJpeg, fingerprint, rankPlaces, ReferenceEmbedding } from '../mobile/src/core/imageFingerprint';

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

// ---- The "Go offline" button: a guard around EVERY network request --------------
// While offline, each fetch the app attempts is blocked here and counted. The
// on-screen counter is the demo's proof that nothing reaches the internet.
// (For the strongest proof on a phone, also switch on airplane mode.)
const net = { offline: false, blocked: 0, listeners: new Set<() => void>() };
const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
  if (net.offline) {
    net.blocked++;
    net.listeners.forEach((l) => l());
    return Promise.reject(new OfflineError());
  }
  return realFetch(...args);
}) as typeof fetch;
function useBlockedCount() {
  const [n, setN] = useState(net.blocked);
  useEffect(() => {
    const l = () => setN(net.blocked);
    net.listeners.add(l);
    return () => {
      net.listeners.delete(l);
    };
  }, []);
  return n;
}

/** Photos/assets the API serves (e.g. promoted hiker photos) have relative URLs. */
const assetUrl = (u: string) => (u.startsWith('/') ? `${API_URL}${u}` : u);

async function toDataUri(url: string): Promise<string> {
  const blob = await (await fetch(url)).blob();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error('Could not read photo'));
    r.readAsDataURL(blob);
  });
}

/** Something done while offline, waiting to be sent. */
type QueuedUpload =
  | { kind: 'report'; trailId: string; body: Record<string, unknown>; label: string; location: LatLng }
  | { kind: 'vote'; trailId: string; body: Record<string, unknown>; label: string }
  | { kind: 'photo'; trailId: string; body: Record<string, unknown>; label: string; preview: string };
const UPLOAD_PATH: Record<QueuedUpload['kind'], string> = {
  report: '/hazards/reports',
  vote: '/hazards/votes',
  photo: '/contributions/photos',
};

async function api<T>(_offline: boolean, method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  // While offline the fetch guard above blocks (and counts) this request.
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

// ---- Map: drawn trail network (placeholder for real tiles) ----------------------
// Zoom (+/−/fit), drag to pan, tap a place to zoom in and see its photos, tap
// any path (main route or side trail) to drop a hazard there.

const MAP_W = 320;
const MAP_H = 260;
const MAP_PAD = 18;
const SNAP_MAX = 40; // view units at zoom 1: taps further than this from any path are ignored
const PLACE_HIT = 14; // view units at zoom 1: taps this close to a place select it
const MAX_ZOOM = 8;

const KIND_COLOR: Record<NonNullable<Waypoint['kind']>, string> = {
  trailhead: '#1565c0',
  summit: '#6d4c41',
  viewpoint: '#7b1fa2',
  landmark: '#455a64',
  junction: '#455a64',
  point: '#2e7d4f',
};
const KIND_LABEL: Record<NonNullable<Waypoint['kind']>, string> = {
  trailhead: 'Trailhead',
  summit: 'Summit',
  viewpoint: 'Viewpoint',
  landmark: 'Landmark',
  junction: 'Junction',
  point: 'Point',
};

function useProjection(pkg: TripPackage) {
  return useMemo(() => {
    const pts = [
      ...pkg.trail.routeLine,
      ...(pkg.trail.branches ?? []).flatMap((b) => b.line),
      ...pkg.trail.waypoints.map((w) => w.location),
    ];
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
    // Centre the drawing in the box.
    const ox = (MAP_W - (maxLng - minLng) * kx * scale) / 2;
    const oy = (MAP_H - (maxLat - minLat) * scale) / 2;
    const toXY = (p: LatLng) => ({ x: ox + (p.lng - minLng) * kx * scale, y: MAP_H - oy - (p.lat - minLat) * scale });
    const toLatLng = (x: number, y: number): LatLng => ({
      lat: minLat + (MAP_H - oy - y) / scale,
      lng: minLng + (x - ox) / (kx * scale),
    });
    return { toXY, toLatLng };
  }, [pkg]);
}

/** Nearest point on any of the lines (in map units) to a tap, or null if it's further than `max`. */
function snapToLines(x: number, y: number, lines: { x: number; y: number }[][], max: number) {
  let best: { x: number; y: number; d: number } | null = null;
  for (const line of lines) {
    for (let i = 0; i < line.length - 1; i++) {
      const a = line[i];
      const b = line[i + 1];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len2 = dx * dx + dy * dy;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / len2));
      const px = a.x + t * dx;
      const py = a.y + t * dy;
      const d = Math.hypot(x - px, y - py);
      if (!best || d < best.d) best = { x: px, y: py, d };
    }
  }
  return best && best.d <= max ? best : null;
}

type View2D = { zoom: number; cx: number; cy: number };
const clampView = (v: View2D): View2D => {
  const zoom = Math.min(MAX_ZOOM, Math.max(1, v.zoom));
  const w = MAP_W / zoom;
  const h = MAP_H / zoom;
  return { zoom, cx: Math.min(MAP_W - w / 2, Math.max(w / 2, v.cx)), cy: Math.min(MAP_H - h / 2, Math.max(h / 2, v.cy)) };
};
const FIT: View2D = { zoom: 1, cx: MAP_W / 2, cy: MAP_H / 2 };

function RouteMap({
  pkg,
  picked,
  queued,
  selectedPlaceId,
  onPick,
  onMiss,
  onSelectPlace,
}: {
  pkg: TripPackage;
  picked: LatLng | null;
  queued: LatLng[];
  selectedPlaceId: string | null;
  onPick: (p: LatLng) => void;
  onMiss: () => void;
  onSelectPlace: (id: string) => void;
}) {
  const { toXY, toLatLng } = useProjection(pkg);
  const [view, setView] = useState<View2D>(FIT);
  const viewRef = useRef(view);
  viewRef.current = view;
  const size = useRef({ w: MAP_W, h: MAP_H });
  const route = useMemo(() => pkg.trail.routeLine.map(toXY), [pkg, toXY]);
  const branches = useMemo(() => (pkg.trail.branches ?? []).map((b) => ({ ...b, pts: b.line.map(toXY) })), [pkg, toXY]);
  const z = view.zoom;
  const vbW = MAP_W / z;
  const vbH = MAP_H / z;
  const vbX = view.cx - vbW / 2;
  const vbY = view.cy - vbH / 2;

  // Zoom in on a place when it's selected (from the map or the photo filters).
  useEffect(() => {
    const wp = pkg.trail.waypoints.find((w) => w.id === selectedPlaceId);
    if (wp) {
      const p = toXY(wp.location);
      setView(clampView({ zoom: Math.max(viewRef.current.zoom, 3), cx: p.x, cy: p.y }));
    }
  }, [selectedPlaceId, pkg, toXY]);

  /** Screen pixels inside the map -> map units, undoing zoom/pan and the SVG's fit-and-centre scaling. */
  const toMap = (px: number, py: number) => {
    const v = viewRef.current;
    const w = MAP_W / v.zoom;
    const h = MAP_H / v.zoom;
    const ps = Math.min(size.current.w / w, size.current.h / h);
    const ox = (size.current.w - w * ps) / 2;
    const oy = (size.current.h - h * ps) / 2;
    return { x: v.cx - w / 2 + (px - ox) / ps, y: v.cy - h / 2 + (py - oy) / ps, ps };
  };

  const handleTap = (px: number, py: number) => {
    const { x, y } = toMap(px, py);
    const zoom = viewRef.current.zoom;
    const place = pkg.trail.waypoints
      .map((w) => ({ w, d: Math.hypot(toXY(w.location).x - x, toXY(w.location).y - y) }))
      .sort((a, b) => a.d - b.d)[0];
    if (place && place.d <= PLACE_HIT / zoom) return onSelectPlace(place.w.id);
    const snapped = snapToLines(x, y, [route, ...branches.map((b) => b.pts)], SNAP_MAX / zoom);
    if (snapped) onPick(toLatLng(snapped.x, snapped.y));
    else onMiss();
  };
  const tapRef = useRef(handleTap);
  tapRef.current = handleTap;

  // Drag to pan: the pan handler only takes over once the finger/mouse has
  // actually moved, so a plain tap still reaches the Pressable below (on the
  // web, a pan handler that claims every press never reports a tap).
  const start = useRef({ cx: 0, cy: 0 });
  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponderCapture: (_e, g) => Math.hypot(g.dx, g.dy) > 6,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        start.current = { cx: viewRef.current.cx, cy: viewRef.current.cy };
      },
      onPanResponderMove: (_e, g) => {
        const { ps } = toMapRef.current(0, 0);
        setView(clampView({ zoom: viewRef.current.zoom, cx: start.current.cx - g.dx / ps, cy: start.current.cy - g.dy / ps }));
      },
    }),
  ).current;
  const toMapRef = useRef(toMap);
  toMapRef.current = toMap;

  const zoomBy = (f: number) => setView((v) => clampView({ ...v, zoom: v.zoom * f }));

  return (
    <View style={styles.mapWrap}>
      <Svg width="100%" height={MAP_H} viewBox={`${vbX} ${vbY} ${vbW} ${vbH}`}>
        {branches.map((b) => (
          <Polyline
            key={b.id}
            points={b.pts.map((p) => `${p.x},${p.y}`).join(' ')}
            fill="none"
            stroke="#86b596"
            strokeWidth={2.5 / z}
            strokeDasharray={`${6 / z},${4 / z}`}
            strokeLinecap="round"
          />
        ))}
        {z >= 2.5 &&
          branches.map((b) => {
            const mid = b.pts[Math.floor(b.pts.length / 2)];
            return (
              <SvgText key={`${b.id}-label`} x={mid.x} y={mid.y - 4 / z} fontSize={8 / z} fill="#4f6b5a" textAnchor="middle">
                {b.name}
              </SvgText>
            );
          })}
        <Polyline
          points={route.map((p) => `${p.x},${p.y}`).join(' ')}
          fill="none"
          stroke="#2e7d4f"
          strokeWidth={4 / z}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {pkg.hazards.map((h) => {
          const pos = hazardPosition(h, pkg);
          if (!pos) return null;
          const p = toXY(pos);
          return <Circle key={h.id} cx={p.x} cy={p.y - 12 / z} r={7 / z} fill={TIER_COLOR[h.confidenceLevel]} stroke="#fff" strokeWidth={2 / z} />;
        })}
        {queued.map((q, i) => {
          const p = toXY(q);
          return <Circle key={`q${i}`} cx={p.x} cy={p.y - 12 / z} r={7 / z} fill="#fff" stroke="#5d6f64" strokeWidth={2 / z} strokeDasharray={`${3 / z},${2 / z}`} />;
        })}
        {pkg.trail.waypoints.map((w) => {
          const p = toXY(w.location);
          const right = p.x > view.cx;
          const selected = w.id === selectedPlaceId;
          return (
            <G key={w.id}>
              {selected && <Circle cx={p.x} cy={p.y} r={12 / z} fill="none" stroke={KIND_COLOR[w.kind ?? 'point']} strokeWidth={3 / z} />}
              <Circle cx={p.x} cy={p.y} r={6.5 / z} fill={w.kind ? KIND_COLOR[w.kind] : '#fff'} stroke={w.kind ? '#fff' : '#2e7d4f'} strokeWidth={2.5 / z} />
              <SvgText
                x={p.x + (right ? -10 : 10) / z}
                y={p.y + 4 / z}
                fontSize={11 / z}
                fontWeight={selected ? 'bold' : 'normal'}
                fill="#1b3a2a"
                textAnchor={right ? 'end' : 'start'}
              >
                {w.name}
              </SvgText>
            </G>
          );
        })}
        {picked && (
          <G>
            <Circle cx={toXY(picked).x} cy={toXY(picked).y} r={10 / z} fill="none" stroke="#1565c0" strokeWidth={3 / z} />
            <Circle cx={toXY(picked).x} cy={toXY(picked).y} r={3 / z} fill="#1565c0" />
          </G>
        )}
      </Svg>
      {/* Transparent layer on top: drag to pan, tap to select a place or drop a hazard.
          Tap positions are measured relative to this layer (phones and web). */}
      <View style={StyleSheet.absoluteFill} {...responder.panHandlers}>
        <Pressable
          accessibilityLabel="Trail map: drag to move, tap a place or the trail"
          style={StyleSheet.absoluteFill}
          onLayout={(e: LayoutChangeEvent) => {
            size.current = { w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height };
          }}
          onPress={(e) => {
            // Phones report locationX/Y; on the web a click has offsetX/Y instead.
            const ne = e.nativeEvent as unknown as { locationX?: number; locationY?: number; offsetX?: number; offsetY?: number };
            const x = ne.locationX ?? ne.offsetX;
            const y = ne.locationY ?? ne.offsetY;
            if (x === undefined || y === undefined) return onMiss();
            tapRef.current(x, y);
          }}
        />
      </View>
      <View style={styles.zoomBar}>
        <Pressable accessibilityLabel="Zoom in" style={styles.zoomBtn} onPress={() => zoomBy(1.6)}>
          <Text style={styles.zoomText}>+</Text>
        </Pressable>
        <Pressable accessibilityLabel="Zoom out" style={styles.zoomBtn} onPress={() => zoomBy(1 / 1.6)}>
          <Text style={styles.zoomText}>−</Text>
        </Pressable>
        <Pressable accessibilityLabel="Show whole trail" style={styles.zoomBtn} onPress={() => setView(FIT)}>
          <Text style={[styles.zoomText, { fontSize: 13 }]}>Fit</Text>
        </Pressable>
      </View>
    </View>
  );
}

// ---- Photos: filter by season and place, tap for full size with credit -----------

const SEASON_NAMES: Record<Season, string> = { spring: 'Spring', summer: 'Summer', fall: 'Fall', winter: 'Winter' };
/** New England seasons by month. */
function seasonOf(d: Date): Season {
  const m = d.getMonth();
  if (m === 11 || m <= 1) return 'winter';
  if (m <= 4) return 'spring';
  if (m <= 7) return 'summer';
  return 'fall';
}
const isWebImage = (p: LandmarkPhoto) => /^(https:\/\/|\/photos\/)/.test(p.thumbnailUrl ?? p.uri);

function PhotoGallery({
  pkg,
  placeId,
  onPlace,
  season,
  onSeason,
  onOpen,
  photoSrc,
  pending,
}: {
  pkg: TripPackage;
  placeId: string | null;
  onPlace: (id: string | null) => void;
  season: Season | 'all';
  onSeason: (s: Season | 'all') => void;
  onOpen: (p: LandmarkPhoto) => void;
  photoSrc: (p: LandmarkPhoto) => string | null;
  pending: string[];
}) {
  const all = pkg.landmarkPhotos.filter(isWebImage);
  if (all.length === 0) return null;
  const now = seasonOf(new Date());
  const inPlace = placeId ? all.filter((p) => p.waypointId === placeId) : all;
  const shown = season === 'all' ? inPlace : inPlace.filter((p) => p.season === season);
  const place = pkg.trail.waypoints.find((w) => w.id === placeId);
  const placesWithPhotos = pkg.trail.waypoints.filter((w) => all.some((p) => p.waypointId === w.id));

  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>{place ? place.name : 'Reference photos'}</Text>
      {place && (
        <Text style={styles.meta}>
          {place.kind ? `${KIND_LABEL[place.kind]} · ` : ''}
          {place.description ?? ''}
        </Text>
      )}
      <Text style={styles.label}>Season</Text>
      <View style={styles.wrap}>
        {(['all', 'spring', 'summer', 'fall', 'winter'] as const).map((s) => {
          const n = s === 'all' ? inPlace.length : inPlace.filter((p) => p.season === s).length;
          const name = s === 'all' ? 'All' : SEASON_NAMES[s];
          return (
            <Button
              key={s}
              title={`${name}${s === now ? ' (now)' : ''} · ${n}`}
              kind={season === s ? 'selected' : 'secondary'}
              onPress={() => onSeason(s)}
            />
          );
        })}
      </View>
      <Text style={styles.label}>Place</Text>
      <View style={styles.wrap}>
        <Button title="All places" kind={placeId === null ? 'selected' : 'secondary'} onPress={() => onPlace(null)} />
        {placesWithPhotos.map((w) => (
          <Button key={w.id} title={w.name} kind={placeId === w.id ? 'selected' : 'secondary'} onPress={() => onPlace(w.id)} />
        ))}
      </View>
      {shown.length === 0 ? (
        <Text style={styles.body}>
          No {season === 'all' ? '' : `${SEASON_NAMES[season].toLowerCase()} `}photos of {place ? place.name : 'this trail'} yet. Hikers can
          add theirs from the trail.
        </Text>
      ) : (
        <View style={styles.grid}>
          {shown.map((p) => (
            <Pressable key={p.id} accessibilityLabel={`Photo: ${p.title ?? 'trail photo'}`} onPress={() => onOpen(p)} style={styles.thumbWrap}>
              {photoSrc(p) ? (
                <Image source={{ uri: photoSrc(p)! }} style={styles.thumb} resizeMode="cover" />
              ) : (
                <View style={[styles.thumb, styles.thumbMissing]}>
                  <Text style={styles.thumbCaption}>Not saved offline</Text>
                </View>
              )}
              <Text style={styles.thumbCaption} numberOfLines={1}>
                {p.season ? SEASON_NAMES[p.season] : ''} {p.capturedAt.slice(0, 4)}
              </Text>
            </Pressable>
          ))}
        </View>
      )}
      {pending.length > 0 && (
        <>
          <Text style={styles.label}>Your photos waiting to upload ({pending.length})</Text>
          <View style={styles.grid}>
            {pending.map((src, i) => (
              <Image key={i} source={{ uri: src }} style={[styles.thumb, styles.thumbPending, { width: '31%' }]} accessibilityLabel="Photo waiting to upload" />
            ))}
          </View>
        </>
      )}
      <Text style={styles.meta}>Photos from Wikimedia Commons and hikers; tap one for the credit.</Text>
    </View>
  );
}

function PhotoViewer({
  photo,
  pkg,
  src,
  onClose,
}: {
  photo: LandmarkPhoto | null;
  pkg: TripPackage | null;
  src: string | null;
  onClose: () => void;
}) {
  if (!photo || !pkg) return null;
  const place = pkg.trail.waypoints.find((w) => w.id === photo.waypointId);
  const a = photo.attribution;
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.viewer}>
        {src ? (
          <Image source={{ uri: src }} style={styles.viewerImage} resizeMode="contain" accessibilityLabel={photo.title ?? 'Trail photo'} />
        ) : (
          <Text style={styles.viewerMeta}>This photo wasn't saved for offline use.</Text>
        )}
        <View style={styles.viewerInfo}>
          <Text style={[styles.cardTitle, { color: '#fff' }]}>{photo.title ?? 'Trail photo'}</Text>
          <Text style={styles.viewerMeta}>
            {place?.name ?? ''} · {photo.season ? SEASON_NAMES[photo.season] : ''} · {photo.capturedAt.slice(0, 10)}
          </Text>
          {a && (
            <Text style={styles.viewerMeta}>
              Photo: {a.author} · {a.license}
            </Text>
          )}
          <View style={styles.row}>
            {a && /^https:\/\//.test(a.sourceUrl) && (
              <Button title="View on Wikimedia Commons" kind="secondary" onPress={() => Linking.openURL(a.sourceUrl)} />
            )}
            <Button title="Close" onPress={onClose} />
          </View>
        </View>
      </View>
    </Modal>
  );
}

// ---- "Where am I?": match your photo against the downloaded reference photos ----
// Runs entirely on the device (no internet): see mobile/src/core/imageFingerprint.ts.

type SeriesPhoto = { id: string; base64: string; preview: string; embedding: number[] };
const pct = (c: number) => `${Math.round(c * 100)}%`;

function WhereAmI({
  pkg,
  refs,
  photoSrc,
  onShowPlace,
  onShare,
}: {
  pkg: TripPackage;
  refs: ReferenceEmbedding[];
  photoSrc: (p: LandmarkPhoto) => string | null;
  onShowPlace: (placeId: string) => void;
  onShare: (photos: SeriesPhoto[], placeId: string, confidence: number) => void;
}) {
  const [series, setSeries] = useState<SeriesPhoto[]>([]);
  const [problem, setProblem] = useState('');
  const guesses = useMemo(() => rankPlaces(series.map((s) => s.embedding), refs), [series, refs]);
  const top = guesses[0];
  const level = top ? confidenceLevel(top.confidence) : 'low';
  const place = top && pkg.trail.waypoints.find((w) => w.id === top.placeId);
  const lookalike = top && pkg.landmarkPhotos.find((p) => p.id === top.bestPhotoId);
  const lookalikeSrc = lookalike ? photoSrc(lookalike) : null;
  const placeCount = new Set(refs.map((r) => r.placeId)).size;

  const addPhoto = async (from: 'camera' | 'library') => {
    setProblem('');
    try {
      if (from === 'camera') {
        const perm = await ImagePicker.requestCameraPermissionsAsync();
        if (!perm.granted) return setProblem('Camera permission is needed to take a photo.');
      }
      const opts: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], base64: true, quality: 0.6, exif: false };
      const result = from === 'camera' ? await ImagePicker.launchCameraAsync(opts) : await ImagePicker.launchImageLibraryAsync(opts);
      if (result.canceled || !result.assets?.[0]) return;
      const a = result.assets[0];
      const base64 = a.base64 ?? (a.uri.startsWith('data:') ? a.uri.slice(a.uri.indexOf(',') + 1) : '');
      const mime = a.mimeType ?? (/^data:([^;]+)/.exec(a.uri)?.[1] ?? '');
      if (!base64 || !/jpe?g/i.test(mime || 'image/jpeg')) {
        return setProblem('Please use a JPEG photo (phone cameras take JPEGs by default).');
      }
      const embedding = fingerprint(decodeJpeg(base64));
      setSeries((s) => [...s, { id: makeId('photo'), base64, preview: `data:image/jpeg;base64,${base64}`, embedding }]);
    } catch (e) {
      setProblem(`Couldn't read that photo (${e instanceof Error ? e.message : e}).`);
    }
  };

  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>Where am I?</Text>
      <Text style={styles.meta}>
        Take a photo and OffGrid compares it with the {refs.length} reference photos of {placeCount} places saved on this
        device. Works with no internet.
      </Text>
      {refs.length === 0 ? (
        <Text style={styles.body}>No reference photos saved for this trail yet. Open it while online to save them.</Text>
      ) : (
        <View style={styles.row}>
          <Button title="Take a photo" onPress={() => addPhoto('camera')} />
          <Button title="Choose a photo" kind="secondary" onPress={() => addPhoto('library')} />
          {series.length > 0 && <Button title="Start over" kind="secondary" onPress={() => setSeries([])} />}
        </View>
      )}
      {!!problem && <Text style={styles.error}>{problem}</Text>}

      {top && place && (
        <View style={styles.guess}>
          <Text style={styles.guessTitle}>
            {level === 'low' ? 'Not sure yet' : `Probably ${place.name}`}
          </Text>
          <Text style={styles.meta}>
            {level === 'low'
              ? `Best guess ${place.name} at ${pct(top.confidence)}. Take another photo of something distinctive (a sign, the tower, a view).`
              : `${pct(top.confidence)} confidence (${level}) from ${series.length} photo${series.length === 1 ? '' : 's'}.`}
          </Text>
          <View style={styles.row}>
            {series.map((s) => (
              <Image key={s.id} source={{ uri: s.preview }} style={styles.compareThumb} accessibilityLabel="Your photo" />
            ))}
            {lookalikeSrc && (
              <View style={{ alignItems: 'center' }}>
                <Image source={{ uri: lookalikeSrc }} style={[styles.compareThumb, styles.compareRef]} accessibilityLabel="Closest reference photo" />
                <Text style={styles.thumbCaption}>closest match</Text>
              </View>
            )}
          </View>
          {guesses.slice(1, 3).map((g) => (
            <Text key={g.placeId} style={styles.meta}>
              {pkg.trail.waypoints.find((w) => w.id === g.placeId)?.name}: {pct(g.confidence)}
            </Text>
          ))}
          <View style={styles.row}>
            <Button title="Show on map" kind="secondary" onPress={() => onShowPlace(place.id)} />
            {level === 'high' && (
              <Button
                title={`Share ${series.length === 1 ? 'photo' : `${series.length} photos`} as a reference`}
                onPress={() => {
                  onShare(series, place.id, top.confidence);
                  setSeries([]);
                }}
              />
            )}
            {level === 'medium' && (
              <Button
                title={`Yes, I'm at ${place.name}: share`}
                onPress={() => {
                  onShare(series, place.id, top.confidence);
                  setSeries([]);
                }}
              />
            )}
          </View>
          {level === 'low' && <Text style={styles.meta}>Low-confidence photos stay on this phone and aren't shared.</Text>}
        </View>
      )}
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
  const [photoData, setPhotoData] = useState<Record<string, string>>({}); // photo id -> image saved on device
  const [refEmbeddings, setRefEmbeddings] = useState<Record<string, ReferenceEmbedding[]>>({}); // trail id -> fingerprints
  const blocked = useBlockedCount();
  const [picked, setPicked] = useState<LatLng | null>(null);
  const [placeId, setPlaceId] = useState<string | null>(null);
  const [season, setSeason] = useState<Season | 'all'>('all');
  const [viewerPhoto, setViewerPhoto] = useState<LandmarkPhoto | null>(null);
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

  /**
   * Saves a trail's reference photos ON THE DEVICE (as data URIs) and
   * fingerprints them, so the gallery and "Where am I?" work with no internet.
   */
  const saveForOffline = async (p: TripPackage) => {
    const photos = p.landmarkPhotos.filter(isWebImage);
    const saved: Record<string, string> = {};
    const embeddings: ReferenceEmbedding[] = [];
    for (const photo of photos) {
      try {
        const data = photoData[photo.id] ?? (await toDataUri(assetUrl(photo.thumbnailUrl ?? photo.uri)));
        saved[photo.id] = data;
        if (/^data:image\/jpe?g/i.test(data)) {
          embeddings.push({ placeId: photo.waypointId, photoId: photo.id, embedding: fingerprint(decodeJpeg(data)) });
        }
      } catch {
        // One photo failing (e.g. rate-limited) shouldn't stop the rest.
      }
      setStatus(`Saving photos for offline use… ${Object.keys(saved).length}/${photos.length}`);
    }
    setPhotoData((prev) => ({ ...prev, ...saved }));
    setRefEmbeddings((prev) => ({ ...prev, [p.trailId]: embeddings }));
    return Object.keys(saved).length;
  };
  const photoSrc = (p: LandmarkPhoto): string | null =>
    photoData[p.id] ?? (offline ? null : assetUrl(p.thumbnailUrl ?? p.uri));

  const openTrail = (trailId: string) =>
    run(async () => {
      setPicked(null);
      setPlaceId(null);
      if (!offline) {
        const firstTime = !packages[trailId];
        const p = await fetchPackage(trailId); // first download, or refresh while we have signal
        setOpenTrailId(trailId);
        const n = await saveForOffline(p);
        setStatus(
          firstTime
            ? `Downloaded with ${n} photo${n === 1 ? '' : 's'}. This trail now works with no internet.`
            : `Up to date; ${n} photo${n === 1 ? '' : 's'} saved for offline.`,
        );
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
      const ack = await api<{ message?: string }>(offline, 'POST', UPLOAD_PATH[item.kind], item.body);
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

  const goOffline = () => {
    net.offline = true;
    net.blocked = 0;
    setOffline(true);
    setStatus('Offline: the app can no longer reach the internet. Everything below runs from this device.');
  };

  /** Photos from "Where am I?" become reference-photo contributions (queued if offline). */
  const sharePhotos = (photos: { base64: string; preview: string }[], waypointId: string, confidence: number) => {
    if (!pkg) return;
    const place = pkg.trail.waypoints.find((w) => w.id === waypointId);
    for (const ph of photos) {
      send({
        kind: 'photo',
        trailId: pkg.trailId,
        label: `photo of ${place?.name ?? 'the trail'} (${Math.round(confidence * 100)}% match)`,
        preview: ph.preview,
        body: {
          id: makeId('photo'),
          trailId: pkg.trailId,
          waypointHintId: waypointId,
          capturedAt: new Date().toISOString(),
          location: place?.location,
          gpsWeakOrMissing: true, // place inferred from the photo match, not GPS
          imageBase64: ph.base64,
          contributorId: DEVICE_HIKER_ID,
        },
      });
    }
  };

  /** Back online: send everything queued, in order; stop at the first failure and keep the rest. */
  const goOnline = () => {
    net.offline = false;
    setOffline(false);
    if (queue.length === 0) return;
    run(async () => {
      let sent = 0;
      const touched = new Set<string>();
      for (const item of queue) {
        try {
          await api(false, 'POST', UPLOAD_PATH[item.kind], item.body);
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
            <Text style={styles.netTitle}>{offline ? 'Offline: no internet' : 'Online'}</Text>
            <Text style={styles.meta}>
              {offline
                ? `${queue.length} change${queue.length === 1 ? '' : 's'} saved on this device, waiting to sync`
                : 'Plan and download your trail, then go offline.'}
            </Text>
            {offline && (
              <Text style={styles.proof} accessibilityLabel="Blocked internet requests">
                Internet requests blocked: {blocked} · sent: 0
              </Text>
            )}
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={offline ? 'Go back online' : 'Go offline'}
            onPress={offline ? goOnline : goOffline}
            style={({ pressed }) => [styles.offlineBtn, offline && styles.offlineBtnOn, pressed && { opacity: 0.7 }]}
          >
            <Text style={styles.offlineBtnText}>{offline ? 'Back online' : 'Go offline'}</Text>
          </Pressable>
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
                onMiss={() => setError('Tap on (or right next to) a trail to place a hazard.')}
                selectedPlaceId={placeId}
                onSelectPlace={(id) => {
                  setPlaceId(id);
                  setPicked(null);
                  setError('');
                }}
              />
              <Text style={styles.meta}>
                Drag to move, +/− to zoom. Tap a place to see its photos; tap any trail to report a hazard.
                {pkg.trail.branches?.length ? ` Dashed lines are side trails (${pkg.trail.branches.length}).` : ''}
              </Text>
              <Button
                title="← All trails"
                kind="secondary"
                onPress={() => {
                  setOpenTrailId(null);
                  setPicked(null);
                  setPlaceId(null);
                  setStatus('');
                }}
              />
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

            <WhereAmI
              pkg={pkg}
              refs={refEmbeddings[pkg.trailId] ?? []}
              photoSrc={photoSrc}
              onShowPlace={(id) => setPlaceId(id)}
              onShare={sharePhotos}
            />

            <PhotoGallery
              pkg={pkg}
              placeId={placeId}
              onPlace={setPlaceId}
              season={season}
              onSeason={setSeason}
              onOpen={setViewerPhoto}
              photoSrc={photoSrc}
              pending={queue.filter((q): q is Extract<QueuedUpload, { kind: 'photo' }> => q.kind === 'photo' && q.trailId === pkg.trailId).map((q) => q.preview)}
            />

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
        <Text style={styles.footer}>Map data © OpenStreetMap contributors · Photos: Wikimedia Commons (credited per photo) · demo build</Text>
      </ScrollView>
      <PhotoViewer
        photo={viewerPhoto}
        pkg={pkg}
        src={viewerPhoto ? photoData[viewerPhoto.id] ?? (offline ? null : assetUrl(viewerPhoto.uri)) : null}
        onClose={() => setViewerPhoto(null)}
      />
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
  proof: { fontSize: 13, fontWeight: '700', color: '#8a4b00', marginTop: 2 },
  offlineBtn: { backgroundColor: '#1b3a2a', paddingVertical: 12, paddingHorizontal: 16, borderRadius: 12 },
  offlineBtnOn: { backgroundColor: '#2e7d4f' },
  offlineBtnText: { color: '#fff', fontWeight: '800', fontSize: 15 },
  thumbMissing: { alignItems: 'center', justifyContent: 'center' },
  thumbPending: { borderWidth: 2, borderColor: '#5d6f64', borderStyle: 'dashed' },
  guess: { gap: 6, padding: 12, borderRadius: 12, backgroundColor: '#eef4ef' },
  guessTitle: { fontSize: 20, fontWeight: '800', color: '#1b3a2a' },
  compareThumb: { width: 96, height: 72, borderRadius: 8, backgroundColor: '#dfe7e1' },
  compareRef: { borderWidth: 2, borderColor: '#2e7d4f' },
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
  zoomBar: { position: 'absolute', top: 8, right: 8, gap: 6 },
  zoomBtn: {
    width: 36,
    height: 36,
    borderRadius: 8,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#c9d5cc',
  },
  zoomText: { fontSize: 20, fontWeight: '700', color: '#1b3a2a' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  thumbWrap: { width: '31%', gap: 2 },
  thumb: { width: '100%', aspectRatio: 4 / 3, borderRadius: 8, backgroundColor: '#dfe7e1' },
  thumbCaption: { fontSize: 11, color: '#5d6f64' },
  viewer: { flex: 1, backgroundColor: 'rgba(10,20,14,0.94)', justifyContent: 'center', padding: 16, gap: 12 },
  viewerImage: { width: '100%', height: '60%' },
  viewerInfo: { gap: 6 },
  viewerMeta: { color: '#d7e3da', fontSize: 13 },
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
