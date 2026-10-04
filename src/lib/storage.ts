/** localStorage that never throws (private mode, blocked storage, quota) and a hook on top. */
import { useCallback, useEffect, useRef, useState } from "react";

export function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function save(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function remove(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

/**
 * State mirrored to localStorage. Starts from `initial` on the server and the
 * first client render (so hydration matches), then loads the stored value.
 */
export function usePersistent<T>(key: string, initial: T, debounceMs = 300): [T, (v: T | ((p: T) => T)) => void, boolean] {
  const [value, setValue] = useState<T>(initial);
  const [ready, setReady] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(value);
  latest.current = value;
  const readyRef = useRef(false);
  readyRef.current = ready;
  // Flush the last change when the component goes away.
  useEffect(
    () => () => {
      if (readyRef.current) save(key, latest.current);
    },
    [key],
  );
  useEffect(() => {
    const stored = load<T | undefined>(key, undefined);
    if (stored !== undefined) {
      // Merge objects so new fields added in later versions get their defaults.
      if (stored && typeof stored === "object" && !Array.isArray(stored) && initial && typeof initial === "object" && !Array.isArray(initial)) setValue({ ...initial, ...stored });
      else setValue(stored);
    }
    setReady(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => {
    if (!ready) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => save(key, value), debounceMs);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [key, value, ready, debounceMs]);
  const set = useCallback((v: T | ((p: T) => T)) => setValue(v as never), []);
  return [value, set, ready];
}
