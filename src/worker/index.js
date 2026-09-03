import { findProviders, resolveFromFoc } from './foc.js'

const GATEWAYS = [
  { name: 'dweb.link', url: (cid, path) => `https://${cid}.ipfs.dweb.link${path}` },
  { name: 'w3s.link', url: (cid, path) => `https://${cid}.ipfs.w3s.link${path}` },
  { name: 'ipfs.io', url: (cid, path) => `https://ipfs.io/ipfs/${cid}${path}` },
]

const PER_GATEWAY_TIMEOUT_MS = 15000
const EDGE_CACHE_TTL_SECONDS = 300
const API_CACHE_TTL_SECONDS = 300
const BROWSER_CACHE_TTL_SECONDS = 300
const IMMUTABLE_CACHE_TTL_SECONDS = 31536000
const R2_MAX_OBJECT_BYTES = 50 * 1024 * 1024
const CONTENT_CACHE_ORIGIN = 'https://foc-site-cache.internal'
const FOC_DIRECT_HOSTS = new Set(['cloud.filecoincloud.io'])
const PROVIDER_CACHE_TTL_SECONDS = 600

// Per-host D1 binding. Maps a request hostname to which filbeam D1 database to query.
// Keys must cover every FOC-served host (staging + production) that needs live data.
const D1_BY_HOST = {
  // Staging (Cloudflare)
  'beam-dash.filecoincloud.io': 'D1_MAINNET',
  'beam-dash-cal.filecoincloud.io': 'D1_CALIBRATION',
  // Production (post-cutover)
  'dashboard.filbeam.com': 'D1_MAINNET',
  'calibration.dashboard.filbeam.com': 'D1_CALIBRATION',
}

// Per-host API passthrough. The worker proxies /api/* requests to the configured
// upstream, adds CORS headers, and returns the response. Used for sites whose
// backend lives on a separate origin (e.g. NestJS backend for dealbot).
const API_PROXY_BY_HOST = {
  'dealbot.filecoincloud.io': 'https://dealbot.filoz.org',
  'dealbot-staging.filecoincloud.io': 'https://staging.dealbot.filoz.org',
  'dealbot.filoz.org': 'https://dealbot.filoz.org',
  'staging.dealbot.filoz.org': 'https://staging.dealbot.filoz.org',
}

