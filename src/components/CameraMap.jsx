import { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

// Map of the monitored cameras (Live Monitoring -> Map view): each camera at its real GPS
// position from camera.json, on OpenStreetMap tiles. A search panel finds a camera by ID,
// name or location code (e.g. "TV27", "TY", "M7", "78+780") and flies the map to it.
// Cameras closer than GROUP_METERS share one icon (e.g. two directions on the same pole).

const GROUP_METERS = 100;

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

// Camera icon: amber pin with a camera glyph, plus a count badge for grouped cameras.
const cameraIcon = (count, selected) => L.divIcon({
  className: '',
  iconSize: [34, 34],
  iconAnchor: [17, 17],
  popupAnchor: [0, -16],
  html: `
    <div class="camera-map-pin${selected ? ' is-selected' : ''}">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="white" stroke-width="2"
           stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/>
      </svg>
      ${count > 1 ? `<span class="camera-map-count">${count}</span>` : ''}
    </div>`,
});

const distanceMeters = (a, b) => L.latLng(a.lat, a.lng).distanceTo(L.latLng(b.lat, b.lng));

export default function CameraMap({ cameras, cameraInfoList, onOpenCamera }) {
  const mapEl = useRef(null);
  const mapRef = useRef(null);
  const markersRef = useRef([]); // [{ group, marker }]
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  // Latest callback in a ref, so a parent re-render never forces the markers to be rebuilt.
  const openCameraRef = useRef(onOpenCamera);
  useEffect(() => { openCameraRef.current = onOpenCamera; }, [onOpenCamera]);

  // Monitored cameras joined with their GPS / route / KM from camera.json.
  const located = useMemo(() => cameras.map((cam, index) => {
    const info = cameraInfoList.find((c) => (c.title || '').split(' ')[0] === cam.id);
    const lat = Number(info?.latitude), lng = Number(info?.longitude);
    return {
      ...cam,
      index,
      route: info?.route || '',
      km: info?.km || '',
      lat,
      lng,
      hasPosition: Number.isFinite(lat) && Number.isFinite(lng) && (lat !== 0 || lng !== 0),
    };
  }), [cameras, cameraInfoList]);

  // Group cameras standing at (almost) the same spot into one marker.
  const groups = useMemo(() => {
    const result = [];
    located.filter((c) => c.hasPosition).forEach((cam) => {
      const near = result.find((g) => distanceMeters(g[0], cam) <= GROUP_METERS);
      if (near) near.push(cam); else result.push([cam]);
    });
    return result;
  }, [located]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return located;
    return located.filter((c) => [c.id, c.title, c.route, c.km].some((v) => String(v).toLowerCase().includes(q)));
  }, [located, query]);

  // Create the map once.
  useEffect(() => {
    const map = L.map(mapEl.current, { zoomControl: true, scrollWheelZoom: true });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);
    map.setView([13.75, 100.7], 10);
    mapRef.current = map;

    // Leaflet measures its box once, at creation. The box can still be resizing then (layout,
    // Tailwind CDN styles arriving, window resize), which leaves grey untiled areas and
    // misplaced markers - so re-measure whenever the box's size changes.
    const resizeObserver = new ResizeObserver(() => map.invalidateSize());
    resizeObserver.observe(mapEl.current);

    return () => { resizeObserver.disconnect(); map.remove(); mapRef.current = null; };
  }, []);

  // (Re)draw markers when the camera data arrives.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return undefined;
    markersRef.current.forEach(({ marker }) => marker.remove());

    markersRef.current = groups.map((group) => {
      const marker = L.marker([group[0].lat, group[0].lng], { icon: cameraIcon(group.length, false), title: group.map((c) => c.id).join(', ') });
      const rows = group.map((c) => `
        <div class="camera-map-popup-row">
          <div class="camera-map-popup-title">${escapeHtml(c.title)}</div>
          <div class="camera-map-popup-meta">Route ${escapeHtml(c.route || '-')} &middot; KM ${escapeHtml(c.km || '-')}</div>
          <button type="button" class="camera-map-open" data-camera-index="${c.index}">Open camera</button>
        </div>`).join('');
      marker.bindPopup(`
        ${rows}
        <div class="camera-map-popup-coords">
          ${group[0].lat.toFixed(6)}, ${group[0].lng.toFixed(6)}
          &middot; <a href="https://www.google.com/maps?q=${group[0].lat},${group[0].lng}" target="_blank" rel="noopener noreferrer">Google Maps</a>
        </div>`, { minWidth: 220 });
      marker.addTo(map);
      return { group, marker };
    });

    // "Open camera" buttons live inside Leaflet's popup HTML, so wire them on open.
    const onPopupOpen = (e) => {
      e.popup.getElement()?.querySelectorAll('.camera-map-open').forEach((btn) => {
        btn.onclick = () => openCameraRef.current(Number(btn.dataset.cameraIndex));
      });
    };
    map.on('popupopen', onPopupOpen);

    if (groups.length) {
      map.fitBounds(L.latLngBounds(groups.map((g) => [g[0].lat, g[0].lng])), { padding: [40, 40] });
    }
    return () => { map.off('popupopen', onPopupOpen); };
  }, [groups]);

  // Highlight the selected camera's icon.
  useEffect(() => {
    markersRef.current.forEach(({ group, marker }) => {
      marker.setIcon(cameraIcon(group.length, group.some((c) => c.id === selectedId)));
    });
  }, [selectedId, groups]);

  const focusCamera = (cam) => {
    setSelectedId(cam.id);
    const entry = markersRef.current.find(({ group }) => group.some((c) => c.id === cam.id));
    if (!entry || !mapRef.current) return;
    mapRef.current.flyTo(entry.marker.getLatLng(), 15, { duration: 0.8 });
    mapRef.current.once('moveend', () => entry.marker.openPopup());
  };

  const showAll = () => {
    setSelectedId(null);
    mapRef.current?.closePopup();
    if (groups.length) mapRef.current?.flyToBounds(L.latLngBounds(groups.map((g) => [g[0].lat, g[0].lng])), { padding: [40, 40], duration: 0.8 });
  };

  return (
    <div className="flex flex-col md:flex-row gap-4">
      {/* Search + camera list */}
      <aside className="md:w-72 shrink-0 bg-white rounded-xl border border-gray-200 shadow-sm flex flex-col md:max-h-[70vh]">
        <div className="p-3 border-b border-gray-200">
          <label htmlFor="camera-search" className="sr-only">Search cameras</label>
          <input
            id="camera-search"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && matches[0]) focusCamera(matches[0]); }}
            placeholder="Search camera, e.g. TV27 or TY"
            className="w-full px-3 py-2 text-sm text-gray-900 bg-white border border-gray-300 rounded-lg placeholder-gray-400 focus:outline-none focus:border-amber-500 focus:ring-1 focus:ring-amber-500"
          />
          <div className="mt-2 flex items-center justify-between text-xs text-gray-500">
            <span>{matches.length} of {located.length} cameras</span>
            <button onClick={showAll} className="font-semibold text-amber-600 hover:text-amber-700">Show all</button>
          </div>
        </div>
        <ul className="overflow-y-auto max-h-60 md:max-h-none md:flex-1 divide-y divide-gray-100">
          {matches.map((cam) => (
            <li key={cam.id}>
              <button
                onClick={() => focusCamera(cam)}
                disabled={!cam.hasPosition}
                className={`w-full text-left px-3 py-2.5 transition-colors disabled:opacity-50 ${selectedId === cam.id ? 'bg-amber-50' : 'hover:bg-gray-50'}`}
              >
                <div className="text-sm font-semibold text-gray-900">{cam.id}</div>
                <div className="text-xs text-gray-500">
                  {cam.title.replace(`${cam.id} `, '')}{cam.hasPosition ? '' : ' · no GPS position'}
                </div>
              </button>
            </li>
          ))}
          {matches.length === 0 && (
            <li className="px-3 py-6 text-center text-sm text-gray-500">No camera matches "{query}"</li>
          )}
        </ul>
      </aside>

      {/* Map */}
      <div
        ref={mapEl}
        style={{ height: '70vh', minHeight: 360 }}
        className="flex-1 rounded-xl border border-gray-200 shadow-sm z-0"
      />
    </div>
  );
}
