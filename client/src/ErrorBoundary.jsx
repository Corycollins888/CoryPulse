import { Component } from 'react'

export default class ErrorBoundary extends Component {
  state = { error: null }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    console.error('[ui] render crashed:', error, info?.componentStack)
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="crash-screen">
        <div className="crash-card">
          <div className="crash-badge">CoryPulse</div>
          <h1>This screen hit a problem</h1>
          <p>
            The rest of the system is unaffected — your data and routers keep running. Reload to
            pick up where you left off.
          </p>
          <div className="crash-actions">
            <button className="btn primary" onClick={() => window.location.reload()}>
              Reload console
            </button>
            <a className="btn" href="/wall">
              Open pulse wall
            </a>
          </div>
        </div>
      </div>
    )
  }
}
