import { useState, useEffect, useRef } from "react";

const apiHost = window.location.hostname === "localhost" ? "http://localhost:8000" : "";
const MAX_KMH = 200;

// One speed limit shared by every camera and recorded-video job; the server
// is the source of truth. 0 = flag every truck in the restricted lane.
export default function SpeedLimitControl() {
  const [value, setValue] = useState("0");
  const [status, setStatus] = useState("idle"); // idle | saving | saved | error
  const [loaded, setLoaded] = useState(false); // don't allow saving until the server's value is known

  const dirtyRef = useRef(false);
  const [dirty, setDirty] = useState(false); // user is mid-edit; don't overwrite their typing

  useEffect(() => {
    // Drop the obsolete per-camera limits older versions saved in this browser.
    try {
      Object.keys(localStorage)
        .filter((k) => k.startsWith("speed_limit_"))
        .forEach((k) => localStorage.removeItem(k));
    } catch (e) {}
  }, []);

  // Load on mount, then poll so changes made from another tab/browser show up.
  useEffect(() => {
    const load = () =>
      fetch(`${apiHost}/api/speed_limit`)
        .then((res) => { if (!res.ok) throw new Error(res.status); return res.json(); })
        .then((json) => {
          setLoaded(true);
          setValue((cur) => (dirtyRef.current ? cur : String(json.value)));
        })
        .catch(() => setStatus("error"));
    load();
    const id = setInterval(load, 15000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => { dirtyRef.current = dirty; }, [dirty]);

  const save = async () => {
    const num = Number(value);
    if (value === "" || !Number.isFinite(num) || num < 0 || num > MAX_KMH) {
      setStatus("error");
      return;
    }
    setStatus("saving");
    try {
      const res = await fetch(`${apiHost}/api/speed_limit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: num }),
      });
      if (!res.ok) throw new Error(res.status);
      setStatus("saved");
      setDirty(false);
    } catch (e) {
      setStatus("error");
    }
  };

  return (
    <div
      className="flex items-center gap-2 bg-white border border-gray-200 rounded-full pl-4 pr-1 py-1 shadow-sm"
      title="0 = flag every truck in the right lane regardless of speed. Applies to all cameras."
    >
      <label className="text-sm font-medium text-gray-700" htmlFor="speed-limit">Speed limit</label>
      <input
        id="speed-limit"
        type="number"
        min="0"
        max={MAX_KMH}
        step="5"
        value={value}
        onChange={(e) => { setValue(e.target.value); setStatus("idle"); setDirty(true); }}
        onKeyDown={(e) => e.key === "Enter" && loaded && save()}
        className="w-16 px-2 py-1 text-sm text-gray-900 border border-gray-300 rounded-md focus:outline-none focus:border-amber-500"
      />
      <span className="text-sm text-gray-500">km/h</span>
      <button
        onClick={save}
        disabled={!loaded || status === "saving"}
        className="px-3 py-1 text-sm font-semibold rounded-full bg-amber-600 hover:bg-amber-700 text-white disabled:opacity-50 transition-colors"
        title={loaded ? undefined : "Can't reach the server"}
      >
        {status === "saved" ? "Saved ✓" : status === "error" ? "Retry" : "Set"}
      </button>
    </div>
  );
}
