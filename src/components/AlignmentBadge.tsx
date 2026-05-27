import { ShieldCheck, ShieldAlert, Loader2 } from "lucide-react";

type AlignmentResult = {
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

type AlignmentBadgeProps = {
  result: AlignmentResult | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
};

export default function AlignmentBadge({ result, loading, error, onClose }: AlignmentBadgeProps) {
  if (!result && !loading && !error) return null;

  if (loading) {
    return (
      <div className="absolute top-20 right-6 z-40 bg-[#111827]/95 backdrop-blur-xl border border-gray-700/80 rounded-2xl shadow-2xl p-5 w-72">
        <div className="flex items-center gap-3 text-gray-300">
          <Loader2 size={18} className="animate-spin text-blue-400" />
          <span className="text-sm">Verifying alignment…</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="absolute top-20 right-6 z-40 bg-[#111827]/95 backdrop-blur-xl border border-red-800/50 rounded-2xl shadow-2xl p-5 w-80">
        <div className="flex items-start justify-between mb-2">
          <div className="flex items-center gap-2 text-red-400">
            <ShieldAlert size={18} />
            <span className="text-sm font-semibold">Verification Error</span>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-xs">✕</button>
        </div>
        <p className="text-xs text-red-300/80">{error}</p>
      </div>
    );
  }

  if (!result) return null;

  const isCompliant = result.status === "COMPLIANT";

  return (
    <div
      className={`absolute top-20 right-6 z-40 bg-[#111827]/95 backdrop-blur-xl border rounded-2xl shadow-2xl p-5 w-80 ${
        isCompliant ? "border-emerald-700/50" : "border-amber-700/50"
      }`}
    >
      <div className="flex items-start justify-between mb-3">
        <div className={`flex items-center gap-2 ${isCompliant ? "text-emerald-400" : "text-amber-400"}`}>
          {isCompliant ? <ShieldCheck size={20} /> : <ShieldAlert size={20} />}
          <span className="text-sm font-semibold">
            {isCompliant ? "Alignment Verified" : "Misalignment Detected"}
          </span>
        </div>
        <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-xs">✕</button>
      </div>

      <div className="space-y-2 text-xs">
        <div className="flex justify-between text-gray-400">
          <span>Fréchet Distance</span>
          <span className={`font-mono font-medium ${isCompliant ? "text-emerald-300" : "text-amber-300"}`}>
            {result.frechet_distance_km} km
          </span>
        </div>
        <div className="flex justify-between text-gray-400">
          <span>Threshold</span>
          <span className="font-mono text-gray-300">{result.compliance_threshold_km} km</span>
        </div>
        <div className="flex justify-between text-gray-400">
          <span>Max Deviation</span>
          <span className={`font-mono font-medium ${isCompliant ? "text-emerald-300" : "text-amber-300"}`}>
            {result.max_deviation.deviation_km} km
          </span>
        </div>

        <div className="border-t border-gray-700/60 pt-2 mt-3">
          <p className="text-gray-400">
            Route: <span className="text-gray-200">{result.route_info.train_name}</span>
          </p>
          <p className="text-gray-500">
            #{result.route_info.train_no} · {result.route_info.route_length_km} km
          </p>
        </div>
      </div>
    </div>
  );
}
