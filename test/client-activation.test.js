import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import test from 'node:test'

const clientSource = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

function loadClient() {
  let plugin
  const snapshotStore = (initial) => {
    let value = initial
    return {
      getSnapshot: () => value,
      set: (next) => { value = next },
      subscribe: () => () => {},
    }
  }
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: (registration) => { plugin = registration.factory((name) => {
          if (name === 'react') return { createElement: () => null }
          if (name === '@deepseek-ai/dsh-client-store') return { createSnapshotStore: snapshotStore }
          throw new Error(`Unexpected module: ${name}`)
        }) },
      },
    },
  }
  runInNewContext(clientSource, sandbox, { filename: 'lib/client.js' })
  assert.ok(plugin, 'browser plugin must register itself')
  return plugin
}

function context(services) {
  const deferred = []
  const registrations = []
  const ctx = {
    slots: {
      inject: (_name, register) => register(),
      register: (entry) => { registrations.push(entry); return () => {} },
    },
    remote: { credentials: {} },
    connection: {},
    effect: (register) => register(),
    inject: (names, activate) => {
      const name = names[0]
      deferred.push(name)
      if (Object.hasOwn(services, name)) activate({ ...ctx, [name]: services[name] })
    },
  }
  return { ctx, deferred, registrations }
}

function scope() {
  return {
    getSnapshot: () => ({ status: 'loading', value: undefined, writable: false }),
    subscribe: () => () => {},
  }
}

test('missing version-specific settings services do not prevent root activation', () => {
  const plugin = loadClient()
  assert.deepEqual(Array.from(plugin.inject), ['slots', 'remote', 'remote.credentials', 'connection'])
  const { ctx, deferred, registrations } = context({})
  plugin.apply(ctx)
  assert.deepEqual(deferred, ['configForms', 'settingsScope'])
  assert.equal(registrations.length, 0, 'UI waits for a settings transport, but the root plugin returns normally')
})

test('DSH 0.1.7 mounts its settings page via configForms without settingsScope', () => {
  const plugin = loadClient()
  const watched = []
  const form = scope()
  const configForms = {
    get: (name) => { assert.equal(name, 'jev-effort-selector'); return form },
    whileServed: (names, mount) => {
      watched.push(...names)
      return mount()
    },
  }
  const { ctx, registrations } = context({ configForms })
  plugin.apply(ctx)
  assert.deepEqual(watched, ['jev-effort-selector'])
  assert.deepEqual(registrations.map((r) => r.name), ['conversation.input.right', 'plugins.bundle.config'])
  assert.equal(registrations[1].key, 'dsh-plugin-jev-effort-selector')
})

test('DSH 0.1.5 keeps the settingsScope card', () => {
  const plugin = loadClient()
  const { ctx, registrations } = context({ settingsScope: { bind: ({ namespace }) => {
    assert.equal(namespace, 'jev-effort-selector')
    return scope()
  } } })
  plugin.apply(ctx)
  assert.deepEqual(registrations.map((r) => r.name), ['conversation.input.right', 'settings.plugin.item'])
  assert.equal(registrations[1].key, 'jev-effort-selector')
})
