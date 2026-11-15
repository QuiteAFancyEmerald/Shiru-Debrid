import { DebridError, DebridProvider, buildMagnetUri, normalizeInfoHash } from './base.js'

/** @typedef {import('../types.d.ts').DebridProviderMeta} DebridProviderMeta */
/** @typedef {import('../types.d.ts').DebridAccountInfo} DebridAccountInfo */
/** @typedef {import('../types.d.ts').DebridCacheEntry} DebridCacheEntry */
/** @typedef {import('../types.d.ts').DebridResolvedTorrent} DebridResolvedTorrent */

const API_BASE = 'https://api.real-debrid.com'
const POLL_INTERVAL_MS = 3_000
const MAX_POLL_WAIT_MS = 10 * 60_000

const READY_STATUS_CODES = new Set([4, 7, 10])
const FAILED_STATUS_CODES = new Set([5, 8, -1, -2, -3, -4, -5, -6, -7, -8, -9, -10])

const UPLOAD_ERROR_MESSAGES = {
  bad_token: 'The Real-Debrid API token is invalid.',
  magnet_invalid_url: 'Real-Debrid rejected this magnet as invalid.',
  magnet_too_big: 'This torrent is too large for Real-Debrid.',
  magnet_must_be_premium: 'A Real-Debrid premium subscription is required for magnets.',
  not_available: 'Real-Debrid could not resolve this link (it may be dead or region-blocked).'
}

/**
 * Flattens a Real-Debrid `torrents/info` response into resolved files.
 * Real-Debrid carries real per-file IDs, so lookup by ID is exact.
 *
 * @param {Record<string, any>} infoTorrent
 * @returns {{ id: number, name: string, path: string, length: number, link?: string }[]}
 */
function mapTorrentFiles(infoTorrent) {
  const files = Array.isArray(infoTorrent?.files) ? infoTorrent.files : []
  return files.map((file, idx) => {
    const rawPath = String(file.filename || file.original_filename || `file_${idx}`).replace(/^\/+/, '')
    const name = rawPath.split('/').pop() || rawPath
    return {
      id: file.id ?? idx,
      name,
      path: rawPath,
      length: Number(file.filesize) || 0
    }
  })
}

export class RealDebridProvider extends DebridProvider {
  /** @type {DebridProviderMeta} */
  static meta = {
    id: 'realdebrid',
    name: 'Real-Debrid',
    shortName: 'RD',
    description: 'Premium link and torrent debrid with high-speed cached streaming across a large host network.',
    website: 'https://real-debrid.com',
    apiKeyUrl: 'https://real-debrid.com/api-tokens',
    accentColor: '#F3124C',
    capabilities: {
      cacheCheck: true,
      userLibrary: true,
      supportsTorrentFile: true,
      supportsMagnet: true,
      supportsUncached: true
    },
    settingsSchema: []
  }

  /**
   * Performs an authenticated request against the Real-Debrid API (v1).
   *
   * Real-Debrid responds `{ error, error_description }` on failure.
   *
   * @param {string} endpoint
   * @param {Record<string, any>} config
   * @param {Omit<import('../types.d.ts').DebridRequestOptions, 'url'>} [options]
   * @returns {Promise<any>}
   */
  async api(endpoint, config, options = {}) {
    const apiKey = config?.apiKey?.trim()
    if (!apiKey) {
      throw new DebridError('Real-Debrid API token is not configured.', { code: 'MISSING_API_KEY', providerId: this.id })
    }
    const response = await this.request(`${API_BASE}${endpoint}`, {
      ...options,
      headers: { Authorization: `Bearer ${apiKey}`, ...(options.headers || {}) },
      responseType: options.responseType || 'json',
      method: options.method || 'GET'
    })
    const payload = response.data
    const errorCode = payload?.error
    if (!response.ok || errorCode) {
      const description = payload?.error_description || payload?.detail || response.statusText || 'Real-Debrid API request failed'
      const normalizedCode = errorCode === 'bad_token' || errorCode === 'bad_login' || errorCode === 'token_missing'
        ? 'INVALID_API_KEY'
        : response.status === 429 || errorCode === 'rate_limit_exceeded'
          ? 'RATE_LIMIT'
          : errorCode === 'not_available'
            ? 'NOT_AVAILABLE'
            : String(errorCode || `HTTP_${response.status}`)
      throw new DebridError(description, {
        code: normalizedCode,
        status: response.status,
        providerId: this.id,
        retryable: response.status >= 500 || response.status === 429
      })
    }
    return payload
  }

