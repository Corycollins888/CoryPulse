import { useCallback, useEffect, useRef, useState } from 'react'

export async function api(path, options = {}) {
  const { method = 'GET', body, headers = {} } = options
  const init = { method, credentials: 'same-origin', headers: { ...headers } }
  if (body !== undefined) {
    init.body = JSON.stringify(body)
    init.headers['Content-Type'] = 'application/json'
  }
  const res = await fetch('/api' + path, init)
  let data = null
  try {
    data = await res.json()
  } catch {
    data = null
  }
  if (!res.ok) {
    const err = new Error(data?.error || `Request failed (${res.status})`)
    err.status = res.status
    err.data = data
    throw err
  }
  return data
}

export function useApi(path, deps = []) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(Boolean(path))
  const [tick, setTick] = useState(0)
  const hasData = useRef(false)

  useEffect(() => {
    if (!path) {
      setLoading(false)
      return undefined
    }
    let alive = true
    if (!hasData.current) setLoading(true)
    api(path)
      .then((result) => {
        if (!alive) return
        hasData.current = true
        setData(result)
        setError(null)
      })
      .catch((err) => {
        if (alive) setError(err)
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, tick, ...deps])

  const reload = useCallback(() => setTick((t) => t + 1), [])
  return { data, error, loading, reload, setData }
}

export const LIVE_EVENTS = [
  'router',
  'sale',
  'voucher',
  'vouchers_generated',
  'vouchers_expired',
  'refund',
  'payment_failed',
]

export function useLiveEvents(handler) {
  const ref = useRef(handler)
  ref.current = handler
  useEffect(() => {
    const listener = (event) => ref.current(event.detail.type, event.detail.data)
    window.addEventListener('cp:live', listener)
    return () => window.removeEventListener('cp:live', listener)
  }, [])
}

export function useDebouncedReload(reload, delay = 900) {
  const timer = useRef(null)
  useLiveEvents(() => {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => reload(), delay)
  })
  useEffect(() => () => clearTimeout(timer.current), [])
}
