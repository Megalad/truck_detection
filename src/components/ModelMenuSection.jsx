import { useAdminSession } from '../adminAuth';
import { setOverlayModel, useOverlayModel } from '../overlayModel';

const OPTIONS = [
  { id: 'box', label: 'Bounding Box', hint: 'Production model' },
  { id: 'seg', label: 'Segmentation', hint: 'Experimental - no violations filed' },
];

// "Detection model" section for a camera's ⋮ menu. Admin-only, like the on-video toggle.
export default function ModelMenuSection({ cameraId, onPicked }) {
  const session = useAdminSession();
  const current = useOverlayModel(cameraId);
  if (!session) return null;

  return (
    <div className="border-t border-gray-100 py-1" role="group" aria-label="Detection model">
      <div className="px-4 pt-1.5 pb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
        Detection model
      </div>
      {OPTIONS.map((opt) => (
        <button
          key={opt.id}
          role="menuitemradio"
          aria-checked={current === opt.id}
          onClick={() => { setOverlayModel(cameraId, opt.id); onPicked?.(); }}
          title={opt.hint}
          className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-50 hover:text-amber-600 transition-colors"
        >
          <span
            className={`h-3 w-3 shrink-0 rounded-full border ${
              current === opt.id ? (opt.id === 'seg' ? 'border-purple-500 bg-purple-500' : 'border-green-500 bg-green-500') : 'border-gray-300'
            }`}
          />
          {opt.label}
        </button>
      ))}
    </div>
  );
}
