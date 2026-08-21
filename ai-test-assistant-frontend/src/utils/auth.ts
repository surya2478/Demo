// src/utils/auth.ts

import { useEffect, useState } from 'react';

export const setAuthToken = (token: string) => {
  localStorage.setItem('authToken', token);
};

export const getAuthToken = () => {
  return localStorage.getItem('authToken');
};

export const removeAuthToken = () => {
  localStorage.removeItem('authToken');
};

export const isAuthenticated = () => {
  return !!getAuthToken();
};

// React hook reflecting auth state and providing login/logout helpers
export const useAuth = () => {
  const [auth, setAuth] = useState<boolean>(isAuthenticated());

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'authToken') {
        setAuth(!!e.newValue);
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const login = (token: string) => {
    setAuthToken(token);
    setAuth(true);
  };

  const logout = () => {
    removeAuthToken();
    setAuth(false);
  };

  return {
    auth,
    isAuthenticated: auth,
    login,
    logout,
  };
};

// Add a default export for compatibility
export default {
  setAuthToken,
  getAuthToken,
  removeAuthToken,
  isAuthenticated,
  useAuth,
};