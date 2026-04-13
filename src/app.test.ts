/// <reference types="vitest" />
import request from 'supertest'
import { createApp } from './app.js'
import { registerToken } from './middleware/auth.js'
import { readAllUsersCached } from './userStorage.js'

describe('backend app', () => {
  const app = createApp({ startSchedulers: false })

  it('GET /health responde com status de saúde', async () => {
    const res = await request(app).get('/health')
    expect([200, 503]).toContain(res.status)
    expect(res.body).toHaveProperty('status')
    expect(res.body).toHaveProperty('storage')
  })

  it('GET /api/proxy/health sem token retorna 401', async () => {
    const res = await request(app).get('/api/proxy/health')
    expect(res.status).toBe(401)
  })

  it('GET /api/proxy/health com token válido retorna 200', async () => {
    const user = readAllUsersCached()[0]
    expect(user).toBeDefined()
    const token = `test-token-${Date.now()}`
    registerToken(token, user.id)

    const res = await request(app)
      .get('/api/proxy/health')
      .set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('status', 'ok')
    expect(res.body).toHaveProperty('stats')
    expect(res.body).toHaveProperty('tokenCacheSize')
  })

  it('GET /api/proxy/data com requireDsId e sem dsId retorna 422', async () => {
    const user = readAllUsersCached()[0]
    expect(user).toBeDefined()
    const token = `test-token-ds-${Date.now()}`
    registerToken(token, user.id)

    const res = await request(app)
      .get('/api/proxy/data')
      .query({ requireDsId: '1' })
      .set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(422)
    expect(res.body).toHaveProperty('message')
  })

  it('GET /api/v1/ops/status com admin retorna 200 e proxy', async () => {
    const user = readAllUsersCached()[0]
    expect(user?.role).toBe('admin')
    const token = `test-token-ops-${Date.now()}`
    registerToken(token, user.id)

    const res = await request(app)
      .get('/api/v1/ops/status')
      .set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('proxy')
    expect(res.body.proxy).toHaveProperty('stats')
    expect(res.body).toHaveProperty('storage')
  })
})
