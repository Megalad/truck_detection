import { useEffect } from 'react';

export default function CameraNetworkMap() {
  useEffect(() => {
    // Prevent loading the script multiple times
    const existingScript = document.getElementById('longdo-map-script');
    
    const initMap = () => {
      try {
        console.log("Initializing Longdo Map...");
        const container = document.getElementById('longdo-map');
        if (!container) {
            console.error("Map container not found!");
            return;
        }
        
        // Initialize the Longdo Map inside our div
        const map = new window.longdo.Map({
          placeholder: container,
          language: 'en'
        });
        
        // Define our camera locations
        const cam1Location = { lon: 100.655, lat: 13.662 }; // Bangna-Trat
        const cam2Location = { lon: 100.561, lat: 13.824 }; // Vibhavadi
        
        // Drop markers on the map
        map.Overlays.add(new window.longdo.Marker(cam1Location, { 
          title: 'Camera 1 (INBOUND)', 
          detail: 'Bangna-Trat Km.6' 
        }));
        map.Overlays.add(new window.longdo.Marker(cam2Location, { 
          title: 'Camera 2 (INBOUND)', 
          detail: 'Vibhavadi Km.24' 
        }));
        
        // Center the map over Bangkok and zoom in
        map.location({ lon: 100.60, lat: 13.75 }, true); 
        map.zoom(11, true);
        
        // Optional: Add live traffic congestion lines
        map.Layers.add(window.longdo.Layers.TRAFFIC);
        console.log("Map initialized successfully!");
      } catch (err) {
        console.error("Longdo Map Error:", err);
        const container = document.getElementById('longdo-map');
        if (container) container.innerHTML = `<div style="padding: 20px; color: red;">Failed to load map: ${err.message}</div>`;
      }
    };

    // Load the script using your environment variable
    if (!existingScript) {
      console.log("Loading Longdo Map script...");
      const script = document.createElement('script');
      const apiKey = import.meta.env ? import.meta.env.VITE_LONGDO_MAP_KEY : null;
      const finalKey = apiKey || "600e1cba7abc18f7902f8a3e89b76cee"; 
      script.src = `https://api.longdo.com/map/?key=${finalKey}`;
      script.id = 'longdo-map-script';
      script.async = true;
      script.onload = () => {
         console.log("Script loaded!");
         // Longdo sometimes needs a tick to bind to window
         setTimeout(initMap, 100);
      };
      script.onerror = () => {
         const container = document.getElementById('longdo-map');
         if (container) container.innerHTML = `<div style="padding: 20px; color: red;">Failed to fetch Longdo script. Check API key or network.</div>`;
      };
      document.body.appendChild(script);
    } else {
      console.log("Script already exists. Initializing...");
      if (window.longdo) {
          setTimeout(initMap, 100);
      } else {
          // It's still loading from a previous mount
          existingScript.addEventListener('load', () => setTimeout(initMap, 100));
      }
    }
  }, []);

  return (
    <div style={{ backgroundColor: 'white', padding: '16px', borderRadius: '8px', boxShadow: '0 1px 2px rgba(0,0,0,0.05)', border: '1px solid #e2e8f0', marginBottom: '24px' }}>
      <h3 style={{ fontWeight: 'bold', color: '#1e293b', marginBottom: '12px' }}>Live Camera Network Map</h3>
      {/* The map will render inside this container */}
      <div id="longdo-map" style={{ width: '100%', height: '320px', borderRadius: '4px', border: '1px solid #cbd5e1' }}></div>
    </div>
  );
}
