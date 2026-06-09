import { useRef, useState, useEffect, useCallback, useMemo } from "react";
import { TransformWrapper, TransformComponent } from "react-zoom-pan-pinch";
import {
  Train,
  Settings,
  User,
  Navigation,
  ZoomIn,
  ZoomOut,
  Hand,
  PenLine,
  Eraser,
  Download,
  Layers,
  Crosshair,
  ShieldCheck,
  Search,
  MapPin,
  Clock,
  ArrowRight,
} from "lucide-react";
import NearbyPopup from "./NearbyPopup";
import AlignmentBadge from "./AlignmentBadge";

type Tool = "pan" | "draw" | "eraser";
type Point = { x: number; y: number };

type Station = {
  seq?: number;
  code?: string;
  name?: string;
  day?: number;
  arrival?: string;
  departure?: string;
  lat?: number;
  lon?: number;
};

type MatchRoute = {
  train_name?: string;
  train_no?: string;
  route_line?: number[][];
  distance_px_norm?: number;
  route_length_km?: number;
  station_count?: number;
  stations?: Station[];
};

type NearbyStationFromMatch = {
  code: string;
  name: string;
  lat: number;
  lon: number;
  distance_km: number;
};

type JourneyStep = {
  station_code: string;
  station_name: string;
  via_train_no: string | null;
  via_train_name: string | null;
  leg_minutes: number;
};

type JourneyResult = {
  from_code: string;
  from_name: string;
  to_code: string;
  to_name: string;
  total_minutes: number;
  total_hours: number;
  direct_train: boolean;
  stops: number;
  path: JourneyStep[];
};

type MatchResponse = {
  ok?: boolean;
  result?: {
    annotation_length_norm?: number;
    candidates?: number;
    best?: MatchRoute[];
  };
  nearby_stations?: NearbyStationFromMatch[];
};

type NearbySegment = {
  route_id: string;
  train_name: string;
  train_type: string | null;
  station_count: number;
  route_length_km: number;
  nearest_distance_km: number;
};

type AlignmentResultData = {
  status: "COMPLIANT" | "MISALIGNMENT_DETECTED";
  frechet_distance_km: number;
  compliance_threshold_km: number;
  max_deviation: {
    reference_point: [number, number];
    inspection_point: [number, number];
    deviation_km: number;
  };
  route_info: {
    train_no: string;
    train_name: string;
    route_length_km: number;
  };
};

type SearchResult = {
  train_no: string;
  train_name: string;
  train_type: string | null;
  station_count: number;
  route_length_km: number;
  origin: string;
  destination: string;
};

type MatchedRoute = {
  label: string;
  color: string;
  points: Point[];
  glow: string;
  trainNo?: string;
  trainName?: string;
  distanceNorm?: number;
  routeLengthKm?: number;
  stationCount?: number;
  stations?: Station[];
};

type GeoGeometry = {
  type: "Polygon" | "MultiPolygon";
  coordinates: number[][][] | number[][][][];
};

type GeoFeature = {
  type: "Feature";
  geometry: GeoGeometry;
  properties?: Record<string, unknown>;
};

type GeoFeatureCollection = {
  type: "FeatureCollection";
  features: GeoFeature[];
};

type RightTab = "insights" | "stations" | "journey";

const BRUSH_COLOR = "#3b82f6";
const BRUSH_SIZE = 12;
const ROUTE_PALETTE = [
  { line: "#ef4444", glow: "rgba(239,68,68,0.45)" },
  { line: "#f59e0b", glow: "rgba(245,158,11,0.45)" },
  { line: "#10b981", glow: "rgba(16,185,129,0.45)" },
  { line: "#3b82f6", glow: "rgba(59,130,246,0.45)" },
  { line: "#a855f7", glow: "rgba(168,85,247,0.5)" },
];

const MAP_BOUNDS = {
  minLon: 68.18624878,
  minLat: 6.75425577,
  maxLon: 97.41516113,
  maxLat: 35.50133133,
};

const MAP_WIDTH = 1000;
const MAP_HEIGHT = 1000;

const API_BASE = (import.meta.env.VITE_API_BASE_URL || "").replace(/\/$/, "");
const apiUrl = (p: string) => (API_BASE ? `${API_BASE}${p}` : p);

function getRouteStyle(index: number) {
  if (index < ROUTE_PALETTE.length) return ROUTE_PALETTE[index];
  const hue = (index * 47) % 360;
  return { line: `hsl(${hue} 80% 58%)`, glow: `hsla(${hue} 90% 60% / 0.45)` };
}

function clamp01(v: number) {
  return Math.max(0, Math.min(1, v));
}

function lonLatToPixel(lon: number, lat: number, width: number, height: number): Point {
  const xNorm = (lon - MAP_BOUNDS.minLon) / (MAP_BOUNDS.maxLon - MAP_BOUNDS.minLon);
  const yNorm = (MAP_BOUNDS.maxLat - lat) / (MAP_BOUNDS.maxLat - MAP_BOUNDS.minLat);
  return { x: clamp01(xNorm) * width, y: clamp01(yNorm) * height };
}

function pixelToLonLat(point: Point, width: number, height: number): [number, number] {
  const xNorm = clamp01(point.x / width);
  const yNorm = clamp01(point.y / height);
  const lon = MAP_BOUNDS.minLon + xNorm * (MAP_BOUNDS.maxLon - MAP_BOUNDS.minLon);
  const lat = MAP_BOUNDS.maxLat - yNorm * (MAP_BOUNDS.maxLat - MAP_BOUNDS.minLat);
  return [lon, lat];
}

function ringToPath(ring: number[][], width: number, height: number): string {
  if (!ring.length) return "";
  const first = lonLatToPixel(ring[0][0], ring[0][1], width, height);
  let path = `M ${first.x} ${first.y}`;
  for (let i = 1; i < ring.length; i += 1) {
    const p = lonLatToPixel(ring[i][0], ring[i][1], width, height);
    path += ` L ${p.x} ${p.y}`;
  }
  return `${path} Z`;
}

function geometryToPath(geometry: GeoGeometry, width: number, height: number): string {
  if (geometry.type === "Polygon") {
    return (geometry.coordinates as number[][][])
      .map((ring) => ringToPath(ring, width, height))
      .join(" ");
  }
  return (geometry.coordinates as number[][][][])
    .map((polygon) => polygon.map((ring) => ringToPath(ring, width, height)).join(" "))
    .join(" ");
}

function haversineKm(a: [number, number], b: [number, number]) {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const h =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * R * Math.asin(Math.sqrt(h));
}

function polylineKm(coords: [number, number][]) {
  let sum = 0;
  for (let i = 0; i < coords.length - 1; i += 1) sum += haversineKm(coords[i], coords[i + 1]);
  return sum;
}

