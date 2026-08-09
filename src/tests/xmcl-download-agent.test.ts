import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createXmclDownloadDispatcher } from '../main/download-agent'

const dispatcher = createXmclDownloadDispatcher()
let server: Server
let origin: string
let retryRequests = 0
let redirectRequests = 0
let finalRequests = 0

describe('XMCL Undici 7 dispatcher', () => {
  beforeAll(async () => {
    server = createServer((request, response) => {
      switch (request.url) {
        case '/retry':
          retryRequests += 1
          if (retryRequests === 1) {
            response.writeHead(503)
            response.end('try again')
            return
          }
          response.writeHead(200, { 'content-type': 'text/plain' })
          response.end('retried')
          return
        case '/redirect':
          redirectRequests += 1
          response.writeHead(302, { location: '/final' })
          response.end()
          return
        case '/final':
          finalRequests += 1
          response.writeHead(200, { 'content-type': 'text/plain' })
          response.end('redirected')
          return
        default:
          response.writeHead(404)
          response.end()
      }
    })

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address() as AddressInfo
    origin = `http://127.0.0.1:${address.port}`
  })

  afterAll(async () => {
    await dispatcher.close()
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
  })

  it('retries a transient XMCL response', async () => {
    const response = await dispatcher.request({
      origin,
      path: '/retry',
      method: 'GET',
    })

    expect(response.statusCode).toBe(200)
    expect(await response.body.text()).toBe('retried')
    expect(retryRequests).toBe(2)
  })

  it('follows redirects for XMCL downloads', async () => {
    const response = await dispatcher.request({
      origin,
      path: '/redirect',
      method: 'GET',
    })

    expect(response.statusCode).toBe(200)
    expect(await response.body.text()).toBe('redirected')
    expect(redirectRequests).toBe(1)
    expect(finalRequests).toBe(1)
  })
})
