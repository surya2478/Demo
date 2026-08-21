import React from 'react';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import RoutesApp from './routes';
import { AuthProvider } from './context/AuthContext';
import SessionWatcher from './components/SessionWatcher';
import { AIProcessingProvider } from './context/AIProcessingContext';

const App: React.FC = () => {
  return (
    <Router>
      <AuthProvider>
        <AIProcessingProvider>
          <SessionWatcher />
          <RoutesApp />
        </AIProcessingProvider>
      </AuthProvider>
    </Router>
  );
};

export default App;
