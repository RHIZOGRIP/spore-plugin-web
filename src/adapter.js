/**
 * A web page for the relay (`@rhizogrip/spore/relay`): each person talks with their spores in a
 * browser. Each person the web file maps is one conversation, keyed by their name — `operator` on a
 * machine with no proxy, else the name the operator's proxy signs them in under. Every message is
 * addressed to one of the spores that person reaches, and everything said there is kept in the
 * page's log, which the page reads back by `seq`.
 */

import { randomBytes } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import { NAME, SporeError } from '@rhizogrip/spore'
import { commandOf, listenOf as listening } from '@rhizogrip/spore/relay'

const FIELDS = ['listen', 'origin', 'user', 'theme', 'shell', 'people']
const PERSON = /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,127}$/
const HEADER = /^[a-z0-9][a-z0-9-]{0,63}$/
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost'])
const SHAPE = '{ "people": { "operator": "*" } }'
const PORT = 7761

export const OPERATOR = 'operator'

const invalid = (path, problem, detail = `a web file is ${SHAPE}`) => new SporeError(`${path} ${problem}`, { type: 'WEB_BOT_INVALID', detail })

export const isPerson = (id) => typeof id === 'string' && PERSON.test(id)

/**
 * What the web file says beside its people. Without a proxy (`user`), a request is the operator's
 * only when its Host is the loopback address itself, so a page on another site that rebinds its
 * name to 127.0.0.1 is refused.
 */
export function webOf (raw, path) {
  const listen = listening(raw.listen, { port: PORT, refused: (problem, detail) => invalid(path, problem, detail) })
  if (!LOOPBACK.has(listen.host)) {
    throw invalid(path, `listens on ${listen.text}, beyond loopback`, 'the page trusts who a request names only from loopback — listen on 127.0.0.1, and put a proxy in front for anyone else')
  }
  if (raw.user !== undefined && !(typeof raw.user === 'string' && HEADER.test(raw.user))) {
    throw invalid(path, `has a user that is not a header name — ${JSON.stringify(raw.user)}`, 'user is the header the proxy names the signed-in person in, as "x-forwarded-user", in lower case')
  }
  let origin = null
  if (raw.origin !== undefined) {
    const url = typeof raw.origin === 'string' && URL.canParse(raw.origin) ? new URL(raw.origin) : null
    if (!url || !['http:', 'https:'].includes(url.protocol) || url.origin !== raw.origin) {
      throw invalid(path, `has an origin that is not one — ${JSON.stringify(raw.origin)}`, 'origin is the address the page is opened at, scheme, host and port only, as "https://spores.example.org"')
    }
    origin = url.origin
  }
  if (raw.user !== undefined && origin === null) {
    throw invalid(path, 'names a user header and no origin', 'behind a proxy, origin is the address people open the page at, as "https://spores.example.org" — every write must come from it')
  }
  let theme = null
  if (raw.theme !== undefined) {
    if (typeof raw.theme !== 'string' || !raw.theme) throw invalid(path, 'has a theme that is not a file', 'theme is a CSS file, absolute or beside the web file, setting the page\'s custom properties')
    theme = isAbsolute(raw.theme) ? raw.theme : resolve(dirname(path), raw.theme)
    if (!existsSync(theme)) throw invalid(path, `has a theme that is not there — ${theme}`, 'theme is a CSS file, absolute or beside the web file')
  }
  let shell = null
  if (raw.shell !== undefined) {
    const told = 'shell is { "name": "<what the page is called>", "links": [{ "label": "<text>", "href": "/<a path at this address>" }] }, for a site that serves pages of its own around this one'
    const { name, links } = raw.shell ?? {}
    if (typeof name !== 'string' || !name.trim() || name.length > 40) throw invalid(path, 'has a shell with no name, or one over 40 characters', told)
    if (!Array.isArray(links) || !links.length) throw invalid(path, 'has a shell with no links', told)
    for (const link of links) {
      if (typeof link?.label !== 'string' || !link.label.trim() || link.label.length > 40) throw invalid(path, `has a shell link with no label, or one over 40 characters — ${JSON.stringify(link)}`, told)
      if (typeof link.href !== 'string' || !/^\/(?![/\\])/.test(link.href)) throw invalid(path, `has a shell link that leaves this address — ${JSON.stringify(link.href)}`, told)
    }
    shell = { name, links: links.map(({ label, href }) => ({ label, href })) }
  }
  return {
    listen,
    user: raw.user ?? null,
    origin,
    theme,
    shell
  }
}

const CONVERSATIONS = {
  people: {
    noun: 'person',
    id: PERSON,
    says: 'which is not a person\'s name',
    fix: `a person is "${OPERATOR}" or the name the proxy signs them in under — letters, digits, ., _, @, + and -, at most 128`,
    called: `"${OPERATOR}" or the name the proxy signs them in under`,
    fields: ['spore', 'spores', 'details', 'brief']
  }
}

const HELP = 'Each message goes to the spore that is open. /status says what it is doing; /stop ends the turn it is running and sets aside what was sent that it had not read; /wrap [10m] asks it to wrap up; /flush starts the conversation over, forgetting nothing'
const EXTEND = '/extend wall 30m gives it more, as far as its spore.cmk allows'

