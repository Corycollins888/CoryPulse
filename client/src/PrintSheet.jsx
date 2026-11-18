import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { Modal } from './components.jsx'
import Icon from './icons.jsx'
import { money, duration, dataSize } from './utils.js'

export default function PrintSheet({ sheet, onClose }) {
  const [qrs, setQrs] = useState({})
  const items = sheet?.items || []
  const fallbackSite = sheet?.site

  useEffect(() => {
    let alive = true
    setQrs({})
    Promise.all(
      items.map(async (item) => {
        const siteId = item.site_id || fallbackSite?.id
        if (!siteId) return [item.id, '']
        const link = `${window.location.origin}/portal/${siteId}?voucher=${encodeURIComponent(item.code)}&auto=1`
        try {
          const dataUrl = await QRCode.toDataURL(link, {
            margin: 1,
            width: 260,
            errorCorrectionLevel: 'M',
            color: { dark: '#0b1220', light: '#ffffff' },
          })
          return [item.id, dataUrl]
        } catch {
          return [item.id, '']
        }
      })
    ).then((entries) => {
      if (alive) setQrs(Object.fromEntries(entries))
    })
    return () => {
      alive = false
    }
  }, [items, fallbackSite])

  return (
    <Modal
      wide
      title="Print voucher cards"
      subtitle="Guests scan the QR and are connected instantly — no typing."
      onClose={onClose}
    >
      <div className="print-toolbar">
        <div className="print-note">
          <Icon name="qr" size={20} />
          <div>
            <strong>{items.length} card{items.length === 1 ? '' : 's'} ready</strong>
            <span>Each QR opens the guest portal and activates that exact voucher.</span>
          </div>
        </div>
        <div className="actions">
          <button className="btn" onClick={onClose}>Close</button>
          <button className="btn primary" onClick={() => window.print()} disabled={!items.length}>
            <Icon name="printer" size={15} /> Print
          </button>
        </div>
      </div>

      {items.length === 0 ? (
        <p className="body-text">There are no unused vouchers for this selection. Generate stock first.</p>
      ) : (
        <div className="print-sheet">
          {items.map((item) => (
            <article className="voucher-card" key={item.id} style={{ '--card-accent': item.color || fallbackSite?.color || '#0f9f7f' }}>
              <div className="vc-top">
                <span className="vc-brand">
                  <span className="vc-mark"><Icon name="pulse" size={12} strokeWidth={2.6} /></span>
                  CoryPulse
                </span>
                <span className="vc-ssid">
                  <Icon name="wifi" size={12} />
                  {item.ssid || fallbackSite?.ssid || 'Guest Wi-Fi'}
                </span>
              </div>
              <div className="vc-body">
                <div className="vc-info">
                  <div className="vc-site">{item.site_name || fallbackSite?.name || 'Guest Wi-Fi'}</div>
                  <div className="vc-plan">{item.plan_name}</div>
                  <div className="vc-meta">
                    {duration(item.duration_minutes)} · {dataSize(item.data_mb)}
                  </div>
                  <div className="vc-code">{item.code}</div>
                  <div className="vc-price">{money(item.price, item.currency || sheet?.currency)}</div>
                </div>
                <div className="vc-qr">
                  {qrs[item.id] ? (
                    <img src={qrs[item.id]} alt={`QR code for ${item.code}`} />
                  ) : (
                    <span className="vc-qr-placeholder" />
                  )}
                </div>
              </div>
              <div className="vc-foot">
                <span>Scan to connect</span>
                <span>or enter the code on the portal</span>
              </div>
            </article>
          ))}
        </div>
      )}
    </Modal>
  )
}
