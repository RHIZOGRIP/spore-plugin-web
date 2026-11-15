/**
 * The web connector against real spores: the relay's conformance suite with the page's log behind a
 * stand-in transport, its own cases — a message addressed to one of several spores, `*` — and the
 * page's HTTP face end to end.
 */

import '../../spore/packages/spore/test/fixtures/own-config.js'
import { describe, it, expect } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { join } from 'node:path'

import { conformance } from '../../spore/packages/spore/test/fixtures/relay-conformance.js'
import { answers, calls } from '../../spore/packages/spore/test/fixtures/scripted-model.js'
import { withAuth } from '../../spore/packages/spore/test/fixtures/outside-ws.js'
import { definitionWith } from '@rhizogrip/spore/testing'
import { SporeError, readInbox } from '@rhizogrip/spore'
import { WEB, createAdapter, openFiles } from '../src/adapter.js'
import { openLog } from '../src/log.js'
import { serve } from '../src/server.js'

const standIn = (root) => {
  const log = openLog(':memory:')
  const files = openFiles(join(root, 'web-state'))
  const waiting = []
  const faults = []
  const seen = new Map()
  let wake = null
  let said = 0
  return {
    log,
    files,
    http: null,
    nextId: () => `m${++said}`,
    record: (conversation, op) => (seen.get(conversation) ?? seen.set(conversation, []).get(conversation)).push(op),
    seen: (conversation) => seen.get(conversation) ?? [],
    fault (op) {
      const found = faults.find(one => one.op === op && one.times > 0)
      if (!found) return
      found.times -= 1
      throw found.error
    },
    fail: (op, error, times = 1) => faults.push({ op, error, times }),
    push (job) {
      waiting.push(job)
      wake?.()
    },
    async receive (handlers) {
      if (this.http) return serve({ ...this.http, ...handlers, log, files, say: handlers.log })
      const { signal } = handlers
      while (!signal.aborted) {
        if (!waiting.length) {
          await new Promise(resolve => {
            wake = resolve
            signal.addEventListener('abort', resolve, { once: true })
          })
          wake = null
          continue
        }
        await waiting.shift()(handlers)
      }
    }
  }
}

const harness = {
  spec: WEB,
  conversation: String,
  words: (text) => text,
  formats: false,
  credentials: {},
  botFile: (bot, table, fields = {}) => {
    const people = Object.entries(table).map(([who, { spore, spores, details, brief }]) => {
      const reach = spores ? { spores } : { spore }
      return [who, details || brief !== undefined || spores ? { ...reach, ...(details ? { details } : {}), ...(brief !== undefined ? { brief } : {}) } : spore]
    })
    return { people: Object.fromEntries(people), ...fields }
  },
  platform: standIn,
  adapter (stand, bot) {
    const live = createAdapter({ name: bot, log: stand.log, files: stand.files, receive: (handlers) => stand.receive(handlers) })
    const faulty = (op, after) => async (...args) => {
      stand.fault(op)
      const done = await live[op](...args)
      after?.(done, ...args)
      return done
    }
    return {
      ...live,
      post: faulty('post', (note, conversation, text, { answering = null, as = null } = {}) => stand.record(conversation, { op: 'post', note, text, answering: answering === null ? null : String(answering), formatted: false, as })),
      edit: faulty('edit', (done, conversation, note, text, { live: view = null } = {}) => stand.record(conversation, { op: 'edit', note, text, live: view })),
      remove: faulty('remove', (done, conversation, note) => stand.record(conversation, { op: 'remove', note })),
      upload: faulty('upload', (done, conversation, { path }, caption) => stand.record(conversation, { op: 'upload', path, caption })),
      fetch: faulty('fetch'),
      ask: async (conversation, ...rest) => {
        const asked = await live.ask(conversation, ...rest)
        const event = stand.log.after(conversation, Number(asked.note) - 1, 1)[0]
        stand.record(conversation, {
          op: 'ask',
          note: asked.note,
          text: JSON.stringify(event.body),
          choices: event.options.map(option => ({ label: option.label, data: `ap:${event.approval}:${option.id}`, style: option.style })),
          fields: event.fields.map(({ id, label, value, required, kind, choices, least, most, look }) => kind === 'choice'
            ? { id, label, choices, least, most, value, look }
            : { id, label, value: value ?? null, required: required ?? false })
        })
        return asked
      },
      settle: async (conversation, note, ...rest) => {
        const closed = await live.settle(conversation, note, ...rest)
        stand.record(conversation, { op: 'close', note: String(note), text: JSON.stringify(closed) })
        return closed
      }
    }
  },
  say (stand, { conversation, text, files = [], id = stand.nextId(), to = 'triage' }) {
    const uploads = files.map(file => {
      const upload = stand.files.newId()
      writeFileSync(stand.files.uploadPath(upload), file.data)
      stand.log.upload(upload, conversation, { name: file.name, mime: file.mime, bytes: file.data.length })
      return { upload, name: file.name, mime: file.mime, bytes: file.data.length }
    })
    const said = stand.log.say(conversation, id, { to, text: text ?? null, files: uploads, zone: null })
    if (!said.delivered) stand.push(({ deliver }) => deliver(said.event))
    return { id, message: String(said.event.seq), from: { name: conversation, id: `web:${conversation}`, where: 'the web page "triage"' } }
  },
  seen: (stand, conversation) => stand.seen(conversation).map(({ as, live, ...op }) => op),
  form: (stand, { conversation, note }) => harness.seen(stand, conversation).find(one => one.op === 'ask' && one.note === note).fields,
  press (stand, { data, person, inputs = null }) {
    const [, approval, choice] = /^ap:([0-9a-f]{12}):(.+)$/.exec(data)
    let heard
    stand.push(async ({ press }) => { heard = await press({ card: stand.log.cardOf(approval), choice, by: person, inputs }) })
    return { acknowledged: () => heard === undefined ? undefined : { text: heard.text } }
  },
  fail: (stand, op, error, times) => stand.fail(op, error, times),
  retryable: (retryAfter) => new SporeError('the page could not write it', { type: 'WEB_FAILED', retryable: true, detail: 'busy', context: { retryAfter } }),
  refused: (detail) => new SporeError('the page refused it', { type: 'WEB_FAILED', retryable: false, detail, context: { retryAfter: null } }),
  command: (verb, args) => `/${verb}${args ? ` ${args}` : ''}`
}

