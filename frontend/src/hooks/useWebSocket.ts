import { useState, useEffect, useRef, useCallback } from 'react'

export interface WebSocketMessage {
  type: string
  [key: string]: unknown
}

export interface UseWebSocketResult<T = WebSocketMessage> {
  /** Latest data received from the server */
  data: T | null
  /** Whether the WebSocket is currently connected */
  isConnected: boolean
  /** Latest error, if any */
  error: string | null
  /** Manually trigger a reconnection */
  reconnect: () => void
}

/**
 * WebSocket hook with exponential backoff reconnection.
 *
 * Features:
 * - Automatic reconnection with exponential backoff (1s, 2s, 4s, ..., max 30s)
 * - Heartbeat ping every 30s (detects silent disconnections)
 * - Cleans up on unmount
 *
 * Implementation note: the connect routine lives in a ref rather than a
 * useCallback so that it never becomes a reactive dependency. An earlier
 * version had `connect` in the effect's dependency array while `connect`
 * itself called setState, which recreated the callback, re-ran the effect,
 * closed the socket and triggered onclose -> reconnect: an endless
 * connect/disconnect loop that made the UI flicker between "connected" and
 * "reconnecting". The effect now depends only on `url` and `enabled`.
 *
 * @param url  - The full WebSocket URL (ws:// or wss://)
 * @param enabled - Whether to open the connection (default: true)
 */
export function useWebSocket<T = WebSocketMessage>(
  url: string | null,
  enabled: boolean = true,
): UseWebSocketResult<T> {
  const [data, setData] = useState<T | null>(null)
  const [isConnected, setIsConnected] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const wsRef = useRef<WebSocket | null>(null)
  const retryCount = useRef(0)
  const retryTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)
  const heartbeatInterval = useRef<ReturnType<typeof setInterval> | null>(null)
  /** Set during cleanup so the socket's onclose handler skips reconnecting. */
  const intentionalClose = useRef(false)
  /** Stable handle to the latest connect implementation. */
  const connectRef = useRef<() => void>(() => {})

  const clearHeartbeat = useCallback(() => {
    if (heartbeatInterval.current !== null) {
      clearInterval(heartbeatInterval.current)
      heartbeatInterval.current = null
    }
  }, [])

  const clearRetry = useCallback(() => {
    if (retryTimeout.current !== null) {
      clearTimeout(retryTimeout.current)
      retryTimeout.current = null
    }
  }, [])

  useEffect(() => {
    if (!url || !enabled) {
      // Nothing to connect to — make sure any previous socket is torn down.
      intentionalClose.current = true
      clearRetry()
      clearHeartbeat()
      if (wsRef.current) {
        wsRef.current.close()
        wsRef.current = null
      }
      setIsConnected(false)
      return
    }

    intentionalClose.current = false

    /** Exponential backoff with ±20 % jitter, capped at 30 s. */
    const getRetryDelay = () => {
      const base = Math.min(1000 * 2 ** retryCount.current, 30_000)
      return Math.round(base * (0.8 + Math.random() * 0.4))
    }

    const open = () => {
      // Guard against opening a second socket for the same effect run.
      if (intentionalClose.current) return

      const ws = new WebSocket(url)
      wsRef.current = ws

      ws.onopen = () => {
        if (intentionalClose.current) {
          ws.close()
          return
        }
        retryCount.current = 0
        setIsConnected(true)
        setError(null)
        clearHeartbeat()
        heartbeatInterval.current = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ping' }))
          }
        }, 30_000)
      }

      ws.onmessage = (event: MessageEvent) => {
        try {
          const parsed: T = JSON.parse(event.data as string)
          // Ignore pong heartbeats
          if ((parsed as unknown as { type?: string })?.type === 'pong') return
          setData(parsed)
        } catch {
          // Non-JSON message — ignore
        }
      }

      ws.onclose = () => {
        clearHeartbeat()
        // Only surface a disconnect if this socket is still the active one.
        // A stale socket closing during teardown must not flip the UI state.
        if (wsRef.current !== ws) return
        setIsConnected(false)
        if (intentionalClose.current) return

        const delay = getRetryDelay()
        retryCount.current += 1
        clearRetry()
        retryTimeout.current = setTimeout(open, delay)
      }

      ws.onerror = () => {
        // onerror is always followed by onclose, which handles reconnection.
        if (wsRef.current === ws) setError('WebSocket connection error')
      }
    }

    connectRef.current = () => {
      retryCount.current = 0
      clearRetry()
      intentionalClose.current = false
      if (wsRef.current) {
        const stale = wsRef.current
        wsRef.current = null
        stale.close()
      }
      open()
    }

    open()

    return () => {
      intentionalClose.current = true
      clearRetry()
      clearHeartbeat()
      if (wsRef.current) {
        const ws = wsRef.current
        wsRef.current = null
        ws.close()
      }
    }
    // Only url/enabled should re-establish the connection.
  }, [url, enabled, clearHeartbeat, clearRetry])

  const reconnect = useCallback(() => {
    connectRef.current()
  }, [])

  return { data, isConnected, error, reconnect }
}

export default useWebSocket
