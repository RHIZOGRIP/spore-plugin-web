#!/usr/bin/env node
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { CONFIG_FILE } from '@rhizogrip/spore'
import { readBot, runService, statePath } from '@rhizogrip/spore/relay'

import { WEB, createAdapter, openFiles, webOf } from '../src/adapter.js'
import { openLog } from '../src/log.js'
import { serve } from '../src/server.js'

await runService({
  spec: WEB,
  program: 'spore-web',
  root: resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  open: async ({ bot, file }) => {
    const { listen } = webOf(readBot(WEB, file), file)
    const dir = dirname(statePath(WEB.kind, bot))
    const log = openLog(join(dir, 'log.sqlite'))
    const files = openFiles(dir)
    const receive = ({ deliver, press, signal, log: say }) => serve({ host: listen.host, port: listen.port, file, configFile: CONFIG_FILE, log, files, deliver, press, signal, say })
    return { adapter: createAdapter({ name: bot, log, files, receive }), who: listen.shown }
  }
})
