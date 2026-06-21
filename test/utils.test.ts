import { describe, it, expect } from 'vitest'
import net from 'net'
import {
  normalize,
  slash,
  escapeRegExp,
  resolveInternalHost,
  detectInternalNetwork,
} from '../src/utils'

describe('normalize', () => {
  it('合并连续多余的斜杠（保留协议的双斜杠）', () => {
    expect(normalize('https://cdn.x.com//a//b.png')).toBe('https://cdn.x.com/a/b.png')
  })

  it('无多余斜杠时原样返回', () => {
    expect(normalize('https://cdn.x.com/a/b.png')).toBe('https://cdn.x.com/a/b.png')
  })

  it('相对路径不做协议合并', () => {
    expect(normalize('/static/a.png')).toBe('/static/a.png')
  })
})

describe('slash', () => {
  it('Windows 反斜杠转成正斜杠', () => {
    expect(slash('a\\b\\c')).toBe('a/b/c')
  })

  it('已经是 POSIX 路径则不变', () => {
    expect(slash('a/b/c')).toBe('a/b/c')
  })

  it('包含非 ASCII 字符的路径保持原样', () => {
    const p = '/tmp/中文目录/a.png'
    expect(slash(p)).toBe(p)
  })
})

describe('escapeRegExp', () => {
  it('转义正则元字符', () => {
    expect(escapeRegExp('a.b+c?')).toBe('a\\.b\\+c\\?')
  })

  it('普通字符串不变', () => {
    expect(escapeRegExp('assets')).toBe('assets')
  })

  it('可安全用于 new RegExp', () => {
    const re = new RegExp('^' + escapeRegExp('a.b') + '/c$')
    expect(re.test('a.b/c')).toBe(true)
    expect(re.test('axb/c')).toBe(false)
  })
})

describe('resolveInternalHost', () => {
  it('endpoint 优先，去掉协议/端口/路径', () => {
    expect(resolveInternalHost('oss-cn-hangzhou', 'https://oss-cn-hangzhou.aliyuncs.com:443/foo'))
      .toBe('oss-cn-hangzhou.aliyuncs.com')
  })

  it('仅 region 时拼出 internal 域名', () => {
    expect(resolveInternalHost('oss-cn-hangzhou')).toBe('oss-cn-hangzhou-internal.aliyuncs.com')
  })

  it('region 与 endpoint 都缺失时返回空串', () => {
    expect(resolveInternalHost()).toBe('')
    expect(resolveInternalHost('  ', '  ')).toBe('')
  })
})

describe('detectInternalNetwork', () => {
  it('连接到本地可监听端口时返回 true', async () => {
    const server = net.createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address()
    if (typeof addr !== 'object' || !addr) throw new Error('listen failed')
    const port = addr.port

    try {
      const internal = await detectInternalNetwork('127.0.0.1', port, 1500)
      expect(internal).toBe(true)
    } finally {
      server.close()
    }
  })

  it('不可达主机返回 false（不抛错）', async () => {
    // RFC 6761 保留域名，解析/连接必然失败；用极小超时快速返回
    const internal = await detectInternalNetwork('nonexistent-invalid-host.invalid', 80, 500)
    expect(internal).toBe(false)
  })

  it('空 host 直接返回 false', async () => {
    expect(await detectInternalNetwork('')).toBe(false)
  })
})
