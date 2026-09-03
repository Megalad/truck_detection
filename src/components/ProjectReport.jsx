import React from 'react';

export default function FrameOptimizationReport() {
  return (
    <div style={{ maxWidth: '1000px', margin: '40px auto', fontFamily: 'system-ui, -apple-system, sans-serif', color: '#1e293b', padding: '20px' }}>
      
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
        <p style={{ margin: '12px 0 0 0', fontSize: '12px', color: '#94a3b8', lineHeight: '1.6' }}>
          The camera is not calibrated yet, so the exact km/h is approximate &mdash; what matters is red (noisy) vs blue (steady).
        </p>
      </div>

      {/* Three simple problem -> fix rows */}
      <div style={{ backgroundColor: '#ffffff', borderRadius: '12px', border: '1px solid #e2e8f0', boxShadow: '0 2px 4px rgba(0,0,0,0.05)', overflow: 'hidden', marginBottom: '32px' }}>
        <div style={{ padding: '16px 24px', backgroundColor: '#f8fafc', borderBottom: '1px solid #e2e8f0' }}>
          <h4 style={{ margin: 0, color: '#0f172a', fontSize: '18px' }}>Why red is so jumpy &mdash; and what we changed</h4>
        </div>
        {[
          {
            old: 'It followed the middle of the truck box, which slides around as the truck gets closer.',
            neu: 'It follows the wheels on the road, which stay in place.',
          },
          {
            old: 'It measured distance with a ruler that changed across the screen.',
            neu: 'It uses one fixed ruler for the whole camera view.',
          },
          {
            old: 'It compared only two frames, so small wobbles looked like big speed jumps.',
            neu: 'A Kalman filter blends many frames into one steady number.',
          },
        ].map((row, i, arr) => (
          <div key={i} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', borderBottom: i < arr.length - 1 ? '1px solid #e2e8f0' : 'none' }}>
            <div style={{ padding: '16px 24px', fontSize: '14px', color: '#475569', lineHeight: '1.6', borderLeft: '3px solid #fecaca' }}>
              <span style={{ display: 'block', color: '#ef4444', fontWeight: 'bold', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '0.03em', marginBottom: '4px' }}>Old problem</span>
              {row.old}
            </div>
            <div style={{ padding: '16px 24px', fontSize: '14px', color: '#475569', lineHeight: '1.6', borderLeft: '3px solid #bfdbfe' }}>
              <span style={{ display: 'block', color: '#3b82f6', fontWeight: 'bold', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '0.03em', marginBottom: '4px' }}>What we did</span>
              {row.neu}
            </div>
          </div>
        ))}
      </div>

      {/* Still to do */}
      <div style={{ padding: '20px 24px', backgroundColor: '#fffbeb', borderRadius: '8px', border: '1px solid #fde68a' }}>
        <h4 style={{ margin: '0 0 8px 0', color: '#92400e', fontSize: '16px' }}>Still to do (for exact numbers)</h4>
        <ul style={{ margin: 0, paddingLeft: '20px', fontSize: '14px', color: '#78350f', lineHeight: '1.7' }}>
          <li>Calibrate each fixed camera once: mark 4 road points of known distance.</li>
          <li>Thailand reference: lane = 3.5 m; dashed line = 3 m paint + 6 m gap.</li>
          <li>Until then, speed is consistent but still an estimate.</li>
        </ul>
      </div>



    </div>
  );
}