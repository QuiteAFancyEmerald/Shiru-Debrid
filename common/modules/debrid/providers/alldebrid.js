import { DebridError, DebridProvider, buildMagnetUri, normalizeInfoHash } from './base.js'

/** @typedef {import('../types.d.ts').DebridProviderMeta} DebridProviderMeta */
/** @typedef {import('../types.d.ts').DebridAccountInfo} DebridAccountInfo */
/** @typedef {import('../types.d.ts').DebridCacheEntry} DebridCacheEntry */
/** @typedef {import('../types.d.ts').DebridResolvedTorrent} DebridResolvedTorrent */

const API_BASE = 'https://api.alldebrid.com/v4'
const POLL_INTERVAL_MS = 3_000
const MAX_POLL_WAIT_MS = 10 * 60_000
const UNLOCK_POLL_INTERVAL_MS = 5_000
const MAX_UNLOCK_WAIT_MS = 5 * 60_000

const READY_STATUS_CODE = 4

const FAILED_STATUS_CODES = new Set([
  5, // Upload fail
  6, // Internal error on unpacking
  7, // Not downloaded in 20 min
  8, // File too big
  9, // Internal error
  10, // Download took more than 72h
  11, // Deleted on the hoster website
  12, // Processing failed
  13, // Processing failed
  14, // Error while contacting tracker
  15 // File not available - no peer
])

const UPLOAD_ERROR_MESSAGES = {
  MAGNET_TOO_MANY_ACTIVE: 'AllDebrid active magnet limit (30) reached. Remove some magnets at alldebrid.com and try again.',
  MAGNET_NO_SERVER: 'AllDebrid is not allowing this server to process magnets. Check your VPN allowance at alldebrid.com/vpn.',
  MAGNET_MUST_BE_PREMIUM: 'An AllDebrid premium subscription is required to process magnets.',
  MAGNET_INVALID_URI: 'AllDebrid rejected this magnet as invalid.',
  MAGNET_NO_URI: 'No magnet was provided to AllDebrid.'
}

/**
 * Flattens an AllDebrid magnet file tree (`{n, s, l, e}` nodes) into a
 * deterministic ordered file list. Sequential IDs are shared between
 * resolveTorrent() and getFileStreamUrl(), so the traversal order must never change.
 *
 * @param {Record<string, any>[]} nodes
 * @param {string} dirPath
 * @param {{ id: number }[]} list
 * @param {{ counter: number }} counter
 */
function flattenTree(nodes, dirPath, list, counter) {
  for (const node of nodes || []) {
    if (Array.isArray(node.e)) {
      flattenTree(node.e, `${dirPath}${node.n || ''}/`, list, counter)
    } else {
      const name = node.n || `file_${counter.counter}`
      list.push({
        id: counter.counter++,
        name,
        path: `${dirPath}${name}`,
        length: Number(node.s) || 0,
        link: node.l || ''
      })
    }
  }
  return list
}

/**
 * Converts an AllDebrid file tree into the generic resolved-file shape.
 *
 * @param {Record<string, any>[]} tree
 * @returns {{ id: number, name: string, path: string, length: number, streamUrl?: string }[]}
 */
export class AllDebridProvider extends DebridProvider {
  /** @type {DebridProviderMeta} */
  static meta = {
    id: 'alldebrid',
    name: 'AllDebrid',
    shortName: 'AD',
    description: 'Premium link and torrent debrid with instant cached-streaming and cloud magnet hosting.',
    website: 'https://alldebrid.com',
    apiKeyUrl: 'https://alldebrid.com/apikeys',
    accentColor: '#2C9BF0',
    capabilities: {
      cacheCheck: false,
      userLibrary: true,
      supportsTorrentFile: true,
      supportsMagnet: true,
      supportsUncached: true
    },
    settingsSchema: []
  }