export const WEB = {
  kind: 'web',
  label: 'web',
  noun: 'conversation',
  fields: FIELDS,
  credentials: [],
  stateFields: [],
  refusals: ['WEB_LISTEN_REFUSED'],
  example: SHAPE,
  conversations: CONVERSATIONS,
  check: webOf,
  usage: { help: `${HELP}; ${EXTEND}.`, briefHelp: `${HELP}.`, extend: '/extend wall 30m, /extend cost 1.50 or /extend rounds 20' },
  limits: { message: 1_000_000, file: 200 * 1024 * 1024, fetch: 100 * 1024 * 1024, editEveryMs: 150, typingEveryMs: 0 },
  can: { upload: true, edit: true, remove: true, react: false, typing: false, choose: true, live: true, fields: { text: true, choice: { several: true, list: 20, menu: 100 } } },
  reactions: null,
  showShared: 'working',
  hint (err, { file }) {
    if (err.type === 'WEB_LISTEN_REFUSED') return `another process holds that address — change listen in ${file}`
    return null
  },
  refusal: () => null
}

export const isSporeName = (name) => typeof name === 'string' && NAME.test(name)

/** What a person said, as the relay takes a message: addressed to the one spore the page had open. */
export function messageOf (name, event) {
  return {
    id: `${name}:${event.id}`,
    conversation: event.person,
    message: String(event.seq),
    person: { id: event.person, name: event.person, groups: [], zone: event.zone ?? null },
    spore: null,
    where: `the web page "${name}"`,
    shared: false,
    text: event.text,
    command: commandOf(event.text),
    addresses: [event.to],
    files: event.files.map(file => ({ name: file.name, mime: file.mime, bytes: file.bytes, ref: file.upload })),
    ...(event.traceparent ? { traceparent: event.traceparent } : {})
  }
}

const keyed = ({ native, fallback }) => native === null ? { default: fallback } : { web: native }

/**
 * The live adapter over the page's log. `receive({ deliver, press, signal, log })` is the transport
 * — the HTTP listener, or a test's: `deliver(event)` hands a message the log holds to the relay, and
 * `press({ card, choice, by, inputs })` a press on a card, answering `{ text, taken }`, as the relay
 * acknowledged it. A note is the `seq` of the event that posted it; what a turn handed back is
 * copied into `files`, so it stays downloadable after the workspace changes.
 */
export function createAdapter ({ name, log, files, receive }) {
  return {
    ...WEB,

    listen: ({ onMessage, onChoice, trace, signal, log: say }) => receive({
      signal,
      log: say,
      deliver: async (event) => {
        trace(`message ${event.id}`, event)
        await onMessage(messageOf(name, event))
        log.delivered(event.id)
      },
      press: async ({ card, choice, by, inputs }) => {
        trace(`press on ${card.approval}`, { choice, by, inputs })
        let heard = null
        await onChoice({
          conversation: card.person,
          data: `ap:${card.approval}:${choice}`,
          inputs,
          person: { id: by, name: by, groups: [] },
          acknowledge: async (text, how) => { heard = { text, taken: how?.taken === true } }
        })
        return heard
      }
    }),

    post: async (conversation, text, { answering = null, for: about = [], as = null, turn, origin } = {}) => {
      if (turn) {
        const answers = answering === null ? [] : log.answering(conversation, Number(answering))
        return String(log.append(conversation, turn.stopReason === 'question' ? 'question' : 'reply', { spore: as, text, answers, turn, origin }).seq)
      }
      if (about.length) return String(log.append(conversation, 'working', { spore: as, text }).seq)
      return String(log.append(conversation, 'notice', { spore: as, text }).seq)
    },

    edit: async (conversation, note, text, { live = null } = {}) => {
      log.running(conversation, Number(note), { text, live })
    },

    remove: async (conversation, note) => {
      log.append(conversation, 'done', { note: Number(note) })
    },

    upload: async (conversation, { path, mime }, caption, { as }) => {
      const id = files.keep(path)
      log.append(conversation, 'file', { spore: as, name: caption, mime, bytes: statSync(path).size, file: id })
    },

    fetch: async (ref, { most }) => files.upload(ref, { most }),

    checkBody: () => null,

    ask: async (conversation, shown, choices, { as, fields, approval }) => {
      const card = {
        body: keyed(shown),
        options: choices.map(({ id, label, style, skip }) => ({ id, label, style: style ?? null, skip: skip === true })),
        fields,
        by: approval.by,
        until: approval.until
      }
      const { seq } = log.append(conversation, 'card', { approval: approval.id, spore: as, ...card })
      return { note: String(seq), shown: card }
    },

    settle: async (conversation, note, replacement, { ended }) => {
      const closed = {
        note: Number(note),
        state: ended.state,
        choice: ended.choice,
        by: ended.by,
        outcome: ended.outcome,
        reason: ended.reason,
        ...(replacement.shown ? { closing: replacement.outcome } : { body: keyed(replacement) })
      }
      log.append(conversation, 'closed', { approval: ended.approval, ...closed })
      return closed
    },

    quiet: async (conversation, { turnNo, origin }) => {
      log.append(conversation, 'quiet', { turn: { turnNo, stopReason: 'quiet' }, origin })
    }
  }
}

/** Uploads waiting to reach a spore, and what turns handed back, each under an id of the page's own. */
export function openFiles (dir) {
  const uploads = join(dir, 'uploads')
  const kept = join(dir, 'files')
  mkdirSync(uploads, { recursive: true })
  mkdirSync(kept, { recursive: true })
  return {
    newId: () => randomBytes(12).toString('hex'),
    uploadPath: (id) => join(uploads, id),
    keptPath: (id) => join(kept, id),
    keep (path) {
      const id = randomBytes(12).toString('hex')
      copyFileSync(path, join(kept, id))
      return id
    },
    upload (id, { most }) {
      const path = join(uploads, id)
      const { size } = statSync(path)
      if (size > most) throw new SporeError('the file is larger than this page takes', { type: 'FILE_TOO_LARGE', detail: `more than ${most} bytes`, context: { bytes: size } })
      return readFileSync(path)
    }
  }
}
