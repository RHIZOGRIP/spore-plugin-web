import { marked } from './vendor/marked.js'
import DOMPurify from './vendor/purify.js'

import { join } from './share.js'

const $ = (id) => document.getElementById(id)
const AT_BOTTOM_PX = 80
const FRESH_MS = 1500
const PEEK_PX = 48
const RESEND_MS = 3000
const RECONNECT_MS = [1000, 2000, 5000, 10000, 30000]
const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone
const COMMANDS = [
  { verb: 'status', what: 'what it is doing' },
  { verb: 'stop', what: 'end the running turn' },
  { verb: 'wrap', what: 'ask it to wrap up, now or in a while', args: ' 10m' },
  { verb: 'extend', what: 'give the running turn more', args: ' wall 30m', full: true },
  { verb: 'flush', what: 'start the conversation over, forgetting nothing' }
]
const SANITIZE = {
  ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'del', 's', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li', 'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'input', 'span', 'sup', 'sub'],
  ALLOWED_ATTR: ['href', 'title', 'class', 'align', 'start', 'type', 'checked', 'disabled'],
  ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|#)/i
}

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noopener noreferrer')
  }
  if (node.tagName === 'INPUT' && node.getAttribute('type') !== 'checkbox') node.remove()
})

const page = {
  me: null,
  open: null,
  events: [],
  seqs: new Set(),
  drawn: new Set(),
  running: new Map(),
  threads: new Map(),
  outbox: [],
  attached: [],
  first: null,
  last: 0,
  shared: null,
  stuck: true,
  held: false
}

const threadOf = (spore) => {
  if (!page.threads.has(spore)) page.threads.set(spore, { scroll: null, draft: '', unread: false, info: null })
  return page.threads.get(spore)
}

const markdown = (text) => DOMPurify.sanitize(marked.parse(text, { gfm: true }), SANITIZE)

const json = async (path, body) => {
  const response = await fetch(path, body === undefined
    ? { headers: { accept: 'application/json' } }
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const answer = await response.json()
  if (!response.ok) throw Object.assign(new Error(answer.error ?? answer.reason ?? `${response.status}`), { status: response.status, answer })
  return answer
}

const announce = (() => {
  let last = ''
  let timer = null
  return (text) => {
    if (text === last) return
    last = text
    clearTimeout(timer)
    timer = setTimeout(() => { $('status').textContent = text }, 250)
  }
})()

const sporeOf = (event) => event.type === 'message' ? event.to : event.spore ?? null

const time = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
const day = (iso) => new Date(iso).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })

const element = (tag, props = {}, ...children) => {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value
    else if (key === 'text') node.textContent = value
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value)
    else if (value !== null && value !== undefined && value !== false) node.setAttribute(key, value === true ? '' : value)
  }
  for (const child of children) if (child) node.append(child)
  return node
}

const SVG = 'http://www.w3.org/2000/svg'

const glyph = (name) => {
  const svg = document.createElementNS(SVG, 'svg')
  svg.setAttribute('class', 'glyph')
  svg.setAttribute('aria-hidden', 'true')
  const use = document.createElementNS(SVG, 'use')
  use.setAttribute('href', `#i-${name}`)
  svg.append(use)
  return svg
}

const heading = (who) => element('h3', { class: 'sr-only', text: who })

const withCopy = (root) => {
  for (const pre of root.querySelectorAll('pre')) {
    const language = /(?:^|\s)language-(\S+)/.exec(pre.querySelector('code')?.className ?? '')?.[1] ?? ''
    const button = element('button', { type: 'button', class: 'copy', 'aria-label': 'Copy', title: 'Copy' }, glyph('copy'))
    button.addEventListener('click', async () => {
      await navigator.clipboard.writeText(pre.querySelector('code')?.textContent ?? pre.textContent)
      button.replaceChildren(glyph('check'))
      $('status').textContent = 'Copied'
      setTimeout(() => button.replaceChildren(glyph('copy')), 1500)
    })
    const block = element('div', { class: 'code' }, element('div', { class: 'code-head' }, element('span', { text: language }), button))
    pre.replaceWith(block)
    block.append(pre)
  }
  return root
}

