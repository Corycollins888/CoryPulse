import { formatUptime } from './utils.js'

let addressCounter = 20

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function guestName() {
  return 'guest-' + randomInt(1000, 9999)
}

function guestAddress() {
  addressCounter = (addressCounter + 1) % 240
  return `10.5.50.${addressCounter + 2}`
}

export class SimulatedRouter {
  constructor(router) {
    this.router = router
    this.startedAt = Date.now() - randomInt(2, 40) * 86_400_000
    this.lastRx = randomInt(50, 400) * 1024 * 1024
    this.lastTx = randomInt(10, 90) * 1024 * 1024
    this.lastTick = Date.now()
    this.clients = []
    const initial = randomInt(4, 9)
    for (let i = 0; i < initial; i += 1) {
      this.clients.push({
        name: guestName(),
        address: guestAddress(),
        uptime: randomInt(120, 20_000),
        rx: randomInt(2, 600) * 1024 * 1024,
        tx: randomInt(1, 90) * 1024 * 1024,
        idle: randomInt(0, 900),
      })
    }
  }

  tick() {
    const now = Date.now()
    const dt = Math.min(60, Math.max(1, (now - this.lastTick) / 1000))
    this.lastTick = now
    this.lastRx += Math.round(randomInt(30, 900) * 1024 * dt)
    this.lastTx += Math.round(randomInt(10, 220) * 1024 * dt)
    for (const client of this.clients) {
      client.uptime += Math.round(dt)
      client.rx += Math.round(randomInt(20, 400) * 1024 * dt)
      client.tx += Math.round(randomInt(5, 80) * 1024 * dt)
      client.idle += Math.round(dt)
      if (Math.random() < 0.04) client.idle = 0
    }
    if (this.clients.length > 4 && Math.random() < 0.08) {
      this.clients.splice(randomInt(0, this.clients.length - 1), 1)
    }
    if (this.clients.length < 12 && Math.random() < 0.12) {
      this.clients.push({
        name: guestName(),
        address: guestAddress(),
        uptime: randomInt(30, 600),
        rx: randomInt(1, 60) * 1024 * 1024,
        tx: randomInt(1, 10) * 1024 * 1024,
        idle: 0,
      })
    }
  }

  async exec(command, args = {}) {
    this.tick()
    switch (command) {
      case '/system/identity/print':
        return [{ name: this.router.name }]
      case '/system/resource/print':
        return [
          {
            'cpu-load': String(randomInt(4, 46)),
            uptime: formatUptime((Date.now() - this.startedAt) / 60_000),
            'free-memory': String(randomInt(60_000_000, 210_000_000)),
            'total-memory': String(262_144_000),
            'board-name': 'Simulated RB4011',
            version: '7.16 (simulated)',
          },
        ]
      case '/interface/print':
        return [
          { name: 'ether1', type: 'ether', running: 'true', 'rx-byte': String(this.lastRx), 'tx-byte': String(this.lastTx) },
          { name: 'wlan1', type: 'wlan', running: 'true', 'rx-byte': String(this.lastRx), 'tx-byte': String(this.lastTx) },
        ]
      case '/ip/hotspot/active/print':
        this.clients = this.clients.filter((client) => client.idle < 3600)
        return this.clients.map((client) => ({
          user: client.name,
          address: client.address,
          uptime: formatUptime(client.uptime / 60),
          'bytes-in': String(client.rx),
          'bytes-out': String(client.tx),
        }))
      case '/ip/hotspot/user/print':
        return this.clients.map((client) => ({
          '.id': client.name,
          name: client.name,
          'limit-uptime': '',
          'bytes-in': String(client.rx),
          'bytes-out': String(client.tx),
        }))
      case '/ip/hotspot/user/add': {
        const name = args.name || guestName()
        const exists = this.clients.find((client) => client.name === name)
        if (!exists) {
          this.clients.push({
            name,
            address: args.address || guestAddress(),
            uptime: 0,
            rx: 0,
            tx: 0,
            idle: 0,
          })
        }
        return []
      }
      case '/ip/hotspot/user/remove':
      case '/ip/hotspot/active/remove': {
        const target = args.numbers || args['.id'] || args.name
        this.clients = this.clients.filter((client) => client.name !== target)
        return []
      }
      case '/ip/hotspot/user/disable':
      case '/ip/hotspot/user/enable':
        return []
      case '/ip/hotspot/active/login':
        return []
      default:
        return []
    }
  }

  close() {}
}