// Named queries served from /api/<name>.json. Cached at the edge.
const QUERIES = {
  'platform-stats': {
    sql: `WITH ttfb_ranked AS (
            SELECT worker_ttfb, NTILE(100) OVER (ORDER BY worker_ttfb) AS pr
            FROM retrieval_logs WHERE timestamp > DATETIME('now','-30 day')
          ),
          percentiles AS (
            SELECT
              MIN(worker_ttfb) FILTER (WHERE pr = 5)  AS worker_ttfb_p5,
              MIN(worker_ttfb) FILTER (WHERE pr = 50) AS worker_ttfb_p50,
              MIN(worker_ttfb) FILTER (WHERE pr = 95) AS worker_ttfb_p95,
              MIN(worker_ttfb) FILTER (WHERE pr = 99) AS worker_ttfb_p99
            FROM ttfb_ranked
          )
          SELECT
            SUM(CASE WHEN cache_miss THEN 1 ELSE 0 END) AS cache_miss_requests,
            SUM(CASE WHEN NOT cache_miss THEN 1 ELSE 0 END) AS cache_hit_requests,
            SUM(egress_bytes) AS total_egress_bytes,
            COUNT(*) AS total_requests,
            worker_ttfb_p5, worker_ttfb_p50, worker_ttfb_p95, worker_ttfb_p99
          FROM retrieval_logs, percentiles
          WHERE retrieval_logs.timestamp > DATETIME('now','-30 day');`,
    first: true,
  },
  'daily-requests': {
    sql: `SELECT DATE(timestamp) AS day, COUNT(id) AS total_requests
          FROM retrieval_logs WHERE DATE(timestamp) < DATE('now')
          GROUP BY day ORDER BY day;`,
  },
  'daily-egress': {
    sql: `SELECT DATE(timestamp) AS day,
            ROUND(SUM(egress_bytes) / 1073741824.0, 2) AS total_egress_gib
          FROM retrieval_logs WHERE DATE(timestamp) < DATE('now')
          GROUP BY day ORDER BY day;`,
  },
  'daily-retrieval-speed': {
    sql: `WITH retrieval_speeds AS (
            SELECT DATE(timestamp) AS day,
              (egress_bytes * 8.0) / (fetch_ttlb / 1000.0) / 1000000 AS mbps
            FROM retrieval_logs
            WHERE cache_miss = 1 AND fetch_ttlb > 0
              AND timestamp >= datetime('now','-90 days')
              AND DATE(timestamp) < DATE('now')
          ),
          pb AS (
            SELECT day, mbps, NTILE(100) OVER (ORDER BY mbps) AS bucket
            FROM retrieval_speeds
          )
          SELECT day,
            ROUND(AVG(mbps), 2) AS avg_retrieval_speed_mbps,
            (SELECT MIN(mbps) FROM pb WHERE pb.day = rs.day AND pb.bucket = 96)
              AS p95_retrieval_speed_mbps
          FROM retrieval_speeds rs
          GROUP BY day ORDER BY day;`,
  },
  'response-code-breakdown': {
    sql: `WITH daily_totals AS (
            SELECT DATE(timestamp) AS day, COUNT(*) AS total_requests
            FROM retrieval_logs WHERE DATE(timestamp) < DATE('now')
            GROUP BY day
          )
          SELECT DATE(r.timestamp) AS day, r.response_status AS code,
            (COUNT(*) * 1.0) / dt.total_requests AS rate
          FROM retrieval_logs r JOIN daily_totals dt ON DATE(r.timestamp) = dt.day
          WHERE DATE(r.timestamp) < DATE('now')
          GROUP BY day, code ORDER BY day, code;`,
  },
  'request-geodistribution': {
    sql: `SELECT request_country_code AS country, COUNT(*) AS count
          FROM retrieval_logs
          WHERE timestamp >= DATE('now','-30 days')
            AND request_country_code IS NOT NULL
            AND request_country_code != 'XX' AND request_country_code != 'T1'
          GROUP BY request_country_code ORDER BY count;`,
  },
  'storage-provider-stats': {
    sql: `WITH spr AS (
            SELECT rl.*, ds.service_provider_id, sp.service_url
            FROM retrieval_logs rl
            LEFT JOIN data_sets ds ON ds.id = rl.data_set_id
            LEFT JOIN service_providers sp ON sp.id = ds.service_provider_id
          ),
          rs AS (
            SELECT service_provider_id,
              (egress_bytes * 8.0) / (fetch_ttlb / 1000.0) / 1000000 AS mbps
            FROM spr WHERE cache_miss = 1 AND fetch_ttlb > 0
              AND timestamp >= datetime('now','-90 days')
          ),
          pb AS (
            SELECT service_provider_id, mbps,
              NTILE(100) OVER (ORDER BY mbps) AS bucket
            FROM rs
          )
          SELECT spr.service_provider_id, spr.service_url,
            SUM(CASE WHEN spr.cache_miss THEN 1 ELSE 0 END) AS cache_miss_requests,
            SUM(CASE WHEN spr.cache_miss AND spr.cache_miss_response_valid OR spr.cache_miss_response_valid IS NULL THEN spr.egress_bytes ELSE 0 END) AS cache_miss_egress_bytes,
            SUM(CASE WHEN spr.cache_miss AND spr.cache_miss_response_valid = 0 THEN spr.egress_bytes ELSE 0 END) AS cache_miss_egress_invalid_bytes,
            AVG(CASE WHEN spr.cache_miss THEN spr.fetch_ttfb ELSE NULL END) AS avg_ttfb,
            ROUND(AVG(CASE WHEN spr.cache_miss THEN (spr.egress_bytes * 8.0)/(spr.fetch_ttlb/1000.0)/1000000 ELSE NULL END), 2) AS avg_cache_miss_retrieval_speed_mbps,
            (SELECT MIN(pb.mbps) FROM pb WHERE pb.service_provider_id = spr.service_provider_id AND pb.bucket = 96) AS p95_cache_miss_retrieval_speed_mbps,
            ROUND(100.0 * SUM(CASE WHEN spr.cache_miss AND spr.response_status = 200 THEN 1 ELSE 0 END)
                  / NULLIF(SUM(CASE WHEN spr.cache_miss THEN 1 ELSE 0 END), 0), 2) AS cache_miss_rsr
          FROM spr
          GROUP BY spr.service_provider_id
          ORDER BY cache_miss_requests DESC;`,
  },
  'client-stats': {
    sql: `WITH client_stats AS (
            SELECT cs.payer_address,
              COUNT(rl.id) AS total_requests,
              SUM(CASE WHEN rl.cache_miss THEN 1 ELSE 0 END) AS cache_miss_requests,
              SUM(rl.egress_bytes) AS total_egress_bytes,
              SUM(CASE WHEN rl.cache_miss AND (rl.cache_miss_response_valid OR rl.cache_miss_response_valid IS NULL) THEN rl.egress_bytes ELSE 0 END) AS cache_miss_egress_bytes
            FROM retrieval_logs rl JOIN data_sets cs ON cs.id = rl.data_set_id
            GROUP BY cs.payer_address
          ),
          client_quotas AS (
            SELECT cs.payer_address,
              SUM(cseqs.cdn_egress_quota) AS remaining_cdn_egress_bytes,
              SUM(cseqs.cache_miss_egress_quota) AS remaining_cache_miss_egress_bytes
            FROM data_sets cs JOIN data_set_egress_quotas cseqs ON cs.id = cseqs.data_set_id
            GROUP BY cs.payer_address
          )
          SELECT cs.*, cq.remaining_cdn_egress_bytes, cq.remaining_cache_miss_egress_bytes
          FROM client_stats cs LEFT JOIN client_quotas cq ON cs.payer_address = cq.payer_address
          ORDER BY cs.total_requests DESC;`,
  },
  'clients': {
    sql: `SELECT DISTINCT payer_address FROM data_sets
          WHERE with_cdn = true ORDER BY payer_address;`,
  },
  'client-daily': {
    sql: `SELECT DATE(rl.timestamp) AS day, ds.payer_address,
            COUNT(rl.id) AS total_requests,
            ROUND(SUM(rl.egress_bytes) / 1073741824.0, 2) AS total_egress_gib,
            SUM(CASE WHEN rl.cache_miss = 1 THEN 1 ELSE 0 END) AS cache_miss_requests,
            SUM(CASE WHEN rl.cache_miss = 0 THEN 1 ELSE 0 END) AS cache_hit_requests
          FROM retrieval_logs rl JOIN data_sets ds ON rl.data_set_id = ds.id
          WHERE ds.payer_address = ?1 AND day < DATE('now')
          GROUP BY day, ds.payer_address ORDER BY day DESC;`,
    params: 1,
  },
  'client-proof-sets': {
    sql: `SELECT ds.id AS data_set_id,
            COUNT(rl.id) AS total_requests,
            SUM(rl.egress_bytes) AS total_egress_used,
            SUM(CASE WHEN rl.cache_miss = 1 THEN 1 ELSE 0 END) AS cache_miss_requests,
            SUM(CASE WHEN rl.cache_miss = 0 THEN 1 ELSE 0 END) AS cache_hit_requests,
            dseqs.cdn_egress_quota, dseqs.cache_miss_egress_quota
          FROM data_sets ds
          LEFT JOIN retrieval_logs rl ON rl.data_set_id = ds.id
          JOIN data_set_egress_quotas dseqs ON ds.id = dseqs.data_set_id
          WHERE ds.payer_address = ?1 AND ds.with_cdn = 1
            AND (rl.timestamp IS NULL OR DATE(rl.timestamp) < DATE('now'))
          GROUP BY ds.id ORDER BY total_requests DESC;`,
    params: 1,
  },
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    const host = url.hostname
    const path = url.pathname

    if (path.startsWith('/api/')) {
      return handleApi(request, env, ctx, host, path, url.searchParams)
    }
    return handleIpfs(request, env, ctx, host, url.pathname, url.search)
  },
}