const fileChip = (event) => {
  const link = element('a', { href: `/files/${event.file}`, download: event.name.split('/').at(-1), text: event.name.split('/').at(-1) })
  const chip = element('li', { class: 'file' }, glyph('download'), link)
  if (/^image\/(png|jpeg|gif|webp)$/.test(event.mime ?? '')) {
    return element('li', {}, element('img', { class: 'picture', src: `/files/${event.file}`, alt: event.name }), chip)
  }
  return chip
}

const cardBody = (body) => {
  const shown = body.web ?? body.default
  const box = element('div')
  if (typeof shown?.text === 'string') box.append(withCopy(Object.assign(element('div', { class: 'answer' }), { innerHTML: markdown(shown.text) })))
  if (Array.isArray(shown?.facts) && shown.facts.length) {
    const list = element('dl')
    for (const fact of shown.facts) list.append(element('dt', { text: fact.title ?? fact[0] }), element('dd', { text: fact.value ?? fact[1] }))
    box.append(list)
  }
  return box
}

const fieldOf = (field) => {
  if (field.kind === 'choice') {
    if (field.look === 'menu') {
      const select = element('select', { name: field.id, multiple: field.most > 1 })
      for (const choice of field.choices) select.append(element('option', { value: choice.id, text: choice.label, selected: field.value?.includes(choice.id) }))
      return element('label', {}, document.createTextNode(field.label), select)
    }
    const set = element('fieldset', {}, element('legend', { text: field.label }))
    for (const choice of field.choices) {
      set.append(element('label', {}, element('input', { type: field.most > 1 ? 'checkbox' : 'radio', name: field.id, value: choice.id, checked: field.value?.includes(choice.id) }), document.createTextNode(` ${choice.label}`)))
    }
    return set
  }
  return element('label', {}, document.createTextNode(field.label), element('input', { type: 'text', name: field.id, value: field.value ?? '', required: field.required }))
}

const inputsOf = (form, fields) => {
  const data = new FormData(form)
  return Object.fromEntries(fields.map(field => [field.id, field.kind === 'choice' ? data.getAll(field.id) : (data.get(field.id) ?? '')]))
}

const outcomeText = (closed, options) => closed.state === 'expired'
  ? 'expired — nobody answered in time'
  : `answered${closed.by ? ` by ${closed.by.name ?? closed.by.id}` : ''}${closed.choice ? ` — ${options.find(option => option.id === closed.choice).label}` : ''}${closed.outcome ? ` · ${closed.outcome}` : ''}${closed.reason ? ` · ${closed.reason}` : ''}`

const card = (event) => {
  const closed = page.events.find(one => one.type === 'closed' && one.note === event.seq) ?? null
  const form = element('form', { class: 'card' })
  form.append(heading(`${event.spore} asks for approval`), cardBody(closed?.body ?? event.body))
  if (closed) {
    form.classList.add('closed')
    form.append(element('p', { class: 'outcome' }, closed.state === 'expired' ? null : glyph('check'), document.createTextNode(outcomeText(closed, event.options))))
    return form
  }
  form.append(...event.fields.map(fieldOf))
  const choices = element('div', { class: 'choices' })
  for (const option of event.options) {
    choices.append(element('button', {
      type: 'submit',
      class: `choice${option.style === 'primary' || option.style === 'positive' ? ' primary' : option.style === 'destructive' || option.style === 'danger' ? ' danger' : ''}`,
      value: option.id,
      formnovalidate: option.skip,
      text: option.label
    }))
  }
  form.append(choices)
  const outcome = element('p', { class: 'outcome', text: `until ${new Date(event.until).toLocaleString()}` })
  form.append(outcome)
  form.addEventListener('submit', async (submitted) => {
    submitted.preventDefault()
    const choice = submitted.submitter?.value
    for (const button of choices.querySelectorAll('button')) button.disabled = true
    try {
      const heard = await json(`/api/approvals/${event.approval}/answer`, { choice, inputs: event.fields.length ? inputsOf(form, event.fields) : null })
      outcome.textContent = heard.text ?? 'recorded'
    } catch (err) {
      outcome.textContent = err.answer?.reason ?? err.message
      for (const button of choices.querySelectorAll('button')) button.disabled = false
    }
  })
  return form
}

