'use client';

import { useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

import { ApiError, authApi, normalizeDevices } from './api';
import { applySnapshot, normalizeState, patchChannelState, patchDeviceOnline, qk } from './cache';
import type { LiveEvent } from './types';

export type LiveStatus = 'connecting' | 'live' | 'offline';

const LiveContext = createContext<LiveStatus>('connecting');

export function useLiveStatus(): LiveStatus {
  return useContext(LiveContext);
}

/** While the socket is down, GET /devices is polled at this interval instead. */
export const POLL_INTERVAL_MS = 10_000;

const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

/**
 * Keeps the React Query device cache live from the backend client WebSocket
 * (`snapshot`, `state_changed`, `device_online`, `device_offline`).
 * Reconnects with jittered exponential backoff, fetching a fresh short-lived
 * token each time via /api/auth/ws-token. Consumers read the status to switch
 * to 10 s polling while disconnected.
 */
export function LiveProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [status, setStatus] = useState<LiveStatus>('connecting');
  const attemptRef = useRef(0);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    const schedule = () => {
      if (disposed) return;
      const attempt = attemptRef.current++;
      const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** attempt);
      const delay = base / 2 + Math.random() * (base / 2);
      timer = setTimeout(connect, delay);
    };

    const handle = (msg: LiveEvent) => {
      switch (msg.event) {
        case 'snapshot':
          applySnapshot(qc, normalizeDevices(msg.devices));
          break;
        case 'state_changed': {
          const state = normalizeState(msg.state);
          if (state) patchChannelState(qc, msg.deviceId, msg.channelIdx, state);
          break;
        }
        case 'device_online':
          patchDeviceOnline(qc, msg.deviceId, true);
          break;
        case 'device_offline':
          patchDeviceOnline(qc, msg.deviceId, false);
          break;
      }
    };

    async function connect() {
      if (disposed) return;
      timer = null;
      setStatus((s) => (s === 'live' ? 'connecting' : s));
      let token: string;
      let wsUrl: string;
      try {
        ({ token, wsUrl } = await authApi.wsToken());
      } catch (err) {
        setStatus('offline');
        // A dead session already redirected to /login; otherwise retry later.
        if (!(err instanceof ApiError && err.status === 401)) schedule();
        return;
      }
      if (disposed) return;

      let socket: WebSocket;
      try {
        const url = new URL(wsUrl);
        url.searchParams.set('token', token);
        socket = new WebSocket(url.toString());
      } catch {
        setStatus('offline');
        schedule();
        return;
      }
      ws = socket;

      socket.onopen = () => {
        attemptRef.current = 0;
        setStatus('live');
        // Catch up on anything missed while disconnected (the snapshot also covers this).
        void qc.invalidateQueries({ queryKey: qk.devices });
      };
      socket.onmessage = (ev) => {
        try {
          const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '') as LiveEvent;
          if (msg && typeof msg === 'object' && 'event' in msg) handle(msg);
        } catch {
          /* ignore malformed frames */
        }
      };
      socket.onclose = () => {
        if (ws === socket) ws = null;
        if (disposed) return;
        setStatus('offline');
        schedule();
      };
      socket.onerror = () => {
        // onclose follows and schedules the reconnect.
      };
    }

    const onVisible = () => {
      if (document.visibilityState === 'visible' && !ws && timer) {
        clearTimeout(timer);
        attemptRef.current = 0;
        void connect();
      }
    };
    const onOnline = () => onVisible();

    void connect();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onOnline);

    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onOnline);
      if (ws) {
        ws.onclose = null;
        ws.close(1000, 'unmount');
      }
    };
  }, [qc]);

  return <LiveContext.Provider value={status}>{children}</LiveContext.Provider>;
}
