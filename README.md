# @rhizogrip/spore-plugin-web

A web page for your spores: each person talks with the spores they reach in a browser, the way
they would in Telegram or Slack, with no other platform in between. On your own machine it is the
alternative to `spore tui` for whoever would rather not live in a terminal; behind your reverse
proxy it is a page your people sign in to. It runs on the machine the spores are on, once per page,
as a systemd user unit, on a loopback address. It gives spores nothing, so it needs no
`spore plugin allow`: `spore service` offers it once it is installed.

A plugin for [spore](https://rhizogrip.com); all of them:
[rhizogrip.com/plugins](https://rhizogrip.com/plugins).

```bash
npm i -g @rhizogrip/spore-plugin-web
mkdir -p ~/.config/spore/web
cat > ~/.config/spore/web/mine.json <<'JSON'
{ "people": { "operator": "*" } }
JSON
spore service define web@mine && spore service start web@mine
# then open http://127.0.0.1:7761
```

**Meant for a machine you do not share.** With no proxy, every request from this machine's
loopback is you: the page holds no password, and anyone else logged in to the machine could open
it too.

## The web file

`web/<name>.json` beside `config.json`, read on every request, so a person is added or moved by
editing a line:

```json
{
  "listen": "127.0.0.1:7761",
  "origin": "https://spores.example.org",
  "user": "x-forwarded-user",
  "theme": "mine.css",
  "shell": { "name": "Oki", "links": [{ "label": "Spores", "href": "/oki/spores/" }] },
  "people": {
    "operator": "*",
    "ada@example.org": { "spores": ["research", "ops"], "brief": true },
    "bob@example.org": "triage"
  }
}
```

- `listen`: where the page answers, `127.0.0.1:7761` when unsaid. Loopback only — an address
  beyond it is refused, since the page trusts who a request names only from loopback.
- `user`: the header your proxy names the signed-in person in. Without it there is no proxy and
  one person, `operator`.
- `origin`: the address people open the page at, required with `user`. Every write must come
  from it, so another site cannot post as someone signed in to your proxy. Without `user`, the
  page answers at `127.0.0.1`, `localhost` and `[::1]` on its port, and to no other host name.
- `theme`: a CSS file, absolute or beside the web file, served after the page's own stylesheet.
- `shell`: for a site that serves pages of its own around this one, through the proxy. The sidebar's
  foot then shows `name`, opening a menu of `links`, where it otherwise shows the person; the tab's
  title ends with `name` too. Each `href` is a path at the page's own address, which the proxy serves.
- `people`: each person against what they reach — a spore's name; `"*"`, every spore in home,
  read as spores come and go; or `{ "spore": … }` or `{ "spores": [...] }` with `details`
  (a turn's calls by their path or command line) or `brief` (only the spore's state and its
  answers). Someone the proxy signs in who is not here is told to ask you, and the service's log
  says the line that would let them in.

A person's conversation is the place `web:<name>/<person>`, where their spores' answers and
approvals go: `spore send` and a spore's `replyTo` can name it.

## A turn on the page

Each spore a person reaches is a thread of its own, opened from the sidebar or with Ctrl K. A
message goes to the spore that is open and moves to the top of the thread, so its answer is read
from its first line: the page does not follow the answer down. While its turn runs, the page shows `working…` with the
tools as they run and the answer as it is written; the finished answer replaces it, its Markdown
formatted. What the turn left in `data/out/` comes as downloads, kept by the page, so they still
download after the workspace file changes. An approval asked of the person is a card they answer
on the page. Files go up with a message by the attach button, by dropping them on the page or by
pasting. `/status`, `/stop`, `/wrap [10m]`, `/extend wall 30m` and `/flush` work as typed text;
while a turn runs, Send becomes Stop when there is nothing to send, and Esc stops it too.

The page keeps each person's conversation in its own state, under
`$XDG_STATE_HOME/spore/web/<name>/`: a reload, a dropped connection or a restart of the service
loses nothing, and a turn that ended while no page was open is there on the next visit. A message
is said once however often the page sends it, and every finished answer reaches the conversation
at least once, as on every connector.

## Behind a proxy

The proxy signs people in — any way it likes, OIDC, passkeys, a VPN — and names the person in the
`user` header on every request it forwards to the loopback address. The page sets no cookie of
its own; the proxy's rides along. It must:

- serve the page over HTTPS: a browser's tabs share one stream through Web Locks, which only a
  secure context has (loopback, with no proxy, is one too). HTTP/1.1 is then enough, however many
  tabs are open, since the shared stream leaves five of a browser's six connections per site to
  the page's requests. Anything else that follows `/api/events` holds a stream of its own: over
  HTTP/1.1, five of those in one browser leave the page no connection. Whatever the protocol, the
  service takes at most eight streams per person: the page's, one per browser it is open in, and
  every other follower's;
- not buffer `/api/events`: nginx honours the page's `X-Accel-Buffering: no`, and its 60 s
  `proxy_read_timeout` is above the stream's 15 s keep-alive; Caddy flushes event streams by itself
  but must leave that route out of `encode`;
- set the `user` header itself, dropping any the browser sent.

## Theming

The page's colours, radius and fonts are CSS custom properties on `:root`: `--bg`, `--surface`
(the sidebar, a message of yours, code), `--raised` (cards, the composer, menus), `--text`,
`--text-muted`, `--accent`, `--on-accent`, `--danger`, `--radius`, `--font`, `--font-mono`. Lines,
hover and selection (`--hairline`, `--border`, `--hover`, `--selected`) are mixed from `--text`, so
they follow it. A theme sets the ones it changes, each once for light and dark:

```css
:root { --accent: light-dark(oklch(55% 0.17 150), oklch(76% 0.13 150)); --radius: 6px; }
```

The page follows the system's light or dark unless the person picks one with the button at the
top of the sidebar; a desktop shell around the page sets `data-theme` on `<html>` the same way.
These properties, with the page's base rules (type, focus ring, icons), are in `page/tokens.css`,
apart from the page's own layout in `page/style.css`. A shell that puts pages of its own around this
one builds them on that file, so both look alike, and reads the same `spore-mode` key in
`localStorage` to follow the scheme the person picked.

The page loads nothing from the network: no font, no script, nothing but what the plugin serves.
It needs a browser from 2024 or later: Chrome or Edge 123, Firefox 120, Safari 17.5.

## Developing

The tests run against a spore checkout beside this one, at `../spore`: the plugin is linked to its
`packages/spore`, and `test/service.test.js` runs the relay's conformance suite from its test
fixtures. Build that checkout first, then `npm install` and `npm test` here.
