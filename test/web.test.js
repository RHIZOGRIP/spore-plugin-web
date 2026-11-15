import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { botPath, routesOf } from '@rhizogrip/spore/relay'

import { WEB, createAdapter, messageOf, openFiles, webOf } from '../src/adapter.js'
import { openLog } from '../src/log.js'
import { serve } from '../src/server.js'

let DIR
let path
let configFile
const webFile = (fields) => writeFileSync(path, JSON.stringify(fields))

beforeEach(() => {
  DIR = mkdtempSync(resolve(tmpdir(), 'spore-web-test-'))
  configFile = resolve(DIR, 'config.json')
  path = botPath(WEB, 'page', configFile)
  mkdirSync(resolve(DIR, 'web'), { recursive: true })
  mkdirSync(resolve(DIR, 'home', 'main'), { recursive: true })
  writeFileSync(resolve(DIR, 'home', 'main', 'spore.cmk'), '---\nname: main\n---\n')
  writeFileSync(configFile, JSON.stringify({ home: resolve(DIR, 'home') }))
})
afterEach(() => rmSync(DIR, { recursive: true, force: true }))

describe('a web file', () => {
  it('reads each person against the spores they reach, every spore in home with "*"', () => {
    webFile({ people: { operator: '*', ada: { spores: ['main', 'ops'], brief: true }, bob: 'main' } })
    expect([...routesOf(WEB, path)].map(([who, { spores, brief }]) => [who, spores, brief])).toEqual([['operator', ['*'], false], ['ada', ['main', 'ops'], true], ['bob', ['main'], false]])
  })

  it('listens on loopback alone, and asks an origin of a page behind a proxy', () => {
    expect(webOf({}, path)).toMatchObject({ listen: { text: '127.0.0.1:7761' }, user: null, origin: null, theme: null, shell: null })
    expect(() => webOf({ listen: '0.0.0.0:7761' }, path)).toThrow(/beyond loopback/)
    expect(() => webOf({ user: 'x-forwarded-user' }, path)).toThrow(/names a user header and no origin/)
    expect(() => webOf({ user: 'X Forwarded', origin: 'https://a.example' }, path)).toThrow(/not a header name/)
    expect(() => webOf({ user: 'x-forwarded-user', origin: 'https://a.example/path' }, path)).toThrow(/an origin that is not one/)
    expect(webOf({ user: 'x-forwarded-user', origin: 'https://a.example' }, path)).toMatchObject({ user: 'x-forwarded-user', origin: 'https://a.example' })
  })

  it('takes a theme beside it or absolute, and refuses one that is not there', () => {
    writeFileSync(resolve(DIR, 'web', 'mine.css'), ':root { --accent: red; }')
    expect(webOf({ theme: 'mine.css' }, path).theme).toBe(resolve(DIR, 'web', 'mine.css'))
    expect(() => webOf({ theme: 'gone.css' }, path)).toThrow(/a theme that is not there/)
  })

  it('takes a shell\'s name and links, each a path at the page\'s own address', () => {
    const shell = { name: 'Oki', links: [{ label: 'Spores', href: '/oki/spores/' }] }
    expect(webOf({ shell }, path).shell).toEqual(shell)
    expect(() => webOf({ shell: { name: 'Oki', links: [] } }, path)).toThrow(/a shell with no links/)
    expect(() => webOf({ shell: { links: shell.links } }, path)).toThrow(/a shell with no name/)
    for (const href of ['https://elsewhere.example/', '//elsewhere.example/', 'oki/']) {
      expect(() => webOf({ shell: { name: 'Oki', links: [{ label: 'Out', href }] } }, path)).toThrow(/a shell link that leaves this address/)
    }
  })
})

