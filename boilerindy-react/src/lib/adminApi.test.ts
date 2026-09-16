import { beforeEach, describe, expect, test, vi } from 'vitest'
import { authRequest } from './authApi'
import { getLiveContent, takeDownContent, type DeletedContentType } from './adminApi'

// Live-content takedown (#195): the admin panel removes an item through its
// type's public DELETE route, so each type must map to the path server.mjs
// actually serves. A wrong entry would only show up as a 404 in production.

vi.mock('./authApi', () => ({ authRequest: vi.fn() }))

const ID = '44444444-4444-4444-8444-444444444444'

beforeEach(() => {
  vi.mocked(authRequest).mockReset().mockResolvedValue('')
})

describe('takeDownContent', () => {
  test.each<[DeletedContentType, string]>([
    ['board', `/api/board/posts/${ID}`],
    ['guide', `/api/guide/${ID}`],
    ['lost-found', `/api/lost-found/${ID}`],
    ['marketplace', `/api/marketplace/${ID}`],
    ['deals', `/api/deals/${ID}`],
    ['study-groups', `/api/study-groups/${ID}`],
  ])('%s sends DELETE %s', async (type, path) => {
    await takeDownContent(type, ID)
    expect(authRequest).toHaveBeenCalledTimes(1)
    expect(authRequest).toHaveBeenCalledWith(path, { method: 'DELETE' })
  })

  test('URL-encodes the id so it cannot change the route', async () => {
    await takeDownContent('guide', 'a/b?c')
    expect(authRequest).toHaveBeenCalledWith('/api/guide/a%2Fb%3Fc', { method: 'DELETE' })
  })
})

describe('getLiveContent', () => {
  test('reads the admin content route for the type with an encoded id', async () => {
    await getLiveContent('study-groups', ID)
    expect(authRequest).toHaveBeenCalledWith(`/api/admin/content/study-groups/${ID}`)
    await getLiveContent('board', 'x y/z')
    expect(authRequest).toHaveBeenLastCalledWith('/api/admin/content/board/x%20y%2Fz')
  })
})
