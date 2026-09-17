import { useRef, useState } from 'react';

// Lets an operator upload their own short clip and see it run through the
// enforcement model, without needing the clip to already live on the server
// or a hand-drawn ROI first - unlike the three fixed cameras below, which
// use the separate /api/process_recorded pipeline against files already in
// public/recorded_videos. This hits /api/infer (server.js), which was fully
// built (multer upload + spawns run_inference.py) but had no UI wired to it.
export default function UploadPlayback() {
  const [file, setFile] = useState(null);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [resultUrl, setResultUrl] = useState(null);
  const [status, setStatus] = useState('idle'); // idle | uploading | done | error
  const [errorMsg, setErrorMsg] = useState('');
  const inputRef = useRef(null);

  const handleFileChange = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.type !== 'video/mp4') {
      setErrorMsg('Please choose an MP4 video.');
      setStatus('error');
      return;
    }
    setFile(f);
    setPreviewUrl(URL.createObjectURL(f));
    setResultUrl(null);
    setStatus('idle');
    setErrorMsg('');
  };

  const handleProcess = async () => {
    if (!file) return;
    setStatus('uploading');
    setErrorMsg('');

    const formData = new FormData();
    formData.append('video', file);
    formData.append('model', 'model_2');

    try {
      const res = await fetch('/api/infer', { method: 'POST', body: formData });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error || `Processing failed (HTTP ${res.status}).`);
      }
      setResultUrl(`${data.outputUrl}?t=${Date.now()}`);
      setStatus('done');
    } catch (err) {
      setErrorMsg(err.message || 'Processing failed.');
      setStatus('error');
    }
  };

  const handleReset = () => {
    setFile(null);
    setPreviewUrl(null);
    setResultUrl(null);
    setStatus('idle');
    setErrorMsg('');
    if (inputRef.current) inputRef.current.value = '';
  };

  return (
    <div className="flex flex-col bg-white rounded-2xl overflow-hidden border border-gray-200 shadow-2xl relative max-w-7xl mx-auto mb-10">
      <div className="flex justify-between items-center bg-white px-6 py-4 border-b border-gray-200">
        <h2 className="text-gray-900 text-xl font-bold tracking-wide">Upload &amp; Analyze a Clip</h2>
        {status === 'done' && (
          <button
            onClick={handleReset}
            className="text-sm font-medium text-gray-600 hover:text-amber-600 border border-gray-300 hover:border-amber-300 rounded-md px-3 py-1.5 transition-colors"
          >
            Upload another
          </button>
        )}
      </div>

      {/* Video Container (16:9 Hero) - same treatment as Focus mode's player */}
      <div className="relative w-full bg-black aspect-video flex items-center justify-center">
        {resultUrl ? (
          <video src={resultUrl} controls autoPlay loop playsInline className="w-full h-full object-contain" />
        ) : previewUrl ? (
          <video src={previewUrl} controls playsInline className="w-full h-full object-contain" />
        ) : (
          <div className="text-gray-500 text-sm text-center px-6">
            Choose a video below to preview it here.
          </div>
        )}

        {status === 'uploading' && (
          <div className="absolute inset-0 bg-black/70 flex flex-col items-center justify-center text-white z-10">
            <div
              style={{
                width: 40,
                height: 40,
                border: '4px solid #f3f3f3',
                borderTop: '4px solid #ef4444',
                borderRadius: '50%',
                animation: 'upload-spin 1s linear infinite',
              }}
            />
            <p className="mt-4 font-semibold">Processing video…</p>
            <style>{`@keyframes upload-spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }`}</style>
          </div>
        )}

        {resultUrl && (
          <span className="absolute bottom-3 left-3 text-white text-xs font-semibold bg-black/50 px-2 py-1 rounded">
            PROCESSED
          </span>
        )}
      </div>

      <div className="px-6 py-5 flex flex-col sm:flex-row sm:items-center gap-4">
        <div className="flex-1">
          <input
            ref={inputRef}
            type="file"
            accept="video/mp4"
            onChange={handleFileChange}
            disabled={status === 'uploading'}
            className="block w-full text-sm text-gray-700 file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-semibold file:bg-amber-50 file:text-amber-700 hover:file:bg-amber-100 disabled:opacity-50"
          />
          <p className="text-gray-500 text-xs mt-2">
            MP4 only, up to 500MB - a short clip (a few seconds to a minute) processes fastest.
          </p>
          {status === 'error' && errorMsg && (
            <p className="text-red-500 text-xs mt-2">{errorMsg}</p>
          )}
        </div>
        <button
          onClick={handleProcess}
          disabled={!file || status === 'uploading'}
          className="px-5 py-2.5 text-sm font-bold rounded-lg bg-amber-600 hover:bg-amber-700 disabled:opacity-50 disabled:cursor-not-allowed text-white transition-colors border-none whitespace-nowrap"
        >
          {status === 'uploading' ? 'Processing…' : 'Process Video'}
        </button>
      </div>
    </div>
  );
}
