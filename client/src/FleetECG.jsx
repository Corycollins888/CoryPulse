import { useEffect, useMemo, useRef, useState } from 'react'
import { timeAgo } from './utils.js'

const GUTTER = 148
const LANE = 38
const PAD_TOP = 18
const PAD_BOTTOM = 14
const ROUTER_PAD = 16

function colorFor(router, siteColor, now) {
  const seen = router.last_seen ? new Date(router.last_seen).getTime() : 0
  const age = seen ? now - seen : Infinity
  // Match the server's coverage rule: three polling intervals, at least 3 min.
  const freshForMs = Math.max(180, Number(router.poll_interval_s || 60) * 3) * 1000
  if (router.status === 'offline') return '#ff5c72'
  if (!seen) return '#3c5a6e'
  if (age < freshForMs) return siteColor || '#22d3a7'
  if (age < freshForMs * 3) return '#f5a524'
  return '#ff5c72'
}

export default function FleetECG({ sites = [], routers = [], onOpenSite }) {
  const wrapRef = useRef(null)
  const canvasRef = useRef(null)
  const layoutRef = useRef({ lanes: [], width: 0 })
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [tip, setTip] = useState(null)

  const lanes = useMemo(() => {
    const bySite = new Map()
    for (const site of sites) bySite.set(site.id, { site, routers: [] })
    for (const router of routers) {
      const lane = bySite.get(router.site_id)
      if (lane) lane.routers.push(router)
    }
    return [...bySite.values()]
      .filter((lane) => lane.routers.length > 0)
      .sort((a, b) => String(a.site.name).localeCompare(String(b.site.name)))
  }, [sites, routers])

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return undefined
    const observer = new ResizeObserver(() => {
      const width = Math.max(320, el.clientWidth)
      const height = Math.max(260, PAD_TOP + lanes.length * LANE + PAD_BOTTOM)
      setSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }))
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [lanes.length])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !size.width) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    canvas.width = Math.round(size.width * dpr)
    canvas.height = Math.round(size.height * dpr)
    canvas.style.width = `${size.width}px`
    canvas.style.height = `${size.height}px`
    const ctx = canvas.getContext('2d')
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, size.width, size.height)

    const now = Date.now()
    const plotLeft = GUTTER
    const plotWidth = size.width - GUTTER - 8
    const drawn = []

    ctx.font = '11px "Segoe UI", system-ui, sans-serif'
    ctx.textBaseline = 'middle'

    lanes.forEach((lane, laneIndex) => {
      const y = PAD_TOP + laneIndex * LANE
      const base = y + LANE - 12
      const list = lane.routers
      const step = list.length > 1 ? (plotWidth - ROUTER_PAD * 2) / (list.length - 1) : 0

      ctx.strokeStyle = 'rgba(148, 184, 205, 0.12)'
      ctx.beginPath()
      ctx.moveTo(plotLeft, base + 0.5)
      ctx.lineTo(size.width - 8, base + 0.5)
      ctx.stroke()

      const online = list.filter((router) => router.status === 'online').length
      ctx.fillStyle = 'rgba(233, 243, 247, 0.9)'
      ctx.fillText(String(lane.site.name).slice(0, 20), 14, base - 10)
      ctx.fillStyle = 'rgba(138, 163, 180, 0.75)'
      ctx.font = '10px "Segoe UI", system-ui, sans-serif'
      ctx.fillText(`${online}/${list.length} online`, 14, base + 6)
      ctx.font = '11px "Segoe UI", system-ui, sans-serif'

      const siteColor = lane.site.color || '#22d3a7'
      list.forEach((router, routerIndex) => {
        const x = list.length > 1 ? plotLeft + ROUTER_PAD + routerIndex * step : plotLeft + plotWidth / 2
        const color = colorFor(router, siteColor, now)
        const activity = router.users > 0 ? Math.min(13, 5 + Math.log2(1 + Number(router.users)) * 3.2) : 4
        const amp = router.users > 0 ? activity : color === '#ff5c72' ? 7 : 4

        ctx.strokeStyle = color
        ctx.globalAlpha = router.users > 0 || color === '#ff5c72' ? 0.95 : 0.5
        ctx.lineWidth = router.users > 0 ? 1.6 : 1
        ctx.beginPath()
        ctx.moveTo(x - 2.4, base)
        ctx.lineTo(x - 1, base - amp * 0.38)
        ctx.lineTo(x, base - amp)
        ctx.lineTo(x + 1.2, base - amp * 0.3)
        ctx.lineTo(x + 2.4, base)
        ctx.stroke()
        ctx.globalAlpha = 1
        if (router.users > 0) {
          ctx.fillStyle = color
          ctx.beginPath()
          ctx.arc(x, base - amp, 1.4, 0, Math.PI * 2)
          ctx.fill()
        }
        drawn.push({ router, lane, x, base, amp })
      })
    })

    layoutRef.current = { lanes, width: size.width, plotLeft, drawn }
  }, [lanes, routers, size])

  const onMove = (event) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const mx = event.clientX - rect.left
    const my = event.clientY - rect.top
    const laneIndex = Math.floor((my - PAD_TOP) / LANE)
    const { drawn } = layoutRef.current
    const candidates = (drawn || []).filter(
      (item) => mx >= GUTTER && Math.floor((item.base - LANE + 12 - PAD_TOP) / LANE) === laneIndex
    )
    let best = null
    let bestDistance = 9
    for (const item of candidates) {
      const distance = Math.abs(item.x - mx)
      if (distance < bestDistance) {
        bestDistance = distance
        best = item
      }
    }
    if (!best) {
      if (tip) setTip(null)
      return
    }
    setTip({ ...best, left: Math.min(Math.max(best.x, 150), Math.max(160, size.width - 190)), top: best.base - best.amp - 8 })
  }

  return (
    <div className="ecg-wrap" ref={wrapRef}>
      <div className="ecg-sweep" aria-hidden="true" />
      <canvas
        ref={canvasRef}
        className="ecg-canvas"
        style={{ height: Math.max(260, PAD_TOP + lanes.length * LANE + PAD_BOTTOM) }}
        role="img"
        aria-label={`Fleet heartbeat for ${routers.length} routers across ${lanes.length} sites`}
        onMouseMove={onMove}
        onMouseLeave={() => setTip(null)}
        onClick={() => {
          if (tip?.lane) onOpenSite?.(tip.lane.site.id)
        }}
      />
      {tip && (
        <div className="ecg-tip" style={{ left: tip.left, top: Math.max(4, tip.top - 62) }}>
          <strong>{tip.router.name}</strong>
          <span>{tip.lane.site.name}</span>
          <span>
            {tip.router.status === 'online' ? 'online' : tip.router.status} · {Number(tip.router.users || 0)}{' '}
            {Number(tip.router.users || 0) === 1 ? 'user' : 'users'}
          </span>
          <span>{tip.router.last_seen ? `reported ${timeAgo(tip.router.last_seen)}` : 'never reported'}</span>
        </div>
      )}
      {lanes.length === 0 && <div className="ecg-empty">No routers to display yet.</div>}
    </div>
  )
}