const elapsed = (since) => {
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(since)) / 1000))
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`
}

const workingOf = (shown, since) => {
  const live = page.running.has(shown.note)
  const row = element('details', { class: `working${live ? ' live' : ''}` })
  row.append(element('summary', {}, element('span', { class: 'verb', text: shown.line.split('\n')[0] }), live ? element('span', { class: 'elapsed', 'data-since': since, 'aria-hidden': 'true', text: elapsed(since) }) : null))
  if (shown.live) {
    const list = element('ul')
    if (shown.live.annotation) list.append(element('li', { text: shown.live.annotation }))
    for (const note of shown.live.notes) list.append(element('li', { text: note.text }))
    for (const call of shown.live.calls) list.append(element('li', { class: call.ending === 'failed' ? 'failed' : call.done ? 'ended' : 'going', text: `${call.title}${call.done ? (call.ending ? ` — ${call.ending}` : '') : ' …'}` }, call.done && !call.ending ? glyph('check') : null))
    if (shown.live.wrapping) list.append(element('li', { text: `wrapping up — reached its ${shown.live.wrapping} limit` }))
    row.append(list)
  } else {
    for (const line of shown.line.split('\n').slice(1)) row.append(element('div', { text: line }))
  }
  return row
}

const item = (event) => {
  if (event.type === 'message') {
    const box = element('div', { class: `item said${event.pending ? ' pending' : ''}${event.failed ? ' failed' : ''}`, title: time(event.at), 'data-said': event.id })
    box.append(heading('You said'))
    if (event.text !== null) box.append(element('div', { class: 'bubble', text: event.text }))
    if (event.files.length) box.append(element('ul', { class: 'files' }, ...event.files.map(file => element('li', { class: 'file', text: file.name }))))
    if (event.failed) box.append(element('div', { class: 'why', text: event.failed }))
    return box
  }
  if (event.type === 'reply' || event.type === 'question') {
    const box = element('div', { class: 'item', title: time(event.at) }, heading(`${event.spore} answered`))
    if (event.type === 'question') box.append(element('div', { class: 'asks', text: 'asks' }))
    box.append(withCopy(Object.assign(element('div', { class: 'answer' }), { innerHTML: markdown(event.text) })))
    return box
  }
  if (event.type === 'notice') return element('div', { class: 'item notice', title: time(event.at), text: event.text })
  if (event.type === 'file') return element('ul', { class: 'item files' }, fileChip(event))
  if (event.type === 'card') return element('div', { class: 'item', title: time(event.at) }, card(event))
  if (event.type === 'working') {
    if (page.events.some(one => one.type === 'done' && one.note === event.seq)) return null
    const box = element('div', { class: 'item', 'data-note': event.seq })
    const shown = page.running.get(event.seq) ?? { note: event.seq, line: event.text, live: null, text: '' }
    if (shown.text) box.append(withCopy(Object.assign(element('div', { class: 'answer preview' }), { innerHTML: markdown(shown.text) })))
    box.append(workingOf(shown, event.at))
    return box
  }
  return null
}

const shownIn = (spore) => (event) => {
  if (!['message', 'reply', 'question', 'notice', 'file', 'card', 'working'].includes(event.type)) return false
  const owner = sporeOf(event)
  return owner === spore || (owner === null && event.type === 'notice')
}

const thread = $('thread')
const column = $('column')

const atBottom = () => thread.scrollHeight - thread.scrollTop - thread.clientHeight < AT_BOTTOM_PX

const toBottom = () => { thread.scrollTop = thread.scrollHeight }

const paintLatest = () => {
  const last = column.lastElementChild
  $('latest').hidden = last === null || last.getBoundingClientRect().bottom - thread.getBoundingClientRect().bottom < AT_BOTTOM_PX
}

const pinSaid = (id) => {
  const said = column.querySelector(`[data-said="${id}"]`)
  const top = Math.max(0, said.getBoundingClientRect().top - column.getBoundingClientRect().top - PEEK_PX)
  column.style.minHeight = `${top + thread.clientHeight}px`
  page.held = true
  page.stuck = false
  thread.scrollTo({ top, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
}

new window.ResizeObserver(() => {
  if (page.stuck && !page.held) toBottom()
  paintLatest()
}).observe(column)

thread.addEventListener('scroll', () => {
  page.stuck = atBottom()
  paintLatest()
})

$('latest').addEventListener('click', () => {
  page.held = false
  page.stuck = true
  toBottom()
})

const render = () => {
  const spore = page.open
  column.replaceChildren()
  if (spore === null) return
  const events = page.events.filter(shownIn(spore))
  if (page.first !== null && page.first > 1) column.append(element('button', { type: 'button', class: 'earlier', text: 'Load earlier', onclick: earlier }))
  if (!events.length) {
    const info = threadOf(spore).info
    column.append(element('div', { class: 'empty' }, element('h2', { text: spore }), info?.description ? element('p', { text: info.description }) : null))
    return
  }
  let lastDay = null
  for (const event of events) {
    const today = day(event.at)
    if (today !== lastDay) {
      column.append(element('div', { class: 'day', text: today }))
      lastDay = today
    }
    const node = item(event)
    if (!node) continue
    const key = event.type === 'message' ? `said:${event.id}` : event.seq
    if (!page.drawn.has(key) && event.type !== 'reply' && event.type !== 'question' && Date.now() - Date.parse(event.at) < FRESH_MS) node.classList.add('fresh')
    page.drawn.add(key)
    column.append(node)
  }
}

setInterval(() => {
  for (const shown of column.querySelectorAll('.elapsed')) shown.textContent = elapsed(shown.dataset.since)
}, 1000)

const paintSpores = () => {
  const list = $('spores')
  list.replaceChildren()
  for (const spore of page.me.spores) {
    const t = threadOf(spore.name)
    const asked = page.events.some(event => event.type === 'card' && event.spore === spore.name && Date.parse(event.until) > Date.now() && !page.events.some(one => one.type === 'closed' && one.note === event.seq))
    const state = asked ? ['asks', 'asks for your answer'] : t.unread ? ['unread', 'new'] : spore.busy ? ['busy', 'working'] : ['', null]
    list.append(element('li', {}, element('button', {
      type: 'button',
      'aria-current': spore.name === page.open ? 'true' : 'false',
      onclick: () => open(spore.name)
    }, element('span', { class: 'name', text: spore.name }), element('span', { class: `dot ${state[0]}`, role: state[1] ? 'img' : null, 'aria-label': state[1] }))))
  }
}

const busy = (spore) => [...page.running.values()].some(shown => shown.spore === spore)

const paintComposer = () => {
  const send = $('send')
  const stopping = page.open !== null && busy(page.open) && !$('input').value.trim() && !page.attached.length
  const label = stopping ? 'Stop' : 'Send'
  if (send.getAttribute('aria-label') !== label) {
    send.replaceChildren(glyph(stopping ? 'stop' : 'send'))
    send.setAttribute('aria-label', label)
    send.title = label
  }
  send.classList.toggle('stop', stopping)
  send.disabled = page.open === null || page.attached.some(one => one.id === null)
}

const open = async (spore) => {
  if (page.open !== null) {
    const t = threadOf(page.open)
    t.scroll = page.stuck ? null : thread.scrollTop
    t.draft = $('input').value
  }
  page.open = spore
  const t = threadOf(spore)
  t.unread = false
  $('title').textContent = spore
  document.title = `${spore} · ${page.me.shell ? page.me.shell.name : 'spore'}`
  $('input').value = t.draft
  $('app').classList.remove('drawer')
  $('scrim').hidden = true
  try {
    window.localStorage.setItem('spore-open', spore)
  } catch (err) {
    console.warn('the spore last open could not be remembered', err)
  }
  column.style.minHeight = ''
  page.held = false
  render()
  paintSpores()
  paintComposer()
  page.stuck = t.scroll === null
  if (page.stuck) toBottom()
  else thread.scrollTop = t.scroll
  paintLatest()
  if (t.info === null) {
    t.info = await json(`/api/spores/${encodeURIComponent(spore)}`)
    if (page.open === spore && !page.events.some(shownIn(spore))) render()
  }
}

const added = (event) => {
  if (page.seqs.has(event.seq)) return false
  page.seqs.add(event.seq)
  page.events.push(event)
  page.last = Math.max(page.last, event.seq)
  return true
}

const heardEvent = (event) => {
  if (event.type === 'message') {
    const mine = page.outbox.findIndex(one => one.id === event.id)
    if (mine !== -1) {
      page.events.splice(page.events.indexOf(page.outbox[mine].shown), 1)
      page.outbox.splice(mine, 1)
    }
  }
  if (!added(event)) return
  if (event.type === 'done') {
    page.running.delete(event.note)
    if (!busy(page.open)) page.held = false
  }
  const spore = sporeOf(event)
  if (event.type === 'reply' || event.type === 'question') {
    announce(`${event.spore} ${event.type === 'question' ? 'asks' : 'answered'}`)
    if (spore !== page.open) threadOf(spore).unread = true
    notify(event)
  }
  if (event.type === 'card') announce(`${event.spore} asks for approval`)
  if (event.type === 'closed' || event.type === 'done' || spore === page.open || (spore === null && event.type === 'notice')) render()
  refreshBusy()
}

const refreshBusy = () => {
  if (!page.me) return
  for (const spore of page.me.spores) spore.busy = busy(spore.name)
  paintSpores()
  paintComposer()
}

const notify = (event) => {
  if (!document.hidden || !('Notification' in window) || window.Notification.permission !== 'granted') return
  const shown = new window.Notification(event.spore, { body: event.text.slice(0, 180), tag: `spore-${event.spore}` })
  shown.addEventListener('click', () => {
    window.focus()
    open(event.spore)
  })
}

const paintRunning = (note) => {
  const shown = page.running.get(note)
  if (!shown || shown.spore !== page.open) return
  const box = column.querySelector(`[data-note="${note}"]`)
  if (!box) return render()
  const wasOpen = box.querySelector('details')?.open ?? false
  const row = workingOf(shown, page.events.find(event => event.seq === note).at)
  row.open = wasOpen
  const preview = shown.text ? withCopy(Object.assign(element('div', { class: 'answer preview' }), { innerHTML: markdown(shown.text) })) : null
  box.replaceChildren(...[preview, row].filter(Boolean))
}

const repaint = (() => {
  const waiting = new Set()
  let frame = null
  return (note) => {
    waiting.add(note)
    if (frame !== null) return
    frame = window.requestAnimationFrame(() => {
      frame = null
      for (const one of waiting) paintRunning(one)
      waiting.clear()
    })
  }
})()

const heardWorking = ({ note, spore, line, live }) => {
  const before = page.running.get(note)
  if (!before) announce(`${spore} is working`)
  page.running.set(note, { note, spore, line, live, text: before?.text ?? '' })
  repaint(note)
  if (!before) refreshBusy()
}

const heardText = ({ note, text }) => {
  const shown = page.running.get(note)
  if (!shown) return
  shown.text = text
  repaint(note)
}

const connected = (yes) => {
  const line = $('connection')
  line.hidden = yes
  line.textContent = yes ? '' : 'Not connected. What you send waits here, and goes out when the connection is back.'
}

const DURABLE = ['message', 'reply', 'question', 'notice', 'working', 'done', 'file', 'card', 'closed', 'quiet']

const lead = ({ tell, state }) => {
  let source = null
  let timer = null
  let tries = 0
  const connect = () => {
    const sent = new Map()
    source = new window.EventSource(`/api/events?after=${page.last}`)
    const durable = (raw) => {
      const event = JSON.parse(raw.data)
      if (event.type === 'done') sent.delete(event.note)
      tell({ type: 'durable', event })
    }
    for (const type of DURABLE) source.addEventListener(type, durable)
    source.addEventListener('running', (raw) => tell({ type: 'running', shown: JSON.parse(raw.data) }))
    source.addEventListener('text', (raw) => {
      const { note, add, text } = JSON.parse(raw.data)
      const whole = text !== undefined ? text : (sent.get(note) ?? '') + add
      sent.set(note, whole)
      tell({ type: 'text', note, text: whole })
    })
    source.addEventListener('reset', () => tell({ type: 'reset' }))
    source.addEventListener('bye', () => {
      source.close()
      timer = setTimeout(connect, RECONNECT_MS[0])
    })
    source.addEventListener('open', () => {
      tries = 0
      state({ type: 'connected', yes: true })
    })
    source.addEventListener('error', () => {
      state({ type: 'connected', yes: false })
      if (source.readyState !== window.EventSource.CLOSED) return
      timer = setTimeout(connect, RECONNECT_MS[Math.min(tries, RECONNECT_MS.length - 1)])
      tries += 1
    })
  }
  connect()
  return () => {
    clearTimeout(timer)
    source.close()
  }
}

const heard = (message) => {
  if (message.type === 'durable') return heardEvent(message.event)
  if (message.type === 'running') return heardWorking(message.shown)
  if (message.type === 'text') return heardText(message)
  if (message.type === 'connected') return connected(message.yes)
  if (message.type === 'reset') return window.location.reload()
}

const runningOf = (shown) => ({ note: shown.note, spore: shown.spore, line: shown.text, live: shown.live === null ? null : { ...shown.live }, text: shown.live?.text ?? '' })

const catchUp = async () => {
  const missed = []
  let running = null
  let before = null
  for (;;) {
    const answer = await json(before === null ? '/api/history' : `/api/history?before=${before}`)
    running ??= answer.running
    missed.unshift(...answer.events.filter(event => event.seq > page.last))
    if (!answer.events.length || answer.events[0].seq <= page.last) break
    before = answer.events[0].seq
  }
  for (const event of missed) heardEvent(event)
  for (const shown of running) page.running.set(shown.note, runningOf(shown))
  refreshBusy()
  render()
}

const earlier = async () => {
  const { events } = await json(`/api/history?before=${page.first}`)
  const height = thread.scrollHeight
  for (const event of events) added(event)
  page.events.sort((a, b) => a.seq - b.seq)
  page.first = events.length ? events[0].seq : 1
  render()
  thread.scrollTop = thread.scrollHeight - height
}

const deliver = async (one) => {
  try {
    await json('/api/messages', one.body)
  } catch (err) {
    if (err.status === undefined || err.status >= 500) {
      setTimeout(() => deliver(one), RESEND_MS)
      return
    }
    one.shown.pending = false
    one.shown.failed = err.message
    if (sporeOf(one.shown) === page.open) render()
  }
}

const say = (text) => {
  const files = page.attached.filter(one => one.id !== null)
  const id = crypto.randomUUID()
  const body = { id, to: page.open, text: text || null, files: files.map(one => one.id), zone: ZONE }
  const shown = { seq: Infinity, at: new Date().toISOString(), type: 'message', id, to: page.open, text: body.text, files: files.map(one => ({ name: one.name })), pending: true }
  page.events.push(shown)
  const one = { id, body, shown }
  page.outbox.push(one)
  page.attached = []
  $('attached').replaceChildren()
  if (body.text?.startsWith('/')) {
    page.stuck = true
    render()
  } else {
    render()
    pinSaid(id)
  }
  deliver(one)
  if ('Notification' in window && window.Notification.permission === 'default') window.Notification.requestPermission()
}

const submit = () => {
  const input = $('input')
  const text = input.value.trim()
  if (!text && !page.attached.length) {
    if (busy(page.open)) {
      say('/stop')
    }
    return
  }
  input.value = ''
  threadOf(page.open).draft = ''
  hideCommands()
  say(text)
  paintComposer()
}

const attach = async (file) => {
  const chip = { id: null, name: file.name }
  page.attached.push(chip)
  const remove = element('button', { type: 'button', 'aria-label': `Remove ${file.name}` }, glyph('close'))
  const li = element('li', { class: 'file' }, document.createTextNode(file.name), remove)
  remove.addEventListener('click', () => {
    page.attached.splice(page.attached.indexOf(chip), 1)
    li.remove()
    paintComposer()
  })
  $('attached').append(li)
  paintComposer()
  if (page.me.files !== 0 && file.size > page.me.files) {
    li.firstChild.textContent = `${file.name} — larger than this page takes`
    page.attached.splice(page.attached.indexOf(chip), 1)
    return
  }
  try {
    const response = await fetch('/api/uploads', { method: 'POST', headers: { 'content-type': file.type || 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name) }, body: file })
    const answer = await response.json()
    if (!response.ok) throw new Error(answer.error)
    chip.id = answer.upload
  } catch (err) {
    li.firstChild.textContent = `${file.name} — ${err.message}`
    page.attached.splice(page.attached.indexOf(chip), 1)
  }
  paintComposer()
}

const commandsFor = (text) => {
  if (!text.startsWith('/') || text.includes(' ') || text.includes('\n')) return []
  return COMMANDS.filter(one => !(one.full && page.me.brief) && one.verb.startsWith(text.slice(1)))
}

let picked = 0

const hideCommands = () => {
  $('commands').hidden = true
}

const paintCommands = () => {
  const found = commandsFor($('input').value)
  const list = $('commands')
  if (!found.length) return hideCommands()
  picked = Math.min(picked, found.length - 1)
  list.replaceChildren(...found.map((one, i) => element('li', {
    role: 'option',
    'aria-selected': i === picked ? 'true' : 'false',
    onmousedown: (pressed) => {
      pressed.preventDefault()
      choose(one)
    }
  }, element('span', { text: `/${one.verb}` }), element('span', { class: 'what', text: one.what }))))
  list.hidden = false
}

const choose = (one) => {
  const input = $('input')
  input.value = `/${one.verb}${one.args ?? ''}`
  hideCommands()
  input.focus()
  if (one.args) input.setSelectionRange(one.verb.length + 2, input.value.length)
}

const input = $('input')

// iOS Safari keeps dvh at the full height while the keyboard is up; the visual viewport is what is left.
window.visualViewport.addEventListener('resize', () => {
  document.documentElement.style.setProperty('--seen-height', `${window.visualViewport.height}px`)
})

if (!window.CSS?.supports?.('field-sizing', 'content')) {
  input.addEventListener('input', () => {
    input.style.height = 'auto'
    input.style.height = `${input.scrollHeight}px`
  })
}

input.addEventListener('input', () => {
  paintCommands()
  paintComposer()
})

input.addEventListener('keydown', (pressed) => {
  if (pressed.isComposing || pressed.keyCode === 229) return
  const found = $('commands').hidden ? [] : commandsFor(input.value)
  if (found.length && (pressed.key === 'ArrowDown' || pressed.key === 'ArrowUp')) {
    pressed.preventDefault()
    picked = (picked + (pressed.key === 'ArrowDown' ? 1 : found.length - 1)) % found.length
    return paintCommands()
  }
  if (found.length && (pressed.key === 'Tab' || pressed.key === 'Enter')) {
    pressed.preventDefault()
    return choose(found[picked])
  }
  if (pressed.key === 'Escape') {
    if (!$('commands').hidden) return hideCommands()
    if (busy(page.open)) say('/stop')
    return
  }
  if (pressed.key === 'Enter' && !pressed.shiftKey) {
    pressed.preventDefault()
    submit()
  }
})

$('composer').addEventListener('submit', (submitted) => {
  submitted.preventDefault()
  submit()
})

$('attach').addEventListener('click', () => $('picker').click())
$('picker').addEventListener('change', () => {
  for (const file of $('picker').files) attach(file)
  $('picker').value = ''
})

input.addEventListener('paste', (pasted) => {
  const files = [...(pasted.clipboardData?.files ?? [])]
  if (!files.length) return
  pasted.preventDefault()
  for (const file of files) attach(file)
})

const box = $('box')
const main = document.querySelector('.main')
main.addEventListener('dragover', (dragged) => {
  if (!dragged.dataTransfer?.types.includes('Files')) return
  dragged.preventDefault()
  box.classList.add('dropping')
})
main.addEventListener('dragleave', () => box.classList.remove('dropping'))
main.addEventListener('drop', (dropped) => {
  if (!dropped.dataTransfer?.files.length) return
  dropped.preventDefault()
  box.classList.remove('dropping')
  for (const file of dropped.dataTransfer.files) attach(file)
})

const MODES = ['system', 'light', 'dark']
const paintMode = () => {
  const mode = document.documentElement.dataset.theme ?? 'system'
  $('mode').setAttribute('aria-label', `Colour scheme: ${mode}`)
  $('mode').title = `Colour scheme: ${mode}`
}
$('mode').addEventListener('click', () => {
  const now = document.documentElement.dataset.theme ?? 'system'
  const next = MODES[(MODES.indexOf(now) + 1) % MODES.length]
  if (next === 'system') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = next
  try {
    if (next === 'system') window.localStorage.removeItem('spore-mode')
    else window.localStorage.setItem('spore-mode', next)
  } catch (err) {
    console.warn('the colour scheme could not be remembered', err)
  }
  paintMode()
})

$('menu').addEventListener('click', () => {
  const opened = $('app').classList.toggle('drawer')
  $('menu').setAttribute('aria-expanded', String(opened))
  $('scrim').hidden = !opened
})
document.addEventListener('click', (clicked) => {
  if (!$('shell').contains(clicked.target)) $('shell').open = false
})
$('shell').addEventListener('keydown', (pressed) => {
  if (pressed.key !== 'Escape' || !$('shell').open) return
  pressed.stopPropagation()
  $('shell').open = false
  $('shell-name').focus()
})
$('scrim').addEventListener('click', () => {
  $('app').classList.remove('drawer')
  $('scrim').hidden = true
})

const switcher = (() => {
  let found = []
  let at = 0
  const paint = () => {
    const words = $('filter').value.toLowerCase()
    found = page.me.spores.filter(spore => spore.name.toLowerCase().includes(words))
    at = Math.min(at, Math.max(found.length - 1, 0))
    $('matches').replaceChildren(...found.map((spore, i) => element('li', {
      role: 'option',
      'aria-selected': i === at ? 'true' : 'false',
      text: spore.name,
      onmousedown: (pressed) => {
        pressed.preventDefault()
        pick(spore.name)
      }
    })))
  }
  const close = () => {
    $('switcher').hidden = true
    input.focus()
  }
  const pick = (name) => {
    close()
    open(name)
  }
  $('filter').addEventListener('input', () => {
    at = 0
    paint()
  })
  $('filter').addEventListener('keydown', (pressed) => {
    if (pressed.key === 'Escape') return close()
    if (pressed.key === 'ArrowDown' || pressed.key === 'ArrowUp') {
      pressed.preventDefault()
      at = (at + (pressed.key === 'ArrowDown' ? 1 : found.length - 1)) % Math.max(found.length, 1)
      return paint()
    }
    if (pressed.key === 'Enter' && found[at]) pick(found[at].name)
  })
  $('switcher').addEventListener('mousedown', (pressed) => { if (pressed.target === $('switcher')) close() })
  return () => {
    $('filter').value = ''
    at = 0
    paint()
    $('switcher').hidden = false
    $('filter').focus()
  }
})()

document.addEventListener('keydown', (pressed) => {
  if ((pressed.ctrlKey || pressed.metaKey) && pressed.key.toLowerCase() === 'k') {
    pressed.preventDefault()
    switcher()
  }
})

const channelOf = () => `spore-events:${page.me.person}`

window.addEventListener('pagehide', () => page.shared?.leave())
window.addEventListener('pageshow', async (shown) => {
  if (!shown.persisted || page.shared === null) return
  page.shared = join(channelOf())
  await catchUp()
  page.shared.follow({ heard, lead })
})

const start = async () => {
  paintMode()
  try {
    page.me = await json('/api/me')
  } catch (err) {
    column.replaceChildren(element('div', { class: 'empty' }, element('h2', { text: 'Not here' }), element('p', { text: err.message })))
    $('composer').hidden = true
    return
  }
  if (page.me.shell) {
    $('who').hidden = true
    $('shell-name').textContent = page.me.shell.name
    $('shell-links').replaceChildren(...page.me.shell.links.map(link => element('li', {}, element('a', { href: link.href, text: link.label }))))
    $('shell').hidden = false
  } else {
    $('who').textContent = page.me.person
  }
  const shared = join(channelOf())
  const { events, running } = await json('/api/history')
  for (const event of events) added(event)
  page.first = events.length ? events[0].seq : 1
  for (const shown of running) page.running.set(shown.note, runningOf(shown))
  let remembered = null
  try {
    remembered = window.localStorage.getItem('spore-open')
  } catch (err) {
    console.warn('the spore last open could not be read', err)
  }
  const names = page.me.spores.map(spore => spore.name)
  if (!names.length) {
    column.replaceChildren(element('div', { class: 'empty' }, element('h2', { text: 'No spores' }), element('p', { text: 'This page reaches no spore yet.' })))
    $('composer').hidden = true
    shared.leave()
    return
  }
  page.shared = shared
  shared.follow({ heard, lead })
  await open(names.includes(remembered) ? remembered : names[0])
  input.focus()
}

start()
