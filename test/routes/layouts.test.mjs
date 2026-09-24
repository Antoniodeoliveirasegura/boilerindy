import { test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createLayoutsRouter } from '../../src/routes/layouts.mjs'
import { defaultLayout, normalizeLayout } from '../../src/dashboardLayout.mjs'
import { defaultLayout as defaultServicesLayout } from '../../src/servicesLayout.mjs'

// Issue #191 - the first feature router. The router takes its dependencies as
// one object, so it boots here on a small app with a fake session and a fake
// database, the way server.mjs mounts it with the real ones.

function fakeSupabase({ updateError = null } = {}) {
  const updates = []
  return {
    updates,
    from(table) {
      return {
        update: (values) => ({
          eq: async (column, value) => {
            updates.push({ table, values, where: { [column]: value } })
            return { error: updateError }
          },
        }),
      }
    },
  }
}

async function withApp({ user, updateError } = {}, run) {
  const supabase = fakeSupabase({ updateError })
  const limiterHits = []
  const app = express()
  app.use(express.json())
  app.use(
    createLayoutsRouter({
      supabase,
      requireAuth: (req, res, next) => {
        if (!user) return res.status(401).json({ error: { message: 'You must sign in to access this resource.', status: 401 } })
        req.currentUser = user
        next()
      },
      userWriteRateLimit: (req, _res, next) => {
        limiterHits.push(`${req.method} ${req.path}`)
        next()
      },
    }),
  )
  const server = app.listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const call = async (method, path, body) => {
    const response = await fetch(base + path, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: response.status, body: await response.json() }
  }
  try {
    await run({ call, supabase, limiterHits })
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

test('GET answers the default layout for a user who never customized, normalized otherwise', async () => {
  await withApp({ user: { id: 'u1', dashboard_layout: null, services_layout: null } }, async ({ call }) => {
    const dashboard = await call('GET', '/api/me/dashboard')
    assert.equal(dashboard.status, 200)
    assert.deepEqual(dashboard.body, { layout: defaultLayout() })
    const services = await call('GET', '/api/me/services')
    assert.equal(services.status, 200)
    assert.deepEqual(services.body, { layout: defaultServicesLayout() })
  })
  const stored = [{ id: 'gpa', size: 'huge' }, { id: 'not-a-widget', size: 'half' }, 'junk']
  await withApp({ user: { id: 'u1', dashboard_layout: stored } }, async ({ call }) => {
    const dashboard = await call('GET', '/api/me/dashboard')
    assert.deepEqual(dashboard.body, { layout: normalizeLayout(stored) })
    assert.ok(!dashboard.body.layout.some((w) => w.id === 'not-a-widget'))
  })
})

test('PUT sanitizes the layout against the allowlist, stores it for the user and passes the write limiter', async () => {
  await withApp({ user: { id: 'u1' } }, async ({ call, supabase, limiterHits }) => {
    const sent = [{ id: 'gpa', size: 'huge' }, { id: 'not-a-widget' }]
    const put = await call('PUT', '/api/me/dashboard', { layout: sent })
    assert.equal(put.status, 200)
    assert.deepEqual(put.body, { layout: normalizeLayout(sent) })
    assert.deepEqual(supabase.updates, [{ table: 'users', values: { dashboard_layout: normalizeLayout(sent) }, where: { id: 'u1' } }])
    assert.deepEqual(limiterHits, ['PUT /api/me/dashboard'])

    const services = await call('PUT', '/api/me/services', { layout: [] })
    assert.equal(services.status, 200)
    assert.equal(supabase.updates[1].table, 'users')
    assert.ok('services_layout' in supabase.updates[1].values)
    assert.deepEqual(limiterHits, ['PUT /api/me/dashboard', 'PUT /api/me/services'])
  })
})

test('a failed write answers the standard 500 envelope without the database text', async () => {
  await withApp({ user: { id: 'u1' }, updateError: { message: 'relation users does not exist' } }, async ({ call }) => {
    const put = await call('PUT', '/api/me/services', { layout: [] })
    assert.equal(put.status, 500)
    assert.deepEqual(put.body, { error: { message: 'Could not save your services layout.', status: 500 } })
  })
})

test('every route sits behind requireAuth', async () => {
  await withApp({ user: null }, async ({ call }) => {
    for (const [method, path] of [['GET', '/api/me/dashboard'], ['PUT', '/api/me/dashboard'], ['GET', '/api/me/services'], ['PUT', '/api/me/services']]) {
      const answer = await call(method, path, method === 'PUT' ? { layout: [] } : undefined)
      assert.equal(answer.status, 401, `${method} ${path}`)
    }
  })
})
