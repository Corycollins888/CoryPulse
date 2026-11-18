import crypto from 'node:crypto'
import { secretKey } from './config.js'

const key = Buffer.from(secretKey, 'hex')

export function encryptSecret(plain) {
  if (!plain) return null
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return ['v1', iv.toString('base64'), tag.toString('base64'), encrypted.toString('base64')].join('.')
}

export function decryptSecret(payload) {
  if (!payload) return null
  if (!payload.startsWith('v1.')) return payload
  const [, ivB64, tagB64, dataB64] = payload.split('.')
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'))
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]).toString('utf8')
}
