import { useRef, useState, useEffect, useCallback } from "react";
import { TransformWrapper, TransformComponent } from "react-zoom-pan-pinch";
import { ZoomIn, ZoomOut, RotateCcw, Pencil, Eraser, Circle } from "lucide-react";
import indiaMap from "@/assets/india-map.png";

type Tool = "pan" | "draw" | "eraser";

const COLORS = ["#ef4444", "#f97316", "#eab308", "#22c55e", "#3b82f6", "#8b5cf6", "#ec4899", "#000000"];
const BRUSH_SIZES = [2, 4, 8, 12];

export default function MapCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [tool, setTool] = useState<Tool>("pan");
  const [color, setColor] = useState("#ef4444");
  const [brushSize, setBrushSize] = useState(4);
  const [showColors, setShowColors] = useState(false);
  const [showBrushSizes, setShowBrushSizes] = useState(false);
  const lastPos = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    
    const updateCanvasSize = () => {
      const img = document.querySelector('.map-image') as HTMLImageElement;
      if (img && img.complete) {
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
      }
    };

    const img = document.querySelector('.map-image') as HTMLImageElement;
    if (img) {
      if (img.complete) {
        updateCanvasSize();
      } else {
        img.onload = updateCanvasSize;
      }
    }
  }, []);

  const getCanvasCoordinates = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;

    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;

    let clientX: number, clientY: number;
    if ('touches' in e) {
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

  const startDrawing = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    if (tool === "pan") return;
    e.stopPropagation();
    
    const coords = getCanvasCoordinates(e);
    if (!coords) return;

    setIsDrawing(true);
    lastPos.current = coords;
  }, [tool, getCanvasCoordinates]);

  const draw = useCallback((e: React.MouseEvent | React.TouchEvent) => {
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
    ctx.strokeStyle = tool === "eraser" ? "#ffffff" : color;
    ctx.lineWidth = tool === "eraser" ? brushSize * 4 : brushSize;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.globalCompositeOperation = tool === "eraser" ? "destination-out" : "source-over";
    ctx.stroke();

    lastPos.current = coords;
  }, [isDrawing, tool, color, brushSize, getCanvasCoordinates]);

  const stopDrawing = useCallback(() => {
    setIsDrawing(false);
    lastPos.current = null;
  }, []);

  const clearCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (ctx && canvas) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  }, []);

  return (
    <div ref={containerRef} className="relative w-full h-screen bg-canvas overflow-hidden">
      <TransformWrapper
        initialScale={1}
        minScale={0.5}
        maxScale={5}
        disabled={tool !== "pan"}
        centerOnInit
      >
        {({ zoomIn, zoomOut, resetTransform }) => (
          <>
            <TransformComponent
              wrapperClass="!w-full !h-full"
              contentClass="!w-full !h-full flex items-center justify-center"
            >
              <div className="relative">
                <img
                  src={indiaMap}
                  alt=""
                  className="map-image max-w-none select-none"
                  draggable={false}
                />
                <canvas
                  ref={canvasRef}
                  className="absolute top-0 left-0 w-full h-full"
                  style={{ 
                    pointerEvents: tool === "pan" ? "none" : "auto",
                    touchAction: tool === "pan" ? "auto" : "none"
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

            {/* Toolbar */}
            <div className="fixed bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-1 bg-toolbar/95 backdrop-blur-sm px-3 py-2 rounded-full shadow-toolbar">
              {/* Zoom Controls */}
              <button
                onClick={() => zoomOut()}
                className="toolbar-btn"
                title="Zoom Out"
              >
                <ZoomOut className="w-5 h-5" />
              </button>
              <button
                onClick={() => zoomIn()}
                className="toolbar-btn"
                title="Zoom In"
              >
                <ZoomIn className="w-5 h-5" />
              </button>
              
              <div className="w-px h-6 bg-toolbar-divider mx-1" />

              {/* Tool Selection */}
              <button
                onClick={() => setTool("pan")}
                className={`toolbar-btn ${tool === "pan" ? "toolbar-btn-active" : ""}`}
                title="Pan"
              >
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v1M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8" />
                  <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" />
                </svg>
              </button>
              <button
                onClick={() => setTool("draw")}
                className={`toolbar-btn ${tool === "draw" ? "toolbar-btn-active" : ""}`}
                title="Draw"
              >
                <Pencil className="w-5 h-5" />
              </button>
              <button
                onClick={() => setTool("eraser")}
                className={`toolbar-btn ${tool === "eraser" ? "toolbar-btn-active" : ""}`}
                title="Eraser"
              >
                <Eraser className="w-5 h-5" />
              </button>

              <div className="w-px h-6 bg-toolbar-divider mx-1" />

              {/* Color Picker */}
              <div className="relative">
                <button
                  onClick={() => {
                    setShowColors(!showColors);
                    setShowBrushSizes(false);
                  }}
                  className="toolbar-btn"
                  title="Color"
                >
                  <div
                    className="w-5 h-5 rounded-full border-2 border-white/50"
                    style={{ backgroundColor: color }}
                  />
                </button>
                {showColors && (
                  <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 flex gap-1 p-2 bg-toolbar rounded-lg shadow-toolbar">
                    {COLORS.map((c) => (
                      <button
                        key={c}
                        onClick={() => {
                          setColor(c);
                          setShowColors(false);
                        }}
                        className={`w-6 h-6 rounded-full transition-transform hover:scale-110 ${
                          color === c ? "ring-2 ring-white ring-offset-2 ring-offset-toolbar" : ""
                        }`}
                        style={{ backgroundColor: c }}
                      />
                    ))}
                  </div>
                )}
              </div>

              {/* Brush Size */}
              <div className="relative">
                <button
                  onClick={() => {
                    setShowBrushSizes(!showBrushSizes);
                    setShowColors(false);
                  }}
                  className="toolbar-btn"
                  title="Brush Size"
                >
                  <Circle className="w-5 h-5" style={{ strokeWidth: brushSize / 2 }} />
                </button>
                {showBrushSizes && (
                  <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 flex gap-2 p-2 bg-toolbar rounded-lg shadow-toolbar">
                    {BRUSH_SIZES.map((size) => (
                      <button
                        key={size}
                        onClick={() => {
                          setBrushSize(size);
                          setShowBrushSizes(false);
                        }}
                        className={`flex items-center justify-center w-8 h-8 rounded-full transition-colors ${
                          brushSize === size ? "bg-white/20" : "hover:bg-white/10"
                        }`}
                      >
                        <div
                          className="rounded-full bg-white"
                          style={{ width: size + 4, height: size + 4 }}
                        />
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="w-px h-6 bg-toolbar-divider mx-1" />

              {/* Clear */}
              <button
                onClick={() => {
                  clearCanvas();
                  resetTransform();
                }}
                className="toolbar-btn"
                title="Reset"
              >
                <RotateCcw className="w-5 h-5" />
              </button>
            </div>
          </>
        )}
      </TransformWrapper>
    </div>
  );
}
