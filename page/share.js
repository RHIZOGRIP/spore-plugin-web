/**
 * One live stream per browser: the tab holding the lock leads, following the server and telling
 * every tab what it hears; when it leaves, the lock passes to a tab waiting on it.
 *
 * Join before reading history and follow after: what the channel carries in between is held, so
 * nothing is lost, and a tab never leads before it knows where it is.
 */

const HELLO = { hello: true }

export function join (name) {
  const channel = new BroadcastChannel(name)
  const held = []
  const quit = new AbortController()
  let heard = (message) => held.push(message)
  let kept = null
  let stop = null
  let release = null

  channel.addEventListener('message', ({ data }) => {
    if (data.hello) {
      if (kept !== null) channel.postMessage(kept)
      return
    }
    heard(data)
  })
  channel.postMessage(HELLO)

  const tell = (message) => {
    channel.postMessage(message)
    heard(message)
  }

  const state = (message) => {
    kept = message
    tell(message)
  }

  return {
    follow ({ heard: to, lead }) {
      heard = to
      for (const message of held.splice(0)) to(message)
      navigator.locks.request(name, { signal: quit.signal }, () => new Promise(resolve => {
        release = resolve
        stop = lead({ tell, state })
      })).catch(err => {
        if (err.name !== 'AbortError') throw err
      })
    },
    leave () {
      quit.abort()
      stop?.()
      release?.()
      channel.close()
    }
  }
}