function formatStationTime(station?: Station) {
  if (!station) return "-";
  const day = station.day ? `Day ${station.day}` : "Day ?";
  const dep = station.departure && station.departure !== "None" ? station.departure.slice(0, 5) : "--:--";
  const arr = station.arrival && station.arrival !== "None" ? station.arrival.slice(0, 5) : "--:--";
  return `${day} | Arr ${arr} | Dep ${dep}`;
}

function estimateDurationHours(stations: Station[]) {
  if (!stations.length) return null;
  const parseMinutes = (t?: string) => {
    if (!t || t === "None") return null;
    const parts = t.split(":");
    if (parts.length < 2) return null;
    const hh = Number(parts[0]);
    const mm = Number(parts[1]);
    if (Number.isNaN(hh) || Number.isNaN(mm)) return null;
    return hh * 60 + mm;
  };
  const first = stations.find((s) => parseMinutes(s.departure) !== null || parseMinutes(s.arrival) !== null);
  const last = [...stations].reverse().find((s) => parseMinutes(s.arrival) !== null || parseMinutes(s.departure) !== null);
  if (!first || !last) return null;
  const firstMins = parseMinutes(first.departure) ?? parseMinutes(first.arrival);
  const lastMins = parseMinutes(last.arrival) ?? parseMinutes(last.departure);
  const firstDay = first.day || 1;
  const lastDay = last.day || firstDay;
  if (firstMins == null || lastMins == null) return null;
  const total = (lastDay - firstDay) * 1440 + (lastMins - firstMins);
  if (total <= 0) return null;
  return Math.round(total / 60);
}

function inferTrainType(name?: string) {
  const n = (name || "").toUpperCase();
  if (n.includes("SUPERFAST") || n.includes(" SF ") || n.endsWith(" SF") || n.startsWith("SF ")) return "Superfast Express";
  if (n.includes("RAJDHANI")) return "Rajdhani";
  if (n.includes("SHATABDI")) return "Shatabdi";
  if (n.includes("DURONTO")) return "Duronto";
  if (n.includes("EXP") || n.includes("EXPRESS")) return "Express";
  if (n.includes("PASS")) return "Passenger";
  return "N/A";
}

function isStoppingStation(station?: Station) {
  if (!station) return false;
  const arr = station.arrival && station.arrival !== "None" ? station.arrival : null;
  const dep = station.departure && station.departure !== "None" ? station.departure : null;
  if ((arr && !dep) || (!arr && dep)) return true;
  if (arr && dep) return arr !== dep;
  return false;
}

// Lower distanceNorm = better match. 0 = perfect, ≥0.05 = poor.
function getMatchScore(distanceNorm?: number): number {
  if (distanceNorm == null) return 0;
  return Math.max(0, Math.min(100, Math.round((1 - distanceNorm / 0.05) * 100)));
}

