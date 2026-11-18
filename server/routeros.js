import net from 'node:net'
import tls from 'node:tls'
import crypto from 'node:crypto'

function encodeLength(length) {
  if (length < 0x80) return Buffer.from([length])
  if (length < 0x4000) return Buffer.from([0x80 | (length >> 8), length & 0xff])
  if (length < 0x200000) {
    return Buffer.from([0xc0 | (length >> 16), (length >> 8) & 0xff, length & 0xff])
  }
  if (length < 0x10000000) {
    return Buffer.from([0xe0 | (length >> 24), (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff])
  }
  const out = Buffer.alloc(5)
  out[0] = 0xf0
  out.writeUInt32BE(length, 1)
  return out
}

function encodeSentence(words) {
  const parts = words.map((word) => {
    const body = Buffer.from(String(word), 'utf8')
    return Buffer.concat([encodeLength(body.length), body])
  })
  parts.push(Buffer.from([0]))
  return Buffer.concat(parts)
}

class SentenceParser {
  constructor() {
    this.buffer = Buffer.alloc(0)
    this.words = []
  }

  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk])
    const sentences = []
    for (;;) {
      if (this.buffer.length === 0) break
      const first = this.buffer[0]
      let length
      let header
      if (first < 0x80) {
        length = first
        header = 1
      } else if (first < 0xc0) {
        if (this.buffer.length < 2) break
        length = ((first & 0x3f) << 8) | this.buffer[1]
        header = 2
      } else if (first < 0xe0) {
        if (this.buffer.length < 3) break
        length = ((first & 0x1f) << 16) | (this.buffer[1] << 8) | this.buffer[2]
        header = 3
      } else if (first < 0xf0) {
        if (this.buffer.length < 4) break
        length =
          ((first & 0x0f) << 24) | (this.buffer[1] << 16) | (this.buffer[2] << 8) | this.buffer[3]
        header = 4
      } else {
        if (this.buffer.length < 5) break
        length = this.buffer.readUInt32BE(1)
        header = 5
      }
      if (this.buffer.length < header + length) break
      const word = this.buffer.subarray(header, header + length).toString('utf8')
      this.buffer = this.buffer.subarray(header + length)
      if (length === 0) {
        if (this.words.length) sentences.push(this.words)
        this.words = []
      } else {
        this.words.push(word)
      }
    }
    return sentences
  }
}

function parseAttributes(sentence) {
  const attrs = {}
  for (const word of sentence.slice(1)) {
    if (!word.startsWith('=')) continue
    const body = word.slice(1)
    const eq = body.indexOf('=')
    if (eq === -1) attrs[body] = ''
    else attrs[body.slice(0, eq)] = body.slice(eq + 1)
  }
  return attrs
}

export class RouterOsClient {
  static async connect({ host, port = 8728, username, password, useTls = false, timeoutMs = 8000 }) {
    const client = new RouterOsClient()
    await client.open({ host, port, useTls, timeoutMs })
    try {
      await client.login(username, password)
    } catch (err) {
      client.destroy()
      throw err
    }
    return client
  }

  constructor() {
    this.socket = null
    this.parser = new SentenceParser()
    this.pending = null
    this.queue = Promise.resolve()
    this.closed = false
  }

  open({ host, port, useTls, timeoutMs }) {
    return new Promise((resolve, reject) => {
      const onError = (err) => {
        clearTimeout(timer)
        reject(new Error(`Cannot reach ${host}:${port} - ${err.message}`))
      }
      const onConnect = () => {
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(() => {
        this.socket?.destroy()
        reject(new Error(`Connection to ${host}:${port} timed out`))
      }, timeoutMs)

      this.socket = useTls ? tls.connect({ host, port, rejectUnauthorized: false }) : net.connect({ host, port })
      this.socket.setNoDelay(true)
      this.socket.once(useTls ? 'secureConnect' : 'connect', onConnect)
      this.socket.once('error', onError)
      this.socket.setTimeout(30000)
      this.socket.on('timeout', () => this.failAll(new Error('Router connection timed out')))
      this.socket.on('error', () => {})
      this.socket.on('data', (chunk) => {
        let sentences
        try {
          sentences = this.parser.push(chunk)
        } catch (err) {
          this.failAll(err)
          return
        }
        for (const sentence of sentences) this.handleSentence(sentence)
      })
      this.socket.on('close', () => {
        this.closed = true
        this.failAll(new Error('Router closed the connection'))
      })
    })
  }

  handleSentence(sentence) {
    if (!this.pending || sentence.length === 0) return
    const type = sentence[0]
    const attrs = parseAttributes(sentence)
    if (type === '!re') {
      this.pending.onRow(attrs)
    } else if (type === '!done') {
      this.pending.resolve(attrs)
    } else if (type === '!trap') {
      this.pending.reject(new Error(attrs.message || 'Router rejected the command'))
    } else if (type === '!fatal') {
      this.pending.reject(new Error(attrs.message || 'Router closed the session'))
      this.destroy()
    }
  }

  failAll(err) {
    if (this.pending) {
      this.pending.reject(err)
      this.pending = null
    }
  }

  destroy() {
    this.closed = true
    this.socket?.destroy()
  }

  call(words, timeoutMs = 10000) {
    const execute = () =>
      new Promise((resolve, reject) => {
        if (this.closed || !this.socket || this.socket.destroyed) {
          reject(new Error('Router connection is closed'))
          return
        }
        const rows = []
        const timer = setTimeout(() => {
          this.pending = null
          this.destroy()
          reject(new Error('Router command timed out'))
        }, timeoutMs)
        this.pending = {
          onRow: (row) => rows.push(row),
          resolve: (done) => {
            clearTimeout(timer)
            this.pending = null
            resolve({ rows, done })
          },
          reject: (err) => {
            clearTimeout(timer)
            this.pending = null
            reject(err)
          },
        }
        this.socket.write(encodeSentence(words))
      })

    const result = this.queue.then(execute, execute)
    this.queue = result.catch(() => {})
    return result
  }

  async login(username, password) {
    const first = await this.call(['/login', `=name=${username}`, `=password=${password}`])
    if (first.done && first.done.ret) {
      const challenge = Buffer.from(first.done.ret, 'hex')
      const digest = crypto
        .createHash('md5')
        .update(Buffer.concat([Buffer.from([0]), Buffer.from(password, 'utf8'), challenge]))
        .digest('hex')
      await this.call(['/login', `=name=${username}`, `=response=00${digest}`])
    }
  }

  async exec(command, args = {}, timeoutMs = 10000) {
    const words = [command]
    for (const [key, value] of Object.entries(args)) {
      if (value === undefined || value === null || value === '') continue
      words.push(`=${key}=${value}`)
    }
    const { rows } = await this.call(words, timeoutMs)
    return rows
  }

  close() {
    this.closed = true
    try {
      this.socket?.end()
    } catch {
      // ignore
    }
    this.socket?.destroy()
  }
}
