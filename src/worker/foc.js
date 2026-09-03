import { CarBufferReader } from '@ipld/car/buffer-reader'
import { exporter } from 'ipfs-unixfs-exporter'
import { MemoryBlockstore } from 'blockstore-core/memory'
import { sha256 } from 'multiformats/hashes/sha2'

const ROUTING_URL = 'https://delegated-ipfs.dev/routing/v1/providers/'
const ROUTING_TIMEOUT_MS = 5000
const PROVIDER_TIMEOUT_MS = 10000
const MAX_PROVIDERS = 3
const MAX_CAR_BYTES = 50 * 1024 * 1024

const MIME = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  webmanifest: 'application/manifest+json',
  xml: 'application/xml; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  wasm: 'application/wasm',
  pdf: 'application/pdf',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
}

export function contentTypeFor(path) {
  const m = /\.([a-z0-9]+)$/i.exec(path)
  return (m && MIME[m[1].toLowerCase()]) || 'application/octet-stream'
}

function multiaddrToHttp(addr) {
  const parts = addr.split('/')
  let host = null
  let port = null
  let scheme = null
  for (let i = 1; i < parts.length; i += 2) {
    const proto = parts[i]
    const value = parts[i + 1]
    if (proto === 'dns' || proto === 'dns4' || proto === 'dns6' || proto === 'ip4' || proto === 'ip6') host = value
    else if (proto === 'tcp') port = value
    else if (proto === 'https' || proto === 'tls') scheme = 'https'
    else if (proto === 'http') scheme = scheme || 'http'
  }
  if (!host || scheme !== 'https') return null
  return port && port !== '443' ? `https://${host}:${port}` : `https://${host}`
}

export async function findProviders(cid) {
  const res = await fetch(`${ROUTING_URL}${cid}`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(ROUTING_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`routing ${res.status}`)
  const json = await res.json()
  const bases = []
  for (const p of json.Providers || []) {
    const protocols = p.Protocols || (p.Protocol ? [p.Protocol] : [])
    if (!protocols.includes('transport-ipfs-gateway-http')) continue
    for (const addr of p.Addrs || []) {
      const base = multiaddrToHttp(addr)
      if (base && !bases.includes(base)) bases.push(base)
    }
  }
  return bases.slice(0, MAX_PROVIDERS)
}

async function verifiedBlockstore(bytes) {
  const reader = CarBufferReader.fromBytes(bytes)
  const store = new MemoryBlockstore()
  for (const block of reader.blocks()) {
    const mh = block.cid.multihash
    if (mh.code === sha256.code) {
      const actual = await sha256.digest(block.bytes)
      const expected = mh.digest
      if (actual.digest.length !== expected.length || !actual.digest.every((b, i) => b === expected[i])) {
        throw new Error(`block ${block.cid} failed hash verification`)
      }
    }
    await store.put(block.cid, block.bytes)
  }
  return store
}

async function fetchEntityCar(base, cid, ipfsPath) {
  const url = `${base}/ipfs/${cid}${ipfsPath}?format=car&dag-scope=entity`
  const res = await fetch(url, {
    headers: { accept: 'application/vnd.ipld.car' },
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`${res.status}`)
  const length = Number(res.headers.get('content-length') || 0)
  if (length > MAX_CAR_BYTES) throw new Error('car too large')
  const bytes = new Uint8Array(await res.arrayBuffer())
  if (bytes.byteLength > MAX_CAR_BYTES) throw new Error('car too large')
  return bytes
}

async function readEntry(cid, ipfsPath, bytes) {
  const store = await verifiedBlockstore(bytes)
  const entry = await exporter(`${cid}${decodeURI(ipfsPath)}`, store)
  if (entry.type === 'directory') return { directory: true }
  if (entry.type !== 'file' && entry.type !== 'raw' && entry.type !== 'identity') return null
  const chunks = []
  let total = 0
  for await (const chunk of entry.content()) {
    chunks.push(chunk)
    total += chunk.byteLength
  }
  const body = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    body.set(c, offset)
    offset += c.byteLength
  }
  return { body }
}

export async function resolveFromFoc(cid, pathname, providers) {
  const errors = []
  const target = pathname.endsWith('/') ? `${pathname}index.html` : pathname
  for (const base of providers) {
    const name = new URL(base).host
    try {
      const bytes = await fetchEntityCar(base, cid, target)
      if (bytes === null) return { status: 404, provider: name }
      const result = await readEntry(cid, target, bytes)
      if (result === null) return { status: 404, provider: name }
      if (result.directory) return { redirect: `${pathname}/`, provider: name }
      return { body: result.body, contentType: contentTypeFor(target), provider: name }
    } catch (err) {
      if (err.code === 'ERR_NOT_FOUND') return { status: 404, provider: name }
      errors.push(`${name}: ${err.name === 'TimeoutError' ? 'timeout' : err.message}`)
    }
  }
  return { status: 502, errors }
}