describe('the log', () => {
  let log
  beforeEach(() => { log = openLog(':memory:') })
  afterEach(() => log.close())

  it('says a page\'s id once, and keeps whether it reached the spore', () => {
    const first = log.say('operator', 'c1', { to: 'main', text: 'hello', files: [], zone: null })
    expect(log.said('c1')).toEqual({ event: first.event, delivered: false })
    log.delivered('c1')
    expect(log.said('c1').delivered).toBe(true)
    expect(log.said('c2')).toBeNull()
  })

  it('reads a person\'s history backwards a page at a time, oldest first', () => {
    for (const n of [1, 2, 3, 4]) log.append('operator', 'notice', { spore: 'main', text: `n${n}` })
    log.append('ada', 'notice', { spore: 'main', text: 'theirs' })
    expect(log.before('operator', Number.MAX_SAFE_INTEGER, 2).map(event => event.text)).toEqual(['n3', 'n4'])
    expect(log.before('operator', 3, 10).map(event => event.text)).toEqual(['n1', 'n2'])
    expect(log.last('operator')).toBe(4)
  })

  it('holds what a working note shows only until the note is done, and never writes it down', () => {
    const note = log.append('operator', 'working', { spore: 'main', text: 'working…' }).seq
    log.running('operator', note, { text: 'working… · 1 call', live: { text: 'Hel', calls: [] } })
    expect(log.runningOf('operator')).toEqual([{ person: 'operator', note, spore: 'main', text: 'working… · 1 call', live: { text: 'Hel', calls: [] } }])
    expect(log.after('operator', note, 10)).toEqual([])
    log.append('operator', 'done', { note })
    log.running('operator', note, { text: 'late', live: null })
    expect(log.runningOf('operator')).toEqual([])
  })
})

describe('the adapter', () => {
  it('addresses each message to the spore the page had open', () => {
    const log = openLog(':memory:')
    const { event } = log.say('operator', 'c9', { to: 'ops', text: '/status', files: [{ upload: 'a'.repeat(24), name: 'a.txt', mime: 'text/plain', bytes: 3 }], zone: 'Europe/Paris' })
    expect(messageOf('page', event)).toEqual({
      id: 'page:c9',
      conversation: 'operator',
      message: String(event.seq),
      person: { id: 'operator', name: 'operator', groups: [], zone: 'Europe/Paris' },
      spore: null,
      where: 'the web page "page"',
      shared: false,
      text: '/status',
      command: { verb: 'status', args: '' },
      addresses: ['ops'],
      files: [{ name: 'a.txt', mime: 'text/plain', bytes: 3, ref: 'a'.repeat(24) }]
    })
    log.close()
  })

  it('keeps a copy of what a turn handed back, so it outlives the workspace file', async () => {
    const log = openLog(':memory:')
    const files = openFiles(resolve(DIR, 'state'))
    const adapter = createAdapter({ name: 'page', log, files, receive: () => {} })
    const handed = resolve(DIR, 'report.md')
    writeFileSync(handed, '# report')
    await adapter.upload('operator', { path: handed, mime: 'text/markdown' }, 'data/out/report.md', { as: 'main' })
    rmSync(handed)
    const [event] = log.after('operator', 0, 10)
    expect(event).toMatchObject({ type: 'file', spore: 'main', name: 'data/out/report.md', mime: 'text/markdown', bytes: 8 })
    expect(readFileSync(files.keptPath(event.file), 'utf8')).toBe('# report')
    expect(log.keptOf(event.file)).toEqual({ id: event.file, person: 'operator', name: 'data/out/report.md', mime: 'text/markdown' })
    log.close()
  })
})

