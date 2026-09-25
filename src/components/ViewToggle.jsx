import React from 'react';

const ViewToggle = ({ currentView, onViewChange }) => {
  return (
    <div className="flex items-center bg-gray-100 rounded-full p-1 border border-gray-200 shadow-inner w-max">
      {/* Focus View Button */}
      <button
        onClick={() => onViewChange('focus')}
        className={`flex items-center justify-center p-2 rounded-full transition-colors ${
          currentView === 'focus' 
            ? 'bg-amber-600 text-white shadow-md' 
            : 'text-gray-500 hover:text-gray-900 hover:bg-white'
        }`}
        title="Focus View"
      >
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
        </svg>
      </button>

      {/* Grid View Button */}
      <button
        onClick={() => onViewChange('grid')}
        className={`flex items-center justify-center p-2 rounded-full transition-colors ${
          currentView === 'grid' 
            ? 'bg-amber-600 text-white shadow-md' 
            : 'text-gray-500 hover:text-gray-900 hover:bg-white'
        }`}
        title="Grid View"
      >
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
        </svg>
      </button>

      {/* Map View Button */}
      <button
        onClick={() => onViewChange('map')}
        className={`flex items-center justify-center p-2 rounded-full transition-colors ${
          currentView === 'map'
            ? 'bg-amber-600 text-white shadow-md'
            : 'text-gray-500 hover:text-gray-900 hover:bg-white'
        }`}
        title="Map View"
      >
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" />
        </svg>
      </button>
    </div>
  );
};

export default ViewToggle;
