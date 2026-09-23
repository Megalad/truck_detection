import React, { useEffect, useRef, useState } from 'react';

// Step 1's photo can be swapped live from the browser (e.g. mid-demo, if a professor
// asks to see a genuinely fresh capture) via a file picker, instead of the fixed
// pipeline_01_capture.jpg. This is entirely local to this browser tab/session - it
// never uploads anywhere or changes what anyone else sees on the site. Kept in
// sessionStorage (not localStorage) so an accidental page refresh mid-demo doesn't
// lose it, but it naturally resets for a new tab/day, same as the admin login session.
const STEP1_IMAGE_KEY = 'projectReportStep1Image';

export default function FrameOptimizationReport() {
  const [step1Image, setStep1Image] = useState(null);
  const fileInputRef = useRef(null);

  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(STEP1_IMAGE_KEY);
      if (saved) setStep1Image(saved);
    } catch { /* private mode etc. */ }
  }, []);

  const handleStep1Upload = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      setStep1Image(dataUrl);
      try { sessionStorage.setItem(STEP1_IMAGE_KEY, dataUrl); } catch { /* quota/private mode - still works for this session */ }
    };
    reader.readAsDataURL(file);
  };

  const handleStep1Reset = () => {
    setStep1Image(null);
    try { sessionStorage.removeItem(STEP1_IMAGE_KEY); } catch { /* ignore */ }
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  return (
    <div style={{ maxWidth: '1000px', margin: '40px auto', fontFamily: 'system-ui, -apple-system, sans-serif', color: '#1e293b', padding: '20px' }}>

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
          body: 'Before anything else, the frame is shrunk to 640px wide (aspect ratio kept, not a square crop) and sent to the Python server over a WebSocket - a smaller frame means faster detection and less network load, with no real accuracy cost.',
          img: 'pipeline_02_resize.jpg',
        },
        {
          n: 3,
          title: 'Detect & track',
          body: 'A YOLO11 model finds every truck in the frame. Each one gets a stable ID that follows it across frames, even as its box changes shape while it drives under the camera.',
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
          body: "Is the truck's real position inside the marked restricted lane (the red region)? The system checks every frame, but only confirms a violation once the truck has stayed inside for about 1.5 real seconds - not one flickery frame.",
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
          title: 'Alert sent & saved',
          body: 'The photo, camera name, and speed are sent to Telegram within seconds, and the same violation is written to the database - where it shows up in the Evidence & History page for review.',
          img: 'alert.png',
        },
      ].map((step, i, arr) => (
        <React.Fragment key={step.n}>
          <div style={{ backgroundColor: '#ffffff', borderRadius: '12px', border: '1px solid #e2e8f0', boxShadow: '0 2px 4px rgba(0,0,0,0.05)', overflow: 'hidden' }}>
            <div style={{ padding: '20px 24px 4px 24px', display: 'flex', alignItems: 'flex-start', gap: '14px' }}>
              <span style={{ flexShrink: 0, width: '28px', height: '28px', borderRadius: '50%', backgroundColor: '#3b82f6', color: '#fff', fontSize: '14px', fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {step.n}
              </span>
              <div>
                <h4 style={{ color: '#0f172a', margin: '0 0 6px 0', fontSize: '17px' }}>{step.title}</h4>
                <p style={{ margin: 0, fontSize: '14px', color: '#475569', lineHeight: '1.6' }}>{step.body}</p>
              </div>
            </div>
            <div style={{ padding: '16px 24px 24px 24px' }}>
              <img
                src={step.n === 1 && step1Image ? step1Image : `/report/${step.img}`}
                alt={step.title}
                style={{ width: '100%', height: 'auto', borderRadius: '8px', border: '1px solid #e2e8f0', display: 'block', margin: step.img === 'alert.png' ? '0 auto' : undefined, maxWidth: step.img === 'alert.png' ? '440px' : undefined }}
              />
              {step.n === 1 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginTop: '12px' }}>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    onChange={handleStep1Upload}
                    style={{ display: 'none' }}
                    id="step1-photo-input"
                  />
                  <label
                    htmlFor="step1-photo-input"
                    style={{ cursor: 'pointer', fontSize: '13px', fontWeight: 600, color: '#3b82f6', padding: '6px 12px', border: '1px solid #3b82f6', borderRadius: '6px' }}
                  >
                    {step1Image ? 'Upload a different photo' : 'Upload a fresh photo'}
                  </label>
                  {step1Image && (
                    <button
                      onClick={handleStep1Reset}
                      style={{ cursor: 'pointer', fontSize: '13px', color: '#64748b', background: 'none', border: 'none', padding: '6px 4px', textDecoration: 'underline' }}
                    >
                      Reset to default
                    </button>
                  )}
                  <span style={{ fontSize: '12px', color: '#94a3b8' }}>
                    (this browser only - doesn't change the live site)
                  </span>
                </div>
              )}
            </div>
          </div>
          {i < arr.length - 1 && (
            <div style={{ textAlign: 'center', color: '#94a3b8', fontSize: '20px', margin: '4px 0' }}>&darr;</div>
          )}
        </React.Fragment>
      ))}

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