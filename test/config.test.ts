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

  const setup = (cfg?: unknown) => {
    const root = mkdtempSync(join(tmpdir(), 'td-cfg-'))
    const dir = join(root, 'cfg', 'telegram-delegate')
    mkdirSync(dir, { recursive: true })
    if (cfg !== undefined) writeFileSync(join(dir, 'config.json'), typeof cfg === 'string' ? cfg : JSON.stringify(cfg))
    return { root, dir, env: { HOME: root, XDG_CONFIG_HOME: join(root, 'cfg'), XDG_STATE_HOME: join(root, 'state') } }
  }

  it('loadConfig defaults', () => {
    const { root, env } = setup({ adminUserId: '1001' })
    const cfg = loadConfig(env)
    expect(cfg.adminUserId).toBe('1001')
    expect(cfg.language).toBe('en')
    expect(cfg.port).toBe(8790)
    expect(cfg.idleHours).toBe(24)
    expect(cfg.lostGraceSec).toBe(60)
    expect(cfg.deepgram).toEqual({ language: 'en' })
    expect(cfg.writeFirst).toBe(false)
    expect(cfg.botToken).toBeUndefined()
    expect(cfg.configDir).toBe(join(root, 'cfg', 'telegram-delegate'))
    expect(cfg.stateDir).toBe(join(root, 'state', 'telegram-delegate'))
  })

  it('adminUserId is required and numeric', () => {
    expect(() => loadConfig(setup().env)).toThrow(/"adminUserId" is required/)
    expect(() => loadConfig(setup({ port: 1 }).env)).toThrow(/"adminUserId" is required/)
    expect(() => loadConfig(setup({ adminUserId: '@owner' }).env)).toThrow(/"adminUserId" is required/)
    expect(loadConfig(setup({ adminUserId: 1001 }).env).adminUserId).toBe('1001')
  })

  it('invalid JSON is a clear error', () => {
    expect(() => loadConfig(setup('{ adminUserId: ').env)).toThrow(/config\.json: invalid JSON/)
  })

  it('language: en/ru, unknown fails, deepgram.language follows unless set', () => {
    const ru = loadConfig(setup({ adminUserId: '1', language: 'ru' }).env)
    expect(ru.language).toBe('ru')
    expect(ru.deepgram.language).toBe('ru')
    const own = loadConfig(setup({ adminUserId: '1', language: 'ru', deepgram: { language: 'multi', model: 'nova-3' } }).env)
    expect(own.deepgram).toEqual({ language: 'multi', model: 'nova-3' })
    expect(() => loadConfig(setup({ adminUserId: '1', language: 'de' }).env)).toThrow(/unknown "language" "de", expected one of: en, ru/)
  })

  it('loadConfig reads config.json and .env, real env wins', () => {
    const { dir, env } = setup({ adminUserId: '1001', port: 9999, writeFirst: true, deepgram: { language: 'en', model: 'nova-2' } })
    writeFileSync(join(dir, '.env'), '# comment\nTELEGRAM_BOT_TOKEN="from-file"\nDEEPGRAM_API_KEY=dg-file\n')
    const cfg = loadConfig({ ...env, DEEPGRAM_API_KEY: 'dg-env' })
    expect(cfg.port).toBe(9999)
    expect(cfg.idleHours).toBe(24)
    expect(cfg.writeFirst).toBe(true)
    expect(cfg.deepgram).toEqual({ language: 'en', model: 'nova-2' })
    expect(cfg.botToken).toBe('from-file')
    expect(cfg.deepgramKey).toBe('dg-env')
  })
})
