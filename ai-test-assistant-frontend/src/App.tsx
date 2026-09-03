import React from 'react';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import RoutesApp from './routes';
import { AuthProvider } from './context/AuthContext';
import SessionWatcher from './components/SessionWatcher';
import { AIProcessingProvider } from './context/AIProcessingContext';
import { ToastProvider } from './components/ui/Toast';
import { ConfirmProvider } from './components/ui/ConfirmDialog';

const App: React.FC = () => {
  return (
    <Router>
      <AuthProvider>
        <AIProcessingProvider>
          <ToastProvider>
            <ConfirmProvider>
              <SessionWatcher />
              <RoutesApp />
            </ConfirmProvider>
          </ToastProvider>
        </AIProcessingProvider>
      </AuthProvider>
    </Router>
  );
};

export default App;