async function handleApi(request, env, ctx, host, path, search) {
  const proxyBase = API_PROXY_BY_HOST[host]
  if (proxyBase) {
    return proxyApi(request, ctx, proxyBase, path, search)
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405 })
  }

  const dbKey = D1_BY_HOST[host]
  if (!dbKey) {
    return new Response(`No D1 binding for host ${host}`, { status: 404 })
  }
  const dbId = env[dbKey]
  if (!dbId) {
    return new Response(`Missing Worker secret ${dbKey}`, { status: 500 })
  }

  // Routes:
  //   /api/<query>.json           — single query with no params
  //   /api/client/<addr>.json     — two-query bundle (daily + proof sets)
  let queryName, params
  if (path.startsWith('/api/client/') && path.endsWith('.json')) {
    const addr = path.slice('/api/client/'.length, -'.json'.length).toLowerCase()
    if (!/^0x[0-9a-f]{40}$/.test(addr)) {
      return new Response('invalid client address', { status: 400 })
    }
    return await serveClientBundle(request, env, ctx, dbId, addr)
  }

  const m = path.match(/^\/api\/([a-z-]+)\.json$/)
  if (!m) return new Response('not found', { status: 404 })
  queryName = m[1]
  const q = QUERIES[queryName]
  if (!q) return new Response('unknown query', { status: 404 })
  if (q.params) {
    return new Response('query requires params not in path', { status: 400 })
  }

  return cacheWrap(request, ctx, () => runD1(env, dbId, q, []))
}

