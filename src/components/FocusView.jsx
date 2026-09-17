import React, { useState, useRef, useEffect } from 'react';
import LiveCCTVPlayer from './LiveCCTVPlayer';
import CameraCharts from './CameraCharts';

const FocusView = ({
  cameras,
  activeCameraIndex,
  setActiveCameraIndex,
  handleViolationAlert,
  cameraInfoList,
}) => {
  const activeCamera = cameras[activeCameraIndex];
  const info = cameraInfoList.find((c) => c.title && c.title.includes(activeCamera.id));

  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const menuRef = useRef(null);

  // Charts fetch per camera, so keep them collapsed by default - an operator
  // cycling quickly through cameras with the arrows/dropdown shouldn't pay
  // for a chart fetch on every single camera they pass through.
  const [showCharts, setShowCharts] = useState(false);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setIsMenuOpen(false);
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleEditRoi = () => {
    setIsMenuOpen(false);
    window.dispatchEvent(new CustomEvent(`toggle-roi-${activeCamera.id}`));
  };

  const goLeft = () => {
    setActiveCameraIndex((prev) => (prev === 0 ? cameras.length - 1 : prev - 1));
  };

  const goRight = () => {
    setActiveCameraIndex((prev) => (prev === cameras.length - 1 ? 0 : prev + 1));
  };

  return (
    <div className="flex flex-col bg-white rounded-2xl overflow-hidden border border-gray-200 shadow-2xl relative max-w-7xl mx-auto my-8">
      {/* Top Bar: Title & Dropdown */}
      <div className="flex justify-between items-center bg-white px-6 py-4 border-b border-gray-200">
        <h2 className="text-gray-900 text-xl font-bold tracking-wide">
          {activeCamera.title}
        </h2>
        <div className="flex items-center gap-3">
          <label className="text-gray-500 text-sm font-medium">Select Camera:</label>
          <select
            className="bg-white text-gray-900 border border-gray-300 rounded-lg px-3 py-1.5 focus:outline-none focus:border-amber-500 focus:ring-1 focus:ring-amber-500 transition-colors shadow-sm"
            value={activeCameraIndex}
            onChange={(e) => setActiveCameraIndex(Number(e.target.value))}
          >
            {cameras.map((cam, idx) => (
              <option key={cam.id} value={idx}>
                {cam.title}
              </option>
            ))}
          </select>

          {/* Three Dot Menu */}
          <div className="relative ml-2" ref={menuRef}>
            <button
              onClick={() => setIsMenuOpen(!isMenuOpen)}
              className="text-gray-500 hover:text-gray-900 p-1 rounded-md hover:bg-gray-100 transition-colors"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="1"></circle>
                <circle cx="12" cy="5" r="1"></circle>
                <circle cx="12" cy="19" r="1"></circle>
              </svg>
            </button>

            {isMenuOpen && (
              <div className="absolute right-0 mt-2 w-36 bg-white rounded-md shadow-lg border border-gray-200 z-50 py-1">
                <button
                  onClick={() => {
                    setIsMenuOpen(false);
                    window.dispatchEvent(new CustomEvent(`trigger-calibrate-${activeCamera.id}`));
                  }}
                  className="block w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 hover:text-amber-600 transition-colors"
                >
                  Auto Calibrate
                </button>
                <button
                  onClick={() => {
                    setIsMenuOpen(false);
                    window.dispatchEvent(new CustomEvent(`trigger-manual-calibrate-${activeCamera.id}`));
                  }}
                  className="block w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 hover:text-amber-600 transition-colors border-t border-gray-100"
                >
                  Manual Calibrate
                </button>
                <button
                  onClick={handleEditRoi}
                  className="block w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 hover:text-amber-600 transition-colors border-t border-gray-100"
                >
                  Edit ROI
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Video Container (16:9 Hero) */}
      <div className="relative w-full bg-black aspect-video group">
        <LiveCCTVPlayer
          key={activeCamera.id}
          streamUrl={activeCamera.url}
          cameraId={activeCamera.id}
          onViolationAlert={handleViolationAlert}
        />

        {/* Navigation Arrows */}
        <button
          onClick={goLeft}
          aria-label="Previous camera"
          className="absolute left-4 top-1/2 -translate-y-1/2 bg-black/50 hover:bg-black/80 text-white p-3 rounded-full opacity-70 md:opacity-0 md:group-hover:opacity-100 transition-all duration-200 z-50 backdrop-blur-sm border border-white/10"
        >
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
             <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>

        <button
          onClick={goRight}
          aria-label="Next camera"
          className="absolute right-4 top-1/2 -translate-y-1/2 bg-black/50 hover:bg-black/80 text-white p-3 rounded-full opacity-70 md:opacity-0 md:group-hover:opacity-100 transition-all duration-200 z-50 backdrop-blur-sm border border-white/10"
        >
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
             <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </button>
      </div>

      {/* Camera metadata - cheap client-side lookup from the already-fetched
          camera.json list, so this stays visible by default (unlike charts). */}
      <div className="px-6 py-5 border-t border-gray-200 bg-gray-50">
        {info ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 text-gray-700 text-sm">
            <div><strong className="text-gray-900">Viewpoint (EN):</strong> {info.viewpoint_en}</div>
            <div><strong className="text-gray-900">Viewpoint (TH):</strong> {info.viewpoint_th}</div>
            <div><strong className="text-gray-900">Route:</strong> {info.route}</div>
            <div><strong className="text-gray-900">Direction:</strong> {info.direction === 'R' ? 'Right / Outbound' : 'Left / Inbound'}</div>
            <div><strong className="text-gray-900">KM Marker:</strong> {info.km}</div>
            <div><strong className="text-gray-900">Coordinates:</strong> {info.latitude}, {info.longitude}</div>
          </div>
        ) : (
          <div className="text-gray-500 text-sm">Loading camera details from JSON...</div>
        )}
      </div>

      {/* Charts - collapsed by default, see showCharts comment above. */}
      <div className="px-6 py-5 border-t border-gray-200">
        <button
          onClick={() => setShowCharts((s) => !s)}
          className="text-sm font-medium text-gray-600 hover:text-amber-600 border border-gray-300 hover:border-amber-300 rounded-md px-3 py-1.5 transition-colors"
        >
          {showCharts ? 'Hide charts' : 'Show charts'}
        </button>
        {showCharts && (
          <div className="mt-4">
            <CameraCharts cameraId={activeCamera.id} />
          </div>
        )}
      </div>
    </div>
  );
};

export default FocusView;
