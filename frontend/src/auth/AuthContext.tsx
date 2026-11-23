import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import axios from 'axios';
import { jwtDecode } from 'jwt-decode';
import { googleLogout } from '@react-oauth/google';
import { API_BASE_URL } from '../config';
import { apiClient, AUTH_TOKEN_KEY } from '../services/api.service';

interface User {
  id: string;
  name: string;
  email: string;
  picture?: string;
}

interface AuthContextType {
  user: User | null;
  loginWithGoogle: (credential: string) => Promise<void>;
  logout: () => void;
  isLoading: boolean;
}

const USER_KEY = 'user';

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const clearStoredSession = () => {
  localStorage.removeItem(USER_KEY);
  localStorage.removeItem(AUTH_TOKEN_KEY);
};

/**
 * Read the saved session synchronously, so the first render already knows
 * whether the user is signed in (no flash of the login page on refresh).
 * A corrupted or expired session is discarded.
 */
const loadStoredUser = (): User | null => {
  const storedUser = localStorage.getItem(USER_KEY);
  const token = localStorage.getItem(AUTH_TOKEN_KEY);
  if (!storedUser || !token) return null;

  try {
    const { exp } = jwtDecode<{ exp?: number }>(token);
    if (exp && exp * 1000 <= Date.now()) {
      clearStoredSession();
      return null;
    }
    return JSON.parse(storedUser) as User;
  } catch {
    clearStoredSession();
    return null;
  }
};

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [user, setUser] = useState<User | null>(loadStoredUser);

  const logout = useCallback(() => {
    clearStoredSession();
    googleLogout();
    setUser(null);
  }, []);

  // Any 401 from the API signs the user out; RequireAuth then shows the login page.
  useEffect(() => {
    apiClient.setUnauthorizedHandler(logout);
    return () => apiClient.setUnauthorizedHandler(null);
  }, [logout]);

  const loginWithGoogle = useCallback(async (credential: string) => {
    // The backend verifies the credential and reads the identity from it.
    const response = await axios.post(`${API_BASE_URL}/auth/google-login`, {
      googleToken: credential,
    });

    const { token, user: account } = response.data ?? {};
    if (!token || !account) {
      throw new Error('The server did not return a session');
    }

    const userData: User = {
      id: account.id,
      name: account.name || account.email,
      email: account.email,
      picture: account.picture,
    };
    localStorage.setItem(AUTH_TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(userData));
    setUser(userData);
  }, []);

  const value = useMemo(
    () => ({ user, loginWithGoogle, logout, isLoading: false }),
    [user, loginWithGoogle, logout]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

// eslint-disable-next-line react-refresh/only-export-components
export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
