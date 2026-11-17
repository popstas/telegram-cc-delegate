import { mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ensureApiToken, loadConfig } from '../src/config.ts'

describe('config', () => {
  it('ensureApiToken creates 600 file once', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'td-cfg-')), 'telegram-delegate')
    const t1 = ensureApiToken(dir)
    expect(t1).toMatch(/^[0-9a-f]{64}$/)
    const t2 = ensureApiToken(dir)
    expect(t2).toBe(t1)
    expect(statSync(join(dir, 'api-token')).mode & 0o777).toBe(0o600)
  })

  it('loadConfig defaults', () => {
    const root = mkdtempSync(join(tmpdir(), 'td-cfg-'))
    const cfg = loadConfig({ HOME: root, XDG_CONFIG_HOME: join(root, 'cfg'), XDG_STATE_HOME: join(root, 'state') })
    expect(cfg.port).toBe(8790)
    expect(cfg.idleHours).toBe(24)
    expect(cfg.lostGraceSec).toBe(60)
    expect(cfg.adminUserId).toBe('241225329')
    expect(cfg.deepgram.language).toBe('ru')
    expect(cfg.writeFirst).toBe(false)
    expect(cfg.botToken).toBeUndefined()
    expect(cfg.configDir).toBe(join(root, 'cfg', 'telegram-delegate'))
    expect(cfg.stateDir).toBe(join(root, 'state', 'telegram-delegate'))
  })

  it('loadConfig reads config.json and .env, real env wins', () => {
    const root = mkdtempSync(join(tmpdir(), 'td-cfg-'))
    const dir = join(root, 'telegram-delegate')
    mkdirSync(dir)
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ port: 9999, writeFirst: true, deepgram: { language: 'en', model: 'nova-2' } }))
    writeFileSync(join(dir, '.env'), '# comment\nTELEGRAM_BOT_TOKEN="from-file"\nDEEPGRAM_API_KEY=dg-file\n')
    const cfg = loadConfig({ XDG_CONFIG_HOME: root, HOME: root, DEEPGRAM_API_KEY: 'dg-env' })
    expect(cfg.port).toBe(9999)
    expect(cfg.idleHours).toBe(24)
    expect(cfg.writeFirst).toBe(true)
    expect(cfg.deepgram).toEqual({ language: 'en', model: 'nova-2' })
    expect(cfg.botToken).toBe('from-file')
    expect(cfg.deepgramKey).toBe('dg-env')
  })
})
