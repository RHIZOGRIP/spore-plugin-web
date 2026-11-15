/**
 * The page's log: everything said in each person's conversation, in order, under a `seq` that
 * only grows and is never handed out twice, whatever the person. The page reads a conversation
 * back from the last `seq` it saw, so the log outlives the service; `said` keeps each message's
 * client id against its `seq`, so a message sent twice is said once.
 *
 * A running turn is not history: what its `working…` note shows is held in memory, replaced at
 * each edit, and gone with the note.
 */

import { EventEmitter } from 'node:events'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  seq       INTEGER PRIMARY KEY AUTOINCREMENT,
  at        TEXT    NOT NULL,
  person    TEXT    NOT NULL,
  type      TEXT    NOT NULL,
  approval  TEXT,
  body      TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS events_person ON events (person, seq);
CREATE INDEX IF NOT EXISTS events_card ON events (approval) WHERE type = 'card';
CREATE TABLE IF NOT EXISTS said (
  id         TEXT    PRIMARY KEY,
  seq        INTEGER NOT NULL REFERENCES events (seq),
  delivered  INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS uploads (
  id      TEXT    PRIMARY KEY,
  person  TEXT    NOT NULL,
  name    TEXT    NOT NULL,
  mime    TEXT,
  bytes   INTEGER NOT NULL,
  at      TEXT    NOT NULL
);
CREATE TABLE IF NOT EXISTS kept (
  id      TEXT    PRIMARY KEY,
  person  TEXT    NOT NULL,
  seq     INTEGER NOT NULL REFERENCES events (seq)
);
`

const ANSWERS = ['reply', 'question']

export function openLog (path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;')
  db.exec(SCHEMA)
  const heard = new EventEmitter().setMaxListeners(0)
  const running = new Map()
  const ended = new Set()

  const insert = db.prepare('INSERT INTO events (at, person, type, approval, body) VALUES (?, ?, ?, ?, ?) RETURNING seq')
  const bySeq = db.prepare('SELECT * FROM events WHERE seq = ?')
  const after = db.prepare('SELECT * FROM events WHERE person = ? AND seq > ? ORDER BY seq LIMIT ?')
  const before = db.prepare('SELECT * FROM events WHERE person = ? AND seq < ? ORDER BY seq DESC LIMIT ?')
  const card = db.prepare('SELECT * FROM events WHERE type = \'card\' AND approval = ?')
  const saidAs = db.prepare('SELECT seq, delivered FROM said WHERE id = ?')
  const keep = db.prepare('INSERT INTO said (id, seq) VALUES (?, ?)')
  const done = db.prepare('UPDATE said SET delivered = 1 WHERE id = ?')
  const covered = db.prepare(`SELECT COALESCE(MAX(j.value), 0) AS seq FROM events e, json_each(e.body, '$.answers') j WHERE e.person = ? AND e.type IN (${ANSWERS.map(() => '?').join(', ')})`)
  const asked = db.prepare('SELECT seq FROM events WHERE person = ? AND type = \'message\' AND seq > ? AND seq <= ? ORDER BY seq')
  const addUpload = db.prepare('INSERT INTO uploads (id, person, name, mime, bytes, at) VALUES (?, ?, ?, ?, ?, ?)')
  const uploadOf = db.prepare('SELECT * FROM uploads WHERE id = ?')
  const dropUpload = db.prepare('DELETE FROM uploads WHERE id = ?')
  const staleUploads = db.prepare('SELECT id FROM uploads WHERE at < ?')
  const addKept = db.prepare('INSERT INTO kept (id, person, seq) VALUES (?, ?, ?)')
  const lastOf = db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE person = ?')
  const keptOf = db.prepare('SELECT k.id, k.person, e.body FROM kept k JOIN events e ON e.seq = k.seq WHERE k.id = ?')

  const eventOf = (row) => ({ seq: row.seq, at: row.at, person: row.person, type: row.type, ...JSON.parse(row.body) })

  const write = (person, type, fields) => {
    const at = new Date().toISOString()
    const { seq } = insert.get(at, person, type, fields.approval ?? null, JSON.stringify(fields))
    return { seq, at, person, type, ...fields }
  }

  const told = (event) => {
    if (event.type === 'done') {
      ended.add(event.note)
      running.delete(event.note)
    }
    heard.emit('event', event)
  }

  return {
    append (person, type, fields) {
      const event = write(person, type, fields)
      if (type === 'file') addKept.run(fields.file, person, event.seq)
      told(event)
      return event
    },

    /**
     * What a person said, under the page's `id` for it: written with its `said` row in one
     * transaction, or the one written the first time that id came, with whether it reached the
     * spore then.
     */
    say (person, id, fields) {
      const found = saidAs.get(id)
      if (found) return { event: eventOf(bySeq.get(found.seq)), repeated: true, delivered: found.delivered === 1 }
      db.exec('BEGIN IMMEDIATE')
      let event
      try {
        event = write(person, 'message', { id, ...fields })
        keep.run(id, event.seq)
        db.exec('COMMIT')
      } catch (err) {
        db.exec('ROLLBACK')
        throw err
      }
      told(event)
      return { event, repeated: false, delivered: false }
    },

    said (id) {
      const found = saidAs.get(id)
      return found ? { event: eventOf(bySeq.get(found.seq)), delivered: found.delivered === 1 } : null
    },

    delivered: (id) => { done.run(id) },

    last: (person) => lastOf.get(person).seq,

    after: (person, seq, limit) => after.all(person, seq, limit).map(eventOf),

    before: (person, seq, limit) => before.all(person, seq, limit).map(eventOf).reverse(),

    cardOf (approval) {
      const row = card.get(approval)
      return row ? eventOf(row) : null
    },

    /** The messages of `person` up to `seq` that no answer has covered yet: what an answer to `seq` answers. */
    answering: (person, seq) => asked.all(person, covered.get(person, ...ANSWERS).seq, seq).map(row => row.seq),

    /** What the `working…` note `note` shows now; nothing once the note is done. */
    running (person, note, { text, live }) {
      if (ended.has(note)) return
      const shown = { person, note, spore: eventOf(bySeq.get(note)).spore, text, live }
      running.set(note, shown)
      heard.emit('running', shown)
    },

    runningOf: (person) => [...running.values()].filter(shown => shown.person === person),

    upload (id, person, { name, mime, bytes }) {
      addUpload.run(id, person, name, mime, bytes, new Date().toISOString())
    },

    uploadOf: (id) => uploadOf.get(id) ?? null,

    dropUpload: (id) => { dropUpload.run(id) },

    staleUploads: (at) => staleUploads.all(at).map(row => row.id),

    keptOf (id) {
      const row = keptOf.get(id)
      if (!row) return null
      const { name, mime } = JSON.parse(row.body)
      return { id: row.id, person: row.person, name, mime }
    },

    subscribe (person, { event, live }) {
      const onEvent = (one) => { if (one.person === person) event(one) }
      const onLive = (shown) => { if (shown.person === person) live(shown) }
      heard.on('event', onEvent)
      heard.on('running', onLive)
      return () => {
        heard.off('event', onEvent)
        heard.off('running', onLive)
      }
    },

    close: () => db.close()
  }
}