  /**
   * Performs an authenticated request against the AllDebrid v4 API.
   *
   * AllDebrid responds `{ status: 'error', error: { code, message } }` on failure.
   *
   * @param {string} endpoint
   * @param {Record<string, any>} config
   * @param {Omit<import('../types.d.ts').DebridRequestOptions, 'url'>} [options]
   * @returns {Promise<any>}
   */
  async api(endpoint, config, options = {}) {
    const apiKey = config?.apiKey?.trim()
    if (!apiKey) {
      throw new DebridError('AllDebrid API key is not configured.', { code: 'MISSING_API_KEY', providerId: this.id })
    }
    const response = await this.request(`${API_BASE}${endpoint}`, {
      ...options,
      headers: { Authorization: `Bearer ${apiKey}`, ...(options.headers || {}) },
      responseType: 'json',
      method: options.method || 'POST'
    })
    const payload = response.data
    const error = payload?.error
    if (!response.ok || !payload || payload.status === 'error') {
      const errorCode = String(error?.code || `HTTP_${response.status}`)
      const message = UPLOAD_ERROR_MESSAGES[errorCode] || error?.message || response.statusText || 'AllDebrid API request failed'
      const normalizedCode = errorCode.startsWith('AUTH_')
        ? 'INVALID_API_KEY'
        : response.status === 429
          ? 'RATE_LIMIT'
          : errorCode
      throw new DebridError(message, {
        code: normalizedCode,
        status: response.status,
        providerId: this.id,
        retryable: response.status >= 500 || errorCode === 'RATE_LIMIT'
      })
    }
    return payload?.data ?? {}
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
    const data = await this.api('/user', config, { method: 'GET' })
    const user = data?.user || {}
    if (!user.username) {
      throw new DebridError('AllDebrid did not return user information.', { code: 'INVALID_RESPONSE', providerId: this.id })
    }
    const plan = user.isPremium ? (user.isTrial ? 'Freedays' : 'Premium') : 'Free'
    return {
      authenticated: true,
      email: user.email || undefined,
      username: user.username || user.email?.split('@')[0] || undefined,
      plan,
      isSubscribed: Boolean(user.isSubscribed || user.isPremium),
      expiresAt: Number(user.premiumUntil) > 0 ? Number(user.premiumUntil) * 1000 : null,
      raw: user
    }
  }

  /**
   * Hash-only instant availability is not exposed by the public v4 API, so
   * cache badges are unavailable; resolution itself remains instant for cached
   * swarms because AllDebrid's upload endpoint recognizes known torrents.
   *
   * @param {string[]} _hashes
   * @param {Record<string, any>} _config
   * @returns {Promise<Record<string, DebridCacheEntry>>}
   */
  async checkCached(_hashes, _config) {
    return {}
  }

  /**
   * Fetches and flattens the file tree for a stored magnet.
   *
   * @param {string | number} torrentId
   * @param {Record<string, any>} config
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ id: number, name: string, path: string, length: number, streamUrl?: string }[]>}
   */
  async getFileTree(torrentId, config, signal) {
    const form = AllDebridProvider.form({ 'id[]': String(torrentId) })
    // FORK PATCH: v4/magnet/files is the live "Get Files and Links" endpoint
    // (the /v4.1 variant documented in the examples 404s). The flattened
    // result retains the internal `link` field for getFileStreamUrl.
    const data = await this.api('/magnet/files', config, { ...form, signal })
    const entry = (data?.magnets || []).find(magnet => String(magnet.id) === String(torrentId)) || data?.magnets?.[0]
    if (!entry) {
      throw new DebridError(`AllDebrid could not provide files for magnet ${torrentId}.`, { code: 'TORRENT_NOT_FOUND', providerId: this.id })
    }
    if (entry.error) {
      throw new DebridError(UPLOAD_ERROR_MESSAGES[entry.error.code] || entry.error.message || 'AllDebrid magnet could not be inspected.', {
        code: entry.error.code || 'MAGNET_ERROR',
        providerId: this.id
      })
    }
    const flattened = flattenTree(entry.files || [], '', [], { counter: 0 })
    if (!flattened.length) {
      throw new DebridError(`AllDebrid returned no file tree for magnet ${torrentId} (files may still be generating).`, {
        code: 'NO_FILES',
        providerId: this.id,
        retryable: true
      })
    }
    if (flattened.every(file => !file.link)) {
      throw new DebridError(`AllDebrid file tree for magnet ${torrentId} has ${flattened.length} files but no links yet (still generating).`, {
        code: 'NO_LINKS_YET',
        providerId: this.id,
        retryable: true
      })
    }
    return flattened
  }