async function serveClientBundle(request, env, ctx, dbId, addr) {
  return cacheWrap(request, ctx, async () => {
    const [daily, proofSets] = await Promise.all([
      runD1Raw(env, dbId, QUERIES['client-daily'], [addr]),
      runD1Raw(env, dbId, QUERIES['client-proof-sets'], [addr]),
    ])
    return new Response(JSON.stringify({ daily, proofSets }), {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': `public, max-age=${API_CACHE_TTL_SECONDS}`,
      },
    })
  })
}

async function runD1(env, dbId, q, params) {
  const rows = await runD1Raw(env, dbId, q, params)
  const body = JSON.stringify(q.first ? rows[0] ?? null : rows)
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': `public, max-age=${API_CACHE_TTL_SECONDS}`,
    },
  })
}

async function runD1Raw(env, dbId, q, params) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${env.FILBEAM_ACCOUNT_ID}/d1/database/${dbId}/query`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.FILBEAM_D1_TOKEN}`,
    },
    body: JSON.stringify({ sql: q.sql, params }),
    cf: { cacheTtl: 60, cacheEverything: true },
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`D1 ${res.status}: ${text}`)
  }
  const json = await res.json()
  return json.result[0].results
}

async function proxyApi(request, ctx, upstreamBase, path, search) {
  const upstream = `${upstreamBase}${path}${search.toString() ? `?${search}` : ''}`

  const reqHeaders = new Headers()
  for (const [k, v] of request.headers) {
    const kl = k.toLowerCase()
    if (kl === 'host' || kl === 'cf-connecting-ip' || kl.startsWith('cf-') || kl === 'x-forwarded-host') continue
    reqHeaders.set(k, v)
  }

  const upstreamReq = new Request(upstream, {
    method: request.method,
    headers: reqHeaders,
    body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : undefined,
    redirect: 'follow',
  })

  let upstreamRes
  try {
    upstreamRes = await fetch(upstreamReq, { cf: { cacheTtl: 30, cacheEverything: false } })
  } catch (err) {
    return new Response(`upstream API error: ${err.message}`, {
      status: 502,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'access-control-allow-origin': '*' },
    })
  }

  const resHeaders = new Headers()
  for (const [k, v] of upstreamRes.headers) {
    const kl = k.toLowerCase()
    if (kl === 'access-control-allow-origin' || kl === 'access-control-allow-credentials' || kl === 'access-control-allow-methods' || kl === 'access-control-allow-headers' || kl === 'set-cookie' || kl === 'server' || kl === 'cf-ray') continue
    resHeaders.set(k, v)
  }
  resHeaders.set('access-control-allow-origin', '*')
  resHeaders.set('access-control-allow-methods', 'GET, HEAD, POST, OPTIONS')
  resHeaders.set('access-control-allow-headers', 'content-type, authorization')

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: resHeaders })
  }

  return new Response(upstreamRes.body, {
    status: upstreamRes.status,
    statusText: upstreamRes.statusText,
    headers: resHeaders,
  })
}

async function cacheWrap(request, ctx, fn) {
  const cache = caches.default
  const key = new Request(request.url, request)
  const cached = await cache.match(key)
  if (cached) {
    const res = new Response(cached.body, cached)
    res.headers.set('x-foc-cache', 'HIT')
    return res
  }
  try {
    const res = await fn()
    res.headers.set('x-foc-cache', 'MISS')
    if (res.ok && request.method === 'GET') {
      ctx.waitUntil(cache.put(key, res.clone()))
    }
    return res
  } catch (err) {
    return new Response(`upstream error: ${err.message}`, {
      status: 502,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    })
  }
}

