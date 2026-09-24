import React, { useEffect, useRef, useState } from 'react';

// Step 1's photo can be swapped live from the browser (e.g. mid-demo, if a professor
// asks to see a genuinely fresh capture) via a file picker, instead of the fixed
// pipeline_01_capture.jpg. This is entirely local to this browser tab/session - it
// never uploads anywhere or changes what anyone else sees on the site. Kept in
// sessionStorage (not localStorage) so an accidental page refresh mid-demo doesn't
// lose it, but it naturally resets for a new tab/day, same as the admin login session.
const STEP1_IMAGE_KEY = 'projectReportStep1Image';

// Matches AI_MAX_WIDTH in LiveCCTVPlayer.jsx - the real width the live system downscales to
// before sending a frame to the server. Kept as one named constant so step 2's demo actually
// stays true to that real value instead of a second, easy-to-forget hardcoded copy of it.
const LIVE_FRAME_WIDTH = 640;

// TV03CL2's real entry from calibration.json: the 4 manually picked image_points /
// world_points_m pairs speed_estimator.py passes to cv2.findHomography() for this camera
// (lane width 3.5 m x dashed-line spacing 27 m). Shown over a frame from the same camera
// (public/report/calibration_TV03CL2.jpg, 1280x720 like the calibration).
const CALIBRATION_TV03CL2 = {
  imageWidth: 1280,
  imageHeight: 720,
  // px/py = pixel coords in the 1280x720 frame; wx/wy = real-world metres on the flat road
  // (wx: across the 3.5 m lane, wy: depth away from the camera).
  points: [
    { px: 666.0, py: 242.4, wx: 0.0, wy: 27.0 },
    { px: 698.1, py: 241.4, wx: 3.5, wy: 27.0 },
    { px: 790.2, py: 437.7, wx: 3.5, wy: 0.0 },
    { px: 720.1, py: 439.7, wx: 0.0, wy: 0.0 },
  ],
};

// TV03CL2's real, currently-configured restricted-lane ROI - the exact same 4 points saved
// in rois.json (what the live system itself checks trucks against for this camera), not an
// illustrative shape. Normalized 0-1, same convention rois.json and the live ROI editor use.
const REAL_ROI_TV03CL2 = [
  { x: 0.530473017008165, y: 0.3433918045340107 },
  { x: 0.5617719188891132, y: 0.34200074222819077 },
  { x: 0.6752304382075504, y: 0.6730735710133317 },
  { x: 0.5735090070944687, y: 0.6855931317657109 },
];

// A small spinner, reused everywhere this file needs a "working on it" indicator (step 1's
// video-frame extraction, step 3's detection run). Plain inline SVG + CSS animation, no
// dependency - matches the rest of this file's inline-style-only convention.
function Spinner({ size = 22, color = '#3b82f6' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={{ animation: 'dodo-spin 0.8s linear infinite' }}>
      <circle cx="12" cy="12" r="9" fill="none" stroke={color} strokeWidth="3" strokeOpacity="0.2" />
      <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke={color} strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

// The "moving to the next step" loading state, centered directly on top of the step's own
// image - not off to the side next to a button, which read as an unrelated indicator rather
// than "this step is wrapping up". Dropped into whichever image container is currently
// visible for the step being left; each of those containers already has position:'relative',
// so this only ever needs position:'absolute', inset:0 to cover it exactly.
function StepLoadingOverlay({ label = 'Loading...' }) {
  return (
    <div style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(255,255,255,0.85)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '10px', borderRadius: '8px', zIndex: 5 }}>
      <Spinner size={28} />
      <span style={{ fontSize: '13px', fontWeight: 600, color: '#334155' }}>{label}</span>
    </div>
  );
}

// Every step image used to just pop in the instant its src resolved - jarring, especially on
// a slower connection. This is spread into each existing <img>'s own style object (added
// directly, not a wrapper component) so it can't disturb any of the absolute-positioned
// overlay markers (track points, calibration dots) that sit as siblings next to several of
// these images - a wrapper would risk repositioning those; a plain style addition can't.
const FADE_IN = { animation: 'dodo-fadein 0.45s ease' };