  /**
   * Waits until a stored magnet reaches the Ready state.
   *
   * @param {{ id: string | number }} uploaded
   * @param {Record<string, any>} config
   * @param {{ name?: string, onProgress?: (info: { status: string, progress: number, name?: string }) => void, signal?: AbortSignal }} [opts]
   * @returns {Promise<Record<string, any>>}
   */
  async waitForReady({ id }, config, { name, onProgress, signal } = {}) {
    const startedAt = Date.now()
    for (;;) {
      const form = AllDebridProvider.form({ id: String(id) })
      const data = await this.api('/magnet/status', config, { ...form, signal })
      const magnet = (data?.magnets || []).find(entry => String(entry.id) === String(id))
      if (!magnet) {
        throw new DebridError('AllDebrid lost track of the uploaded magnet.', { code: 'TORRENT_NOT_FOUND', providerId: this.id })
      }
      if (Number(magnet.statusCode) === READY_STATUS_CODE) return magnet
      if (FAILED_STATUS_CODES.has(Number(magnet.statusCode))) {
        throw new DebridError(`AllDebrid could not process this torrent (${magnet.status || 'error'}).`, {
          code: 'DOWNLOAD_FAILED',
          providerId: this.id
        })
      }
      onProgress?.({
        status: magnet.status || 'downloading',
        progress: Number(magnet.size) > 0
          ? Math.max(0, Math.min(100, Math.round((Number(magnet.downloaded) || 0) / Number(magnet.size) * 100)))
          : 0,
        name: magnet.filename || name
      })
      if (Date.now() - startedAt > MAX_POLL_WAIT_MS) {
        throw new DebridError('Timed out waiting for AllDebrid to finish processing the torrent.', { code: 'TIMEOUT', providerId: this.id })
      }
      await new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(new DebridError('Aborted while waiting for AllDebrid', { code: 'ABORTED', providerId: this.id }))
        const timer = setTimeout(() => {
          signal?.removeEventListener('abort', onAbort)
          resolve()
        }, POLL_INTERVAL_MS)
        const onAbort = () => {
          clearTimeout(timer)
          reject(new DebridError('Aborted while waiting for AllDebrid', { code: 'ABORTED', providerId: this.id }))
        }
        signal?.addEventListener('abort', onAbort, { once: true })
      })
    }
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

    /** @type {Record<string, any>} */
    let uploaded
    if (torrentBytes instanceof Uint8Array && torrentBytes.byteLength > 0) {
      let binary = ''
      for (let i = 0; i < torrentBytes.length; i++) binary += String.fromCharCode(torrentBytes[i])
      uploaded = await this.api('/magnet/upload/file', config, {
        body: {
          __formData: [{
            name: 'files[]',
            value: btoa(binary),
            encoding: 'base64',
            filename: `${safeName}.torrent`,
            contentType: 'application/x-bittorrent'
          }]
        },
        signal
      })
    } else {
      const magnetUri = magnet && magnet.startsWith('magnet:')
        ? magnet
        : normalizedHash
          ? buildMagnetUri(normalizedHash, name)
          : ''
      if (!magnetUri && !normalizedHash) {
        throw new DebridError('Missing magnet URI, info-hash, or .torrent payload for AllDebrid.', {
          code: 'INVALID_TORRENT',
          providerId: this.id
        })
      }
      const form = AllDebridProvider.form({ 'magnets[]': magnetUri || normalizedHash })
      uploaded = await this.api('/magnet/upload', config, { ...form, signal })
    }

    /** @type {Record<string, any>} */
    const entry = uploaded?.magnets?.[0]
    if (!entry) {
      throw new DebridError('AllDebrid returned no magnet information.', { code: 'INVALID_RESPONSE', providerId: this.id })
    }
    if (entry.error) {
      const code = String(entry.error.code || 'MAGNET_ERROR')
      const message = UPLOAD_ERROR_MESSAGES[code] || entry.error.message || 'AllDebrid rejected this torrent.'
      if (code === 'MAGNET_TOO_MANY_ACTIVE') {
        throw new DebridError(message, { code: 'TOO_MANY_ACTIVE', providerId: this.id })
      }
      throw new DebridError(message, { code, providerId: this.id })
    }

    const torrentId = Number(entry.id)
    if (!torrentId) {
      throw new DebridError('AllDebrid returned no magnet ID.', { code: 'INVALID_RESPONSE', providerId: this.id })
    }

    const wasInstant = Boolean(entry.ready)

    if (!wasInstant && !allowUncached) {
      await this.removeTorrent(torrentId, config)
      throw new DebridError('Torrent is not cached on AllDebrid.', { code: 'NOT_CACHED', providerId: this.id })
    }

    if (wasInstant) {
      onProgress?.({ status: 'cached on server', progress: 100, name: entry.name || name })
    } else {
      await this.waitForReady(entry, config, { name, onProgress, signal })
    }

    const rawFiles = await this.getFileTree(torrentId, config, signal)
    if (!rawFiles.length) {
      throw new DebridError('AllDebrid torrent contains no streamable files.', { code: 'NO_FILES', providerId: this.id })
    }
    // FORK PATCH: the public payload carries no internal link field; stream
    // URLs are resolved lazily per file through getFileStreamUrl.
    const files = rawFiles.map(({ id, name, path, length }) => ({ id, name, path, length }))

    const resolvedHash = normalizeInfoHash(entry.hash) || normalizedHash || `ad-${torrentId}`
    return {
      providerId: this.id,
      providerName: this.name,
      torrentId,
      infoHash: resolvedHash,
      name: entry.name || name || safeName,
      cached: wasInstant,
      status: 'ready',
      progress: 100,
      files
    }
  }

  /**
   * Unlocks a stored magnet file into a direct, resumable stream URL.
   *
   * @param {{ torrentId: string | number, fileId: string | number, infoHash?: string, signal?: AbortSignal }} fileRef
   * @param {Record<string, any>} config
   * @returns {Promise<{ url: string, headers?: Record<string, string> }>}
   */
  async getFileStreamUrl({ torrentId, fileId, signal }, config) {
    const files = await this.getFileTree(torrentId, config, signal)
    const file = files.find(candidate => String(candidate.id) === String(fileId)) || files[Number(fileId) || 0]
    const source = /** @type {{ link: string } | undefined} */ (file)
    const link = source?.link
    if (!link) {
      throw new DebridError('AllDebrid returned no streamable link for this file.', { code: 'NO_STREAM_URL', providerId: this.id })
    }

    const form = AllDebridProvider.form({ link })
    const unlocked = await this.api('/link/unlock', config, { ...form, signal })
    let url = unlocked?.link

    if (unlocked?.delayed) {
      const startedAt = Date.now()
      const delayedId = unlocked.delayed
      for (;;) {
        const delayedForm = AllDebridProvider.form({ id: String(delayedId) })
        const delayed = await this.api('/link/delayed', config, { ...delayedForm, signal })
        if (Number(delayed?.status) === 2 && delayed?.link) {
          url = delayed.link
          break
        }
        if (Number(delayed?.status) === 3) {
          throw new DebridError('AllDebrid failed to generate the stream link.', { code: 'NO_STREAM_URL', providerId: this.id })
        }
        if (Date.now() - startedAt > MAX_UNLOCK_WAIT_MS) {
          throw new DebridError('Timed out waiting for AllDebrid to generate the stream link.', { code: 'TIMEOUT', providerId: this.id })
        }
        await new Promise((resolve, reject) => {
          if (signal?.aborted) return reject(new DebridError('Aborted while waiting for AllDebrid', { code: 'ABORTED', providerId: this.id }))
          const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort)
            resolve()
          }, UNLOCK_POLL_INTERVAL_MS)
          const onAbort = () => {
            clearTimeout(timer)
            reject(new DebridError('Aborted while waiting for AllDebrid', { code: 'ABORTED', providerId: this.id }))
          }
          signal?.addEventListener('abort', onAbort, { once: true })
        })
      }
    }

    if (!url || typeof url !== 'string') {
      throw new DebridError('AllDebrid did not return a valid stream URL.', { code: 'NO_STREAM_URL', providerId: this.id })
    }
    return { url }
  }

  /**
   * @param {string | number} torrentId
   * @param {Record<string, any>} config
   * @returns {Promise<void>}
   */
  async removeTorrent(torrentId, config) {
    const form = AllDebridProvider.form({ id: String(torrentId) })
    await this.api('/magnet/delete', config, { ...form })
  }
}