async function handleIpfs(request, env, ctx, host, pathname, search) {
  const cid = await env.CIDS.get(host)
  if (!cid) {
    return new Response(`No CID registered for ${host}`, { status: 404 })
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405 })
  }

  const isHead = request.method === 'HEAD'
  const isRange = request.headers.has('range')
  const contentKey = `${cid}${pathname}`
  const cache = caches.default
  const cacheKey = new Request(`${CONTENT_CACHE_ORIGIN}/${contentKey}`)

  if (!isRange) {
    const cached = await cache.match(cacheKey)
    if (cached) {
      return contentResponse(cached.body, cached.headers, cached.status, cid, 'HIT', isHead)
    }
  }

  const bucket = env.SITE_CACHE
  let staleObject = null
  if (bucket) {
    let object = null
    try {
      object = isHead
        ? await bucket.head(contentKey)
        : await bucket.get(contentKey, isRange ? { range: request.headers } : undefined)
    } catch (err) {
      object = null
    }
    const source = object && object.customMetadata ? object.customMetadata.source : undefined
    const preferFoc = FOC_DIRECT_HOSTS.has(host) && !isRange && !(source && source.startsWith('foc:'))
    if (object && preferFoc) staleObject = object
    if (object && !preferFoc) {
      return r2Response(object, cache, cacheKey, ctx, cid, isHead, isRange)
    }
  }

  const errors = []
  if (FOC_DIRECT_HOSTS.has(host) && !isRange) {
    try {
      const providers = await cachedProviders(cache, ctx, cid)
      const result = await resolveFromFoc(cid, pathname, providers)
      if (staleObject && staleObject.body && (result.body || result.redirect || result.status === 404)) ctx.waitUntil(staleObject.body.cancel())
      if (result.redirect) {
        return Response.redirect(new URL(result.redirect + search, request.url).toString(), 301)
      }
      if (result.body) {
        const headers = new Headers({ 'content-type': result.contentType, 'content-length': String(result.body.byteLength) })
        headers.set('x-foc-gateway', `foc:${result.provider}`)
        headers.set('x-foc-cid', cid)
        headers.set('x-foc-cache', 'MISS')
        headers.set('cache-control', `public, max-age=${BROWSER_CACHE_TTL_SECONDS}`)
        const response = new Response(isHead ? null : result.body, { status: 200, headers })
        if (!isHead) {
          ctx.waitUntil(persistContent(bucket, cache, contentKey, cacheKey, new Response(result.body, { headers }), cid, `foc:${result.provider}`))
        }
        return response
      }
      if (result.status === 404) {
        return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'x-foc-gateway': `foc:${result.provider}`, 'x-foc-cid': cid } })
      }
      errors.push(...(result.errors || ['foc: no providers']))
    } catch (err) {
      errors.push(`foc: ${err.message}`)
    }
  }
  if (staleObject) {
    return r2Response(staleObject, cache, cacheKey, ctx, cid, isHead, isRange)
  }
  for (const gw of GATEWAYS) {
    try {
      const upstream = gw.url(cid, pathname + search)
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), PER_GATEWAY_TIMEOUT_MS)

      const upstreamReq = new Request(upstream, {
        method: request.method,
        headers: filterRequestHeaders(request.headers),
        signal: controller.signal,
        redirect: 'follow',
      })

      const upstreamRes = await fetch(upstreamReq, { cf: { cacheTtl: EDGE_CACHE_TTL_SECONDS, cacheEverything: true } })
      clearTimeout(timeoutId)

      if (upstreamRes.status >= 500 || upstreamRes.status === 408 || upstreamRes.status === 429) {
        errors.push(`${gw.name}: ${upstreamRes.status}`)
        continue
      }

      const response = new Response(upstreamRes.body, {
        status: upstreamRes.status,
        statusText: upstreamRes.statusText,
        headers: filterResponseHeaders(upstreamRes.headers),
      })
      response.headers.set('x-foc-gateway', gw.name)
      response.headers.set('x-foc-cid', cid)
      response.headers.set('x-foc-cache', 'MISS')
      response.headers.set('cache-control', `public, max-age=${BROWSER_CACHE_TTL_SECONDS}`)

      if (upstreamRes.status === 200 && !isHead && !isRange) {
        ctx.waitUntil(persistContent(bucket, cache, contentKey, cacheKey, response.clone(), cid, gw.name))
      }

      return response
    } catch (err) {
      errors.push(`${gw.name}: ${err.name === 'AbortError' ? 'timeout' : err.message}`)
    }
  }

  return new Response(`All IPFS gateways failed for CID ${cid}\n\n${errors.join('\n')}`, {
    status: 502,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  })
}

