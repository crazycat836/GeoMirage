// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { pathToFileURL } from 'node:url'
import nav from './navigation.js'

const { DEV_SERVER_URL, isAppUrl, isExternalHttps } = nav

const PACKAGED = 'file:///Applications/GeoMirage.app/Contents/Resources/app.asar/dist/index.html'

describe('isAppUrl (packaged)', () => {
  it.each([
    [PACKAGED, true],
    [`${PACKAGED}#/settings`, true],
    [`${PACKAGED}?x=1`, true],
    ['file:///Users/me/Downloads/route.gpx', false],
    ['file:///Users/me/Downloads/page.html', false],
    ['file:///Applications/GeoMirage.app/Contents/Resources/app.asar/dist/other.html', false],
    ['https://www.openstreetmap.org/copyright', false],
    [DEV_SERVER_URL, false],
    ['not a url', false],
  ])('%s → %s', (url, expected) => {
    expect(isAppUrl(url, PACKAGED)).toBe(expected)
  })
})

describe('isAppUrl (file path encoding)', () => {
  it('matches however the path characters are escaped', () => {
    const app = pathToFileURL("/Applications/Geo Mirage's/app.asar/dist/index.html").href
    expect(isAppUrl("file:///Applications/Geo%20Mirage%27s/app.asar/dist/index.html", app)).toBe(true)
    expect(isAppUrl("file:///Applications/Geo%20Mirage's/app.asar/dist/index.html", app)).toBe(true)
  })

  it('treats Windows drive paths case-insensitively', () => {
    const app = 'file:///C:/Program%20Files/GeoMirage/resources/app.asar/dist/index.html'
    expect(isAppUrl('file:///c:/program files/GeoMirage/resources/app.asar/dist/index.html', app)).toBe(true)
    expect(isAppUrl('file:///C:/Users/me/Downloads/index.html', app)).toBe(false)
  })
})

describe('isAppUrl (dev server)', () => {
  it.each([
    [`${DEV_SERVER_URL}/`, true],
    [`${DEV_SERVER_URL}/src/main.tsx?t=1`, true],
    ['http://localhost:5174/', false],
    ['http://127.0.0.1:5173/', false],
    ['https://leafletjs.com/', false],
    [PACKAGED, false],
  ])('%s → %s', (url, expected) => {
    expect(isAppUrl(url, DEV_SERVER_URL)).toBe(expected)
  })
})

describe('isExternalHttps', () => {
  it.each([
    ['https://www.openstreetmap.org/copyright', true],
    ['https://carto.com/attributions', true],
    ['http://example.com/', false],
    ['file:///etc/passwd', false],
    ['javascript:alert(1)', false],
    ['geomirage://x', false],
    ['', false],
  ])('%s → %s', (url, expected) => {
    expect(isExternalHttps(url)).toBe(expected)
  })
})
