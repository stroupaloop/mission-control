import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import path from 'node:path'

describe('getOpenclawWorkspaceDir', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    vi.resetModules()
    delete process.env.OPENCLAW_WORKSPACE_DIR
    delete process.env.MISSION_CONTROL_WORKSPACE_DIR
  })

  afterEach(() => {
    process.env = { ...originalEnv }
    vi.resetModules()
  })

  it('prefers OPENCLAW_WORKSPACE_DIR env var', async () => {
    process.env.OPENCLAW_WORKSPACE_DIR = '/explicit/workspace'
    process.env.MISSION_CONTROL_WORKSPACE_DIR = '/should/lose'
    const { getOpenclawWorkspaceDir } = await import('../workspace-paths')
    expect(getOpenclawWorkspaceDir()).toBe('/explicit/workspace')
  })

  it('falls back to MISSION_CONTROL_WORKSPACE_DIR', async () => {
    process.env.MISSION_CONTROL_WORKSPACE_DIR = '/mc/workspace'
    const { getOpenclawWorkspaceDir } = await import('../workspace-paths')
    expect(getOpenclawWorkspaceDir()).toBe('/mc/workspace')
  })

  it('falls back to <openclawStateDir>/workspace when no env var is set', async () => {
    const { config } = await import('@/lib/config')
    const { getOpenclawWorkspaceDir } = await import('../workspace-paths')
    if (config.openclawStateDir) {
      expect(getOpenclawWorkspaceDir()).toBe(path.join(config.openclawStateDir, 'workspace'))
    } else {
      expect(getOpenclawWorkspaceDir()).toBe('')
    }
  })
})
