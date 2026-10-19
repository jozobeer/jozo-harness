import { describe, expect, test } from 'vitest'
import { readyLinesOf } from '../src/index.ts'

describe('the lines a run prints for where it is reachable', () => {
  test('labels every address and aligns them under one column', () => {
    expect(
      readyLinesOf({
        local: 'http://127.0.0.1:4310/?code=a',
        tailnet: ['http://100.88.96.60:4310/?code=b', 'http://myhost.tailnet.ts.net:4310/?code=c'],
        public: 'https://myhost.tailnet.ts.net/?code=d',
      }),
    ).toEqual([
      'local   http://127.0.0.1:4310/?code=a',
      'tailnet http://100.88.96.60:4310/?code=b',
      'tailnet http://myhost.tailnet.ts.net:4310/?code=c',
      'public  https://myhost.tailnet.ts.net/?code=d',
    ])
  })

  test('pads by the longest label present, so a run without a tailnet keeps its spacing', () => {
    expect(
      readyLinesOf({
        local: 'http://127.0.0.1:4310/?code=a',
        tailnet: [],
        public: 'https://myhost.tailnet.ts.net/?code=d',
      }),
    ).toEqual([
      'local  http://127.0.0.1:4310/?code=a',
      'public https://myhost.tailnet.ts.net/?code=d',
    ])
  })
})
