import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { cleanEmptyDir } from '../src/utils'

let tmpRoot = ''

const mk = (p: string) => fs.mkdirSync(p, { recursive: true })
const touch = (p: string) => fs.writeFileSync(p, '')

describe('cleanEmptyDir', () => {
  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vpo-test-'))
  })

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('删除空目录并向上递归清理父空目录', () => {
    const deep = path.join(tmpRoot, 'a', 'b', 'c')
    mk(deep)
    const file = path.join(deep, 'x.png')
    touch(file)
    fs.rmSync(file)

    const removed = cleanEmptyDir(file, tmpRoot)

    expect(removed).toBe(true)
    expect(fs.existsSync(deep)).toBe(false)
    expect(fs.existsSync(path.join(tmpRoot, 'a'))).toBe(false)
  })

  it('兄弟目录仍有文件时，不误删父目录', () => {
    const dir = path.join(tmpRoot, 'a')
    mk(dir)
    const keep = path.join(dir, 'keep.png')
    touch(keep)
    const removedFile = path.join(dir, 'gone.png')
    touch(removedFile)
    fs.rmSync(removedFile)

    cleanEmptyDir(removedFile, tmpRoot)

    // dir 仍含 keep.png，不能删
    expect(fs.existsSync(dir)).toBe(true)
    expect(fs.existsSync(keep)).toBe(true)
  })

  it('到达 root 即停止，不删除 root 自身', () => {
    const dir = path.join(tmpRoot, 'only')
    mk(dir)
    const file = path.join(dir, 'x.png')
    touch(file)
    fs.rmSync(file)

    cleanEmptyDir(file, tmpRoot)

    expect(fs.existsSync(tmpRoot)).toBe(true)
    expect(fs.existsSync(dir)).toBe(false)
  })
})
