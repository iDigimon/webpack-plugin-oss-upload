import fs from 'fs'
import net from 'net'
import path from 'path'

/**
 * 规范化 URL：合并连续多余的反斜杠/斜杠，避免出现 `https://cdn.x//assets//a.png` 这种路径。
 * 仅处理协议之后的连续斜杠，保留 `https://`。
 */
export const normalize = (url: string): string => {
  const tmpArr = url.split(/\/{2,}/)
  if (tmpArr.length > 2) {
    const [protocol, ...rest] = tmpArr
    return protocol + '//' + rest.join('/')
  }
  return url
}

/**
 * 将 Windows 反斜杠路径转换为 POSIX 斜杠路径。
 * 对于扩展长度路径或包含非 ASCII 字符的路径保持原样（与 Node 内部实现保持一致）。
 */
export const slash = (p: string): string => {
  const isExtendedLengthPath = /^\\\\\?\\/.test(p)
  const hasNonAscii = /[^\u0000-\u0080]+/.test(p)

  if (isExtendedLengthPath || hasNonAscii) {
    return p
  }

  return p.replace(/\\/g, '/')
}

/** 转义字符串，使其可安全用于 `new RegExp(...)`。 */
export const escapeRegExp = (str: string): string => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * 删除指定文件所在的空目录（递归向上，直到遇到非空目录或构建根为止）。
 * 仅在目录确实为空时才删除，避免误删仍含其它文件的目录。
 *
 * @param filePath 已被删除的文件绝对路径
 * @param root 不会再向上删除的根目录（通常是构建输出目录），默认为 `path.parse(filePath).root`
 * @returns 是否至少删除了一个空目录
 */
export const cleanEmptyDir = (filePath: string, root?: string): boolean => {
  const stopAt = root ?? path.parse(filePath).root
  let removed = false
  let dir = path.dirname(filePath)

  while (dir !== stopAt && dir !== path.dirname(dir)) {
    if (!fs.existsSync(dir)) break
    const stats = fs.statSync(dir)
    if (!stats.isDirectory()) break

    const entries = fs.readdirSync(dir)
    if (entries.length > 0) break

    try {
      fs.rmdirSync(dir)
      removed = true
    } catch {
      break
    }
    dir = path.dirname(dir)
  }
  return removed
}

/**
 * 根据传入的 region / endpoint 推导出阿里云 OSS 的内网访问主机名。
 * - 若 endpoint 已显式给出，直接复用（去掉协议前缀和端口）；
 * - 否则按 region 拼接 `<region>-internal.aliyuncs.com`。
 * 若两者都没有，返回空字符串。
 */
export const resolveInternalHost = (
  region?: string,
  endpoint?: string,
): string => {
  if (endpoint && endpoint.trim() !== '') {
    return endpoint
      .replace(/^https?:\/\//i, '')
      .replace(/\/.*$/, '')
      .replace(/:\d+$/, '')
      .trim()
  }
  if (region && region.trim() !== '') {
    return `${region.replace(/^oss-/, 'oss-')}-internal.aliyuncs.com`
  }
  return ''
}

/**
 * 通过 TCP 端口探测判断是否处于阿里云内网环境。
 * 尝试连接内网主机名的 80 端口（内网默认走 HTTP），成功即判定为内网。
 *
 * 设计为“永不抛错”：任何异常（DNS 失败、超时、拒绝连接）都视为非内网，
 * 这样在 CI / 无外网环境 / 单元测试中也不会中断构建，而是沿用用户原配置。
 *
 * @param host 要探测的内网主机名
 * @param port 要探测的端口，默认 80
 * @param timeoutMs 超时毫秒，默认 1500
 * @returns 是否处于内网环境
 */
export const detectInternalNetwork = (
  host: string,
  port = 80,
  timeoutMs = 1500,
): Promise<boolean> => {
  if (!host) return Promise.resolve(false)

  return new Promise((resolve) => {
    let settled = false
    const done = (result: boolean) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(result)
    }

    const socket = net.createConnection({ host, port })

    const timer = setTimeout(() => done(false), timeoutMs)

    socket.once('connect', () => {
      clearTimeout(timer)
      done(true)
    })

    // DNS 失败 / 连接被拒绝 / 其它错误统一视为非内网
    socket.once('error', () => {
      clearTimeout(timer)
      done(false)
    })
  })
}
