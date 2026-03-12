import { useRef, useState, useEffect, useCallback, useMemo } from "react";
import { TransformWrapper, TransformComponent } from "react-zoom-pan-pinch";
import {
  Map,
  PenTool,
  Upload,
  Layers,
  CheckCircle,
  AlertTriangle,
  Download,
  Clock,
  Crosshair,
  ZoomIn,
  MousePointer2,
  RotateCcw,
  Undo2,
  Eraser,
  ZoomOut,
} from "lucide-react";

type Tool = "pan" | "draw" | "eraser";
type Point = { x: number; y: number };

type MatchRoute = {
  train_name?: string;
  train_no?: string;
  route_line?: number[][];
  distance_px_norm?: number;
  route_length_km?: number;
  station_count?: number;
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
  trainNo?: string;
  trainName?: string;
  distanceNorm?: number;
  routeLengthKm?: number;
  stationCount?: number;
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
const ROUTE_COLORS = ["#ef4444", "#f59e0b", "#10b981", "#8b5cf6", "#06b6d4"];

const MAP_BOUNDS = {
  minLon: 68.10055226476403,
  minLat: 6.766373153037801,
  maxLon: 97.38755686813376,
  maxLat: 37.07695799999999,
};

const MAP_WIDTH = 1000;
const MAP_HEIGHT = 1000;

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

export default function MapCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mapWrapRef = useRef<HTMLDivElement>(null);

  const [isDrawing, setIsDrawing] = useState(false);
  const [tool, setTool] = useState<Tool>("pan");
  const [history, setHistory] = useState<ImageData[]>([]);
  const [matchedRoutes, setMatchedRoutes] = useState<MatchedRoute[]>([]);
  const [hoveredRouteLabel, setHoveredRouteLabel] = useState<string | null>(null);
  const [mapPaths, setMapPaths] = useState<string[]>([]);
  const [cursorCoords, setCursorCoords] = useState({ lat: 26.2006, lon: 92.9376 });
  const [annotationLengthKm, setAnnotationLengthKm] = useState(0);
  const [outOfBoundsPoints, setOutOfBoundsPoints] = useState(0);
  const [candidateCount, setCandidateCount] = useState(0);

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
      // Keep UI silent
    });

    return () => {
      active = false;
    };
  }, []);

  const saveToHistory = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (ctx && canvas) {
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      setHistory((prev) => [...prev, imageData]);
    }
  }, []);

  const undo = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (ctx && canvas && history.length > 0) {
      const newHistory = [...history];
      newHistory.pop();
      setHistory(newHistory);

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (newHistory.length > 0) {
        ctx.putImageData(newHistory[newHistory.length - 1], 0, 0);
      }

      strokesRef.current.pop();
    }
  }, [history]);

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

  const updateCursorFromMouse = useCallback((e: React.MouseEvent) => {
    const wrap = mapWrapRef.current;
    if (!wrap) return;

    const rect = wrap.getBoundingClientRect();
    const x = clamp01((e.clientX - rect.left) / rect.width) * MAP_WIDTH;
    const y = clamp01((e.clientY - rect.top) / rect.height) * MAP_HEIGHT;
    const [lon, lat] = pixelToLonLat({ x, y }, MAP_WIDTH, MAP_HEIGHT);
    setCursorCoords({ lat, lon });
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

  const clearCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (ctx && canvas) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      setHistory([]);
      strokesRef.current = [];
      setMatchedRoutes([]);
      setHoveredRouteLabel(null);
      setAnnotationLengthKm(0);
      setOutOfBoundsPoints(0);
      setCandidateCount(0);
    }
  }, []);

  const projectRouteLineToPixels = useCallback((routeLine: number[][], width: number, height: number) => {
    return routeLine
      .filter((coord) => Array.isArray(coord) && coord.length >= 2)
      .map((coord) => lonLatToPixel(coord[0], coord[1], width, height));
  }, []);

  const exportGeoJSON = useCallback(async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const allPoints = strokesRef.current.flat();
    if (allPoints.length < 2) return;

    const coords = allPoints.map((point) => pixelToLonLat(point, canvas.width, canvas.height));
    const pixelLine = allPoints.map((point) => [clamp01(point.x / canvas.width), clamp01(point.y / canvas.height)]);

    const outPoints = coords.filter(
      ([lon, lat]) =>
        lon < MAP_BOUNDS.minLon || lon > MAP_BOUNDS.maxLon || lat < MAP_BOUNDS.minLat || lat > MAP_BOUNDS.maxLat
    ).length;

    setOutOfBoundsPoints(outPoints);
    setAnnotationLengthKm(polylineKm(coords));

    const geojson = {
      type: "Feature",
      properties: { pixel_line: pixelLine },
      geometry: {
        type: "LineString",
        coordinates: coords,
      },
    };

    try {
      const saveRes = await fetch("/api/annotation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(geojson),
      });
      if (!saveRes.ok) return;

      const matchRes = await fetch("/api/match-last", { method: "POST" });
      if (!matchRes.ok) return;

      const matchData = (await matchRes.json()) as MatchResponse;
      const bestMatches = matchData.result?.best ?? [];
      setCandidateCount(matchData.result?.candidates ?? 0);

      if (!bestMatches.length) {
        setMatchedRoutes([]);
        setHoveredRouteLabel(null);
        return;
      }

      const projectedRoutes: MatchedRoute[] = [];
      for (let i = 0; i < bestMatches.length && i < ROUTE_COLORS.length; i += 1) {
        const route = bestMatches[i];
        const routeLine = route.route_line;
        if (!routeLine || routeLine.length < 2) continue;

        const projected = projectRouteLineToPixels(routeLine, canvas.width, canvas.height);
        if (projected.length < 2) continue;

        const name = route.train_name?.trim();
        const number = route.train_no?.trim();
        const label = name ? `${name}${number ? ` (${number})` : ""}` : number ? `Train ${number}` : `Match ${i + 1}`;

        projectedRoutes.push({
          label,
          color: ROUTE_COLORS[i],
          points: projected,
          trainNo: route.train_no,
          trainName: route.train_name,
          distanceNorm: route.distance_px_norm,
          routeLengthKm: route.route_length_km,
          stationCount: route.station_count,
        });
      }

      setMatchedRoutes(projectedRoutes);
      setHoveredRouteLabel(null);
    } catch {
      // Keep UI silent
    }
  }, [projectRouteLineToPixels]);

  const displayedRoutes = useMemo(() => {
    if (!hoveredRouteLabel) return matchedRoutes;
    const active = matchedRoutes.find((route) => route.label === hoveredRouteLabel);
    if (!active) return matchedRoutes;
    return [...matchedRoutes.filter((route) => route.label !== hoveredRouteLabel), active];
  }, [matchedRoutes, hoveredRouteLabel]);

  const topRoute = matchedRoutes[0];
  const similarity = topRoute?.distanceNorm != null ? Math.max(0, Math.min(100, 100 - topRoute.distanceNorm * 180)) : 0;

  return (
    <div className="h-screen w-screen bg-slate-950 text-slate-300 font-sans flex flex-col overflow-hidden selection:bg-blue-500/30">
      <header className="h-14 bg-slate-900 border-b border-slate-800 flex items-center justify-between px-6 z-20 shrink-0 shadow-sm">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center text-white shadow-lg shadow-blue-500/20">
            <Map size={18} />
          </div>
          <h1 className="text-slate-100 font-semibold tracking-tight truncate">RailRoute Validator</h1>
          <div className="h-4 w-px bg-slate-700 mx-2" />
          <button className="flex items-center gap-2 text-xs font-medium text-slate-400 bg-slate-800/50 px-3 py-1.5 rounded-md border border-slate-700/50">
            <Clock size={14} />
            <span>v2.1.4 (Latest)</span>
          </button>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={undo}
            className="flex items-center gap-2 text-sm font-medium bg-slate-800 hover:bg-slate-700 text-slate-100 px-3 py-2 rounded-lg transition-all border border-slate-700"
          >
            <Undo2 size={16} />
            Undo
          </button>
          <button
            onClick={clearCanvas}
            className="flex items-center gap-2 text-sm font-medium bg-slate-800 hover:bg-slate-700 text-slate-100 px-3 py-2 rounded-lg transition-all border border-slate-700"
          >
            <RotateCcw size={16} />
            Reset
          </button>
          <button
            onClick={exportGeoJSON}
            className="flex items-center gap-2 text-sm font-medium bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded-lg transition-all shadow-lg shadow-blue-900/20"
          >
            <Download size={16} />
            Export GeoJSON
          </button>
        </div>
      </header>

      <main className="flex-1 flex relative min-h-0">
        <div
          className="flex-1 relative bg-[#0a0f18]"
          style={{
            backgroundImage: "radial-gradient(circle at center, #1e293b 1px, transparent 1px)",
            backgroundSize: "24px 24px",
          }}
        >
          <TransformWrapper initialScale={1} minScale={0.55} maxScale={6} disabled={tool !== "pan"} centerOnInit>
            {({ zoomIn, zoomOut }) => (
              <>
                <TransformComponent
                  wrapperClass="!w-full !h-full overflow-auto"
                  contentClass="!w-full !h-full flex items-start justify-center px-4 pt-4 pb-20"
                >
                  <div
                    ref={mapWrapRef}
                    className="relative w-[min(95vw,1040px)] max-w-full"
                    style={{ aspectRatio: `${MAP_WIDTH} / ${MAP_HEIGHT}` }}
                    onMouseMove={updateCursorFromMouse}
                  >
                    <svg
                      width={MAP_WIDTH}
                      height={MAP_HEIGHT}
                      viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`}
                      preserveAspectRatio="xMidYMin meet"
                      className="block h-full w-full"
                      style={{ background: "#ffffff" }}
                    >
                      <g fill="#ffffff" stroke="#6b7280" strokeWidth="1.15" strokeLinejoin="round">
                        {mapPaths.map((d, idx) => (
                          <path key={`state-${idx}`} d={d} />
                        ))}
                      </g>

                      {displayedRoutes.map((route) => {
                        const isActive = !hoveredRouteLabel || hoveredRouteLabel === route.label;
                        return (
                          <polyline
                            key={`route-${route.label}`}
                            points={route.points.map((p) => `${p.x},${p.y}`).join(" ")}
                            fill="none"
                            stroke={route.color}
                            strokeWidth={isActive ? "6" : "3"}
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            opacity={isActive ? 0.95 : 0.22}
                          />
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

                <div className="absolute left-6 top-6 flex flex-col gap-2 bg-slate-900/85 backdrop-blur-md border border-slate-800 p-2 rounded-xl shadow-2xl z-10">
                  <ToolButton icon={<MousePointer2 size={18} />} tooltip="Pan" active={tool === "pan"} onClick={() => setTool("pan")} />
                  <ToolButton icon={<PenTool size={18} />} tooltip="Draw Route (LineString)" active={tool === "draw"} onClick={() => setTool("draw")} />
                  <ToolButton icon={<Eraser size={18} />} tooltip="Eraser" active={tool === "eraser"} onClick={() => setTool("eraser")} />
                  <div className="h-px w-full bg-slate-800 my-1" />
                  <ToolButton icon={<Layers size={18} />} tooltip="Clear Highlights" onClick={() => setHoveredRouteLabel(null)} />
                  <ToolButton icon={<ZoomIn size={18} />} tooltip="Zoom In" onClick={() => zoomIn()} />
                  <ToolButton icon={<ZoomOut size={18} />} tooltip="Zoom Out" onClick={() => zoomOut()} />
                  <ToolButton icon={<Upload size={18} />} tooltip="Export Annotation" onClick={exportGeoJSON} />
                </div>

                <div className="absolute bottom-6 left-6 flex items-center gap-2 bg-slate-900/80 backdrop-blur-md border border-slate-800 px-3 py-1.5 rounded-lg shadow-lg text-xs font-mono text-slate-400 z-10">
                  <Crosshair size={14} className="text-blue-500" />
                  <span>Lat: {cursorCoords.lat.toFixed(4)}°</span>
                  <span className="text-slate-600">|</span>
                  <span>Lon: {cursorCoords.lon.toFixed(4)}°</span>
                </div>
              </>
            )}
          </TransformWrapper>
        </div>

        <aside className="w-[380px] max-w-[40vw] bg-slate-900 border-l border-slate-800 flex flex-col h-full shadow-2xl z-20 shrink-0">
          <div className="p-5 border-b border-slate-800">
            <h2 className="text-sm font-semibold text-slate-100 uppercase tracking-wider mb-4">Validation Dashboard</h2>

            <div
              className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium mb-6 ${
                outOfBoundsPoints === 0
                  ? "bg-emerald-500/10 border border-emerald-500/20 text-emerald-400"
                  : "bg-red-500/10 border border-red-500/25 text-red-400"
              }`}
            >
              <CheckCircle size={16} />
              {outOfBoundsPoints === 0 ? "Inside India Bounds" : "Contains Out-of-Bounds Points"}
            </div>

            <div className="bg-slate-800/50 rounded-xl p-4 border border-slate-700/50">
              <div className="text-sm text-slate-400 mb-1">Route Similarity Match</div>
              <div className="flex items-baseline gap-2">
                <span className="text-5xl font-bold text-slate-100 tracking-tight">{similarity.toFixed(1)}</span>
                <span className="text-xl text-slate-500">%</span>
              </div>
              <div className="mt-3 w-full bg-slate-950 rounded-full h-1.5 overflow-hidden">
                <div className="bg-blue-500 h-full rounded-full" style={{ width: `${similarity}%` }} />
              </div>
            </div>
          </div>

          <div className="p-5 flex-1 overflow-y-auto space-y-6">
            <div>
              <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">Top Route Matches</h3>
              <div className="space-y-2 max-h-[260px] overflow-y-auto pr-1">
                {matchedRoutes.length === 0 ? (
                  <div className="text-xs text-slate-500">No routes yet. Draw and export to match.</div>
                ) : (
                  matchedRoutes.map((route, idx) => {
                    const isActive = !hoveredRouteLabel || hoveredRouteLabel === route.label;
                    return (
                      <button
                        key={`legend-${route.label}`}
                        type="button"
                        className={`w-full text-left p-3 rounded-lg border transition ${
                          isActive
                            ? "bg-slate-800/60 border-slate-700 text-slate-100"
                            : "bg-slate-900/50 border-slate-800 text-slate-400"
                        }`}
                        onMouseEnter={() => setHoveredRouteLabel(route.label)}
                        onMouseLeave={() => setHoveredRouteLabel(null)}
                      >
                        <div className="flex items-center gap-2">
                          <span className="inline-block w-3 h-3 rounded-full" style={{ backgroundColor: route.color }} />
                          <span className="text-sm font-medium truncate">{route.label}</span>
                          <span className="ml-auto text-xs text-slate-500">#{idx + 1}</span>
                        </div>
                      </button>
                    );
                  })
                )}
              </div>
            </div>

            <div>
              <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">Geographic Bounds</h3>
              <div className="grid grid-cols-2 gap-3">
                <DataCard label="Min Longitude" value={`${MAP_BOUNDS.minLon.toFixed(2)}°`} valid />
                <DataCard label="Max Longitude" value={`${MAP_BOUNDS.maxLon.toFixed(2)}°`} valid />
                <DataCard label="Min Latitude" value={`${MAP_BOUNDS.minLat.toFixed(2)}°`} valid />
                <DataCard label="Max Latitude" value={`${MAP_BOUNDS.maxLat.toFixed(2)}°`} valid />
              </div>
            </div>

            <div>
              <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">Route Analytics</h3>
              <div className="space-y-2">
                <StatRow label="Calculated Length" value={annotationLengthKm ? `${annotationLengthKm.toFixed(0)} km` : "-"} />
                <StatRow
                  label="Reference Length"
                  value={topRoute?.routeLengthKm ? `${topRoute.routeLengthKm.toFixed(0)} km` : "-"}
                />
                <StatRow
                  label="Matched Stations"
                  value={topRoute?.stationCount ? `${topRoute.stationCount}` : "-"}
                  highlight
                />
                <StatRow label="Candidate Routes" value={String(candidateCount)} />
                <StatRow label="Out of Bounds Points" value={String(outOfBoundsPoints)} isError={outOfBoundsPoints > 0} />
              </div>
            </div>

            <div className="mt-4 p-4 bg-slate-800/30 rounded-lg border border-slate-800 flex items-start gap-3">
              <AlertTriangle size={18} className="text-amber-500 shrink-0 mt-0.5" />
              <p className="text-xs text-slate-400 leading-relaxed">
                Hover a train route in the legend above to highlight it directly on the map and compare trajectory.
              </p>
            </div>
          </div>
        </aside>
      </main>
    </div>
  );
}