function r2Response(object, cache, cacheKey, ctx, cid, isHead, isRange) {
  const headers = new Headers()
  object.writeHttpMetadata(headers)
  headers.set('etag', object.httpEtag)
  headers.set('accept-ranges', 'bytes')
  headers.set('x-foc-gateway', 'r2')
  let status = 200
  let body = isHead ? null : object.body
  if (isRange && object.range) {
    const start = object.range.offset ?? object.size - object.range.suffix
    const length = object.range.length ?? object.size - start
    headers.set('content-range', `bytes ${start}-${start + length - 1}/${object.size}`)
    headers.set('content-length', String(length))
    status = 206
  } else {
    headers.set('content-length', String(object.size))
    if (!isHead) {
      const [toClient, toCache] = object.body.tee()
      body = toClient
      ctx.waitUntil(cache.put(cacheKey, immutableResponse(toCache, headers, cid)))
    }
  }
  return contentResponse(body, headers, status, cid, 'R2', isHead)
}

async function cachedProviders(cache, ctx, cid) {
  const key = new Request(`${CONTENT_CACHE_ORIGIN}/__providers/${cid}`)
  const cached = await cache.match(key)
  if (cached) return cached.json()
  const providers = await findProviders(cid)
  if (providers.length > 0) {
    ctx.waitUntil(cache.put(key, new Response(JSON.stringify(providers), {
      headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${PROVIDER_CACHE_TTL_SECONDS}` },
    })))
  }
  return providers
}

function contentResponse(body, sourceHeaders, status, cid, cacheState, isHead) {
  const headers = new Headers(sourceHeaders)
  headers.set('x-foc-cid', cid)
  headers.set('x-foc-cache', cacheState)
  headers.set('cache-control', `public, max-age=${BROWSER_CACHE_TTL_SECONDS}`)
  return new Response(isHead ? null : body, { status, headers })
}

function immutableResponse(body, sourceHeaders, cid) {
  const headers = new Headers(sourceHeaders)
  headers.set('x-foc-cid', cid)
  headers.set('cache-control', `public, max-age=${IMMUTABLE_CACHE_TTL_SECONDS}, immutable`)
  return new Response(body, { status: 200, headers })
}

async function persistContent(bucket, cache, contentKey, cacheKey, res, cid, gatewayName) {
  const body = await res.arrayBuffer()
  const contentType = res.headers.get('content-type') || 'application/octet-stream'
  const headers = new Headers({
    'content-type': contentType,
    'content-length': String(body.byteLength),
    'x-foc-gateway': gatewayName,
  })
  const writes = [cache.put(cacheKey, immutableResponse(body, headers, cid))]
  if (bucket && body.byteLength <= R2_MAX_OBJECT_BYTES) {
    writes.push(bucket.put(contentKey, body, { httpMetadata: { contentType }, customMetadata: { source: gatewayName } }))
  }
  await Promise.all(writes)
}

function filterRequestHeaders(headers) {
  const out = new Headers()
  const keep = ['accept', 'accept-encoding', 'accept-language', 'range', 'if-none-match', 'if-modified-since', 'user-agent']
  for (const [k, v] of headers) {
    if (keep.includes(k.toLowerCase())) out.set(k, v)
  }
  return out
}

function filterResponseHeaders(headers) {
  const out = new Headers()
  const drop = [
    'set-cookie',
    'x-ipfs-path',
    'x-ipfs-roots',
    'x-ipfs-pop',
    'server',
    'cf-ray',
    'nel',
    'report-to',
    'expect-ct',
    'alt-svc',
  ]
  for (const [k, v] of headers) {
    if (!drop.includes(k.toLowerCase())) out.set(k, v)
  }
  return out
}
