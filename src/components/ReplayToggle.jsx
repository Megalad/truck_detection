import { setReplayMode, useReplayMode } from '../replay';

// Live | Replay switch for the Live Monitoring header (see replay.js).
export default function ReplayToggle() {
  const replay = useReplayMode();
  const opt = (on, label) => (
    <button
      onClick={() => setReplayMode(on)}
      className={`px-3 py-1 text-sm font-semibold rounded-full transition-colors ${
        replay === on ? 'bg-amber-600 text-white' : 'text-gray-600 hover:text-gray-900'
      }`}
    >
      {label}
    </button>
  );
  return (
    <div
      className="flex items-center gap-1 bg-white border border-gray-200 rounded-full p-1 shadow-sm"
      title="Replay plays the recorded clips in public/demo through the same detection pipeline - use it if the CCTV streams are unavailable."
    >
      {opt(false, 'Live')}
      {opt(true, 'Replay')}
    </div>
  );
}
