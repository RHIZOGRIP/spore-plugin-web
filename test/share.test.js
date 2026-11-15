import { describe, it, expect, afterEach } from 'vitest'

import { join } from '../page/share.js'

let names = 0
let tabs = []

const until = async (check) => {
  for (let i = 0; i < 200; i++) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('never came')
}

const tab = (name) => {
  const shown = { heard: [], leads: 0, stops: 0, voice: null, shared: join(name) }
  shown.follow = () => shown.shared.follow({
    heard: (message) => shown.heard.push(message),
    lead: (voice) => {
      shown.leads += 1
      shown.voice = voice
      return () => { shown.stops += 1 }
    }
  })
  shown.leave = () => {
    shown.shared.leave()
    tabs = tabs.filter(one => one !== shown)
  }
  tabs.push(shown)
  return shown
}

const fresh = () => `spore-events:test-${process.pid}-${++names}`

afterEach(() => {
  for (const one of tabs) one.shared.leave()
  tabs = []
})

describe('one stream shared by the tabs of a browser', () => {
  it('is led by the first tab to follow, which tells every tab what it hears, itself included', async () => {
    const name = fresh()
    const [a, b, c] = [tab(name), tab(name), tab(name)]
    for (const one of [a, b, c]) one.follow()
    await until(() => a.leads === 1)
    a.voice.tell({ type: 'durable', event: { seq: 1 } })
    await until(() => b.heard.length && c.heard.length)
    for (const one of [a, b, c]) expect(one.heard).toEqual([{ type: 'durable', event: { seq: 1 } }])
    expect([b.leads, c.leads]).toEqual([0, 0])
  })

  it('passes to a tab still open when the leader leaves, and stops the leader\'s stream', async () => {
    const name = fresh()
    const [a, b] = [tab(name), tab(name)]
    a.follow()
    await until(() => a.leads === 1)
    b.follow()
    a.leave()
    expect(a.stops).toBe(1)
    await until(() => b.leads === 1)
    b.voice.tell({ type: 'durable', event: { seq: 2 } })
    expect(b.heard).toEqual([{ type: 'durable', event: { seq: 2 } }])
    expect(a.heard).toEqual([])
  })

  it('holds what it hears between joining and following, in order, and leads only once it follows', async () => {
    const name = fresh()
    const a = tab(name)
    a.follow()
    await until(() => a.leads === 1)
    const late = tab(name)
    a.voice.tell({ type: 'durable', event: { seq: 3 } })
    a.voice.tell({ type: 'durable', event: { seq: 4 } })
    await new Promise(resolve => setTimeout(resolve, 20))
    a.leave()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(late.leads).toBe(0)
    expect(late.heard).toEqual([])
    late.follow()
    expect(late.heard.map(one => one.event.seq)).toEqual([3, 4])
    await until(() => late.leads === 1)
  })

  it('tells a tab that joins late the leader\'s state', async () => {
    const name = fresh()
    const a = tab(name)
    a.follow()
    await until(() => a.leads === 1)
    a.voice.state({ type: 'connected', yes: false })
    const b = tab(name)
    b.follow()
    await until(() => b.heard.length === 1)
    expect(b.heard).toEqual([{ type: 'connected', yes: false }])
  })

  it('keeps the tabs of one person apart from another\'s', async () => {
    const [a, b] = [tab(fresh()), tab(fresh())]
    a.follow()
    b.follow()
    await until(() => a.leads === 1 && b.leads === 1)
    a.voice.tell({ type: 'durable', event: { seq: 5 } })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(b.heard).toEqual([])
  })
})