function formatMinutes(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

export default function MapCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mapWrapRef = useRef<HTMLDivElement>(null);

  const [isDrawing, setIsDrawing] = useState(false);
  const [tool, setTool] = useState<Tool>("pan");
  const [history, setHistory] = useState<ImageData[]>([]);
  const [matchedRoutes, setMatchedRoutes] = useState<MatchedRoute[]>([]);
  const [activeRouteLabel, setActiveRouteLabel] = useState<string | null>(null);
  const [hoveredRouteLabel, setHoveredRouteLabel] = useState<string | null>(null);
  const [mapPaths, setMapPaths] = useState<string[]>([]);
  const [cursorCoords, setCursorCoords] = useState({ lat: 26.2006, lon: 92.9376 });
  const [annotationLengthKm, setAnnotationLengthKm] = useState(0);

  const [matchLoading, setMatchLoading] = useState(false);
  const [matchError, setMatchError] = useState<string | null>(null);

  const [nearbyPopup, setNearbyPopup] = useState<{ lat: number; lon: number } | null>(null);
  const [nearbySegments, setNearbySegments] = useState<NearbySegment[]>([]);
  const [nearbyLoading, setNearbyLoading] = useState(false);

  const [alignmentResult, setAlignmentResult] = useState<AlignmentResultData | null>(null);
  const [alignmentLoading, setAlignmentLoading] = useState(false);
  const [alignmentError, setAlignmentError] = useState<string | null>(null);

  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);

  // Right sidebar tab
  const [activeRightTab, setActiveRightTab] = useState<RightTab>("insights");

  // Nearby stations detected from drawn annotation (from /api/match response)
  const [matchNearbyStations, setMatchNearbyStations] = useState<NearbyStationFromMatch[]>([]);

  // Journey planner
  const [journeyFrom, setJourneyFrom] = useState("");
  const [journeyTo, setJourneyTo] = useState("");
  const [journeyResult, setJourneyResult] = useState<JourneyResult | null>(null);
  const [journeyLoading, setJourneyLoading] = useState(false);
  const [journeyError, setJourneyError] = useState<string | null>(null);

  const lastPos = useRef<Point | null>(null);
  const strokesRef = useRef<Point[][]>([]);
  const currentStrokeRef = useRef<Point[] | null>(null);
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = MAP_WIDTH;
    canvas.height = MAP_HEIGHT;
  }, []);

  useEffect(() => {
    let active = true;
    const loadMap = async () => {
      const res = await fetch("/india-states.geojson");
      if (!res.ok) return;
      const fc = (await res.json()) as GeoFeatureCollection;
      if (!active || !fc?.features?.length) return;
      const paths = fc.features
        .filter((f) => f?.geometry?.type === "Polygon" || f?.geometry?.type === "MultiPolygon")
        .map((f) => geometryToPath(f.geometry, MAP_WIDTH, MAP_HEIGHT))
        .filter(Boolean);
      setMapPaths(paths);
    };
    loadMap().catch(() => {});
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!matchedRoutes.length) { setActiveRouteLabel(null); return; }
    if (!activeRouteLabel || !matchedRoutes.some((r) => r.label === activeRouteLabel)) {
      setActiveRouteLabel(matchedRoutes[0].label);
    }
  }, [matchedRoutes, activeRouteLabel]);

  const saveToHistory = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (ctx && canvas) {
      setHistory((prev) => [...prev, ctx.getImageData(0, 0, canvas.width, canvas.height)]);
    }
  }, []);

  const getCanvasCoordinates = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    let clientX: number, clientY: number;
    if ("touches" in e) {
      if (!e.touches.length) return null;
      clientX = e.touches[0].clientX;
      clientY = e.touches[0].clientY;
    } else {
      clientX = e.clientX;
      clientY = e.clientY;
    }
    return { x: (clientX - rect.left) * scaleX, y: (clientY - rect.top) * scaleY };
  }, []);

  const startDrawing = useCallback(
    (e: React.MouseEvent | React.TouchEvent) => {
      if (tool === "pan") return;
      e.stopPropagation();
      saveToHistory();
      const coords = getCanvasCoordinates(e);
      if (!coords) return;
      setIsDrawing(true);
      lastPos.current = coords;
      const stroke: Point[] = [coords];
      strokesRef.current.push(stroke);
      currentStrokeRef.current = stroke;
    },
    [tool, saveToHistory, getCanvasCoordinates]
  );

  const draw = useCallback(
    (e: React.MouseEvent | React.TouchEvent) => {
      if (!isDrawing || tool === "pan") return;
      e.stopPropagation();
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (!ctx || !lastPos.current) return;
      const coords = getCanvasCoordinates(e);
      if (!coords) return;
      ctx.beginPath();
      ctx.moveTo(lastPos.current.x, lastPos.current.y);
      ctx.lineTo(coords.x, coords.y);
      ctx.strokeStyle = tool === "eraser" ? "#ffffff" : BRUSH_COLOR;
      ctx.lineWidth = tool === "eraser" ? BRUSH_SIZE * 4 : BRUSH_SIZE;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.globalCompositeOperation = tool === "eraser" ? "destination-out" : "source-over";
      ctx.stroke();
      currentStrokeRef.current?.push(coords);
      lastPos.current = coords;
    },
    [isDrawing, tool, getCanvasCoordinates]
  );

  const stopDrawing = useCallback(() => {
    setIsDrawing(false);
    lastPos.current = null;
    currentStrokeRef.current = null;
  }, []);

  const undo = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!ctx || !canvas || history.length === 0) return;
    const newHistory = [...history];
    newHistory.pop();
    setHistory(newHistory);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (newHistory.length > 0) ctx.putImageData(newHistory[newHistory.length - 1], 0, 0);
    strokesRef.current.pop();
  }, [history]);

  const clearCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!ctx || !canvas) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    setHistory([]);
    strokesRef.current = [];
    setMatchedRoutes([]);
    setActiveRouteLabel(null);
    setHoveredRouteLabel(null);
    setAnnotationLengthKm(0);
    setAlignmentResult(null);
    setAlignmentError(null);
    setMatchError(null);
    setNearbyPopup(null);
    setMatchNearbyStations([]);
    setJourneyResult(null);
    setJourneyError(null);
  }, []);

  const updateCursorFromMouse = useCallback((e: React.MouseEvent) => {
    const wrap = mapWrapRef.current;
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    const x = clamp01((e.clientX - rect.left) / rect.width) * MAP_WIDTH;
    const y = clamp01((e.clientY - rect.top) / rect.height) * MAP_HEIGHT;
    const [lon, lat] = pixelToLonLat({ x, y }, MAP_WIDTH, MAP_HEIGHT);
    setCursorCoords({ lat, lon });
  }, []);

  const handleMapClick = useCallback((e: React.MouseEvent) => {
    if (tool !== "pan") return;
    if (clickTimerRef.current) clearTimeout(clickTimerRef.current);
    const wrap = mapWrapRef.current;
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    const x = clamp01((e.clientX - rect.left) / rect.width) * MAP_WIDTH;
    const y = clamp01((e.clientY - rect.top) / rect.height) * MAP_HEIGHT;
    const [lon, lat] = pixelToLonLat({ x, y }, MAP_WIDTH, MAP_HEIGHT);
    clickTimerRef.current = setTimeout(async () => {
      setNearbyPopup({ lat, lon });
      setNearbyLoading(true);
      setNearbySegments([]);
      try {
        const res = await fetch(apiUrl(`/api/nearby-segments?lat=${lat}&lon=${lon}&radius=0.3&max=15`));
        if (res.ok) {
          const data = await res.json();
          setNearbySegments(data.segments || []);
        }
      } catch {}
      finally { setNearbyLoading(false); }
    }, 200);
  }, [tool]);

  const handleSelectNearbyTrain = useCallback(async (trainNo: string) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    try {
      const res = await fetch(apiUrl(`/api/routes/${trainNo}?geometry=true`));
      if (!res.ok) return;
      const data = await res.json();
      const route = data.route;
      if (!route?.route_line?.length) return;
      const projected = route.route_line
        .filter((c: number[]) => Array.isArray(c) && c.length >= 2)
        .map((c: number[]) => lonLatToPixel(c[0], c[1], canvas.width, canvas.height));
      if (projected.length < 2) return;
      const style = getRouteStyle(matchedRoutes.length);
      const label = route.train_name ? `${route.train_name} (${route.train_no})` : `Train ${route.train_no}`;
      setMatchedRoutes((prev) => [
        ...prev,
        {
          label, color: style.line, glow: style.glow, points: projected,
          trainNo: route.train_no, trainName: route.train_name,
          routeLengthKm: route.route_length_km, stationCount: route.station_count,
          stations: route.stations,
        },
      ]);
      setActiveRouteLabel(label);
      setNearbyPopup(null);
    } catch {}
  }, [matchedRoutes.length]);

  const activeRoute = useMemo(
    () => matchedRoutes.find((r) => r.label === activeRouteLabel) || matchedRoutes[0],
    [matchedRoutes, activeRouteLabel]
  );

  const hoveredRoute = useMemo(
    () => matchedRoutes.find((r) => r.label === hoveredRouteLabel) || null,
    [matchedRoutes, hoveredRouteLabel]
  );

  const verifyAlignment = useCallback(async () => {
    if (!activeRoute?.trainNo) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const validStrokes = strokesRef.current.filter((s) => s.length >= 2);
    if (!validStrokes.length) { setAlignmentError("Draw a route on the map first, then verify alignment."); return; }
    const coords = validStrokes.flatMap((stroke) => stroke.map((point) => pixelToLonLat(point, canvas.width, canvas.height)));
    setAlignmentLoading(true);
    setAlignmentResult(null);
    setAlignmentError(null);
    try {
      const res = await fetch(apiUrl("/api/verify-alignment"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ route_id: activeRoute.trainNo, inspection_coordinates: coords, compliance_threshold_km: 2.0 }),
      });
      if (!res.ok) { const err = await res.json(); setAlignmentError(err.error || "Verification failed"); return; }
      const data = await res.json();
      setAlignmentResult(data.result);
    } catch { setAlignmentError("Network error — could not reach the server."); }
    finally { setAlignmentLoading(false); }
  }, [activeRoute]);

  const handleSearch = useCallback(async (q: string) => {
    setSearchQuery(q);
    if (q.trim().length < 2) { setSearchResults([]); return; }
    setSearchLoading(true);
    try {
      const res = await fetch(apiUrl(`/api/search-trains?q=${encodeURIComponent(q)}&max=8`));
      if (res.ok) { const data = await res.json(); setSearchResults(data.results || []); }
    } catch {}
    finally { setSearchLoading(false); }
  }, []);

  // ── Journey Planner ─────────────────────────────────────────────────────────

  const planJourney = useCallback(async () => {
    const from = journeyFrom.trim().toUpperCase();
    const to = journeyTo.trim().toUpperCase();
    if (!from || !to) return;
    setJourneyLoading(true);
    setJourneyError(null);
    setJourneyResult(null);
    try {
      const res = await fetch(apiUrl(`/api/journey?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`));
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setJourneyError(err.error || `No path found between ${from} and ${to}.`);
        return;
      }
      const data = await res.json();
      setJourneyResult(data.journey);
    } catch {
      setJourneyError("Network error — could not reach server.");
    } finally {
      setJourneyLoading(false);
    }
  }, [journeyFrom, journeyTo]);

  const projectRouteLineToPixels = useCallback((routeLine: number[][], width: number, height: number) => {
    return routeLine
      .filter((coord) => Array.isArray(coord) && coord.length >= 2)
      .map((coord) => lonLatToPixel(coord[0], coord[1], width, height));
  }, []);

  const exportGeoJSON = useCallback(async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const validStrokes = strokesRef.current.filter((stroke) => stroke.length >= 2);
    if (!validStrokes.length) { setMatchError("Draw a path on the map first, then click Match."); return; }

    const strokeCoords = validStrokes.map((stroke) => stroke.map((point) => pixelToLonLat(point, canvas.width, canvas.height)));
    const strokePixelLines = validStrokes.map((stroke) =>
      stroke.map((point) => [clamp01(point.x / canvas.width), clamp01(point.y / canvas.height)])
    );

    const totalLengthKm = strokeCoords.reduce((sum, line) => sum + polylineKm(line), 0);
    setAnnotationLengthKm(totalLengthKm);

    const geojson = {
      type: "FeatureCollection",
      properties: { pixel_strokes: strokePixelLines, stroke_count: strokePixelLines.length },
      features: strokeCoords.map((line, idx) => ({
        type: "Feature",
        properties: { stroke_index: idx, pixel_line: strokePixelLines[idx] },
        geometry: { type: "LineString", coordinates: line },
      })),
    };

    setMatchLoading(true);
    setMatchError(null);
    setMatchedRoutes([]);
    setMatchNearbyStations([]);

    try {
      const matchRes = await fetch(apiUrl("/api/match"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(geojson),
      });

      if (!matchRes.ok) {
        const err = await matchRes.json().catch(() => ({}));
        setMatchError(err.error || `Server error ${matchRes.status}. Try again.`);
        return;
      }

      const matchData = (await matchRes.json()) as MatchResponse;
      const bestMatches = matchData.result?.best ?? [];

      // Store nearby stations detected from the annotation geography
      if (matchData.nearby_stations?.length) {
        setMatchNearbyStations(matchData.nearby_stations);
      }

      if (bestMatches.length === 0) {
        setMatchError("No matching routes found. Try drawing a longer or more precise path.");
        return;
      }

      const projectedRoutes: MatchedRoute[] = [];
      for (let i = 0; i < bestMatches.length; i += 1) {
        const route = bestMatches[i];
        const routeLine = route.route_line;
        if (!routeLine || routeLine.length < 2) continue;
        const projected = projectRouteLineToPixels(routeLine, canvas.width, canvas.height);
        if (projected.length < 2) continue;
        const name = route.train_name?.trim();
        const number = route.train_no?.trim();
        const label = name ? `${name}${number ? ` (${number})` : ""}` : number ? `Train ${number}` : `Match ${i + 1}`;
        const style = getRouteStyle(i);
        projectedRoutes.push({
          label, color: style.line, glow: style.glow, points: projected,
          trainNo: route.train_no, trainName: route.train_name,
          distanceNorm: route.distance_px_norm,
          routeLengthKm: route.route_length_km, stationCount: route.station_count,
          stations: route.stations,
        });
      }

      setMatchedRoutes(projectedRoutes);
      setHoveredRouteLabel(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      setMatchError(`Network error hitting ${apiUrl("/api/match")} — ${msg}. Check Vercel env var VITE_API_BASE_URL.`);
    } finally {
      setMatchLoading(false);
    }
  }, [projectRouteLineToPixels]);

  const displayedRoutes = useMemo(() => {
    const emphasis = hoveredRouteLabel || activeRouteLabel;
    if (!emphasis) return matchedRoutes;
    const active = matchedRoutes.find((route) => route.label === emphasis);
    if (!active) return matchedRoutes;
    return [...matchedRoutes.filter((route) => route.label !== emphasis), active];
  }, [matchedRoutes, hoveredRouteLabel, activeRouteLabel]);

  // Station dots: stopping stations of the active route that have coordinates
  const activeStationDots = useMemo(() => {
    if (!activeRoute?.stations) return [];
    return (activeRoute.stations)
      .filter(isStoppingStation)
      .filter((st) => st.lat != null && st.lon != null);
  }, [activeRoute]);

  const stopStations = (activeRoute?.stations || []).filter(isStoppingStation);
  const estDurationHours = estimateDurationHours(activeRoute?.stations || []);
  const trainType = inferTrainType(activeRoute?.trainName);

  return (
    <div className="h-screen w-screen bg-[#0B1120] text-slate-300 font-sans flex flex-col overflow-hidden">
      <header className="h-14 bg-[#111827] border-b border-gray-800 flex items-center justify-between px-6 z-20 shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded bg-blue-600/20 text-blue-400 flex items-center justify-center border border-blue-500/30">
            <Train size={18} />
          </div>
          <h1 className="text-gray-100 font-medium tracking-wide">DrawMyTrain</h1>
        </div>
        <div className="flex items-center gap-4 text-gray-400">
          <button className="hover:text-white transition-colors"><Settings size={18} /></button>
          <button className="hover:text-white transition-colors"><User size={18} /></button>
        </div>
      </header>

      <main className="flex-1 flex overflow-hidden">

        {/* ── LEFT SIDEBAR ─────────────────────────────────────────────────── */}
        <aside className="w-[340px] bg-[#111827] border-r border-gray-800 flex flex-col z-10 shrink-0">

          {/* Search */}
          <div className="p-4 border-b border-gray-800">
            <div className="relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => handleSearch(e.target.value)}
                placeholder="Search trains by name or number…"
                className="w-full bg-[#1f2937] border border-gray-700 rounded-lg pl-9 pr-3 py-2 text-sm text-gray-200 placeholder:text-gray-600 focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/20 transition-all"
              />
            </div>
            {searchLoading && <p className="text-[11px] text-gray-600 mt-1 pl-1">Searching…</p>}
            {searchResults.length > 0 && searchQuery.trim().length >= 2 && (
              <div className="mt-2 border border-gray-700 rounded-xl bg-[#1a2332] overflow-hidden shadow-lg">
                {searchResults.map((r) => (
                  <button
                    key={r.train_no}
                    onClick={() => { handleSelectNearbyTrain(r.train_no); setSearchQuery(""); setSearchResults([]); }}
                    className="w-full text-left px-4 py-2.5 hover:bg-[#1f2937] border-b border-gray-800 last:border-0 transition-colors"
                  >
                    <p className="text-sm text-gray-200 truncate">{r.train_name}</p>
                    <p className="text-[11px] text-gray-500">#{r.train_no} · {r.origin} → {r.destination}</p>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Annotation stats bar */}
          {annotationLengthKm > 0 && (
            <div className="px-4 py-2.5 border-b border-gray-800 bg-[#0d1520]/60 flex items-center justify-between">
              <div className="flex items-center gap-2 text-xs text-gray-500">
                <PenLine size={12} className="text-blue-400" />
                <span>Annotation drawn</span>
              </div>
              <span className="text-blue-400 font-mono text-xs font-medium">{annotationLengthKm.toFixed(0)} km</span>
            </div>
          )}

          {/* Routes Gallery header */}
          <div className="p-5 border-b border-gray-800">
            <h2 className="text-sm font-semibold text-gray-100">Routes Gallery</h2>
            <p className="text-xs text-gray-500 mt-1">BEST MATCHES ({matchedRoutes.length} Trains)</p>
          </div>

          {/* Route cards */}
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {matchedRoutes.length === 0 ? (
              <div className="text-xs text-gray-500 border border-dashed border-gray-700 rounded-xl p-4 leading-relaxed">
                Draw on the map and click <span className="text-gray-400">Match</span> to fetch best matches, or click anywhere on the map to find nearby routes.
              </div>
            ) : (
              matchedRoutes.map((route, idx) => {
                const isActive = activeRoute?.label === route.label;
                const isHovered = hoveredRouteLabel === route.label;
                const score = getMatchScore(route.distanceNorm);
                const scoreColor =
                  score >= 70 ? "text-green-400 bg-green-900/30" :
                  score >= 40 ? "text-yellow-400 bg-yellow-900/30" :
                  "text-red-400 bg-red-900/30";

                return (
                  <button
                    key={route.label}
                    onClick={() => setActiveRouteLabel(route.label)}
                    onMouseEnter={() => setHoveredRouteLabel(route.label)}
                    onMouseLeave={() => setHoveredRouteLabel(null)}
                    className="w-full text-left p-4 rounded-xl border transition-all duration-200 flex items-start gap-3 relative overflow-hidden bg-transparent"
                    style={{
                      borderColor: isActive ? route.color : isHovered ? "#4b5563" : "#1f2937",
                      boxShadow: isActive ? `0 0 18px ${route.glow}` : "none",
                      backgroundColor: isActive ? "rgba(31,41,55,0.7)" : isHovered ? "rgba(31,41,55,0.45)" : "transparent",
                    }}
                  >
                    <div className="w-3 h-3 rounded-full mt-1 shrink-0" style={{ backgroundColor: route.color }} />
                    <div className="flex-1 min-w-0">
                      <h3 className={`text-sm font-medium truncate ${isActive ? "text-white" : "text-gray-300"}`}>
                        {route.trainName || route.label}
                      </h3>
                      <p className="text-xs text-gray-500 mt-1">#{route.trainNo || "-"}</p>
                    </div>
                    <div className="flex flex-col items-end gap-1 shrink-0">
                      <span className="text-xs text-gray-600 font-mono">#{idx + 1}</span>
                      {route.distanceNorm != null && (
                        <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${scoreColor}`}>
                          {score}%
                        </span>
                      )}
                    </div>
                  </button>
                );
              })
            )}
          </div>

          {/* Nearby stations from match annotation */}
          {matchNearbyStations.length > 0 && (
            <div className="border-t border-gray-800 p-4 shrink-0">
              <div className="flex items-center gap-2 mb-2.5">
                <MapPin size={12} className="text-amber-500" />
                <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Stations Near Annotation</span>
              </div>
              <div className="space-y-1.5 max-h-[130px] overflow-y-auto">
                {matchNearbyStations.slice(0, 6).map((st) => (
                  <div key={st.code} className="flex items-center justify-between px-2.5 py-1.5 rounded-lg bg-[#1a2332] text-xs">
                    <div className="min-w-0 flex-1 mr-2">
                      <span className="text-gray-300 truncate block">{st.name}</span>
                      <span className="text-gray-600 font-mono">{st.code} · {st.distance_km} km</span>
                    </div>
                    <button
                      onClick={() => { setJourneyFrom(st.code); setActiveRightTab("journey"); }}
                      className="text-blue-500 hover:text-blue-300 text-[11px] px-2 py-1 rounded hover:bg-blue-900/20 transition-colors whitespace-nowrap flex items-center gap-0.5"
                    >
                      Plan <ArrowRight size={10} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </aside>

        {/* ── MAP ──────────────────────────────────────────────────────────── */}
        <section className="flex-1 relative bg-[#0a0f18] flex items-center justify-center overflow-hidden">
          <div
            className="absolute inset-0 opacity-20 pointer-events-none"
            style={{ backgroundImage: "radial-gradient(#334155 1px, transparent 1px)", backgroundSize: "30px 30px" }}
          />
          <div className="absolute inset-0 flex items-center justify-center opacity-30 pointer-events-none">
            <div className="w-[620px] h-[620px] border border-gray-700/50 rounded-full blur-[100px] bg-blue-900/20" />
          </div>

          <TransformWrapper initialScale={1} minScale={0.55} maxScale={6} disabled={tool !== "pan"} centerOnInit>
            {({ zoomIn, zoomOut }) => (
              <>
                <TransformComponent wrapperClass="!w-full !h-full overflow-auto" contentClass="!w-full !h-full flex items-center justify-center p-6">
                  <div
                    ref={mapWrapRef}
                    className="relative w-[min(90vw,900px)] max-w-full"
                    style={{ aspectRatio: `${MAP_WIDTH} / ${MAP_HEIGHT}` }}
                    onMouseMove={updateCursorFromMouse}
                    onClick={handleMapClick}
                  >
                    <svg
                      width={MAP_WIDTH}
                      height={MAP_HEIGHT}
                      viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`}
                      preserveAspectRatio="xMidYMin meet"
                      className="block h-full w-full"
                    >
                      {/* India state boundaries */}
                      <g fill="none" stroke="#334155" strokeWidth="1.05" strokeLinejoin="round" opacity="0.9">
                        {mapPaths.map((d, idx) => (
                          <path key={`state-${idx}`} d={d} />
                        ))}
                      </g>

                      {/* Matched route polylines */}
                      {displayedRoutes.map((route) => {
                        const highlighted =
                          (hoveredRouteLabel && hoveredRouteLabel === route.label) ||
                          (!hoveredRouteLabel && activeRoute && activeRoute.label === route.label);
                        const muted = hoveredRouteLabel && hoveredRouteLabel !== route.label;
                        const strokeWidth = highlighted ? 5 : 3;
                        const opacity = muted ? 0.16 : highlighted ? 1 : 0.65;
                        return (
                          <g key={`route-${route.label}`} style={{ opacity }}>
                            {highlighted && (
                              <polyline
                                points={route.points.map((p) => `${p.x},${p.y}`).join(" ")}
                                fill="none" stroke={route.color}
                                strokeWidth={strokeWidth + 6} strokeLinecap="round" strokeLinejoin="round" opacity="0.25"
                              />
                            )}
                            <polyline
                              points={route.points.map((p) => `${p.x},${p.y}`).join(" ")}
                              fill="none" stroke={route.color}
                              strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round"
                            />
                          </g>
                        );
                      })}

                      {/* Station dots for active route's stopping stations */}
                      {activeRoute && activeStationDots.map((st, i) => {
                        const p = lonLatToPixel(st.lon!, st.lat!, MAP_WIDTH, MAP_HEIGHT);
                        return (
                          <g key={`dot-${i}`}>
                            <circle cx={p.x} cy={p.y} r={6} fill={activeRoute.color} stroke="#0B1120" strokeWidth={2} opacity={0.85} />
                            <circle cx={p.x} cy={p.y} r={3} fill="#fff" opacity={0.7} />
                            <title>{st.name || st.code}</title>
                          </g>
                        );
                      })}
                    </svg>

                    <canvas
                      ref={canvasRef}
                      className="absolute inset-0"
                      style={{
                        width: "100%", height: "100%",
                        pointerEvents: tool === "pan" ? "none" : "auto",
                        touchAction: tool === "pan" ? "auto" : "none",
                      }}
                      onMouseDown={startDrawing}
                      onMouseMove={draw}
                      onMouseUp={stopDrawing}
                      onMouseLeave={stopDrawing}
                      onTouchStart={startDrawing}
                      onTouchMove={draw}
                      onTouchEnd={stopDrawing}
                    />
                  </div>
                </TransformComponent>

                {/* Hover preview card */}
                {hoveredRoute && (
                  <div className="absolute top-24 right-24 bg-[#1e293b]/95 backdrop-blur-md border border-gray-700 p-4 rounded-xl shadow-2xl max-w-xs z-30">
                    <h4 className="text-sm font-semibold text-white mb-1">{hoveredRoute.trainName || hoveredRoute.label}</h4>
                    <p className="text-xs text-gray-400 mb-2">Train No: {hoveredRoute.trainNo || "-"}</p>
                    <div className="text-xs text-gray-500 leading-relaxed border-t border-gray-700 pt-2">
                      Hover preview active. Click the route card to lock full details.
                    </div>
                  </div>
                )}

                {nearbyPopup && (
                  <NearbyPopup
                    lat={nearbyPopup.lat} lon={nearbyPopup.lon}
                    segments={nearbySegments} loading={nearbyLoading}
                    onClose={() => setNearbyPopup(null)} onSelectTrain={handleSelectNearbyTrain}
                  />
                )}

                <AlignmentBadge
                  result={alignmentResult} loading={alignmentLoading} error={alignmentError}
                  onClose={() => { setAlignmentResult(null); setAlignmentError(null); }}
                />

                {/* Cursor coords */}
                <div className="absolute top-6 left-6 flex items-center gap-2 bg-[#111827]/90 backdrop-blur border border-gray-800 px-3 py-1.5 rounded-lg shadow-lg text-xs font-mono text-slate-400 z-30">
                  <Crosshair size={13} className="text-blue-500" />
                  <span>Lat: {cursorCoords.lat.toFixed(4)}°</span>
                  <span className="text-slate-600">|</span>
                  <span>Lon: {cursorCoords.lon.toFixed(4)}°</span>
                </div>

                {/* Match loading / error banner */}
                {(matchError || matchLoading) && (
                  <div
                    className="absolute bottom-24 left-1/2 -translate-x-1/2 z-40 flex items-center gap-2 px-4 py-2.5 rounded-xl shadow-2xl border text-sm font-medium"
                    style={{
                      backgroundColor: matchLoading ? "rgba(17,24,39,0.97)" : "rgba(127,29,29,0.97)",
                      borderColor: matchLoading ? "#334155" : "#991b1b",
                      color: matchLoading ? "#94a3b8" : "#fca5a5",
                    }}
                  >
                    {matchLoading ? (
                      <>
                        <svg className="animate-spin w-4 h-4 text-blue-400" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                        </svg>
                        Matching route… this may take 30s on first load
                      </>
                    ) : (
                      <>
                        <span>{matchError}</span>
                        <button onClick={() => setMatchError(null)} className="ml-2 text-red-300 hover:text-white">✕</button>
                      </>
                    )}
                  </div>
                )}

                {/* Toolbar */}
                <div className="absolute bottom-6 left-1/2 -translate-x-1/2 bg-[#111827]/90 backdrop-blur border border-gray-800 p-2 rounded-2xl flex items-center gap-2 shadow-2xl z-30">
                  <IconButton icon={<ZoomIn size={18} />} tooltip="Zoom In" onClick={() => zoomIn()} />
                  <IconButton icon={<ZoomOut size={18} />} tooltip="Zoom Out" onClick={() => zoomOut()} />
                  <div className="w-px h-6 bg-gray-800 mx-1" />
                  <IconButton icon={<Hand size={18} />} tooltip="Pan Map" active={tool === "pan"} onClick={() => setTool("pan")} />
                  <IconButton icon={<PenLine size={18} />} tooltip="Draw Route" active={tool === "draw"} onClick={() => setTool("draw")} />
                  <IconButton icon={<Eraser size={18} />} tooltip="Eraser" active={tool === "eraser"} onClick={() => setTool("eraser")} />
                  <div className="w-px h-6 bg-gray-800 mx-1" />
                  <IconButton
                    icon={matchLoading
                      ? <svg className="animate-spin w-[18px] h-[18px]" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/></svg>
                      : <Download size={18} />}
                    tooltip={matchLoading ? "Matching…" : "Match Route"}
                    onClick={matchLoading ? undefined : exportGeoJSON}
                    active={matchLoading}
                  />
                  {activeRoute?.trainNo && (
                    <IconButton icon={<ShieldCheck size={18} />} tooltip="Verify Alignment" onClick={verifyAlignment} />
                  )}
                  <IconButton icon={<Layers size={18} />} tooltip="Clear Canvas" onClick={clearCanvas} />
                  <button
                    onClick={undo}
                    className="text-[11px] text-gray-400 px-2.5 py-2 rounded-xl hover:bg-gray-800 hover:text-gray-200 transition"
                    title="Undo"
                  >
                    Undo
                  </button>
                </div>
              </>
            )}
          </TransformWrapper>
        </section>

        {/* ── RIGHT SIDEBAR ─────────────────────────────────────────────────── */}
        <aside className="w-[320px] bg-[#111827] border-l border-gray-800 flex flex-col z-10 shrink-0 shadow-2xl">

          {/* Tab bar */}
          <div className="flex border-b border-gray-800 shrink-0">
            {(["insights", "stations", "journey"] as RightTab[]).map((tab) => {
              const labels: Record<RightTab, string> = { insights: "Insights", stations: "Stations", journey: "Journey" };
              const icons: Record<RightTab, React.ReactNode> = {
                insights: <Navigation size={12} />,
                stations: <Train size={12} />,
                journey: <MapPin size={12} />,
              };
              return (
                <button
                  key={tab}
                  onClick={() => setActiveRightTab(tab)}
                  className={`flex-1 flex items-center justify-center gap-1.5 py-3.5 text-xs font-medium transition-colors border-b-2 ${
                    activeRightTab === tab
                      ? "text-blue-400 border-blue-500 bg-blue-900/10"
                      : "text-gray-500 border-transparent hover:text-gray-300"
                  }`}
                >
                  {icons[tab]}
                  {labels[tab]}
                </button>
              );
            })}
          </div>

          {/* ── TAB 1: Route Insights ── */}
          {activeRightTab === "insights" && (
            <div className="flex-1 overflow-y-auto">
              <div className="p-5 text-sm">
                <div className="uppercase text-[10px] tracking-widest text-gray-500 mb-3 font-semibold">Route Analytics — Selected</div>
                <h3 className="text-gray-200 font-medium leading-snug mb-6">
                  {activeRoute?.trainName || "No route selected"}
                  <span className="block text-gray-500 text-xs mt-1">({activeRoute?.trainNo || "-"})</span>
                </h3>

                {activeRoute ? (
                  <>
                    <div className="mb-6 rounded-xl border border-gray-700/60 overflow-hidden bg-[#1f2937]/40">
                      <div className="grid grid-cols-2">
                        <div className="p-3 border-r border-b border-gray-700/60">
                          <div className="text-xs text-gray-500 mb-1">Distance</div>
                          <div className="text-2xl font-semibold text-gray-200">
                            {activeRoute.routeLengthKm ? `${activeRoute.routeLengthKm.toFixed(0)} km` : "N/A"}
                          </div>
                        </div>
                        <div className="p-3 border-b border-gray-700/60">
                          <div className="text-xs text-gray-500 mb-1">Est. Duration</div>
                          <div className="text-2xl font-semibold text-gray-200">
                            {estDurationHours ? `${estDurationHours} hrs` : "N/A"}
                          </div>
                        </div>
                      </div>
                      <div className="p-3 border-b border-gray-700/60">
                        <div className="text-xs text-gray-500 mb-1">Major Stops</div>
                        <div className="text-2xl font-semibold text-gray-200">{stopStations.length}</div>
                      </div>
                      <div className="grid grid-cols-2">
                        <div className="p-3 border-r border-gray-700/60">
                          <div className="text-xs text-gray-500 mb-1">Train Type</div>
                          <div className="text-lg font-semibold text-gray-200">{trainType}</div>
                        </div>
                        <div className="p-3">
                          <div className="text-xs text-gray-500 mb-1">Match Score</div>
                          <div className={`text-lg font-semibold ${
                            getMatchScore(activeRoute.distanceNorm) >= 70 ? "text-green-400" :
                            getMatchScore(activeRoute.distanceNorm) >= 40 ? "text-yellow-400" : "text-red-400"
                          }`}>
                            {activeRoute.distanceNorm != null ? `${getMatchScore(activeRoute.distanceNorm)}%` : "N/A"}
                          </div>
                        </div>
                      </div>
                    </div>

                    <div>
                      <div className="text-xs font-semibold text-gray-400 mb-4 flex items-center gap-2">
                        <Navigation size={14} className="text-blue-500" />
                        Stopping Stations
                      </div>
                      <div className="space-y-4 relative before:absolute before:inset-0 before:ml-[5px] before:h-full before:w-px before:bg-gray-800">
                        {stopStations.map((station, idx) => (
                          <div key={`${station.code || station.name || "st"}-${idx}`} className="relative flex flex-col pl-6">
                            <div className="absolute left-0 top-1 w-3 h-3 bg-gray-700 rounded-full border-2 border-[#111827]" />
                            <span className="text-gray-300 font-medium text-xs">
                              {idx + 1}. {station.name || station.code || "Unknown"}
                            </span>
                            <span className="text-[11px] text-gray-500 mt-0.5">{formatStationTime(station)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="h-40 flex items-center justify-center border border-dashed border-gray-800 rounded-xl">
                    <div className="text-gray-500 text-center px-4 text-xs leading-relaxed">
                      Draw and match an annotation to load route insights.
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── TAB 2: Full Station Table ── */}
          {activeRightTab === "stations" && (
            <div className="flex-1 overflow-y-auto">
              {activeRoute?.stations?.length ? (
                <>
                  <div className="px-4 py-3 border-b border-gray-800 bg-[#0d1520]/60">
                    <p className="text-xs text-gray-400 font-medium truncate">{activeRoute.trainName}</p>
                    <p className="text-[11px] text-gray-600 font-mono">#{activeRoute.trainNo} · {activeRoute.stations.length} stations</p>
                  </div>
                  {/* Table header */}
                  <div className="grid grid-cols-[auto_1fr_auto_auto] gap-x-2 px-4 py-2 border-b border-gray-800 bg-[#111827] sticky top-0 z-10">
                    <span className="text-[10px] text-gray-600 uppercase tracking-wider w-5">#</span>
                    <span className="text-[10px] text-gray-600 uppercase tracking-wider">Station</span>
                    <span className="text-[10px] text-gray-600 uppercase tracking-wider text-right">Arr</span>
                    <span className="text-[10px] text-gray-600 uppercase tracking-wider text-right">Dep</span>
                  </div>
                  <div className="divide-y divide-gray-800/60">
                    {activeRoute.stations.map((st, idx) => {
                      const isStopping = isStoppingStation(st);
                      const arr = st.arrival && st.arrival !== "None" ? st.arrival.slice(0, 5) : "—";
                      const dep = st.departure && st.departure !== "None" ? st.departure.slice(0, 5) : "—";
                      return (
                        <div
                          key={`${st.code}-${idx}`}
                          className={`grid grid-cols-[auto_1fr_auto_auto] gap-x-2 px-4 py-2 text-xs ${isStopping ? "bg-[#1a2332]/50" : ""}`}
                        >
                          <span className="text-gray-600 font-mono w-5">{st.seq ?? idx + 1}</span>
                          <div className="min-w-0">
                            <span className={`block truncate ${isStopping ? "text-gray-200" : "text-gray-500"}`}>
                              {st.name || st.code || "Unknown"}
                            </span>
                            <span className="text-[10px] text-gray-700 font-mono">{st.code}</span>
                          </div>
                          <span className="text-gray-500 font-mono text-right">{arr}</span>
                          <span className="text-gray-500 font-mono text-right">{dep}</span>
                        </div>
                      );
                    })}
                  </div>
                </>
              ) : (
                <div className="h-40 flex items-center justify-center">
                  <div className="text-gray-500 text-center px-4 text-xs leading-relaxed">
                    Match a route to view its full station schedule.
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── TAB 3: Journey Planner ── */}
          {activeRightTab === "journey" && (
            <div className="flex-1 overflow-y-auto p-4">
              <div className="mb-4">
                <div className="flex items-center gap-2 mb-1">
                  <Clock size={13} className="text-blue-400" />
                  <span className="text-xs font-semibold text-gray-300 uppercase tracking-wider">Journey Planner</span>
                </div>
                <p className="text-[11px] text-gray-600 leading-relaxed">
                  Enter station codes to find the fastest rail path via Dijkstra's algorithm across 8,247 stations.
                </p>
              </div>

              <div className="space-y-3 mb-4">
                <div>
                  <label className="text-[11px] text-gray-500 mb-1.5 block uppercase tracking-wider">From</label>
                  <input
                    value={journeyFrom}
                    onChange={(e) => setJourneyFrom(e.target.value.toUpperCase())}
                    onKeyDown={(e) => e.key === "Enter" && planJourney()}
                    placeholder="e.g. NDLS"
                    maxLength={10}
                    className="w-full bg-[#1f2937] border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder:text-gray-600 focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/20 font-mono uppercase tracking-widest transition-all"
                  />
                </div>
                <div>
                  <label className="text-[11px] text-gray-500 mb-1.5 block uppercase tracking-wider">To</label>
                  <input
                    value={journeyTo}
                    onChange={(e) => setJourneyTo(e.target.value.toUpperCase())}
                    onKeyDown={(e) => e.key === "Enter" && planJourney()}
                    placeholder="e.g. MAS"
                    maxLength={10}
                    className="w-full bg-[#1f2937] border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder:text-gray-600 focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/20 font-mono uppercase tracking-widest transition-all"
                  />
                </div>
                <button
                  onClick={planJourney}
                  disabled={journeyLoading || !journeyFrom.trim() || !journeyTo.trim()}
                  className="w-full bg-blue-600 hover:bg-blue-500 disabled:bg-gray-800 disabled:text-gray-600 text-white text-sm font-medium py-2.5 rounded-lg transition-colors flex items-center justify-center gap-2"
                >
                  {journeyLoading ? (
                    <>
                      <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                      </svg>
                      Planning…
                    </>
                  ) : (
                    <>
                      <ArrowRight size={15} />
                      Find Fastest Path
                    </>
                  )}
                </button>

                {/* Quick hints */}
                <div className="text-[10px] text-gray-700 leading-relaxed">
                  Common codes: NDLS (New Delhi), MAS (Chennai), BCT (Mumbai), HWH (Howrah), BLR (Bangalore)
                </div>
              </div>

              {journeyError && (
                <div className="text-xs text-red-400 bg-red-900/20 border border-red-900/40 rounded-lg p-3 mb-4 leading-relaxed">
                  {journeyError}
                </div>
              )}

              {journeyResult && (
                <div className="space-y-4">
                  {/* Summary card */}
                  <div className="rounded-xl border border-gray-700/60 bg-[#1f2937]/40 overflow-hidden">
                    <div className="p-3 border-b border-gray-700/60">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="text-blue-400 font-mono text-sm font-semibold">{journeyResult.from_code}</span>
                          <ArrowRight size={12} className="text-gray-600" />
                          <span className="text-blue-400 font-mono text-sm font-semibold">{journeyResult.to_code}</span>
                        </div>
                        {journeyResult.direct_train && (
                          <span className="text-[10px] text-green-400 bg-green-900/30 px-2 py-0.5 rounded-full font-medium">Direct</span>
                        )}
                      </div>
                      <p className="text-[11px] text-gray-600 mt-1 truncate">
                        {journeyResult.from_name} → {journeyResult.to_name}
                      </p>
                    </div>
                    <div className="grid grid-cols-2">
                      <div className="p-3 border-r border-gray-700/60">
                        <div className="text-[10px] text-gray-500 mb-0.5">Total Time</div>
                        <div className="text-base font-semibold text-gray-200">{formatMinutes(journeyResult.total_minutes)}</div>
                        <div className="text-[10px] text-gray-600">{journeyResult.total_hours}h</div>
                      </div>
                      <div className="p-3">
                        <div className="text-[10px] text-gray-500 mb-0.5">Stops</div>
                        <div className="text-base font-semibold text-gray-200">{journeyResult.stops}</div>
                        <div className="text-[10px] text-gray-600">via {journeyResult.path.length} stations</div>
                      </div>
                    </div>
                  </div>

                  {/* Path timeline */}
                  <div>
                    <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-3 font-semibold">Fastest Route</div>
                    <div className="relative">
                      <div className="absolute left-[7px] top-4 bottom-4 w-px bg-gray-800" />
                      <div className="space-y-3">
                        {journeyResult.path.map((step, i) => {
                          const isFirst = i === 0;
                          const isLast = i === journeyResult.path.length - 1;
                          return (
                            <div key={`step-${i}`} className="relative flex gap-3 pl-6">
                              <div
                                className={`absolute left-0 top-1 w-3.5 h-3.5 rounded-full border-2 ${
                                  isFirst || isLast
                                    ? "border-blue-500 bg-blue-600"
                                    : "border-gray-600 bg-[#0B1120]"
                                }`}
                              />
                              <div className="flex-1 min-w-0">
                                <div className={`text-xs font-medium ${isFirst || isLast ? "text-white" : "text-gray-300"}`}>
                                  {step.station_name}
                                </div>
                                <div className="text-[10px] text-gray-600 font-mono">{step.station_code}</div>
                                {step.via_train_name && (
                                  <div className="flex items-center gap-1 mt-0.5 text-[10px] text-blue-400">
                                    <Train size={9} />
                                    <span className="truncate">{step.via_train_name}</span>
                                    <span className="text-gray-600 shrink-0">· {formatMinutes(step.leg_minutes)}</span>
                                  </div>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </aside>
      </main>
    </div>
  );
}

function IconButton({
  icon, tooltip, active, onClick,
}: {
  icon: React.ReactNode;
  tooltip: string;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      title={tooltip}
      onClick={onClick}
      className={`p-2.5 rounded-xl transition-all duration-200 ${
        active ? "bg-blue-600 text-white shadow-lg shadow-blue-900/20" : "text-gray-400 hover:bg-gray-800 hover:text-gray-200"
      }`}
    >
      {icon}
    </button>
  );
}
