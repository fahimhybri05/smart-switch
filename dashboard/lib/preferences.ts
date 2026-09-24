'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * Per-browser dashboard preferences (localStorage). Conveniences only —
 * storage can be blocked or cleared, so every read falls back to "unset".
 */
const DEFAULT_HOUSEHOLD_KEY = 'sc.defaultHousehold';

export function readDefaultHouseholdId(): number | null {
  try {
    const n = Number(window.localStorage.getItem(DEFAULT_HOUSEHOLD_KEY));
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function writeDefaultHouseholdId(id: number | null) {
  try {
    if (id == null) window.localStorage.removeItem(DEFAULT_HOUSEHOLD_KEY);
    else window.localStorage.setItem(DEFAULT_HOUSEHOLD_KEY, String(id));
  } catch {
    // Storage blocked — the choice just won't persist.
  }
}

/** The household pages open to when the URL doesn't pick one (`?h=`). */
export function useDefaultHousehold() {
  const [id, setId] = useState<number | null>(null);
  useEffect(() => setId(readDefaultHouseholdId()), []);
  const set = useCallback((next: number | null) => {
    writeDefaultHouseholdId(next);
    setId(next);
  }, []);
  return [id, set] as const;
}
