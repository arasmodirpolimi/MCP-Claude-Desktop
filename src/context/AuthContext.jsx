import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { supabase, isSupabaseConfigured } from '../supabaseClient';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let isMounted = true;
    async function init() {
      try {
        const {
          data: { session },
        } = await supabase.auth.getSession();
        if (isMounted) setSession(session);
      } catch (e) {
        console.error('[Auth] init error', e);
      } finally {
        if (isMounted) setLoading(false);
      }
    }
    init();

    let listener;
    if (isSupabaseConfigured && typeof supabase.auth.onAuthStateChange === 'function') {
      const { data } = supabase.auth.onAuthStateChange((_event, session) => {
        setSession(session);
      });
      listener = data?.subscription;
    }
    return () => {
      isMounted = false;
      if (listener) listener.unsubscribe();
    };
  }, []);

  const signInWithEmail = useCallback(async (email, password) => {
    setError(null);
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      setError(error.message);
      return { error };
    }
    setSession(data.session);
    return { data };
  }, []);

  const signOut = useCallback(async () => {
    setError(null);
    const { error } = await supabase.auth.signOut();
    if (error) {
      setError(error.message);
      return { error };
    }
    setSession(null);
  }, []);

  const value = {
    session,
    user: session?.user ?? null,
    loading,
    error,
    signInWithEmail,
    signOut,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>');
  return ctx;
}