conformance(harness, (ctx) => {
  const spore = (name) => {
    const ws = join(ctx.root, 'home', name)
    mkdirSync(ws, { recursive: true })
    writeFileSync(join(ws, 'spore.cmk'), withAuth(definitionWith('anthropic/claude-haiku-4-5')))
    return ws
  }
  const asOf = (conversation, text) => ctx.platform.seen(conversation).find(op => op.op === 'post' && op.text === text)?.as

  describe('several spores', () => {
    it('reaches the one spore a message is for, which answers under its own name, and refuses one the person does not reach', async () => {
      const second = spore('second')
      ctx.routes({ 1: { spores: ['triage', 'second'] } })
      ctx.replying(async () => answers('from whoever'))
      ctx.start()
      ctx.say({ conversation: '1', text: 'hello second', to: 'second' })
      await ctx.until(() => ctx.posted('1', 'from whoever'))
      expect(asOf('1', 'from whoever')).toBe('second')
      expect(readInbox(second).map(entry => entry.text)).toEqual(['hello second'])
      expect(readInbox(ctx.ws)).toEqual([])

      ctx.say({ conversation: '1', text: 'hello stranger', to: 'elsewhere' })
      await ctx.until(() => ctx.posted('1', 'this conversation does not reach "elsewhere"'))
      expect(ctx.logs.some(line => line.includes('a message for "elsewhere", which it does not reach'))).toBe(true)
    })

    it('reaches, with "*", every spore in home as it stands, one made after the service started included', async () => {
      ctx.routes({ 1: { spores: ['*'] } })
      ctx.replying(async () => answers('here'))
      ctx.start()
      const late = spore('late')
      ctx.say({ conversation: '1', text: 'are you there', to: 'late' })
      await ctx.until(() => ctx.posted('1', 'here'))
      expect(asOf('1', 'here')).toBe('late')
      expect(readInbox(late).map(entry => entry.text)).toEqual(['are you there'])
    })
  })

  describe('a running turn', () => {
    it('is handed to the page as data with each edit, its calls and the answer so far', async () => {
      ctx.replying(async (input, round) => round === 0 ? calls('wsexec', { command: 'sleep 0.4', out: 'data/slept.txt' }) : answers('slept'))
      ctx.start()
      ctx.say({ conversation: '1', text: 'sleep a little' })
      await ctx.until(() => ctx.posted('1', 'slept'))
      const edits = ctx.platform.seen('1').filter(op => op.op === 'edit')
      expect(edits.some(op => op.live?.calls.length === 1)).toBe(true)
      expect(edits.every(op => op.live && Array.isArray(op.live.notes) && typeof op.live.text === 'string')).toBe(true)
    })

    it('is not handed as data to a brief conversation', async () => {
      ctx.routes({ 1: { spore: 'triage', brief: true } })
      ctx.replying(async (input, round) => round === 0 ? calls('wsexec', { command: 'sleep 0.4', out: 'data/slept.txt' }) : answers('slept'))
      ctx.start()
      ctx.say({ conversation: '1', text: 'sleep a little' })
      await ctx.until(() => ctx.posted('1', 'slept'))
      expect(ctx.platform.seen('1').filter(op => op.op === 'edit').every(op => op.live === null)).toBe(true)
    })
  })

  describe('over HTTP', () => {
    let port
    const ORIGIN = () => `http://127.0.0.1:${port}`

    const listening = () => {
      port = undefined
      ctx.platform.http = {
        host: '127.0.0.1',
        port: 0,
        file: join(ctx.root, 'web', 'triage.json'),
        configFile: join(ctx.root, 'config.json'),
        listening: (at) => { port = at }
      }
      ctx.start()
      return ctx.until(() => port)
    }

    const call = async (method, path, body, headers = {}) => {
      const response = await fetch(`${ORIGIN()}${path}`, {
        method,
        headers: { ...(method === 'POST' ? { origin: ORIGIN() } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined
      })
      const text = await response.text()
      return { status: response.status, body: text ? JSON.parse(text) : null }
    }

    it('says a message from the page once however often it is sent, and streams the answer to it', async () => {
      ctx.routes({ operator: { spore: 'triage' } })
      ctx.replying(async () => answers('checked it'))
      await listening()
      expect((await call('GET', '/api/me')).body).toMatchObject({ person: 'operator', spores: [{ name: 'triage', busy: false }] })

      const sent = await call('POST', '/api/messages', { id: 'c1', to: 'triage', text: 'check it' })
      expect(sent).toEqual({ status: 200, body: { seq: expect.any(Number), repeated: false } })
      expect((await call('POST', '/api/messages', { id: 'c1', to: 'triage', text: 'check it' })).body).toEqual({ seq: sent.body.seq, repeated: true })
      expect(readInbox(ctx.ws)).toHaveLength(1)
      expect(readInbox(ctx.ws)[0]).toMatchObject({ requestId: 'web:triage:c1:triage', replyTo: 'web:triage/operator', fromWhere: 'the web page "triage"' })

      const controller = new AbortController()
      const response = await fetch(`${ORIGIN()}/api/events`, { headers: { accept: 'text/event-stream', 'last-event-id': String(sent.body.seq) }, signal: controller.signal })
      expect(response.headers.get('content-type')).toBe('text/event-stream')
      const reader = response.body.getReader()
      let text = ''
      while (!text.includes('event: reply')) {
        const { value, done } = await reader.read()
        if (done) throw new Error(`the stream ended (${response.status}) before the reply — ${text}`)
        text += new TextDecoder().decode(value)
      }
      controller.abort()
      expect(text).toMatch(/^retry: 3000\n\n/)
      expect(text).not.toContain(`id: ${sent.body.seq}\n`)
      expect(text).toMatch(/id: \d+\nevent: reply\ndata: \{.*"text":"checked it"/)
    })

    it('takes a file the page uploaded with the message that names it, and keeps it no longer once said', async () => {
      ctx.routes({ operator: { spore: 'triage' } })
      ctx.replying(async () => answers('read it'))
      await listening()
      const uploaded = await fetch(`${ORIGIN()}/api/uploads`, { method: 'POST', headers: { origin: ORIGIN(), 'content-type': 'text/plain', 'x-file-name': encodeURIComponent('q3 notes.txt') }, body: 'numbers' })
      const { upload } = await uploaded.json()
      expect(uploaded.status).toBe(200)
      await call('POST', '/api/messages', { id: 'f1', to: 'triage', text: 'see this', files: [upload] })
      await ctx.until(() => ctx.posted('operator', 'read it'))
      expect(readInbox(ctx.ws)[0].text).toContain('see this')
      expect(ctx.platform.log.uploadOf(upload)).toBeNull()
      expect((await call('POST', '/api/messages', { id: 'f2', to: 'triage', text: 'again', files: [upload] })).status).toBe(410)
    })

    it('refuses a write from another origin, a stream read from another site, and a host that is not loopback', async () => {
      ctx.routes({ operator: { spore: 'triage' } })
      await listening()
      expect((await call('POST', '/api/messages', { id: 'x1', to: 'triage', text: 'hi' }, { origin: 'https://evil.example' })).status).toBe(403)
      expect((await call('GET', '/api/events', null, { 'sec-fetch-site': 'cross-site' })).status).toBe(403)
      const rebound = await new Promise((resolve, reject) => request({ host: '127.0.0.1', port, path: '/api/me', headers: { host: `evil.example:${port}` } }, response => {
        response.resume()
        resolve(response.statusCode)
      }).on('error', reject).end())
      expect(rebound).toBe(403)
      expect(readInbox(ctx.ws)).toEqual([])
    })

    it('behind a proxy, takes the person the header names from among its people, and no one else', async () => {
      ctx.routes({ ada: { spore: 'triage' } }, {}, { user: 'x-forwarded-user', origin: 'https://spores.example.org' })
      await listening()
      const proxied = (path, person, body) => call(body ? 'POST' : 'GET', path, body, { origin: 'https://spores.example.org', ...(person ? { 'x-forwarded-user': person } : {}) })
      expect((await proxied('/api/me', 'ada')).body).toMatchObject({ person: 'ada' })
      expect((await proxied('/api/me', null)).status).toBe(401)
      expect((await proxied('/api/me', 'bob')).body).toEqual({ error: '"bob" may not use this page — ask whoever runs it to add them' })
      expect(ctx.logs.some(line => line.includes('add "bob": "<a spore>" to its people'))).toBe(true)
      expect((await call('POST', '/api/messages', { id: 'p1', to: 'triage', text: 'hi' }, { 'x-forwarded-user': 'ada' })).status).toBe(403)
    })
  })
})
