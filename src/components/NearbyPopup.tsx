import { X, MapPin, Train, ArrowRight, Ruler } from "lucide-react";

type NearbySegment = {
  route_id: string;
  train_name: string;
  train_type: string | null;
  station_count: number;
  route_length_km: number;
  nearest_distance_km: number;
};

type NearbyPopupProps = {
  lat: number;
  lon: number;
  segments: NearbySegment[];
  loading: boolean;
  onClose: () => void;
  onSelectTrain: (trainNo: string) => void;
};

export default function NearbyPopup({ lat, lon, segments, loading, onClose, onSelectTrain }: NearbyPopupProps) {
  return (
    <div className="absolute top-20 left-1/2 -translate-x-1/2 z-40 w-[420px] max-h-[70vh] bg-[#111827]/95 backdrop-blur-xl border border-gray-700/80 rounded-2xl shadow-2xl flex flex-col overflow-hidden animate-in fade-in slide-in-from-top-2 duration-200">
      {/* Header */}
      <div className="px-5 py-4 border-b border-gray-700/60 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-emerald-600/20 text-emerald-400 flex items-center justify-center border border-emerald-500/30">
            <MapPin size={16} />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-gray-100">Nearby Railways</h3>
            <p className="text-[11px] text-gray-500 font-mono mt-0.5">
              {lat.toFixed(4)}°N, {lon.toFixed(4)}°E
            </p>
          </div>
        </div>
        <button
          onClick={onClose}
          className="p-1.5 rounded-lg text-gray-500 hover:text-gray-200 hover:bg-gray-800 transition-colors"
        >
          <X size={16} />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="flex items-center gap-3 text-gray-400 text-sm">
              <div className="w-5 h-5 border-2 border-blue-500/50 border-t-blue-400 rounded-full animate-spin" />
              Searching nearby routes…
            </div>
          </div>
        ) : segments.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 px-6 text-center">
            <div className="w-12 h-12 rounded-full bg-gray-800 flex items-center justify-center mb-3">
              <Train size={20} className="text-gray-600" />
            </div>
            <p className="text-sm text-gray-400">No railway routes found nearby</p>
            <p className="text-xs text-gray-600 mt-1">Try clicking closer to a railway line on the map</p>
          </div>
        ) : (
          <div className="p-3 space-y-2">
            <p className="text-[11px] text-gray-500 px-2 mb-1 font-medium uppercase tracking-wider">
              {segments.length} route{segments.length !== 1 ? "s" : ""} found
            </p>
            {segments.map((seg, idx) => (
              <button
                key={`${seg.route_id}-${idx}`}
                onClick={() => onSelectTrain(seg.route_id)}
                className="w-full text-left p-3 rounded-xl border border-gray-800 hover:border-gray-600 hover:bg-[#1f2937]/60 transition-all duration-150 group"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <h4 className="text-sm font-medium text-gray-200 truncate group-hover:text-white transition-colors">
                        {seg.train_name || `Train ${seg.route_id}`}
                      </h4>
                    </div>
                    <p className="text-xs text-gray-500 mt-1">
                      #{seg.route_id} · {seg.train_type || "N/A"}
                    </p>
                  </div>
                  <div className="shrink-0 flex items-center gap-1 text-gray-600 group-hover:text-blue-400 transition-colors">
                    <ArrowRight size={14} />
                  </div>
                </div>

                <div className="flex items-center gap-4 mt-2.5 text-[11px] text-gray-500">
                  <span className="flex items-center gap-1">
                    <Ruler size={11} />
                    {seg.nearest_distance_km} km away
                  </span>
                  <span>{seg.station_count} stations</span>
                  <span>{seg.route_length_km} km route</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
