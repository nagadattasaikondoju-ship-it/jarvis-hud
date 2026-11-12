import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { initPwa } from './pwa.js';
import './styles.css';

initPwa();
createRoot(document.getElementById('root')).render(<App />);