export default function FrameOptimizationReport() {
  const [step1Image, setStep1Image] = useState(null);
  const [step1Video, setStep1Video] = useState(null);
  const [isProcessingUpload, setIsProcessingUpload] = useState(false); // true while a video's first frame is being extracted
  // A second REAL frame, captured a fraction of a second after step1Image, only when the
  // upload is a video (a photo has no "next frame" to offer). Exists purely so step 4's
  // Optical Flow panel can show the tracked point's actual measured motion between two real
  // frames, instead of a single static point with no way to show movement.
  const [step1Image2, setStep1Image2] = useState(null);
  const [flowPoint2, setFlowPoint2] = useState(null); // frame 2's detected ground point, normalized {x, y}
  const [fingerprint, setFingerprint] = useState(null); // real 512-d re-ID embedding (sample) from /api/detect_demo, step 7
  const [step2Image, setStep2Image] = useState(null);
  const [step3Image, setStep3Image] = useState(null);
  const [step3Bbox, setStep3Bbox] = useState(null); // real detected-truck box from /api/detect_demo, normalized 0-1
  const [currentStep, setCurrentStep] = useState(1);
  // Step 4 ("Estimate speed") has its own 3 sub-panels (Optical Flow / Homography / Kalman
  // Filter). 1 = only the first is shown, 4 = all three plus the frame-tracking recap are
  // shown - revealed one click at a time so a presenter can narrate each in turn instead of
  // dumping all three on screen together. Once step 4 itself is behind you (currentStep > 4),
  // this stops gating anything - see `revealed` below.
  const [step4Reveal, setStep4Reveal] = useState(1);
  const fileInputRef = useRef(null);

  // A 1s "loading" beat before a step (or step 4 sub-step) actually advances - both
  // "Continue to Step N" and step 4's "Next: ..." buttons go through this instead of
  // calling setCurrentStep/setStep4Reveal directly, so the transition reads as the system
  // doing something rather than an instant jump-cut. advancingFrom is the step NUMBER being
  // left (not just a boolean) so the loading spinner can be shown centered over that specific
  // step's own image - not just as text next to a button - which is where it actually reads
  // as "this step is finishing up", not a stray unrelated indicator. Only one transition can
  // be in flight at a time, so a stray unmount/reset just cancels the pending one cleanly.
  const [advancingFrom, setAdvancingFrom] = useState(null); // step number, or null
  const isAdvancing = advancingFrom !== null;
  const advanceTimeoutRef = useRef(null);
  useEffect(() => () => clearTimeout(advanceTimeoutRef.current), []); // cancel on unmount

  const advanceAfterDelay = (fromStep, apply) => {
    setAdvancingFrom(fromStep);
    clearTimeout(advanceTimeoutRef.current);
    advanceTimeoutRef.current = setTimeout(() => {
      apply();
      setAdvancingFrom(null);
    }, 1000);
  };
  const handleContinue = (fromStep) => advanceAfterDelay(fromStep, () => setCurrentStep(fromStep + 1));
  const handleStep4Next = (toReveal) => advanceAfterDelay(4, () => setStep4Reveal(toReveal));

  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(STEP1_IMAGE_KEY);
      if (saved) setStep1Image(saved);
    } catch { /* private mode etc. */ }
  }, []);

  // Step 2 ("Resize & send") is a real, live resize of whatever step 1 currently shows -
  // not a second, separately-uploaded photo. Without this, uploading a fresh photo in step
  // 1 would leave step 2 stuck on an unrelated old picture, breaking the "one real truck,
  // followed through every stage" story the whole section is built around.
  useEffect(() => {
    if (!step1Image) { setStep2Image(null); return; }
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      const scale = Math.min(1, LIVE_FRAME_WIDTH / img.naturalWidth);
      const w = Math.round(img.naturalWidth * scale);
      const h = Math.round(img.naturalHeight * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      setStep2Image(canvas.toDataURL('image/jpeg', 0.6)); // same quality the live system sends at
    };
    img.src = step1Image;
    return () => { cancelled = true; };
  }, [step1Image]);

  const [isDetecting, setIsDetecting] = useState(false);
  // "box" = production model_v6.pt (bounding boxes), "seg" = experimental truck_seg model
  // (Plan B, models/model_seg_v1.pt) - lets step 3 be re-run with either one on the same
  // uploaded photo, so the two can actually be compared side by side instead of just described.
  const [demoModel, setDemoModel] = useState('box');
  const [maskGroundPoint, setMaskGroundPoint] = useState(null); // seg: midpoint of the two wheel points (speed track point), normalized
  const [maskWheelPoints, setMaskWheelPoints] = useState(null); // seg: [left, right] wheel-contact points (ROI test), normalized
  const [lastRunModel, setLastRunModel] = useState(null); // which model actually produced step3Image ("box" | "seg")

  // Step 5's interactive ROI - draw-to-test, the same click-to-add-points interaction as the
  // real admin ROI editor on the Live Monitoring page (LiveCCTVPlayer.jsx's handleSvgClick/
  // handleFinishDrawing), not a fixed illustration. Points are kept directly as percentages
  // (0-100) of the image's own rendered box, computed straight from each click's position -
  // simpler than the live page's version needs to be, since this image is never object-fit
  // cropped, so no pixel<->normalized conversion or resize tracking is required here.
  const [roiPoints, setRoiPoints] = useState([]); // [{x, y}] in percent
  const [isDrawingRoi, setIsDrawingRoi] = useState(false);
  const [roiFinished, setRoiFinished] = useState(false);

  const handleRoiClick = (e) => {
    if (!isDrawingRoi || roiFinished) return;
    const rect = e.currentTarget.getBoundingClientRect();
    setRoiPoints((pts) => [...pts, {
      x: (e.clientX - rect.left) / rect.width * 100,
      y: (e.clientY - rect.top) / rect.height * 100,
    }]);
  };
  const handleRoiClear = () => { setRoiPoints([]); setRoiFinished(false); };
  const handleRoiFinish = () => { if (roiPoints.length >= 3) setRoiFinished(true); };
  const handleRoiLoadReal = () => {
    setRoiPoints(REAL_ROI_TV03CL2.map((p) => ({ x: p.x * 100, y: p.y * 100 })));
    setRoiFinished(true);
    setIsDrawingRoi(true);
  };

  // Same test the real backend runs (cv2.pointPolygonTest, in live_server.py) - ray casting
  // against the polygon you actually drew, not a scripted "yes" - so this genuinely answers
  // differently depending on where you draw it and where the truck actually is.
  const pointInPolygon = (x, y, poly) => {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  };
  // The truck's ROI test point(s) as percentages {x, y} (0-100, y from top) - the same rule
  // as the live system: box model = the box's bottom-right corner; segmentation model = the
  // mask's two wheel-contact points, where either one inside the ROI counts.
  const truckRoiPoints = lastRunModel === 'seg' && maskWheelPoints
    ? maskWheelPoints.map((p) => ({ x: p.x * 100, y: p.y * 100 }))
    : step3Bbox
    ? [{ x: step3Bbox.x2 * 100, y: step3Bbox.y2 * 100 }]
    : null;
  const truckInsideDrawnRoi = roiFinished && roiPoints.length >= 3 && truckRoiPoints
    ? truckRoiPoints.some((p) => pointInPolygon(p.x, p.y, roiPoints))
    : null; // null = can't tell yet (no ROI drawn, or no detection run)

  // Reduces a /api/detect_demo response to one normalized {x, y} ground point, matching
  // whichever kind of point the selected model actually produced - mask pixel for seg, box
  // center-bottom for box - same rule frame 1's own track point already follows.
  const groundPointFromResponse = (data, model) => {
    if (model === 'seg' && data?.mask_ground_point) return data.mask_ground_point;
    if (data?.bbox) return { x: (data.bbox.x1 + data.bbox.x2) / 2, y: data.bbox.y2 };
    return null;
  };

  const handleRunDetection = async () => {
    if (!step2Image) return;
    setIsDetecting(true);
    try {
      const apiHost = window.location.hostname === 'localhost'
        ? 'http://localhost:8000'
        : `${window.location.protocol}//${window.location.hostname}:8000`;

      const response = await fetch(`${apiHost}/api/detect_demo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image_base64: step2Image, model: demoModel })
      });

      const data = await response.json().catch(() => null);
      if (response.ok) {
        if (data?.result_image) setStep3Image(data.result_image);
        setStep3Bbox(data?.bbox || null);
        setMaskGroundPoint(data?.mask_ground_point || null);
        setMaskWheelPoints(data?.mask_wheel_points || null);
        setLastRunModel(data?.model_used || demoModel);
        setFingerprint(data?.fingerprint || null);

        // Real optical-flow demo (step 4): if the upload was a video, a second real frame
        // exists (captured in handleStep1Upload, ~0.4s after this one). Detect on it too,
        // with the same model, so step 4 can show this point's ACTUAL measured motion
        // between two real frames - not just where it sits in one.  Not resized to 640px
        // like step2Image - normalized (0-1) coordinates are scale-independent, so this
        // doesn't need to match that pipeline exactly to give the same real point.
        if (step1Image2) {
          setFlowPoint2(null);
          const resp2 = await fetch(`${apiHost}/api/detect_demo`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ image_base64: step1Image2, model: demoModel })
          });
          const data2 = await resp2.json().catch(() => null);
          if (resp2.ok) setFlowPoint2(groundPointFromResponse(data2, data?.model_used || demoModel));
        } else {
          setFlowPoint2(null);
        }
      } else {
        alert(data?.detail || ("Failed to connect to AI (Error " + response.status + "). Please make sure you RESTARTED the Python server (live_server.py) so it loads the new Code!"));
      }
    } catch (err) {
      console.error("Live detection error:", err);
      alert("Network Error: Could not reach the Python server. Make sure it is running.");
    } finally {
      setIsDetecting(false);
    }
  };

  const handleStep1Upload = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.type.startsWith('video/')) {
      setIsProcessingUpload(true);
      setStep1Image2(null);
      setFlowPoint2(null);
      const fileUrl = URL.createObjectURL(file);
      setStep1Video(fileUrl);
      const video = document.createElement('video');
      video.src = fileUrl;
      video.muted = true;

      const FLOW_GAP_SECONDS = 0.4; // real gap between the two frames used for step 4's optical-flow demo
      let capturedFirst = false;
      const captureFrame = () => {
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL('image/jpeg', 0.9);
      };

      video.onloadeddata = () => { video.currentTime = 0.5; };
      video.onseeked = () => {
        if (!capturedFirst) {
          capturedFirst = true;
          const dataUrl = captureFrame();
          setStep1Image(dataUrl);
          try { sessionStorage.setItem(STEP1_IMAGE_KEY, dataUrl); } catch {}

          // Grab a second, real frame a moment later - only possible because this upload is
          // a video. A clip too short for a meaningful gap just skips it; step 4 falls back
          // to its single-point view in that case (see the panel's own fallback there).
          const secondTime = Math.min(video.duration - 0.05, video.currentTime + FLOW_GAP_SECONDS);
          if (Number.isFinite(secondTime) && secondTime > video.currentTime) {
            video.currentTime = secondTime;
          } else {
            setIsProcessingUpload(false);
          }
        } else {
          setStep1Image2(captureFrame());
          setIsProcessingUpload(false);
        }
      };
    } else {
      setIsProcessingUpload(true);
      setStep1Image2(null); // a photo has no second frame - clear any left over from a previous video upload
      setFlowPoint2(null);
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result;
        setStep1Image(dataUrl);
        setStep1Video(null);
        setIsProcessingUpload(false);
        try { sessionStorage.setItem(STEP1_IMAGE_KEY, dataUrl); } catch {}
      };
      reader.readAsDataURL(file);
    }
  };

  const handleStep1Reset = () => {
    setStep1Image(null);
    setStep2Image(null);
    setStep3Image(null);
    setStep3Bbox(null);
    setMaskGroundPoint(null);
    setMaskWheelPoints(null);
    setLastRunModel(null);
    setStep1Video(null);
    setStep1Image2(null);
    setFlowPoint2(null);
    setFingerprint(null);
    setIsDetecting(false);
    setIsProcessingUpload(false);
    setRoiPoints([]);
    setIsDrawingRoi(false);
    setRoiFinished(false);
    clearTimeout(advanceTimeoutRef.current);
    setAdvancingFrom(null);
    setCurrentStep(1);
    setStep4Reveal(1);
    try { sessionStorage.removeItem(STEP1_IMAGE_KEY); } catch { /* ignore */ }
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  return (
    <div style={{ maxWidth: '1000px', margin: '40px auto', fontFamily: 'system-ui, -apple-system, sans-serif', color: '#1e293b', padding: '20px' }}>
      <style>{`
        @keyframes dodo-spin { to { transform: rotate(360deg); } }
        @keyframes dodo-fadein { from { opacity: 0; } to { opacity: 1; } }
        @keyframes dodo-ping { 75%, 100% { transform: scale(2.2); opacity: 0; } }
      `}</style>


      {/* =========================================
          PART 0: HOW THE SYSTEM WORKS, STEP BY STEP
          Every image below is from one real truck, on one real camera (TV03CL2),
          followed through the actual pipeline in a single pass - not staged.
          ========================================= */}

      <div style={{ textAlign: 'center', paddingBottom: '24px', borderBottom: '1px solid #e2e8f0', marginBottom: '32px' }}>
        <h1 style={{ fontSize: '32px', margin: '0 0 8px 0', color: '#0f172a' }}>How the System Works</h1>
        <p style={{ fontSize: '18px', color: '#64748b', margin: 0 }}>One real truck, followed through every stage of the pipeline</p>
      </div>

      {[
        {
          n: 1,
          title: 'Capture the frame',
          body: "The system pulls a live frame straight from the camera's own CCTV feed - here, TV03CL2, at its native 1280×720.",
          img: 'pipeline_01_capture.jpg',
        },
        {
          n: 2,
          title: 'Resize & send',
          body: 'The resized frame(640x640) is sent to the Python server over a WebSocket for fast AI detection.',
          img: 'pipeline_02_resize.jpg',
        },
        {
          n: 3,
          title: 'Detect & track',
          body: 'A YOLO11 model finds every truck in the frame. Each one gets a stable ID that follows it across frames.',
          img: 'pipeline_03_detect.jpg',
        },
        {
          n: 4,
          title: 'Estimate speed',
          body: "The truck's ground-contact point is mapped through this camera's own calibration into real-world metres, then a Kalman filter turns that into one steady km/h reading - 12.9 km/h here, not a single noisy frame-to-frame guess.",
          img: 'pipeline_04_speed.jpg',
        },
        {
          n: 5,
          title: 'Check the restricted lane',
          body: "Is the truck inside the marked restricted lane (the red region)? With the bounding-box model, the system tests the box's bottom-right corner - where the right-side wheels meet the road. With the segmentation model, it tests both wheel-contact points from the truck's real outline, and either one inside counts. The check runs every frame, and each truck is reported once.",
          img: 'pipeline_05_roi.jpg',
        },
        {
          n: 6,
          title: 'Capture evidence',
          body: 'Once confirmed, a 1920×1080 evidence photo is generated: the background dimmed, the truck itself kept bright, and a red marker placed above it - built for a human to review afterward, not just a machine.',
          img: 'pipeline_06_evidence.jpg',
        },
        {
          n: 7,
          title: 'Fingerprint & match the route',
          body: "Before saving, the truck's crop is run through a ResNet34 model (trained on VeRi-776, a vehicle re-ID dataset) to get a 512-number visual fingerprint. That fingerprint is compared against every OTHER camera's violations on the same route in the last 15 minutes - so the system can tell if this is the same truck caught earlier down the highway, not just a one-off event.",
          img: 'pipeline_06_evidence.jpg',
        },
        {
          n: 8,
          title: 'Alert sent & saved',
          body: 'The photo, camera name, and speed are sent to Telegram within seconds, and the same violation - fingerprint and route match included - is written to the database, where it shows up in the Violations page for review.',
          img: 'alert.png',
        },
      ].map((step, i, arr) => {
        if (step.n > currentStep) return null;
        return (
        <React.Fragment key={step.n}>
          {/* animation, not transition: this card is freshly mounted the moment it's
              revealed (earlier steps return null before that), and a CSS transition only
              animates a property CHANGE on an element already in the DOM - it wouldn't fire
              on first appearance at all. animation runs once on mount, which is what a newly
              revealed step actually needs. */}
          <div style={{ backgroundColor: '#ffffff', borderRadius: '12px', border: '1px solid #e2e8f0', boxShadow: '0 2px 4px rgba(0,0,0,0.05)', overflow: 'hidden', animation: 'dodo-fadein 0.4s ease' }}>
            <div style={{ padding: '20px 24px 4px 24px', display: 'flex', alignItems: 'flex-start', gap: '14px' }}>
              <span style={{ flexShrink: 0, width: '28px', height: '28px', borderRadius: '50%', backgroundColor: '#3b82f6', color: '#fff', fontSize: '14px', fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {step.n}
              </span>
              <div>
                <h4 style={{ color: '#0f172a', margin: '0 0 6px 0', fontSize: '17px' }}>{step.title}</h4>
                {step.n !== 1 && step.body && (
                  <p style={{ margin: 0, fontSize: '14px', color: '#475569', lineHeight: '1.6' }}>{step.body}</p>
                )}
              </div>
            </div>
            <div style={{ padding: '16px 24px 24px 24px' }}>
              {step.n === 3 && step3Image ? (
                <div style={{ position: 'relative', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '16px' }}>
                  <div>
                    <div style={{ fontSize: '12px', fontWeight: 700, color: '#64748b', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Received by Server (640px)</div>
                    <img key={step2Image} src={step2Image} style={{ width: '100%', height: 'auto', borderRadius: '8px', border: '1px solid #e2e8f0', ...FADE_IN }} alt="Received" />
                  </div>
                  <div>
                    <div style={{ fontSize: '12px', fontWeight: 700, color: '#3b82f6', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Detected Result (YOLO - {lastRunModel === 'seg' ? 'Segmentation' : 'Bounding Box'})</div>
                    <div style={{ position: 'relative' }}>
                      <img key={step3Image} src={step3Image} style={{ width: '100%', height: 'auto', borderRadius: '8px', border: '2px solid #3b82f6', boxShadow: '0 4px 12px rgba(59, 130, 246, 0.15)', display: 'block', ...FADE_IN }} alt="Result" />
                      {/* ROI test points, as the live system uses them: the box's bottom-right corner
                          (red) vs the segmentation mask's two wheel-contact points (green). On an angled
                          or wide truck these land in different places and can decide "in ROI" differently. */}
                      {step3Bbox && (
                        <div title="Bounding box ROI point (bottom-right corner)" style={{ position: 'absolute', left: `${step3Bbox.x2 * 100}%`, top: `${step3Bbox.y2 * 100}%`, width: '12px', height: '12px', marginLeft: '-6px', marginTop: '-6px', borderRadius: '50%', backgroundColor: '#ef4444', border: '2px solid white', boxShadow: '0 0 8px #ef4444' }} />
                      )}
                      {maskWheelPoints && maskWheelPoints.map((p, i) => (
                        <div key={i} title={`Segmentation mask ${i === 0 ? 'left' : 'right'} wheel point`} style={{ position: 'absolute', left: `${p.x * 100}%`, top: `${p.y * 100}%`, width: '12px', height: '12px', marginLeft: '-6px', marginTop: '-6px', borderRadius: '50%', backgroundColor: '#22c55e', border: '2px solid white', boxShadow: '0 0 8px #22c55e' }} />
                      ))}
                      {/* Re-running (Run again / switching models) leaves the PREVIOUS result visible
                          underneath - without this, it's easy to mistake a stale image for the new
                          answer while the request is still in flight. */}
                      {isDetecting && (
                        <div style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(255,255,255,0.7)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '8px', borderRadius: '8px' }}>
                          <Spinner size={28} />
                          <span style={{ fontSize: '12px', fontWeight: 600, color: '#334155' }}>Re-running...</span>
                        </div>
                      )}
                    </div>
                    {lastRunModel === 'seg' && (
                      <div style={{ display: 'flex', gap: '14px', marginTop: '8px', fontSize: '11px', color: '#475569' }}>
                        {step3Bbox && <span><span style={{ display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%', backgroundColor: '#ef4444', marginRight: '4px' }}></span>Box ROI point (bottom-right)</span>}
                        {maskWheelPoints && <span><span style={{ display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%', backgroundColor: '#22c55e', marginRight: '4px' }}></span>Mask wheel points (either counts)</span>}
                      </div>
                    )}
                  </div>
                  {advancingFrom === 3 && <StepLoadingOverlay label="Moving to Step 4..." />}
                </div>
              ) : step.n === 2 && step1Image ? (
                <div style={{ position: 'relative', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '16px', alignItems: 'start' }}>
                  <div>
                    <div style={{ fontSize: '12px', fontWeight: 700, color: '#64748b', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'flex', justifyContent: 'space-between' }}>
                      <span>Original Frame</span>
                      <span style={{ color: '#ef4444' }}>{Math.round(((step1Image.length - step1Image.indexOf(',') - 1) * 3 / 4) / 1024)} KB</span>
                    </div>
                    <img key={step1Image} src={step1Image} style={{ width: '100%', height: 'auto', borderRadius: '8px', border: '1px solid #e2e8f0', ...FADE_IN }} alt="Original" />
                  </div>
                  <div>
                    <div style={{ fontSize: '12px', fontWeight: 700, color: '#3b82f6', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'flex', justifyContent: 'space-between' }}>
                      <span>Resized Frame (640px)</span>
                      <span style={{ color: '#22c55e' }}>{Math.round(((step2Image.length - step2Image.indexOf(',') - 1) * 3 / 4) / 1024)} KB</span>
                    </div>
                    <div style={{ width: '100%', position: 'relative', borderRadius: '8px', backgroundColor: 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
                       {/* Ghost image to force same aspect ratio container */}
                       <img src={step1Image} style={{ width: '100%', height: 'auto', visibility: 'hidden' }} alt="Ghost" />
                       <img key={step2Image} src={step2Image} style={{ position: 'absolute', width: '50%', height: 'auto', borderRadius: '4px', border: '2px solid #3b82f6', boxShadow: '0 4px 12px rgba(59, 130, 246, 0.15)', ...FADE_IN }} alt="Resized" />
                    </div>
                  </div>
                  {advancingFrom === 2 && <StepLoadingOverlay label="Moving to Step 3..." />}
                </div>
              ) : (
                (step.n !== 1 || step1Image) && !(step.n === 3 && step1Image) && (
                  step.video && !step1Video && !step1Image ? (
                    <video
                      src={`/report/${step.video}`}
                      autoPlay
                      loop
                      muted
                      playsInline
                      style={{ 
                        width: '100%', 
                        height: 'auto', 
                        borderRadius: '8px', 
                        border: '1px solid #e2e8f0', 
                        display: 'block', 
                        margin: '0 auto' 
                      }}
                    />
                  ) : step.n === 1 && step1Video ? (
                    <video
                      src={step1Video}
                      autoPlay
                      loop
                      muted
                      playsInline
                      style={{ 
                        width: '100%', 
                        height: 'auto', 
                        borderRadius: '8px', 
                        border: '1px solid #e2e8f0', 
                        display: 'block', 
                        margin: '0 auto' 
                      }}
                    />
                  ) : (
                    <div style={{ 
                      position: 'relative', 
                      margin: step.img === 'alert.png' ? '0 auto' : undefined, 
                      maxWidth: step.img === 'alert.png' ? '440px' : undefined 
                    }}>
                      <img
                        key={
                          step.n === 1 ? step1Image
                          : [4, 5, 6, 7].includes(step.n) && step.img !== 'alert.png' && (step3Image || step2Image || step1Image) ? (step3Image || step2Image || step1Image)
                          : `/report/${step.img}`
                        }
                        src={
                          step.n === 1 ? step1Image
                          : [4, 5, 6, 7].includes(step.n) && step.img !== 'alert.png' && (step3Image || step2Image || step1Image) ? (step3Image || step2Image || step1Image)
                          : `/report/${step.img}`
                        }
                        alt={step.title}
                        style={{
                          width: '100%',
                          height: 'auto',
                          borderRadius: '8px',
                          border: '1px solid #e2e8f0',
                          display: 'block',
                          ...FADE_IN,
                        }}
                      />
                      {/* Interactive, like the real admin ROI editor on the Live Monitoring page:
                          click points on the photo to draw your own restricted lane, instead of
                          a fixed illustration. Once finished, the truck's real tracked point
                          (same one step 4 marks) is tested against exactly what you drew, using
                          the same point-in-polygon math live_server.py actually runs. */}
                      {step.n === 5 && (
                        <svg
                          width="100%" height="100%" viewBox="0 0 100 100" preserveAspectRatio="none"
                          onClick={handleRoiClick}
                          style={{ position: 'absolute', inset: 0, cursor: (isDrawingRoi && !roiFinished) ? 'crosshair' : 'default', pointerEvents: isDrawingRoi && !roiFinished ? 'auto' : 'none' }}
                        >
                          {roiPoints.length > 0 && (
                            roiFinished ? (
                              <polygon
                                points={roiPoints.map((p) => `${p.x},${p.y}`).join(' ')}
                                fill={truckInsideDrawnRoi ? 'rgba(239, 68, 68, 0.3)' : 'rgba(34, 197, 94, 0.2)'}
                                stroke={truckInsideDrawnRoi ? '#ef4444' : '#22c55e'}
                                strokeWidth="0.5"
                                vectorEffect="non-scaling-stroke"
                              />
                            ) : (
                              <polyline
                                points={roiPoints.map((p) => `${p.x},${p.y}`).join(' ')}
                                fill="none" stroke="#ef4444" strokeWidth="0.6" vectorEffect="non-scaling-stroke"
                              />
                            )
                          )}
                          {roiPoints.map((p, i) => (
                            <circle key={i} cx={p.x} cy={p.y} r="1.2" fill="#ef4444" stroke="white" strokeWidth="0.3" vectorEffect="non-scaling-stroke" />
                          ))}
                          {truckRoiPoints && truckRoiPoints.map((p, i) => (
                            <circle key={`t-${i}`} cx={p.x} cy={p.y} r="1.4" fill="#3b82f6" stroke="white" strokeWidth="0.3" vectorEffect="non-scaling-stroke" />
                          ))}
                        </svg>
                      )}
                      {step.n === 5 && roiFinished && (
                        <div style={{ position: 'absolute', bottom: '8%', left: '5%', color: truckInsideDrawnRoi ? '#ef4444' : '#22c55e', fontWeight: '900', fontSize: 'clamp(14px, 4vw, 24px)', textShadow: '2px 2px 0 #000, -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000', textTransform: 'uppercase', pointerEvents: 'none' }}>
                          {truckRoiPoints
                            ? (truckInsideDrawnRoi ? 'INSIDE restricted lane' : 'Outside the restricted lane')
                            : 'Run detection in step 3 to test a real truck'}
                        </div>
                      )}
                      {advancingFrom === step.n && <StepLoadingOverlay label={`Moving to Step ${step.n + 1}...`} />}
                    </div>
                  )
                )
              )}

              {step.n === 4 && (() => {
                // Track-point position: the real bottom-center of the truck YOLO actually found
                // in step 3 (step3Bbox, from /api/detect_demo) - not a fixed guessed spot - so
                // this panel keeps telling the same "one real truck" story step 3 already proved.
                // Falls back to a plausible fixed spot only if step 3's detection hasn't run yet.
                const trackImg = step3Image || step2Image || '/report/pipeline_04_speed.jpg';
                // When segmentation was the model run, use its mask-derived ground point
                // (midpoint of its two wheel points) rather than the box's bottom-centre.
                const usingMaskPoint = lastRunModel === 'seg' && !!maskGroundPoint;
                const leftPct = usingMaskPoint ? maskGroundPoint.x * 100
                  : step3Bbox ? (step3Bbox.x1 + step3Bbox.x2) / 2 * 100 : 45;
                const bottomPct = usingMaskPoint ? (1 - maskGroundPoint.y) * 100
                  : step3Bbox ? (1 - step3Bbox.y2) * 100 : 20;
                // Real motion, from two real frames (only possible when step 1's upload was a
                // video - see handleStep1Upload/handleRunDetection). When present, this is what
                // actually gets shown instead of the single static-point fallback below.
                const hasRealFlow = !!(step1Image2 && flowPoint2);
                const leftPct2 = flowPoint2 ? flowPoint2.x * 100 : null;
                const bottomPct2 = flowPoint2 ? (1 - flowPoint2.y) * 100 : null;
                // Once step 4 is behind you, show everything - the click-through gating below is
                // only while a presenter is actively narrating this step live.
                const revealed = step.n < currentStep ? 4 : step4Reveal;
                const nextLabel = revealed === 1 ? 'Homography' : revealed === 2 ? 'Kalman Filter' : 'See it in action';
                return (
                <>
                  <div style={{ marginTop: '24px' }}>
                    <h5 style={{ fontSize: '15px', color: '#0f172a', margin: '0 0 12px 0' }}>How the Algorithm Works:</h5>
                    {!step3Bbox && (
                      <div style={{ fontSize: '12px', color: '#b45309', backgroundColor: '#fffbeb', border: '1px solid #fde68a', borderRadius: '6px', padding: '8px 12px', marginBottom: '12px' }}>
                        Go back to step 3 and press "Run" first - the track point below will then sit on the truck YOLO actually detected, instead of a placeholder spot.
                      </div>
                    )}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                      <div style={{ backgroundColor: '#ffffff', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '12px', boxShadow: '0 1px 2px rgba(0,0,0,0.05)', display: 'flex', flexDirection: 'column' }}>
                        <div style={{ position: 'relative', width: '100%', aspectRatio: '16/9', backgroundColor: '#f1f5f9', borderRadius: '4px', overflow: 'hidden', marginBottom: '12px' }}>
                          <img key={trackImg} src={trackImg} style={{ width: '100%', height: '100%', objectFit: 'cover', ...FADE_IN }} alt="Track" />
                          {hasRealFlow ? (
                            <>
                              {/* Real motion between two real frames of your upload, ~0.4s apart -
                                  both overlaid on frame 1's image so it's one picture to look at,
                                  not a toggle between two. This is exactly what optical flow
                                  measures: how far this exact point actually moved. */}
                              <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ position: 'absolute', inset: 0, overflow: 'visible' }}>
                                <defs>
                                  <marker id="flow-arrowhead" markerWidth="7" markerHeight="7" refX="5.5" refY="3.5" orient="auto">
                                    <path d="M0,0 L7,3.5 L0,7 Z" fill="#3b82f6" />
                                  </marker>
                                </defs>
                                <line
                                  x1={leftPct} y1={100 - bottomPct} x2={leftPct2} y2={100 - bottomPct2}
                                  stroke="#3b82f6" strokeWidth="2" strokeDasharray="4 3" strokeLinecap="round"
                                  markerEnd="url(#flow-arrowhead)" vectorEffect="non-scaling-stroke"
                                />
                              </svg>
                              <div style={{ position: 'absolute', bottom: `${bottomPct}%`, left: `${leftPct}%`, width: '12px', height: '12px', marginLeft: '-6px', marginBottom: '-6px', backgroundColor: '#94a3b8', borderRadius: '50%', border: '2px solid white', boxShadow: '0 0 6px rgba(0,0,0,0.4)' }}></div>
                              <div style={{ position: 'absolute', bottom: `calc(${bottomPct}% + 10px)`, left: `${leftPct}%`, transform: 'translateX(-50%)', whiteSpace: 'nowrap', fontSize: '9px', backgroundColor: 'rgba(71,85,105,0.85)', color: 'white', padding: '2px 5px', borderRadius: '4px', fontWeight: 'bold' }}>Frame 1</div>
                              <div style={{ position: 'absolute', bottom: `${bottomPct2}%`, left: `${leftPct2}%`, width: '14px', height: '14px', marginLeft: '-7px', marginBottom: '-7px' }}>
                                <span style={{ position: 'absolute', inset: 0, borderRadius: '50%', backgroundColor: '#ef4444', animation: 'dodo-ping 1.6s cubic-bezier(0, 0, 0.2, 1) infinite' }}></span>
                                <span style={{ position: 'absolute', inset: 0, backgroundColor: '#ef4444', borderRadius: '50%', border: '2px solid white', boxShadow: '0 0 10px #ef4444' }}></span>
                              </div>
                              <div style={{ position: 'absolute', bottom: `calc(${bottomPct2}% + 12px)`, left: `${leftPct2}%`, transform: 'translateX(-50%)', whiteSpace: 'nowrap', fontSize: '10px', backgroundColor: 'rgba(0,0,0,0.7)', color: 'white', padding: '2px 6px', borderRadius: '4px', fontWeight: 'bold' }}>
                                Frame 2{usingMaskPoint ? ' (real mask pixel)' : ''} - locked here
                              </div>
                            </>
                          ) : (
                            <>
                              {/* A single photo genuinely can't show optical flow's motion between
                                  frames - there's no "next frame" here. A pulsing ring (same idea
                                  as a live-location dot on a map) at least reads as "this point is
                                  being actively tracked", not a dead marker on a still image. */}
                              <div style={{ position: 'absolute', bottom: `${bottomPct}%`, left: `${leftPct}%`, width: '14px', height: '14px', marginLeft: '-7px', marginBottom: '-7px' }}>
                                <span style={{ position: 'absolute', inset: 0, borderRadius: '50%', backgroundColor: '#ef4444', animation: 'dodo-ping 1.6s cubic-bezier(0, 0, 0.2, 1) infinite' }}></span>
                                <span style={{ position: 'absolute', inset: 0, backgroundColor: '#ef4444', borderRadius: '50%', border: '2px solid white', boxShadow: '0 0 10px #ef4444' }}></span>
                              </div>
                              <div style={{ position: 'absolute', bottom: `calc(${bottomPct}% + 12px)`, left: `${leftPct}%`, transform: 'translateX(-50%)', whiteSpace: 'nowrap', fontSize: '10px', backgroundColor: 'rgba(0,0,0,0.7)', color: 'white', padding: '2px 6px', borderRadius: '4px', fontWeight: 'bold' }}>
                                Track Point{usingMaskPoint ? ' (real mask pixel)' : ''}{step3Bbox ? ` (${Math.round(step3Bbox.conf * 100)}% conf)` : ''}
                              </div>
                            </>
                          )}
                        </div>
                        <div style={{ fontSize: '12px', fontWeight: 800, color: '#3b82f6', marginBottom: '4px' }}>STEP 1</div>
                        <strong style={{ display: 'block', fontSize: '14px', color: '#0f172a', marginBottom: '4px' }}>Optical Flow</strong>
                        <span style={{ fontSize: '13px', color: '#475569', lineHeight: '1.4' }}>
                          {hasRealFlow
                            ? "This is real, measured motion: the same point, found independently in two real frames of your upload about 0.4s apart. Optical flow does this every single frame on live video - re-locating the point continuously, not guessing once."
                            : "On live video, this exact pixel gets re-located every single frame via optical flow - a moving lock, not a one-time guess. A single photo can't show that motion (there's no next frame to compare against), so this marks the real point it locks onto. Upload a short video instead of a photo to see the actual measured movement here."}
                        </span>
                      </div>

                      {revealed >= 2 && (
                      <div style={{ backgroundColor: '#ffffff', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '12px', boxShadow: '0 1px 2px rgba(0,0,0,0.05)', display: 'flex', flexDirection: 'column', animation: 'dodo-fadein 0.4s ease' }}>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '12px', marginBottom: '12px' }}>
                          {/* TV03CL2 frame with its 4 manual calibration points (yellow) at their real
                              pixel positions from CALIBRATION_TV03CL2. */}
                          <div style={{ position: 'relative', width: '100%', aspectRatio: '16/9', backgroundColor: '#f8fafc', borderRadius: '4px', overflow: 'hidden' }}>
                            <img src="/report/calibration_TV03CL2.jpg" style={{ width: '100%', height: '100%', objectFit: 'cover', ...FADE_IN }} alt="TV03CL2 camera frame with its four manual calibration points" />
                            {CALIBRATION_TV03CL2.points.map((p, i) => (
                              <div key={i} style={{ position: 'absolute', left: `${p.px / CALIBRATION_TV03CL2.imageWidth * 100}%`, top: `${p.py / CALIBRATION_TV03CL2.imageHeight * 100}%`, width: '10px', height: '10px', marginLeft: '-5px', marginTop: '-5px', borderRadius: '50%', backgroundColor: '#facc15', border: '2px solid white', boxShadow: '0 0 6px rgba(0,0,0,0.6)' }}></div>
                            ))}
                            <div style={{ position: 'absolute', bottom: '4px', left: '6px', fontSize: '9px', color: 'white', backgroundColor: 'rgba(0,0,0,0.6)', padding: '2px 6px', borderRadius: '4px' }}>TV03CL2 - manual calibration points</div>
                          </div>
                          {/* Ground-plane rectangle, labeled with the real 3.5 m x 27 m dimensions above -
                              deliberately not drawn to that 1:7.7 scale (it would be a sliver), so this is a
                              schematic, but the numbers on it are TV03CL2's actual world_points_m. */}
                          <svg viewBox="0 0 220 158" width="100%" height="100%" preserveAspectRatio="xMidYMid meet" style={{ aspectRatio: '16/9', backgroundColor: '#f8fafc', borderRadius: '4px' }}>
                            <rect x="0" y="0" width="220" height="158" fill="#f8fafc" />
                            <text x="110" y="16" fontSize="9" fontWeight="700" fill="#94a3b8" textAnchor="middle" style={{ textTransform: 'uppercase', letterSpacing: '0.05em' }}>Ground plane (metres)</text>
                            <rect x="75" y="24" width="70" height="120" fill="#e2e8f0" rx="4" />
                            <line x1="95" y1="24" x2="95" y2="144" stroke="white" strokeWidth="2" strokeDasharray="6 5" />
                            <line x1="125" y1="24" x2="125" y2="144" stroke="white" strokeWidth="2" strokeDasharray="6 5" />
                            {CALIBRATION_TV03CL2.points.map((p, i) => {
                              const x = 75 + (p.wx / 3.5) * 70;
                              const y = 144 - (p.wy / 27) * 120;
                              return <circle key={i} cx={x} cy={y} r="4" fill="#facc15" stroke="#0f172a" strokeWidth="1" />;
                            })}
                            {[0, 9, 18, 27].map((m) => {
                              const y = 144 - (m / 27) * 120;
                              return (
                                <g key={m}>
                                  <line x1="75" y1={y} x2="82" y2={y} stroke="#64748b" strokeWidth="1.5" />
                                  <text x="70" y={y + 3} fontSize="7" fill="#64748b" textAnchor="end">{m}m</text>
                                </g>
                              );
                            })}
                            <text x="110" y="154" fontSize="7" fill="#64748b" textAnchor="middle">3.5 m lane width (not to scale)</text>
                          </svg>
                        </div>
                        <div style={{ fontSize: '12px', fontWeight: 800, color: '#3b82f6', marginBottom: '4px' }}>STEP 2</div>
                        <strong style={{ display: 'block', fontSize: '14px', color: '#0f172a', marginBottom: '4px' }}>Homography</strong>
                        <span style={{ fontSize: '13px', color: '#475569', lineHeight: '1.4' }}>Maps the 2D pixel coordinates into real-world ground-plane metres, using this camera's own calibration.</span>

                        <div style={{ marginTop: '12px', backgroundColor: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '6px', padding: '10px 12px' }}>
                          <div style={{ fontSize: '11px', fontWeight: 700, color: '#64748b', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>TV03CL2's actual calibration data</div>
                          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                            <thead>
                              <tr style={{ color: '#64748b', textAlign: 'left' }}>
                                <th style={{ fontWeight: 600, paddingBottom: '4px' }}>Pixel (x, y)</th>
                                <th style={{ fontWeight: 600, paddingBottom: '4px' }}>Real-world (m)</th>
                              </tr>
                            </thead>
                            <tbody>
                              {CALIBRATION_TV03CL2.points.map((p, i) => (
                                <tr key={i} style={{ borderTop: '1px solid #e2e8f0' }}>
                                  <td style={{ padding: '4px 0', color: '#0f172a', fontFamily: 'ui-monospace, monospace' }}>({p.px.toFixed(0)}, {p.py.toFixed(0)})</td>
                                  <td style={{ padding: '4px 0', color: '#0f172a', fontFamily: 'ui-monospace, monospace' }}>({p.wx.toFixed(1)}, {p.wy.toFixed(1)})</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                          <ul style={{ margin: '10px 0 0 0', paddingLeft: '20px', fontSize: '12px', color: '#475569', lineHeight: '1.6' }}>
                            <li><strong>Manual calibration:</strong> an admin picks 4 road points of known size - lane width (3.5 m) and dashed-line spacing (27 m).</li>
                            <li><strong>Matrix Generation:</strong> <code style={{ backgroundColor: '#e2e8f0', padding: '1px 4px', borderRadius: '3px' }}>cv2.findHomography()</code> builds a 3×3 matrix from the 4 points.</li>
                            <li><strong>Real-world Mapping:</strong> <code style={{ backgroundColor: '#e2e8f0', padding: '1px 4px', borderRadius: '3px' }}>cv2.perspectiveTransform()</code> converts pixel tracking into exact meters.</li>
                          </ul>

                          <div style={{ marginTop: '12px', padding: '10px', backgroundColor: '#1e293b', borderRadius: '6px', color: '#f8fafc', fontSize: '11px', fontFamily: 'ui-monospace, monospace' }}>
                            <div style={{ color: '#94a3b8', marginBottom: '4px' }}># The core transformation equation</div>
                            <div><span style={{ color: '#38bdf8' }}>[</span>x_real, y_real, w<span style={{ color: '#38bdf8' }}>]</span> = H * <span style={{ color: '#38bdf8' }}>[</span>x_pixel, y_pixel, 1<span style={{ color: '#38bdf8' }}>]</span></div>
                            <div style={{ marginTop: '4px' }}>meters_x = x_real / w</div>
                            <div>meters_y = y_real / w</div>
                          </div>
                        </div>
                      </div>
                      )}

                      {revealed >= 3 && (
                      <div style={{ backgroundColor: '#ffffff', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '12px', boxShadow: '0 1px 2px rgba(0,0,0,0.05)', display: 'flex', flexDirection: 'column', animation: 'dodo-fadein 0.4s ease' }}>
                        <div style={{ position: 'relative', width: '100%', aspectRatio: '16/9', backgroundColor: '#f8fafc', borderRadius: '4px', overflow: 'hidden', marginBottom: '12px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          <img src="/report/kalman_demo.png" style={{ width: '100%', height: '100%', objectFit: 'contain', ...FADE_IN }} alt="Kalman Graph" />
                        </div>
                        <div style={{ fontSize: '12px', fontWeight: 800, color: '#3b82f6', marginBottom: '4px' }}>STEP 3</div>
                        <strong style={{ display: 'block', fontSize: '14px', color: '#0f172a', marginBottom: '4px' }}>Kalman Filter</strong>
                        <span style={{ fontSize: '13px', color: '#475569', lineHeight: '1.4' }}>Calculates speed (m/s) and filters out frame-to-frame noise for a steady reading.</span>
                        
                        <div style={{ marginTop: '12px', padding: '10px', backgroundColor: '#1e293b', borderRadius: '6px', color: '#f8fafc', fontSize: '11px', fontFamily: 'ui-monospace, monospace' }}>
                          <div style={{ color: '#94a3b8', marginBottom: '4px' }}># 1. Calculate raw speed between frames</div>
                          <div style={{ marginBottom: '6px' }}>distance = sqrt((x2 - x1)² + (y2 - y1)²) <span style={{ color: '#64748b' }}>// m</span><br/>
                          speed_raw = (distance / time_delta) * 3.6 <span style={{ color: '#64748b' }}>// km/h</span></div>
                          <div style={{ color: '#94a3b8', marginBottom: '4px' }}># 2. Kalman filter smooths it</div>
                          <div>kalman.predict()<br/>
                          kalman.update(speed_raw)</div>
                        </div>
                      </div>
                      )}
                    </div>

                    {revealed < 4 && (
                      <div style={{ display: 'flex', justifyContent: 'center', marginTop: '16px' }}>
                        <button
                          onClick={() => handleStep4Next(revealed + 1)}
                          disabled={isAdvancing}
                          style={{ backgroundColor: '#eff6ff', color: '#3b82f6', padding: '8px 20px', borderRadius: '6px', border: '1px solid #bfdbfe', fontSize: '13px', fontWeight: 600, cursor: isAdvancing ? 'wait' : 'pointer', display: 'inline-flex', alignItems: 'center', gap: '8px', opacity: isAdvancing ? 0.75 : 1 }}
                        >
                          {isAdvancing && <Spinner size={13} />}
                          {isAdvancing ? 'Loading...' : `Next: ${nextLabel} ➔`}
                        </button>
                      </div>
                    )}
                  </div>


                </>
                );
              })()}

              {step.n === 3 && step1Image && (
                <div style={{ marginTop: '16px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px' }}>
                  {/* Model picker: production bounding-box model vs the experimental truck_seg
                      segmentation model (Plan B) - re-run on the same photo with either one to
                      compare them directly, instead of only describing the difference. */}
                  <div style={{ display: 'inline-flex', backgroundColor: '#f1f5f9', borderRadius: '8px', padding: '3px', gap: '2px' }}>
                    {[
                      { id: 'box', label: 'Bounding Box' },
                      { id: 'seg', label: 'Segmentation' },
                    ].map((opt) => (
                      <button
                        key={opt.id}
                        onClick={() => setDemoModel(opt.id)}
                        style={{
                          padding: '6px 14px', borderRadius: '6px', border: 'none', fontSize: '13px', fontWeight: 600, cursor: 'pointer',
                          backgroundColor: demoModel === opt.id ? '#ffffff' : 'transparent',
                          color: demoModel === opt.id ? '#0f172a' : '#64748b',
                          boxShadow: demoModel === opt.id ? '0 1px 2px rgba(0,0,0,0.08)' : 'none',
                        }}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                  <button
                    onClick={handleRunDetection}
                    disabled={isDetecting}
                    style={{ backgroundColor: '#3b82f6', color: '#fff', padding: '8px 20px', borderRadius: '8px', border: 'none', fontSize: '14px', fontWeight: 600, cursor: isDetecting ? 'wait' : 'pointer', display: 'flex', alignItems: 'center', gap: '8px', boxShadow: '0 2px 4px rgba(59, 130, 246, 0.3)' }}
                  >
                    {isDetecting && <Spinner size={16} color="#ffffff" />}
                    {isDetecting ? 'Processing in Python Server...' : step3Image ? 'Run again' : 'Run'}
                  </button>
                </div>
              )}

              {step.n === 5 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px', marginTop: '12px' }}>
                  {!isDrawingRoi ? (
                    <button
                      onClick={() => { handleRoiClear(); setIsDrawingRoi(true); }}
                      style={{ cursor: 'pointer', fontSize: '13px', fontWeight: 600, color: '#3b82f6', padding: '6px 12px', border: '1px solid #3b82f6', borderRadius: '6px', background: 'none' }}
                    >
                      Draw the restricted lane
                    </button>
                  ) : !roiFinished ? (
                    <>
                      <span style={{ fontSize: '12px', color: '#64748b' }}>Click {roiPoints.length < 3 ? `${3 - roiPoints.length} more point${3 - roiPoints.length === 1 ? '' : 's'}` : 'more points, or finish'} on the photo above.</span>
                      <button onClick={handleRoiClear} style={{ cursor: 'pointer', fontSize: '13px', color: '#64748b', background: 'none', border: 'none', padding: '6px 4px', textDecoration: 'underline' }}>Clear</button>
                      <button
                        onClick={handleRoiFinish}
                        disabled={roiPoints.length < 3}
                        style={{ cursor: roiPoints.length < 3 ? 'not-allowed' : 'pointer', fontSize: '13px', fontWeight: 700, color: '#fff', backgroundColor: roiPoints.length < 3 ? '#94a3b8' : '#358802', padding: '6px 14px', border: 'none', borderRadius: '6px' }}
                      >
                        Finish Drawing
                      </button>
                    </>
                  ) : (
                    <>
                      <span style={{ fontSize: '12px', color: '#64748b' }}>
                        {truckRoiPoints
                          ? (truckRoiPoints.length > 1
                            ? 'Testing your drawn shape against the truck\'s two wheel points - either one inside counts.'
                            : 'Testing your drawn shape against the truck\'s bottom-right (right-side wheel) point.')
                          : 'Run detection in step 3 first to test a real truck against this shape.'}
                      </span>
                      <button onClick={() => { handleRoiClear(); setIsDrawingRoi(true); }} style={{ cursor: 'pointer', fontSize: '13px', color: '#64748b', background: 'none', border: 'none', padding: '6px 4px', textDecoration: 'underline' }}>Redraw</button>
                    </>
                  )}
                  {!(isDrawingRoi && !roiFinished) && (
                    <button
                      onClick={handleRoiLoadReal}
                      style={{ cursor: 'pointer', fontSize: '12px', color: '#94a3b8', background: 'none', border: 'none', padding: '6px 4px', textDecoration: 'underline' }}
                    >
                      Or load TV03CL2's real configured ROI
                    </button>
                  )}
                </div>
              )}

              {step.n === 1 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '12px', marginTop: '12px' }}>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="video/*,image/*"
                    onChange={handleStep1Upload}
                    style={{ display: 'none' }}
                    id="step1-photo-input"
                  />
                  <label
                    htmlFor="step1-photo-input"
                    style={{
                      cursor: isProcessingUpload ? 'wait' : 'pointer', fontSize: '13px', fontWeight: 600, color: '#3b82f6',
                      padding: '6px 12px', border: '1px solid #3b82f6', borderRadius: '6px',
                      opacity: isProcessingUpload ? 0.5 : 1, pointerEvents: isProcessingUpload ? 'none' : 'auto',
                    }}
                  >
                    {step1Image || step1Video ? 'Upload a different file' : 'Upload a photo or short video'}
                  </label>
                  {(step1Image || step1Video) && !isProcessingUpload && (
                    <button
                      onClick={handleStep1Reset}
                      style={{ cursor: 'pointer', fontSize: '13px', color: '#64748b', background: 'none', border: 'none', padding: '6px 4px', textDecoration: 'underline' }}
                    >
                      Remove file
                    </button>
                  )}
                  {isProcessingUpload && (
                    <span style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: '#64748b' }}>
                      <Spinner size={16} />
                      Extracting a frame from your video...
                    </span>
                  )}
                </div>
              )}
            </div>
            
            {step.n === currentStep && currentStep < arr.length && !(step.n === 4 && step4Reveal < 4) && (
              <div style={{ backgroundColor: '#f8fafc', padding: '16px 24px', borderTop: '1px solid #e2e8f0', display: 'flex', justifyContent: 'flex-end' }}>
                <button
                  onClick={() => handleContinue(step.n)}
                  disabled={isAdvancing}
                  style={{ backgroundColor: '#3b82f6', color: '#fff', padding: '8px 24px', borderRadius: '6px', border: 'none', fontSize: '14px', fontWeight: 600, cursor: isAdvancing ? 'wait' : 'pointer', display: 'flex', alignItems: 'center', gap: '8px', boxShadow: '0 2px 4px rgba(59, 130, 246, 0.3)', opacity: isAdvancing ? 0.75 : 1 }}
                >
                  {isAdvancing && <Spinner size={14} color="#ffffff" />}
                  {isAdvancing ? 'Loading...' : `Continue to Step ${step.n + 1} ➔`}
                </button>
              </div>
            )}
          </div>
          {step.n < currentStep && step.n < arr.length && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', margin: '2px 0' }}>
              <div style={{ width: '2px', height: '16px', backgroundColor: '#dbeafe' }} />
              <div style={{ width: '36px', height: '36px', borderRadius: '50%', backgroundColor: '#eff6ff', border: '1px solid #dbeafe', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 5v14M6 13l6 6 6-6" />
                </svg>
              </div>
              <div style={{ width: '2px', height: '16px', backgroundColor: '#dbeafe' }} />
            </div>
          )}
        </React.Fragment>
      )})}

      {/* Visual Separator into the rest of the report (design-decision deep dives) */}
      <div style={{ margin: '64px 0', borderBottom: '2px dashed #e2e8f0' }}></div>

      {/* =========================================
          PART 1: FRAME OPTIMIZATION (Original Code)
          ========================================= */}
      
      {/* Header */}
      <div style={{ textAlign: 'center', paddingBottom: '24px', borderBottom: '1px solid #e2e8f0', marginBottom: '32px' }}>
        <h1 style={{ fontSize: '32px', margin: '0 0 8px 0', color: '#0f172a' }}>Speeding Up the AI</h1>
        <p style={{ fontSize: '18px', color: '#64748b', margin: 0 }}>Fixing video lag by skipping unnecessary frames</p>
      </div>

      {/* Context Grid - Aligned to match the 2 videos below (minmax 400px) */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(400px, 1fr))', gap: '24px', marginBottom: '32px' }}>
        
        {/* 1. The Problem */}
        <div style={{ padding: '20px', backgroundColor: '#ffffff', borderRadius: '8px', border: '1px solid #e2e8f0', borderTop: '4px solid #ef4444', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
          <h3 style={{ color: '#ef4444', marginTop: 0, marginBottom: '12px', fontSize: '16px' }}>1. The Problem (Previous Version)</h3>
          <ul style={{ margin: 0, paddingLeft: '20px', fontSize: '14px', color: '#475569', lineHeight: '1.6' }}>
            <li>Checking every single video frame was too much work for the computer.</li>
            <li>A huge backlog of video frames piled up.</li>
            <li>The live video became very laggy (5 to 10 frames per second).</li>
          </ul>
        </div>
        
        {/* 2. The Fix */}
        <div style={{ padding: '20px', backgroundColor: '#ffffff', borderRadius: '8px', border: '1px solid #e2e8f0', borderTop: '4px solid #3b82f6', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
          <h3 style={{ color: '#3b82f6', marginTop: 0, marginBottom: '12px', fontSize: '16px' }}>2. The Fix (Current Version)</h3>
          <ul style={{ margin: 0, paddingLeft: '20px', fontSize: '14px', color: '#475569', lineHeight: '1.6' }}>
            <li>We changed the code to check only 1 out of every 6 frames.</li>
            <li>The system skips the other 5 frames.</li>
          </ul>
        </div>
        
      </div>

      {/* Video Comparison Section */}
      <div style={{ display: 'flex', gap: '24px', flexWrap: 'wrap' }}>
        
        {/* Before Card */}
        <div style={{ flex: '1 1 400px', backgroundColor: '#ffffff', padding: '24px', borderRadius: '12px', border: '1px solid #e2e8f0', boxShadow: '0 2px 4px rgba(0,0,0,0.05)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
            <h4 style={{ color: '#0f172a', margin: 0, fontSize: '18px' }}>Before (Checking Every Frame)</h4>
          </div>
          <video 
            src="/report/BeforeFPSFiexed.mov" 
            autoPlay 
            loop 
            muted 
            playsInline 
            controls
            style={{ width: '100%', borderRadius: '8px', backgroundColor: '#f1f5f9', aspectRatio: '16/9', objectFit: 'cover' }} 
          />
        </div>

        {/* After Card */}
        <div style={{ flex: '1 1 400px', backgroundColor: '#ffffff', padding: '24px', borderRadius: '12px', border: '1px solid #e2e8f0', boxShadow: '0 2px 4px rgba(0,0,0,0.05)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
            <h4 style={{ color: '#0f172a', margin: 0, fontSize: '18px' }}>After (Skipping 5 Frames)</h4>
          </div>
          <video 
            src="/report/AfterFPSFixed.mov" 
            autoPlay 
            loop 
            muted 
            playsInline 
            controls
            style={{ width: '100%', borderRadius: '8px', backgroundColor: '#f1f5f9', aspectRatio: '16/9', objectFit: 'cover' }} 
          />
        </div>

      </div>


      {/* =========================================
          PART 2: TELEGRAM NOTIFICATION EXTENSION 
          ========================================= */}
          
      {/* Visual Separator */}
      <div style={{ margin: '64px 0', borderBottom: '2px dashed #e2e8f0' }}></div>

      {/* Header for Notifications */}
      <div style={{ textAlign: 'center', paddingBottom: '24px', borderBottom: '1px solid #e2e8f0', marginBottom: '32px' }}>
        <h1 style={{ fontSize: '32px', margin: '0 0 8px 0', color: '#0f172a' }}>Real-Time Alerts</h1>
        <p style={{ fontSize: '18px', color: '#64748b', margin: 0 }}>Choosing the best messaging app for instant violation alerts</p>
      </div>

      {/* Context Grid - 2 Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(400px, 1fr))', gap: '24px', marginBottom: '32px' }}>
        
        {/* 1. The Original Idea */}
        <div style={{ padding: '20px', backgroundColor: '#ffffff', borderRadius: '8px', border: '1px solid #e2e8f0', borderTop: '4px solid #ef4444', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
          <h3 style={{ color: '#ef4444', marginTop: 0, marginBottom: '12px', fontSize: '16px' }}>1. The Original Idea (LINE App)</h3>
          <ul style={{ margin: 0, paddingLeft: '20px', fontSize: '14px', color: '#475569', lineHeight: '1.6' }}>
            <li>We  planned to use LINE because it is very popular in Thailand.</li>
            <li><strong>The Problem:</strong> The free plan only allows 500 messages per month.</li>
          </ul>
        </div>
        
        {/* 2. The Final Choice */}
        <div style={{ padding: '20px', backgroundColor: '#ffffff', borderRadius: '8px', border: '1px solid #e2e8f0', borderTop: '4px solid #3b82f6', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
          <h3 style={{ color: '#3b82f6', marginTop: 0, marginBottom: '12px', fontSize: '16px' }}>2. The Final Choice (Telegram)</h3>
          <ul style={{ margin: 0, paddingLeft: '20px', fontSize: '14px', color: '#475569', lineHeight: '1.6' }}>
            <li>We switched to Telegram because their bot API is completely free and unlimited.</li>
            <li><strong>The Benefit:</strong> We can send a "free flow" of thousands of alerts with zero cost.</li>
          </ul>
        </div>
        
      </div>
      {/* Example Telegram Alert Showcase */}
      <div style={{ backgroundColor: '#ffffff', padding: '24px', borderRadius: '12px', border: '1px solid #e2e8f0', boxShadow: '0 2px 4px rgba(0,0,0,0.05)', textAlign: 'center' }}>
        <h4 style={{ color: '#0f172a', margin: '0 0 16px 0', fontSize: '18px' }}>Example: Live Telegram Alert with images</h4>
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <img 
            src="/report/alert.png" 
            alt="Real-Time Telegram Alert Example" 
            style={{ 
              maxWidth: '440px', 
              width: '100%', 
              height: 'auto', 
              borderRadius: '12px', 
              border: '1px solid #cbd5e1',
              boxShadow: '0 8px 24px rgba(0,0,0,0.08)' 
            }} 
          />
        </div>
      </div>


      {/* =========================================
          PART 3: SPEED ESTIMATION (Old vs New)
          ========================================= */}

      {/* Visual Separator */}
      <div style={{ margin: '64px 0', borderBottom: '2px dashed #e2e8f0' }}></div>

      {/* Header */}
      <div style={{ textAlign: 'center', paddingBottom: '24px', borderBottom: '1px solid #e2e8f0', marginBottom: '32px' }}>
        <h1 style={{ fontSize: '32px', margin: '0 0 8px 0', color: '#0f172a' }}>Measuring Truck Speed</h1>
        <p style={{ fontSize: '18px', color: '#64748b', margin: 0 }}>Why the old speed numbers were jumpy &mdash; and how the new method fixes them</p>
      </div>

      {/* Summary Grid - Old vs New */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(400px, 1fr))', gap: '24px', marginBottom: '32px' }}>

        <div style={{ padding: '20px', backgroundColor: '#ffffff', borderRadius: '8px', border: '1px solid #e2e8f0', borderTop: '4px solid #ef4444', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
          <h3 style={{ color: '#ef4444', marginTop: 0, marginBottom: '12px', fontSize: '16px' }}>Old Method</h3>
          <ul style={{ margin: 0, paddingLeft: '20px', fontSize: '14px', color: '#475569', lineHeight: '1.7' }}>
            <li>Followed the <strong>middle of the truck's box</strong>.</li>
            <li>Compared just <strong>two frames at a time</strong>.</li>
            <li>Used a ruler that <strong>changed across the screen</strong>.</li>
            <li style={{ color: '#ef4444', fontWeight: 'bold', listStyle: 'none', marginLeft: '-20px', marginTop: '8px' }}>Result: jumpy &mdash; a glitch could show 200&ndash;300 km/h.</li>
          </ul>
        </div>

        <div style={{ padding: '20px', backgroundColor: '#ffffff', borderRadius: '8px', border: '1px solid #e2e8f0', borderTop: '4px solid #3b82f6', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
          <h3 style={{ color: '#3b82f6', marginTop: 0, marginBottom: '12px', fontSize: '16px' }}>New Method</h3>
          <ul style={{ margin: 0, paddingLeft: '20px', fontSize: '14px', color: '#475569', lineHeight: '1.7' }}>
            <li>Follows the <strong>wheels on the road</strong>.</li>
            <li>Uses <strong>one fixed ruler</strong> for the whole view.</li>
            <li>A <strong>Kalman filter</strong> blends many frames into one steady number.</li>
            <li style={{ color: '#3b82f6', fontWeight: 'bold', listStyle: 'none', marginLeft: '-20px', marginTop: '8px' }}>Result: steady, believable km/h.</li>
          </ul>
        </div>

      </div>

      {/* Real-data chart: raw vs Kalman-filtered */}
      <div style={{ backgroundColor: '#ffffff', padding: '24px', borderRadius: '12px', border: '1px solid #e2e8f0', boxShadow: '0 2px 4px rgba(0,0,0,0.05)', marginBottom: '32px' }}>
        <h4 style={{ color: '#0f172a', margin: '0 0 4px 0', fontSize: '18px' }}>See it on real footage: one truck, every frame</h4>
        <p style={{ margin: '0 0 16px 0', fontSize: '14px', color: '#64748b', lineHeight: '1.6' }}>
          <span style={{ color: '#ef4444', fontWeight: 'bold' }}>Red</span> = old way, no smoothing: the speed jumps all over the place from one frame to the next.
          {' '}<span style={{ color: '#3b82f6', fontWeight: 'bold' }}>Blue</span> = new way: one steady number that follows the truck slowing down.
        </p>
        <img
          src="/report/kalman_demo.png"
          alt="Raw vs Kalman-filtered speed for one tracked truck"
          style={{ width: '100%', height: 'auto', borderRadius: '8px', border: '1px solid #e2e8f0' }}
        />
        
      </div>

      {/* =========================================
          PART 4: WHERE THE CAMERA FEEDS COME FROM
          ========================================= */}

      {/* Visual Separator */}
      <div style={{ margin: '64px 0', borderBottom: '2px dashed #e2e8f0' }}></div>

      {/* Header */}
      <div style={{ textAlign: 'center', paddingBottom: '24px', borderBottom: '1px solid #e2e8f0', marginBottom: '32px' }}>
        <h1 style={{ fontSize: '32px', margin: 0, color: '#0f172a' }}>Streaming CCTV References</h1>
      </div>

      <div style={{ backgroundColor: '#ffffff', padding: '24px', borderRadius: '12px', border: '1px solid #e2e8f0', boxShadow: '0 2px 4px rgba(0,0,0,0.05)' }}>

        {/* Camera types breakdown */}
        <p style={{ margin: '0 0 16px 0', fontSize: '14px', color: '#475569', lineHeight: '1.6' }}>
          We have <strong>112 CCTV</strong> cameras in total, covering three viewing angles:
        </p>
        <p> The resolution is 720p and 25 fps roughly</p>
        <div style={{ display: 'flex', gap: '20px', flexWrap: 'wrap', marginBottom: '16px' }}>
          <div style={{ flex: '1 1 160px', backgroundColor: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '10px', padding: '16px', textAlign: 'center' }}>
            <img src="/report/left.png" alt="Left-facing CCTV example" style={{ width: '100%', height: 'auto', borderRadius: '6px', marginBottom: '10px' }} />
            <span style={{ fontSize: '13px', fontWeight: 600, color: '#0f172a' }}>Left</span>
          </div>
          <div style={{ flex: '1 1 160px', backgroundColor: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '10px', padding: '16px', textAlign: 'center' }}>
            <img src="/report/center.png" alt="Center-facing CCTV example" style={{ width: '100%', height: 'auto', borderRadius: '6px', marginBottom: '10px' }} />
            <span style={{ fontSize: '13px', fontWeight: 600, color: '#0f172a' }}>Center</span>
          </div>
          <div style={{ flex: '1 1 160px', backgroundColor: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '10px', padding: '16px', textAlign: 'center' }}>
            <img src="/report/right.png" alt="Right-facing CCTV example" style={{ width: '100%', height: 'auto', borderRadius: '6px', marginBottom: '10px' }} />
            <span style={{ fontSize: '13px', fontWeight: 600, color: '#0f172a' }}>Right</span>
          </div>
        </div>
        <p style={{ margin: '0 0 28px 0', fontSize: '13px', color: '#64748b' }}>
          Current : <strong>Center</strong> ones &mdash; <strong className='text-warning'>15 cameras</strong>.
        </p>

        {/* Source logos */}
        <div style={{ display: 'flex', gap: '20px', flexWrap: 'wrap', marginBottom: '28px' }}>
          <div style={{ flex: '1 1 200px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '12px', backgroundColor: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '10px', padding: '20px' }}>
            <img src="/logo/Unknown.jpeg" alt="M-Traffic logo" style={{ height: '44px', width: 'auto', objectFit: 'contain', borderRadius: '6px' }} />
            <span style={{ fontSize: '13px', fontWeight: 600, color: '#0f172a', letterSpacing: '0.02em' }}>M-Traffic</span>
          </div>

          <div style={{ flex: '1 1 200px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '12px', backgroundColor: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '10px', padding: '20px' }}>
            <img src="/logo/itic-logo.png" alt="ITIC logo" style={{ height: '44px', width: 'auto', objectFit: 'contain' }} />
            <span style={{ fontSize: '13px', fontWeight: 600, color: '#0f172a', letterSpacing: '0.02em' }}>ITIC</span>
          </div>
        </div>

        {/* Example stream URL */}
        <p style={{ margin: '0 0 8px 0', fontSize: '13px', color: '#64748b', fontWeight: 'bold' }}>
          Example: camera TV03CL2 (M9-0+000-KL)
        </p>
        <div style={{ backgroundColor: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '12px 14px', overflowX: 'auto' }}>
          <code style={{ fontFamily: 'monospace', fontSize: '13px', color: '#334155', whiteSpace: 'pre' }}>
            http://1.4.213.19:1921/live/TV03CL2-M9-0_000-KL.stream/playlist.m3u8
          </code>
        </div>
        <p style={{ margin: '12px 0 0 0', fontSize: '20px', color: '#64748b' }}>
          User must use <span style={{ color: '#dc2626', fontWeight: 700 }}>VPN</span> with AU Wifi
        </p>
        
      </div>
      




    </div>
  );
}