describe('the page', () => {
  let log
  let files
  let port
  let controller
  let served
  let delivered
  const base = () => `http://127.0.0.1:${port}`

  const call = async (method, route, body, headers = {}) => {
    const response = await fetch(`${base()}${route}`, {
      method,
      headers: { ...(method === 'POST' ? { origin: base(), 'content-type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    return response
  }

  const start = async (fields) => {
    webFile({ listen: '127.0.0.1:7761', people: { operator: 'main' }, ...fields })
    controller = new AbortController()
    let listening
    const ready = new Promise(resolve => { listening = resolve })
    served = serve({
      host: '127.0.0.1',
      port: 0,
      file: path,
      configFile,
      log,
      files,
      deliver: async (event) => {
        delivered.push(event)
        log.delivered(event.id)
      },
      press: async () => null,
      signal: controller.signal,
      say: () => {},
      listening
    })
    port = await ready
  }

  const events = async (route, headers, until) => {
    const abort = new AbortController()
    const response = await fetch(`${base()}${route}`, { headers: { accept: 'text/event-stream', ...headers }, signal: abort.signal })
    const reader = response.body.getReader()
    let text = ''
    while (!until(text)) {
      const { value, done } = await reader.read()
      if (done) throw new Error(`the stream ended (${response.status}) before it said what was awaited — ${text}`)
      text += new TextDecoder().decode(value)
    }
    abort.abort()
    return text
  }

  beforeEach(() => {
    log = openLog(':memory:')
    files = openFiles(resolve(DIR, 'state'))
    delivered = []
  })

  afterEach(async () => {
    controller.abort()
    await served
    log.close()
  })

  it('serves itself and the operator\'s theme under a policy that runs no script but its own', async () => {
    writeFileSync(resolve(DIR, 'web', 'mine.css'), ':root { --accent: red; }')
    await start({ theme: 'mine.css' })
    const index = await call('GET', '/')
    expect(index.headers.get('content-security-policy')).toMatch(/script-src 'self'; .*object-src 'none'; .*frame-ancestors 'none'/)
    expect(await index.text()).toContain('<script type="module" src="/app.js"></script>')
    expect(await (await call('GET', '/theme.css')).text()).toBe(':root { --accent: red; }')
    expect((await call('GET', '/vendor/marked.js')).status).toBe(200)
    expect((await call('GET', '/vendor/purify.js')).status).toBe(200)
    expect((await call('GET', '/share.js')).status).toBe(200)
  })

  it('names the spores the person reaches, and tells a spore it does not', async () => {
    await start({ people: { operator: '*' } })
    expect(await (await call('GET', '/api/me')).json()).toEqual({ person: 'operator', shell: null, brief: false, spores: [{ name: 'main', busy: false }], files: WEB.limits.fetch, last: 0 })
    expect((await call('GET', '/api/spores/elsewhere')).status).toBe(404)
  })

  it('tells the page the shell it sits in', async () => {
    const shell = { name: 'Oki', links: [{ label: 'Spores', href: '/oki/spores/' }] }
    await start({ shell })
    expect((await (await call('GET', '/api/me')).json()).shell).toEqual(shell)
  })

  it('refuses a person the web file does not map, and serves no file of someone else\'s', async () => {
    await start({ people: { ada: 'main' }, user: 'x-forwarded-user', origin: 'https://spores.example.org' })
    expect((await call('GET', '/api/me', undefined, { 'x-forwarded-user': 'bob' })).status).toBe(403)
    const handed = resolve(DIR, 'q.txt')
    writeFileSync(handed, 'theirs')
    const adapter = createAdapter({ name: 'page', log, files, receive: () => {} })
    await adapter.upload('bob', { path: handed, mime: 'text/html' }, 'data/out/q.html', { as: 'main' })
    const [event] = log.after('bob', 0, 1)
    expect((await call('GET', `/files/${event.file}`, undefined, { 'x-forwarded-user': 'ada' })).status).toBe(404)
  })

  it('hands back a file as a download that never runs on the page', async () => {
    await start()
    const handed = resolve(DIR, 'q.html')
    writeFileSync(handed, '<script>alert(1)</script>')
    const adapter = createAdapter({ name: 'page', log, files, receive: () => {} })
    await adapter.upload('operator', { path: handed, mime: 'text/html' }, 'data/out/q.html', { as: 'main' })
    const [event] = log.after('operator', 0, 1)
    const response = await call('GET', `/files/${event.file}`)
    expect(response.headers.get('content-type')).toBe('application/octet-stream')
    expect(response.headers.get('content-disposition')).toBe('attachment; filename*=UTF-8\'\'q.html')
    expect(response.headers.get('content-security-policy')).toMatch(/^sandbox/)
    expect(await response.text()).toBe('<script>alert(1)</script>')
  })

  it('says a message once, and refuses one naming an upload that is not the person\'s', async () => {
    await start()
    const first = await call('POST', '/api/messages', { id: 'm1', to: 'main', text: 'hello' })
    expect(await first.json()).toEqual({ seq: 1, repeated: false })
    expect(await (await call('POST', '/api/messages', { id: 'm1', to: 'main', text: 'hello' })).json()).toEqual({ seq: 1, repeated: true })
    expect(delivered.map(event => event.id)).toEqual(['m1'])
    log.upload('b'.repeat(24), 'ada', { name: 'x.txt', mime: null, bytes: 1 })
    expect((await call('POST', '/api/messages', { id: 'm2', to: 'main', text: 'hi', files: ['b'.repeat(24)] })).status).toBe(410)
    for (const body of [{ id: 'm3', to: 'main' }, { id: 'a b', to: 'main', text: 'x' }, { id: 'm4', to: 'no/name', text: 'x' }, { id: 'm5', to: 'main', text: 'x', extra: 1 }]) {
      expect((await call('POST', '/api/messages', body)).status, JSON.stringify(body)).toBe(400)
    }
  })

  it('resumes a stream after the last event seen, what lands during the replay included, and follows a running turn', async () => {
    await start()
    for (const n of [1, 2, 3]) log.append('operator', 'notice', { spore: 'main', text: `n${n}` })
    const note = log.append('operator', 'working', { spore: 'main', text: 'working…' }).seq
    log.running('operator', note, { text: 'working… · 1 call', live: { text: 'Hel', calls: [], notes: [] } })
    const text = await events('/api/events', { 'last-event-id': '1' }, (seen) => seen.includes('"add":"Hel"'))
    expect(text).not.toContain('id: 1\n')
    expect(text).toMatch(/id: 2\nevent: notice\n.*\n\nid: 3\nevent: notice\n.*\n\nid: 4\nevent: working\n/)
    expect(text).toContain('event: running\ndata: {"note":4,"spore":"main","line":"working… · 1 call","live":{"calls":[],"notes":[]}}')
    expect(text).toContain('event: text\ndata: {"note":4,"add":"Hel"}')
    setTimeout(() => log.running('operator', note, { text: 'working… · 1 call', live: { text: 'Hello', calls: [], notes: [] } }), 50)
    const more = await events('/api/events?after=4', {}, (seen) => seen.includes('"add":"lo"'))
    expect(more).toContain('event: text\ndata: {"note":4,"add":"lo"}')
    expect(more.split('event: running').length - 1).toBe(1)
  })

  it('reads nothing cross-site, and takes no write from another origin', async () => {
    await start()
    expect((await call('GET', '/api/history', undefined, { 'sec-fetch-site': 'cross-site' })).status).toBe(403)
    expect((await call('POST', '/api/messages', { id: 'x', to: 'main', text: 'hi' }, { origin: 'https://evil.example' })).status).toBe(403)
    expect(delivered).toEqual([])
  })

  it('lets one person follow on a bounded number of pages at once', async () => {
    await start()
    const open = []
    for (let i = 0; i < 8; i++) open.push(await fetch(`${base()}/api/events`, { headers: { accept: 'text/event-stream' } }))
    expect((await fetch(`${base()}/api/events`)).status).toBe(429)
    for (const response of open) await response.body.cancel()
  })

  it('ends a stream that stops reading, rather than holding what it cannot send', async () => {
    await start()
    const response = await fetch(`${base()}/api/events`, { headers: { accept: 'text/event-stream' } })
    const big = 'x'.repeat(256 * 1024)
    for (let i = 0; i < 40; i++) log.append('operator', 'notice', { spore: 'main', text: big })
    const reader = response.body.getReader()
    let ended = false
    while (!ended) ended = (await reader.read()).done
    expect(ended).toBe(true)
  })
})

describe('the shipped themes', () => {
  const luminance = (l, c, h) => {
    const a = c * Math.cos(h * Math.PI / 180)
    const b = c * Math.sin(h * Math.PI / 180)
    const L = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3
    const M = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3
    const S = (l - 0.0894841775 * a - 1.2914855480 * b) ** 3
    const clamp = (v) => Math.min(1, Math.max(0, v))
    return 0.2126 * clamp(4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S) +
      0.7152 * clamp(-1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S) +
      0.0722 * clamp(-0.0041960863 * L - 0.7034186147 * M + 1.7076147010 * S)
  }
  const ratio = (x, y) => (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)

  it('meet WCAG AA for every pair of text and what it sits on, light and dark', () => {
    const css = readFileSync(join(import.meta.dirname, '..', 'page', 'tokens.css'), 'utf8')
    const pairs = [...css.matchAll(/--([a-z-]+):\s*light-dark\(oklch\(([\d.]+)%\s+([\d.]+)\s+([\d.]+)\),\s*oklch\(([\d.]+)%\s+([\d.]+)\s+([\d.]+)\)\)/g)]
    const themes = [1, 4].map(at => Object.fromEntries(pairs.map(pair => [pair[1], luminance(pair[at + 1] / 100, Number(pair[at + 2]), Number(pair[at + 3]))])))
    expect(Object.keys(themes[0])).toEqual(expect.arrayContaining(['bg', 'surface', 'raised', 'text', 'text-muted', 'accent', 'on-accent', 'danger']))
    for (const theme of themes) {
      for (const [text, on] of [['text', 'bg'], ['text', 'surface'], ['text', 'raised'], ['text-muted', 'bg'], ['text-muted', 'surface'], ['text-muted', 'raised'], ['on-accent', 'accent'], ['accent', 'bg'], ['accent', 'raised'], ['danger', 'bg'], ['danger', 'surface'], ['danger', 'raised']]) {
        expect(ratio(theme[text], theme[on]), `${text} on ${on}`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })
})
