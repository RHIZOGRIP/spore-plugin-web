/**
 * The page and its API on a loopback address. Who asks is `operator` with no proxy, else the person
 * the proxy names in the web file's `user` header; either must be among its people. Every write
 * must come from the page's own origin, and nothing is read cross-site. The page reads its
 * conversation as server-sent events, resuming from the last `seq` it saw.
 */

import { createReadStream, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { RUNNING, SporeError, errorText, parseTraceparent, readConfig, show, stateOf, workspaceFor } from '@rhizogrip/spore'
import { filesOf, namesOf, readBody, readBot, routesOf } from '@rhizogrip/spore/relay'

import { OPERATOR, WEB, isSporeName, webOf } from './adapter.js'

const MOST_BYTES = 1024 * 1024
const MOST_TEXT = 100_000
const MOST_FILES = 10
const HISTORY = 200
const MOST_HISTORY = 1000
const PAGE = 500
const PING_MS = 15_000
const RETRY_MS = 3000
const MOST_STREAMS = 8
const MOST_BUFFERED = 4 * 1024 * 1024
const UPLOAD_KEPT_MS = 24 * 60 * 60 * 1000
const ID = /^[A-Za-z0-9._:-]{1,128}$/
const CHOICE = /^[A-Za-z0-9_-]{1,32}$/
const FILE_ID = /^[0-9a-f]{24}$/
const APPROVAL = /^\/api\/approvals\/([0-9a-f]{12})\/answer$/
const SPORE = /^\/api\/spores\/([^/]+)$/
const KEPT = /^\/files\/([0-9a-f]{24})$/
const PEERS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const LOOPBACK_NAMES = ['127.0.0.1', 'localhost', '[::1]']
const SHOWN_INLINE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

const HERE = dirname(fileURLToPath(import.meta.url))
const PAGE_DIR = join(HERE, '..', 'page')

const SECURITY = {
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin'
}

class Refused extends Error {
  constructor (status, message) {
    super(message)
    this.status = status
  }
}

async function bodyOf (request, response) {
  const body = await readBody(request, response, MOST_BYTES)
  if (body === null) throw new Refused(413, `a request carries at most ${MOST_BYTES} bytes`)
  try {
    return JSON.parse(body.toString('utf8'))
  } catch (err) {
    throw new Refused(400, `the body is not JSON — ${err.message}`)
  }
}

const numberIn = (query, field, { least = 0, most = Infinity, absent }) => {
  const raw = query.get(field)
  if (raw === null) return absent
  const value = Number(raw)
  if (!Number.isInteger(value) || value < least || value > most) throw new Refused(400, `${field} is a whole number from ${least} to ${most}`)
  return value
}

const assetsOf = () => ({
  '/': { path: join(PAGE_DIR, 'index.html'), type: 'text/html; charset=utf-8' },
  '/app.js': { path: join(PAGE_DIR, 'app.js'), type: 'text/javascript; charset=utf-8' },
  '/tokens.css': { path: join(PAGE_DIR, 'tokens.css'), type: 'text/css; charset=utf-8' },
  '/style.css': { path: join(PAGE_DIR, 'style.css'), type: 'text/css; charset=utf-8' },
  '/mode.js': { path: join(PAGE_DIR, 'mode.js'), type: 'text/javascript; charset=utf-8' },
  '/share.js': { path: join(PAGE_DIR, 'share.js'), type: 'text/javascript; charset=utf-8' },
  '/icon.svg': { path: join(PAGE_DIR, 'icon.svg'), type: 'image/svg+xml' },
  '/vendor/marked.js': { path: fileURLToPath(import.meta.resolve('marked')), type: 'text/javascript; charset=utf-8' },
  '/vendor/purify.js': { path: fileURLToPath(import.meta.resolve('dompurify')), type: 'text/javascript; charset=utf-8' }
})

/**
 * Serves until `signal` aborts, telling `listening` the port once it listens. The web file is read
 * again on every request, so a person added or a theme changed needs no restart.
 */
export function serve ({ host, port, file, configFile, log, files, deliver, press, signal, say, listening = () => {} }) {
  const assets = assetsOf()
  const streams = new Map()
  let answering = null
  const originsOf = (web) => web.origin !== null ? [web.origin] : LOOPBACK_NAMES.map(name => `http://${name}:${answering}`)

  const who = (request) => {
    if (!PEERS.has(request.socket.remoteAddress)) throw new Refused(403, 'the page answers loopback alone')
    const web = webOf(readBot(WEB, file), file)
    let person = OPERATOR
    if (web.user !== null) {
      const named = request.headers[web.user]
      if (typeof named !== 'string' || !named) throw new Refused(401, `no ${web.user} header — this page is opened through the proxy that signs people in`)
      person = named
    } else if (web.origin === null && !LOOPBACK_NAMES.map(name => `${name}:${answering}`).includes(request.headers.host)) {
      throw new Refused(403, `the page answers at ${originsOf(web).join(', ')}`)
    }
    const routed = routesOf(WEB, file).get(person)
    if (!routed) {
      say(`refused "${person}", who is not among the people of ${file} — to let them in, add "${person}": "<a spore>" to its people`)
      throw new Refused(403, `"${person}" may not use this page — ask whoever runs it to add them`)
    }
    return { web, person, routed }
  }

  const fromPage = (request, web) => {
    if (!originsOf(web).includes(request.headers.origin)) throw new Refused(403, 'a write comes from the page itself')
  }

  const notCrossSite = (request) => {
    const site = request.headers['sec-fetch-site']
    if (site === 'cross-site' || site === 'same-site') throw new Refused(403, 'the page is read from itself')
  }

  const reached = (routed) => {
    const config = readConfig(configFile)
    return namesOf(routed, config).map(name => {
      const ws = workspaceFor(name, { config }).path
      return { name, busy: stateOf(ws).state === RUNNING }
    })
  }

  const me = ({ web, person, routed }) => ({
    person,
    shell: web.shell,
    brief: routed.brief,
    spores: reached(routed),
    files: filesOf(WEB, file),
    last: log.last(person)
  })

  const sporeInfo = ({ routed }, name) => {
    if (!isSporeName(name) || !namesOf(routed, readConfig(configFile)).includes(name)) throw new Refused(404, `no spore "${name}" here`)
    const shown = show({ ws: name, configFile })
    return { name, description: shown.description, state: shown.state }
  }

  const history = ({ person }, query) => {
    const before = numberIn(query, 'before', { least: 1, absent: Number.MAX_SAFE_INTEGER })
    const limit = numberIn(query, 'limit', { least: 1, most: MOST_HISTORY, absent: HISTORY })
    return { events: log.before(person, before, limit), running: log.runningOf(person) }
  }

  const upload = async (request, response, { person }) => {
    const most = filesOf(WEB, file)
    if (most === 0) throw new Refused(403, 'this page takes no files')
    const name = decodeURIComponent(request.headers['x-file-name'] ?? '')
    if (!name || name.length > 255 || /[/\\\0]/.test(name)) throw new Refused(400, 'x-file-name is the file\'s name, URI-encoded, with no slash')
    const body = await readBody(request, response, most)
    if (body === null) throw new Refused(413, `a file is at most ${most} bytes here`)
    const stale = log.staleUploads(new Date(Date.now() - UPLOAD_KEPT_MS).toISOString())
    for (const id of stale) dropUpload(id)
    const id = files.newId()
    writeFileSync(files.uploadPath(id), body)
    log.upload(id, person, { name, mime: request.headers['content-type'] ?? null, bytes: body.length })
    return { status: 200, body: { upload: id, name, bytes: body.length } }
  }

  const dropUpload = (id) => {
    unlinkSync(files.uploadPath(id))
    log.dropUpload(id)
  }

  const deliverOnce = async (event) => {
    const gone = event.files.filter(one => log.uploadOf(one.upload) === null)
    if (gone.length) throw new Refused(410, `${gone.map(one => one.name).join(', ')} ${gone.length === 1 ? 'is' : 'are'} no longer here — send the message again under a new id`)
    await deliver(event)
    for (const one of event.files) dropUpload(one.upload)
  }

  const message = async (request, response, { person }) => {
    const { id, to, text = null, files: sent = [], zone = null, ...rest } = await bodyOf(request, response)
    const extra = Object.keys(rest)
    if (extra.length) throw new Refused(400, `a message is { "id", "to", "text", "files", "zone" } — not ${extra.join(', ')}`)
    if (typeof id !== 'string' || !ID.test(id)) throw new Refused(400, 'id is the page\'s for this message, letters, digits, ., _, : and -, at most 128: the same id twice is said once')
    const earlier = log.said(id)
    if (earlier) {
      if (earlier.event.person !== person) throw new Refused(409, `id ${id} was said by someone else`)
      if (!earlier.delivered) await deliverOnce(earlier.event)
      return { status: 200, body: { seq: earlier.event.seq, repeated: true } }
    }
    if (!isSporeName(to)) throw new Refused(400, 'to is the name of the spore the message is for')
    if (text !== null && (typeof text !== 'string' || text.length > MOST_TEXT)) throw new Refused(400, `text is a string of at most ${MOST_TEXT} characters`)
    if (zone !== null && !(typeof zone === 'string' && zone.length <= 64)) throw new Refused(400, 'zone is the person\'s IANA time zone')
    if (!Array.isArray(sent) || sent.length > MOST_FILES || !sent.every(one => typeof one === 'string' && FILE_ID.test(one))) throw new Refused(400, `files is the ids of at most ${MOST_FILES} uploads`)
    if (text === null && !sent.length) throw new Refused(400, 'a message has text, files or both')
    const traceparent = request.headers.traceparent ?? null
    if (traceparent !== null && !parseTraceparent(traceparent)) throw new Refused(400, 'traceparent is W3C trace context, as 00-<32 hex>-<16 hex>-01')
    const uploads = sent.map(one => log.uploadOf(one))
    if (uploads.some(one => one === null || one.person !== person)) throw new Refused(410, 'a file of this message is no longer here — attach it again')
    const said = log.say(person, id, {
      to,
      text,
      files: uploads.map(one => ({ upload: one.id, name: one.name, mime: one.mime, bytes: one.bytes })),
      zone,
      ...(traceparent ? { traceparent } : {})
    })
    await deliverOnce(said.event)
    return { status: 200, body: { seq: said.event.seq, repeated: false } }
  }

  const answer = async (request, response, { person }, approval) => {
    const { choice, inputs = null, ...rest } = await bodyOf(request, response)
    const extra = Object.keys(rest)
    if (extra.length) throw new Refused(400, `an answer is { "choice", "inputs" } — not ${extra.join(', ')}`)
    if (typeof choice !== 'string' || !CHOICE.test(choice)) throw new Refused(400, 'choice is the id of one of the card\'s options')
    if (inputs !== null && (typeof inputs !== 'object' || Array.isArray(inputs))) throw new Refused(400, 'inputs is { "<field id>": "<text>" or ["<choice id>", …] }')
    const card = log.cardOf(approval)
    if (!card || card.person !== person) throw new Refused(404, `no card ${approval} was shown to ${person}`)
    const heard = await press({ card, choice, by: person, inputs })
    if (heard === null) throw new SporeError(`the press on ${approval} was not answered`, { type: 'WEB_PRESS_UNANSWERED' })
    return heard.taken ? { status: 200, body: { taken: true, text: heard.text } } : { status: 409, body: { taken: false, reason: heard.text } }
  }

  const kept = (response, { person }, id) => {
    const found = log.keptOf(id)
    if (!found || found.person !== person) throw new Refused(404, 'no such file here')
    const path = files.keptPath(id)
    response.writeHead(200, {
      ...SECURITY,
      'content-security-policy': 'sandbox; default-src \'none\'',
      'content-type': SHOWN_INLINE.has(found.mime) ? found.mime : 'application/octet-stream',
      'content-length': statSync(path).size,
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(basename(found.name))}`,
      'cache-control': 'private, max-age=31536000, immutable'
    })
    createReadStream(path).on('error', () => response.destroy()).pipe(response)
  }

  const stream = (request, response, { person }, query) => {
    const open = streams.get(person) ?? new Set()
    if (open.size >= MOST_STREAMS) throw new Refused(429, `at most ${MOST_STREAMS} pages of one person follow at once`)
    const after = numberIn(query, 'after', { absent: Number(request.headers['last-event-id'] ?? 0) })
    if (!Number.isInteger(after) || after < 0) throw new Refused(400, 'Last-Event-ID is a seq')
    response.writeHead(200, { ...SECURITY, 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' })
    response.flushHeaders()
    const send = (chunk) => {
      if (response.writableEnded) return
      response.write(chunk)
      if (response.writableLength > MOST_BUFFERED) response.end()
    }
    send(`retry: ${RETRY_MS}\n\n`)
    let cursor = after
    if (after > log.last(person)) {
      send('event: reset\ndata: {}\n\n')
      cursor = log.last(person)
    }
    const sentText = new Map()
    const sentView = new Map()
    const drain = () => {
      for (let batch = log.after(person, cursor, PAGE); batch.length && !response.writableEnded; batch = log.after(person, cursor, PAGE)) {
        for (const event of batch) {
          if (event.type === 'done') {
            sentText.delete(event.note)
            sentView.delete(event.note)
          }
          send(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
        }
        cursor = batch.at(-1).seq
      }
    }
    const live = ({ note, spore, text, live: view }) => {
      const { text: written = '', ...rest } = view ?? {}
      const shown = JSON.stringify({ note, spore, line: text, live: view === null ? null : rest })
      if (shown !== sentView.get(note)) {
        sentView.set(note, shown)
        send(`event: running\ndata: ${shown}\n\n`)
      }
      const before = sentText.get(note) ?? ''
      if (written === before) return
      sentText.set(note, written)
      send(`event: text\ndata: ${JSON.stringify(written.startsWith(before) ? { note, add: written.slice(before.length) } : { note, text: written })}\n\n`)
    }
    const off = log.subscribe(person, { event: drain, live })
    drain()
    for (const shown of log.runningOf(person)) live(shown)
    const ping = setInterval(() => send(': ping\n\n'), PING_MS)
    open.add(response)
    streams.set(person, open)
    response.on('close', () => {
      off()
      clearInterval(ping)
      open.delete(response)
      if (!open.size) streams.delete(person)
    })
  }

  const asset = (response, path, web) => {
    if (path === '/theme.css') {
      response.writeHead(200, { ...SECURITY, 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-cache' }).end(web.theme === null ? '' : readFileSync(web.theme))
      return
    }
    const found = assets[path]
    if (!found) throw new Refused(404, 'no such page')
    response.writeHead(200, { ...SECURITY, 'content-type': found.type, 'cache-control': 'no-cache' }).end(readFileSync(found.path))
  }

  const route = async (request, response, url) => {
    const { pathname, searchParams: query } = url
    if (request.method === 'GET' && !pathname.startsWith('/api/') && !pathname.startsWith('/files/')) {
      asset(response, pathname, webOf(readBot(WEB, file), file))
      return
    }
    const asking = who(request)
    if (request.method === 'GET') {
      notCrossSite(request)
      if (pathname === '/api/me') return { status: 200, body: me(asking) }
      if (pathname === '/api/history') return { status: 200, body: history(asking, query) }
      if (pathname === '/api/events') return stream(request, response, asking, query)
      const spore = SPORE.exec(pathname)
      if (spore) return { status: 200, body: sporeInfo(asking, decodeURIComponent(spore[1])) }
      const one = KEPT.exec(pathname)
      if (one) return kept(response, asking, one[1])
    }
    if (request.method === 'POST') {
      fromPage(request, asking.web)
      if (pathname === '/api/messages') return message(request, response, asking)
      if (pathname === '/api/uploads') return upload(request, response, asking)
      const approval = APPROVAL.exec(pathname)
      if (approval) return answer(request, response, asking, approval[1])
    }
    throw new Refused(404, 'no such route')
  }

  const server = createServer(async (request, response) => {
    const json = (status, body) => response.writeHead(status, { ...SECURITY, 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body))
    try {
      const done = await route(request, response, new URL(request.url, 'http://page'))
      if (done !== undefined) json(done.status, done.body)
    } catch (err) {
      if (response.headersSent) return response.end()
      if (err instanceof Refused) return json(err.status, { error: err.message })
      say(`${request.method} ${request.url} failed — ${errorText(err)}`)
      json(err.type?.endsWith('_INVALID') ? 503 : 500, { error: errorText(err) })
    }
  })

  return new Promise((resolve, reject) => {
    server.once('error', (err) => reject(new SporeError(`cannot listen on ${host}:${port}`, { type: 'WEB_LISTEN_REFUSED', detail: err.message })))
    server.listen(port, host, () => {
      answering = server.address().port
      listening(answering)
      const stop = () => {
        for (const open of streams.values()) {
          for (const response of open) response.end('event: bye\ndata: {}\n\n')
        }
        server.close(() => resolve())
        server.closeIdleConnections()
      }
      if (signal.aborted) return stop()
      signal.addEventListener('abort', stop, { once: true })
    })
  })
}
