import { useState } from 'react';
import { adminLogin, useAdminLoginRequest, clearAdminLoginRequest } from '../adminAuth';

// Rendered exactly ONCE, at the App level (see App.jsx) - not per camera card. Any component
// anywhere calls requestAdminLogin(onSuccess, contextLabel) from adminAuth.js to open this;
// see that file's comment for why this used to be duplicated per LiveCCTVPlayer instance.
export default function AdminLoginModal() {
  const request = useAdminLoginRequest();
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (!request) return null;

  const close = () => {
    setPassword('');
    setError('');
    setBusy(false);
    clearAdminLoginRequest();
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <form
        className="bg-white rounded-xl shadow-2xl p-6 max-w-xs w-full"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            await adminLogin(username, password);
            const onSuccess = request.onSuccess;
            close();
            onSuccess();
          } catch (err) {
            setError(err.message || 'Login failed.');
            setBusy(false);
          }
        }}
      >
        <h3 className="text-lg font-bold text-gray-900 mb-1">Admin sign-in</h3>
        <p className="text-gray-500 text-sm mb-4">
          {request.contextLabel ? `Required to edit the restricted-lane region for ${request.contextLabel}.` : 'Admin sign-in required.'}
        </p>
        <label className="block text-xs font-medium text-gray-700 mb-1">Username</label>
        <input
          type="text"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          className="w-full px-3 py-2 mb-3 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-amber-500"
          autoFocus
        />
        <label className="block text-xs font-medium text-gray-700 mb-1">Password</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full px-3 py-2 mb-3 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-amber-500"
        />
        {error && <p className="text-red-600 text-xs mb-3">{error}</p>}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={close}
            className="flex-1 py-2 px-3 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors text-sm font-medium"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy}
            className="flex-1 py-2 px-3 bg-amber-600 hover:bg-amber-700 disabled:opacity-50 text-white rounded-lg transition-colors text-sm font-semibold"
          >
            {busy ? 'Signing in...' : 'Sign in'}
          </button>
        </div>
      </form>
    </div>
  );
}
