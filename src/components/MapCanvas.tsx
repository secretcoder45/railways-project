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
} from "lucide-react";

type Tool = "pan" | "draw" | "eraser";
type Point = { x: number; y: number };

type Station = {
  seq?: number;
  code?: string;
  name?: string;
  day?: number;
  arrival?: string;
  departure?: string;
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

type MatchResponse = {
  ok?: boolean;
  result?: {
    annotation_length_norm?: number;
    candidates?: number;
    best?: MatchRoute[];
  };
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
  const line = `hsl(${hue} 80% 58%)`;
  const glow = `hsla(${hue} 90% 60% / 0.45)`;
  return { line, glow };
}


function clamp01(v: number) {
  return Math.max(0, Math.min(1, v));
}

function lonLatToPixel(lon: number, lat: number, width: number, height: number): Point {
  const xNorm = (lon - MAP_BOUNDS.minLon) / (MAP_BOUNDS.maxLon - MAP_BOUNDS.minLon);
  const yNorm = (MAP_BOUNDS.maxLat - lat) / (MAP_BOUNDS.maxLat - MAP_BOUNDS.minLat);
  return {
    x: clamp01(xNorm) * width,
    y: clamp01(yNorm) * height,
  };
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
  for (let i = 0; i < coords.length - 1; i += 1) {
    sum += haversineKm(coords[i], coords[i + 1]);
  }
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

  const lastPos = useRef<Point | null>(null);
  const strokesRef = useRef<Point[][]>([]);
  const currentStrokeRef = useRef<Point[] | null>(null);

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

    loadMap().catch(() => {
      // keep silent by design
    });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!matchedRoutes.length) {
      setActiveRouteLabel(null);
      return;
    }
    if (!activeRouteLabel || !matchedRoutes.some((r) => r.label === activeRouteLabel)) {
      setActiveRouteLabel(matchedRoutes[0].label);
    }
  }, [matchedRoutes, activeRouteLabel]);

  const saveToHistory = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (ctx && canvas) {
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      setHistory((prev) => [...prev, imageData]);
    }
  }, []);

  const getCanvasCoordinates = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;

    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;

    let clientX: number;
    let clientY: number;

    if ("touches" in e) {
      if (!e.touches.length) return null;
      clientX = e.touches[0].clientX;
      clientY = e.touches[0].clientY;
    } else {
      clientX = e.clientX;
      clientY = e.clientY;
    }

    return {
      x: (clientX - rect.left) * scaleX,
      y: (clientY - rect.top) * scaleY,
    };
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
    if (newHistory.length > 0) {
      ctx.putImageData(newHistory[newHistory.length - 1], 0, 0);
    }

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

  const projectRouteLineToPixels = useCallback((routeLine: number[][], width: number, height: number) => {
    return routeLine
      .filter((coord) => Array.isArray(coord) && coord.length >= 2)
      .map((coord) => lonLatToPixel(coord[0], coord[1], width, height));
  }, []);

  const exportGeoJSON = useCallback(async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const validStrokes = strokesRef.current.filter((stroke) => stroke.length >= 2);
    if (!validStrokes.length) return;

    const strokeCoords = validStrokes.map((stroke) =>
      stroke.map((point) => pixelToLonLat(point, canvas.width, canvas.height))
    );
    const strokePixelLines = validStrokes.map((stroke) =>
      stroke.map((point) => [clamp01(point.x / canvas.width), clamp01(point.y / canvas.height)])
    );

    const totalLengthKm = strokeCoords.reduce((sum, line) => sum + polylineKm(line), 0);
    setAnnotationLengthKm(totalLengthKm);

    const geojson = {
      type: "FeatureCollection",
      properties: {
        pixel_strokes: strokePixelLines,
        stroke_count: strokePixelLines.length,
      },
      features: strokeCoords.map((line, idx) => ({
        type: "Feature",
        properties: {
          stroke_index: idx,
          pixel_line: strokePixelLines[idx],
        },
        geometry: {
          type: "LineString",
          coordinates: line,
        },
      })),
    };

    try {
      const saveRes = await fetch(apiUrl("/api/annotation"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(geojson),
      });
      if (!saveRes.ok) return;

      const matchRes = await fetch(apiUrl("/api/match-last"), { method: "POST" });
      if (!matchRes.ok) return;

      const matchData = (await matchRes.json()) as MatchResponse;
      const bestMatches = matchData.result?.best ?? [];

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
          label,
          color: style.line,
          glow: style.glow,
          points: projected,
          trainNo: route.train_no,
          trainName: route.train_name,
          distanceNorm: route.distance_px_norm,
          routeLengthKm: route.route_length_km,
          stationCount: route.station_count,
          stations: route.stations,
        });
      }

      setMatchedRoutes(projectedRoutes);
      setHoveredRouteLabel(null);
    } catch {
      // keep silent by design
    }
  }, [projectRouteLineToPixels]);

  const displayedRoutes = useMemo(() => {
    const emphasis = hoveredRouteLabel || activeRouteLabel;
    if (!emphasis) return matchedRoutes;
    const active = matchedRoutes.find((route) => route.label === emphasis);
    if (!active) return matchedRoutes;
    return [...matchedRoutes.filter((route) => route.label !== emphasis), active];
  }, [matchedRoutes, hoveredRouteLabel, activeRouteLabel]);

  const activeRoute = useMemo(
    () => matchedRoutes.find((r) => r.label === activeRouteLabel) || matchedRoutes[0],
    [matchedRoutes, activeRouteLabel]
  );

  const hoveredRoute = useMemo(
    () => matchedRoutes.find((r) => r.label === hoveredRouteLabel) || null,
    [matchedRoutes, hoveredRouteLabel]
  );
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
          <h1 className="text-gray-100 font-medium tracking-wide">RailRoute Explorer</h1>
        </div>
        <div className="flex items-center gap-4 text-gray-400">
          <button className="hover:text-white transition-colors">
            <Settings size={18} />
          </button>
          <button className="hover:text-white transition-colors">
            <User size={18} />
          </button>
        </div>
      </header>

      <main className="flex-1 flex overflow-hidden">
        <aside className="w-[340px] bg-[#111827] border-r border-gray-800 flex flex-col z-10 shrink-0">
          <div className="p-5 border-b border-gray-800">
            <h2 className="text-sm font-semibold text-gray-100">Routes Gallery</h2>
            <p className="text-xs text-gray-500 mt-1">BEST MATCHES ({matchedRoutes.length} Trains)</p>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {matchedRoutes.length === 0 ? (
              <div className="text-xs text-gray-500 border border-dashed border-gray-700 rounded-xl p-4">
                Draw on the map and click export to fetch best matches.
              </div>
            ) : (
              matchedRoutes.map((route, idx) => {
                const isActive = activeRoute?.label === route.label;
                const isHovered = hoveredRouteLabel === route.label;
                const borderColor = isActive ? route.color : isHovered ? "#4b5563" : "#1f2937";
                const glow = isActive ? `0 0 18px ${route.glow}` : "none";

                return (
                  <button
                    key={route.label}
                    onClick={() => setActiveRouteLabel(route.label)}
                    onMouseEnter={() => setHoveredRouteLabel(route.label)}
                    onMouseLeave={() => setHoveredRouteLabel(null)}
                    className="w-full text-left p-4 rounded-xl border transition-all duration-200 flex items-start gap-3 relative overflow-hidden bg-transparent"
                    style={{
                      borderColor,
                      boxShadow: glow,
                      backgroundColor: isActive ? "rgba(31,41,55,0.7)" : isHovered ? "rgba(31,41,55,0.45)" : "transparent",
                    }}
                  >
                    <div className="w-3 h-3 rounded-full mt-1 shrink-0" style={{ backgroundColor: route.color }} />

                    <div className="flex-1 min-w-0">
                      <h3 className={`text-sm font-medium truncate ${isActive ? "text-white" : "text-gray-300"}`}>{route.trainName || route.label}</h3>
                      <p className="text-xs text-gray-500 mt-1">Train No: ({route.trainNo || "-"})</p>
                    </div>

                    <div className="text-xs text-gray-600 font-mono">#{idx + 1}</div>
                  </button>
                );
              })
            )}
          </div>
        </aside>

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
                  >
                    <svg
                      width={MAP_WIDTH}
                      height={MAP_HEIGHT}
                      viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`}
                      preserveAspectRatio="xMidYMin meet"
                      className="block h-full w-full"
                    >
                      <g fill="none" stroke="#334155" strokeWidth="1.05" strokeLinejoin="round" opacity="0.9">
                        {mapPaths.map((d, idx) => (
                          <path key={`state-${idx}`} d={d} />
                        ))}
                      </g>

                      {displayedRoutes.map((route) => {
                        const highlighted =
                          (hoveredRouteLabel && hoveredRouteLabel === route.label) ||
                          (!hoveredRouteLabel && activeRoute && activeRoute.label === route.label);
                        const muted = hoveredRouteLabel && hoveredRouteLabel !== route.label;
                        const strokeWidth = highlighted ? 5 : 3;
                        const opacity = muted ? 0.16 : highlighted ? 1 : 0.65;

                        return (
                          <g key={`route-${route.label}`} style={{ opacity }}>
                            {highlighted ? (
                              <polyline
                                points={route.points.map((p) => `${p.x},${p.y}`).join(" ")}
                                fill="none"
                                stroke={route.color}
                                strokeWidth={strokeWidth + 6}
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                opacity="0.25"
                              />
                            ) : null}
                            <polyline
                              points={route.points.map((p) => `${p.x},${p.y}`).join(" ")}
                              fill="none"
                              stroke={route.color}
                              strokeWidth={strokeWidth}
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </g>
                        );
                      })}
                    </svg>

                    <canvas
                      ref={canvasRef}
                      className="absolute inset-0"
                      style={{
                        width: "100%",
                        height: "100%",
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

                {hoveredRoute ? (
                  <div className="absolute top-24 right-24 bg-[#1e293b]/95 backdrop-blur-md border border-gray-700 p-4 rounded-xl shadow-2xl max-w-xs z-30">
                    <h4 className="text-sm font-semibold text-white mb-1">{hoveredRoute.trainName || hoveredRoute.label}</h4>
                    <p className="text-xs text-gray-400 mb-2">Train No: {hoveredRoute.trainNo || "-"}</p>
                    <div className="text-xs text-gray-500 leading-relaxed border-t border-gray-700 pt-2">
                      Hover preview active. Click this route card in the left gallery to lock full details.
                    </div>
                  </div>
                ) : null}

                <div className="absolute top-6 left-6 flex items-center gap-2 bg-[#111827]/90 backdrop-blur border border-gray-800 px-3 py-1.5 rounded-lg shadow-lg text-xs font-mono text-slate-400 z-30">
                  <Crosshair size={13} className="text-blue-500" />
                  <span>Lat: {cursorCoords.lat.toFixed(4)}°</span>
                  <span className="text-slate-600">|</span>
                  <span>Lon: {cursorCoords.lon.toFixed(4)}°</span>
                </div>

                <div className="absolute bottom-6 left-1/2 -translate-x-1/2 bg-[#111827]/90 backdrop-blur border border-gray-800 p-2 rounded-2xl flex items-center gap-2 shadow-2xl z-30">
                  <IconButton icon={<ZoomIn size={18} />} tooltip="Zoom In" onClick={() => zoomIn()} />
                  <IconButton icon={<ZoomOut size={18} />} tooltip="Zoom Out" onClick={() => zoomOut()} />
                  <div className="w-px h-6 bg-gray-800 mx-1" />
                  <IconButton icon={<Hand size={18} />} tooltip="Pan Map" active={tool === "pan"} onClick={() => setTool("pan")} />
                  <IconButton icon={<PenLine size={18} />} tooltip="Draw Route" active={tool === "draw"} onClick={() => setTool("draw")} />
                  <IconButton icon={<Eraser size={18} />} tooltip="Eraser" active={tool === "eraser"} onClick={() => setTool("eraser")} />
                  <div className="w-px h-6 bg-gray-800 mx-1" />
                  <IconButton icon={<Download size={18} />} tooltip="Export Annotation" onClick={exportGeoJSON} />
                  <IconButton icon={<Layers size={18} />} tooltip="Clear" onClick={clearCanvas} />
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

        <aside className="w-[320px] bg-[#111827] border-l border-gray-800 flex flex-col z-10 shrink-0 shadow-2xl">
          <div className="p-5 border-b border-gray-800 flex items-center justify-between">
            <div className="flex gap-4 w-full">
              <button className="text-sm font-semibold text-gray-100 border-b-2 border-blue-500 pb-4 -mb-5 flex-1 text-left">
                Route Insights
              </button>
              <button className="text-sm font-medium text-gray-500 pb-4 -mb-5 flex-1 text-right">Route Details</button>
            </div>
          </div>

          <div className="p-5 overflow-y-auto flex-1 text-sm">
            <div className="uppercase text-[10px] tracking-widest text-gray-500 mb-3 font-semibold">Route Analytics - Selected</div>
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
                      <div className="text-2xl font-semibold text-gray-200">{estDurationHours ? `${estDurationHours} hrs` : "N/A"}</div>
                    </div>
                  </div>
                  <div className="p-3 border-b border-gray-700/60">
                    <div className="text-xs text-gray-500 mb-1">Number of Major Stops</div>
                    <div className="text-2xl font-semibold text-gray-200">{stopStations.length}</div>
                  </div>
                  <div className="grid grid-cols-2">
                    <div className="p-3 border-r border-gray-700/60">
                      <div className="text-xs text-gray-500 mb-1">Train Type</div>
                      <div className="text-lg font-semibold text-gray-200">{trainType}</div>
                    </div>
                    <div className="p-3">
                      <div className="text-xs text-gray-500 mb-1">Number of Coaches</div>
                      <div className="text-lg font-semibold text-gray-200">N/A</div>
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
                  Draw and export an annotation to load matched routes and insights.
                </div>
              </div>
            )}
          </div>
        </aside>
      </main>
    </div>
  );
}

function IconButton({
  icon,
  tooltip,
  active,
  onClick,
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