  /**
   * Sends form-encoded POST parameters.
   *
   * @param {Record<string, string | number | string[]>} params
   * @returns {{ body: string, headers: Record<string, string> }}
   */
  static form(params) {
    const search = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) {
      for (const entry of Array.isArray(value) ? value : [value]) {
        search.append(key, String(entry))
      }
    }
    return {
      body: search.toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    }
  }

  /**
   * @param {Record<string, any>} config
   * @returns {Promise<DebridAccountInfo>}
   */
  async verifyCredentials(config) {
    const user = await this.api('/user', config, { method: 'GET' })
    if (!user?.username && !user?.email) {
      throw new DebridError('Real-Debrid did not return user information.', { code: 'INVALID_RESPONSE', providerId: this.id })
    }
    const isPremium = String(user.type).toLowerCase() === 'premium' || Boolean(user.premium)
    return {
      authenticated: true,
      email: user.email || undefined,
      username: user.username || user.email?.split('@')[0] || undefined,
      plan: isPremium ? 'Premium' : String(user.type || 'Free'),
      isSubscribed: Boolean(user.premium),
      expiresAt: user.expiration ? Date.parse(user.expiration) || null : null,
      raw: user
    }
  }

  /**
   * Hash-only instant availability: Real-Debrid exposes
   * `/torrents/instantAvailability/{hash}` without uploading a magnet.
   *
   * @param {string[]} hashes
   * @param {Record<string, any>} config
   * @returns {Promise<Record<string, DebridCacheEntry>>}
   */
  async checkCached(hashes, config) {
    const normalized = [...new Set(hashes.map(hash => normalizeInfoHash(hash)).filter(Boolean))]
    /** @type {Record<string, DebridCacheEntry>} */
    const results = {}
    for (const hash of normalized) {
      results[hash] = { hash, cached: false, providerId: this.id, providerName: this.name }
    }
    if (!normalized.length || !config?.apiKey?.trim()) return results

    for (const hash of normalized) {
      const data = await this.api(`/torrents/instantAvailability/${hash}`, config, { method: 'GET' })
      const variants = data?.[hash]
      let variant = null
      if (Array.isArray(variants) && variants.length) {
        variant = variants.find(candidate => (candidate?.files || []).length) || variants[0]
      } else if (variants && typeof variants === 'object') {
        const values = Object.values(variants)
        variant = values.find(candidate => (candidate?.files || []).length) || values[0]
      }
      const files = (variant?.files || []).map(file => ({ id: file.id, name: file.filename, size: file.filesize }))
      if (files.length) {
        results[hash] = {
          hash,
          cached: true,
          providerId: this.id,
          providerName: this.name,
          name: variant?.filename || files[0]?.name,
          size: Number(variant?.filesize) || 0,
          files
        }
      }
    }
    return results
  }

  /**
   * Fetches the full torrent info (files, links, status) for a stored torrent.
   *
   * @param {string | number} torrentId
   * @param {Record<string, any>} config
   * @param {AbortSignal} [signal]
   * @returns {Promise<Record<string, any>>}
   */
  async getTorrentInfo(torrentId, config, signal) {
    return this.api(`/torrents/info/${torrentId}`, config, { method: 'GET', signal })
  }

  /**
   * @param {{
   *   infoHash?: string | null,
   *   magnet?: string | null,
   *   name?: string,
   *   torrentBytes?: Uint8Array | null,
   *   allowUncached?: boolean,
   *   onProgress?: (info: { status: string, progress: number, name?: string }) => void,
   *   signal?: AbortSignal
   * }} input
   * @param {Record<string, any>} config
   * @returns {Promise<DebridResolvedTorrent>}
   */
  async resolveTorrent(input, config) {
    const { magnet, name, torrentBytes, allowUncached = false, onProgress, signal } = input
    const normalizedHash = normalizeInfoHash(input.infoHash || magnet)
    const safeName = (name || normalizedHash || 'torrent').replace(/[^\w.-]+/g, '_')

    // 1) Upload: magnet URI, raw hash, or .torrent file.
    let uploaded
    if (torrentBytes instanceof Uint8Array && torrentBytes.byteLength > 0) {
      let binary = ''
      for (let i = 0; i < torrentBytes.length; i++) binary += String.fromCharCode(torrentBytes[i])
      await this.api('/torrents/upload/file', config, {
        body: {
          __formData: [{
            name: 'file',
            value: btoa(binary),
            encoding: 'base64',
            filename: `${safeName}.torrent`,
            contentType: 'application/x-bittorrent'
          }]
        },
        signal
      })
      // Real-Debrid does not echo the torrent ID on file upload: locate it by hash.
      if (!normalizedHash) {
        throw new DebridError('Real-Debrid file uploads require an info-hash to track the torrent.', {
          code: 'INVALID_TORRENT',
          providerId: this.id
        })
      }
      const list = await this.api('/torrents', config, { method: 'GET', signal })
      uploaded = (Array.isArray(list) ? list : []).find(torrent => normalizeInfoHash(torrent?.hash) === normalizedHash) || null
    } else {
      const magnetUri = magnet && magnet.startsWith('magnet:')
        ? magnet
        : normalizedHash
          ? buildMagnetUri(normalizedHash, name)
          : ''
      if (!magnetUri && !normalizedHash) {
        throw new DebridError('Missing magnet URI, info-hash, or .torrent payload for Real-Debrid.', {
          code: 'INVALID_TORRENT',
          providerId: this.id
        })
      }
      const form = RealDebridProvider.form({ magnet: magnetUri || normalizedHash })
      uploaded = await this.api('/torrents/addMagnet', config, { ...form, signal })
    }
    const torrentId = Number(uploaded?.id)
    if (!torrentId) {
      throw new DebridError(uploadError(uploaded?.error) || 'Real-Debrid returned no torrent ID.', {
        code: 'INVALID_RESPONSE',
        providerId: this.id
      })
    }

    // 2) Smart mode: fail fast for torrents the provider does not already hold.
    const wasInstant = Boolean(uploaded?.ready)
    if (!wasInstant && !allowUncached) {
      await this.removeTorrent(torrentId, config)
      throw new DebridError('Torrent is not cached on Real-Debrid.', { code: 'NOT_CACHED', providerId: this.id })
    }

    // 2) Select all files so the cloud download starts.
    if (uploaded?.statusCode === 0 || uploaded?.statusCode === 1 || uploaded?.statusCode === 2) {
      const form = RealDebridProvider.form({ files: 'all' })
      await this.api(`/torrents/selectFiles/${torrentId}`, config, { ...form, signal })
    }

    // 3) Wait until the torrent is ready to stream.
    const infoTorrent = await this.waitForReady(torrentId, config, { name, onProgress, signal })

    // 4) Files and per-file Real-Debrid links.
    const rawFiles = mapTorrentFiles(infoTorrent)
    const links = Array.isArray(infoTorrent?.links) ? infoTorrent.links : []
    if (!rawFiles.length) {
      throw new DebridError('Real-Debrid torrent contains no streamable files.', { code: 'NO_FILES', providerId: this.id })
    }

    const resolvedHash = normalizeInfoHash(infoTorrent?.hash) || normalizedHash || `rd-${torrentId}`
    return {
      providerId: this.id,
      providerName: this.name,
      torrentId,
      infoHash: resolvedHash,
      name: infoTorrent?.filename || name || safeName,
      cached: wasInstant || uploadsReady(infoTorrent),
      status: 'ready',
      progress: 100,
      files: rawFiles.map((file, index) => ({
        id: file.id,
        name: file.name,
        path: file.path,
        length: file.length,
        link: links[index] || ''
      }))
    }
  }

  /**
   * Waits until a stored torrent reaches a streamable state.
   *
   * @param {string | number} torrentId
   * @param {Record<string, any>} config
   * @param {{ name?: string, onProgress?: (info: { status: string, progress: number, name?: string }) => void, signal?: AbortSignal }} [opts]
   * @returns {Promise<Record<string, any>>}
   */
  async waitForReady(torrentId, config, { name, onProgress, signal } = {}) {
    const startedAt = Date.now()
    for (;;) {
      const infoTorrent = await this.getTorrentInfo(torrentId, config, signal)
      const statusCode = Number(infoTorrent?.statusCode)
      if (READY_STATUS_CODES.has(statusCode)) return infoTorrent
      if (FAILED_STATUS_CODES.has(statusCode)) {
        throw new DebridError(`Real-Debrid could not process this torrent (status ${statusCode ?? 'unknown'}).`, {
          code: 'DOWNLOAD_FAILED',
          providerId: this.id
        })
      }
      onProgress?.({
        status: infoTorrent?.status || 'downloading',
        progress: Math.max(0, Math.min(100, Math.round(Number(infoTorrent?.progress) || 0))),
        name: infoTorrent?.filename || name
      })
      if (Date.now() - startedAt > MAX_POLL_WAIT_MS) {
        throw new DebridError('Timed out waiting for Real-Debrid to finish processing the torrent.', { code: 'TIMEOUT', providerId: this.id })
      }
      await new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(new DebridError('Aborted while waiting for Real-Debrid', { code: 'ABORTED', providerId: this.id }))
        const timer = setTimeout(() => {
          signal?.removeEventListener('abort', onAbort)
          resolve()
        }, POLL_INTERVAL_MS)
        const onAbort = () => {
          clearTimeout(timer)
          reject(new DebridError('Aborted while waiting for Real-Debrid', { code: 'ABORTED', providerId: this.id }))
        }
        signal?.addEventListener('abort', onAbort, { once: true })
      })
    }
  }

  /**
   * Unrestricts a Real-Debrid link into a direct, resumable stream URL.
   *
   * @param {{ torrentId: string | number, fileId: string | number, infoHash?: string, signal?: AbortSignal }} fileRef
   * @param {Record<string, any>} config
   * @returns {Promise<{ url: string, headers?: Record<string, string> }>}
   */
  async getFileStreamUrl({ torrentId, fileId, signal }, config) {
    const infoTorrent = await this.getTorrentInfo(torrentId, config, signal)
    const files = Array.isArray(infoTorrent?.files) ? infoTorrent.files : []
    const links = Array.isArray(infoTorrent?.links) ? infoTorrent.links : []
    const index = files.findIndex(file => String(file?.id) === String(fileId))
    let link = index >= 0 ? links[index] || '' : ''
    if (!link && files.length && files.length === links.length) {
      // Positional fallback: files and links are usually index-aligned.
      const position = Number(fileId) || 0
      if (position >= 0 && position < links.length) {
        link = links[position] || ''
      }
    }
    if (!link) {
      throw new DebridError(`Real-Debrid returned no streamable link for file ${fileId} of torrent ${torrentId}.`, {
        code: 'NO_STREAM_URL',
        providerId: this.id
      })
    }
    return this.unrestrictLink(link, signal, config)
  }

  /**
   * @param {string} link
   * @param {AbortSignal} [signal]
   * @param {Record<string, any>} config
   * @returns {Promise<{ url: string }>}
   */
  async unrestrictLink(link, signal, config) {
    const form = RealDebridProvider.form({ link })
    const data = await this.api('/unrestrict/link', config, { ...form, signal })
    const url = data?.download
    if (!url || typeof url !== 'string') {
      throw new DebridError('Real-Debrid did not return a valid stream URL.', { code: 'NO_STREAM_URL', providerId: this.id })
    }
    return { url }
  }

  /**
   * @param {string | number} torrentId
   * @param {Record<string, any>} config
   * @returns {Promise<void>}
   */
  async removeTorrent(torrentId, config) {
    await this.api(`/torrents/delete/${torrentId}`, config, { method: 'DELETE' })
  }
}

/**
 * @param {any} torrent
 * @returns {boolean}
 */
function uploadsReady(torrent) {
  const statusCode = Number(torrent?.statusCode)
  return READY_STATUS_CODES.has(statusCode) || Number(torrent?.progress) >= 100
}

/**
 * @param {any} error
 * @returns {string}
 */
function uploadError(error) {
  if (!error) return ''
  if (error?.code === 'magnet_must_be_premium' || error?.code === 'magnet_error' || error?.code === 'magnet_too_big') {
    return UPLOAD_ERROR_MESSAGES[error.code] || error.error_description || ''
  }
  return ''
}