function ToolButton({
  icon,
  tooltip,
  active = false,
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
      className={`p-2.5 rounded-lg transition-all duration-200 group ${
        active ? "bg-blue-600 text-white shadow-md shadow-blue-900/20" : "text-slate-400 hover:bg-slate-800 hover:text-slate-100"
      }`}
    >
      {icon}
    </button>
  );
}

function DataCard({ label, value, valid }: { label: string; value: string; valid?: boolean }) {
  return (
    <div className={`p-3 rounded-lg border ${valid ? "bg-slate-800/50 border-slate-700/50" : "bg-red-500/10 border-red-500/30"}`}>
      <div className="text-[10px] text-slate-400 uppercase tracking-wider mb-1">{label}</div>
      <div className={`font-mono text-sm ${valid ? "text-slate-200" : "text-red-400"}`}>{value}</div>
    </div>
  );
}

function StatRow({
  label,
  value,
  highlight,
  isError,
}: {
  label: string;
  value: string;
  highlight?: boolean;
  isError?: boolean;
}) {
  return (
    <div className="flex justify-between items-center py-2 border-b border-slate-800/50 last:border-0">
      <span className="text-sm text-slate-400">{label}</span>
      <span className={`text-sm font-medium ${highlight ? "text-blue-400" : isError ? "text-red-400" : "text-slate-200"}`}>{value}</span>
    </div>
  );
}
