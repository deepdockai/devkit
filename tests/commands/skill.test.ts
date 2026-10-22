import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execute, makeSandbox, type Sandbox } from '../harness.ts'

let box: Sandbox
beforeEach(() => {
  box = makeSandbox()
})
afterEach(() => box.cleanup())

describe('skill', () => {
  it('copies the skill for claude into .claude/skills/deepdock', async () => {
    const outcome = await execute(box, ['skill', '--agent', 'claude'])
    expect(outcome.code).toBe(0)
    const skill = readFileSync(join(box.work, '.claude/skills/deepdock/SKILL.md'), 'utf8')
    expect(skill.startsWith('---\nname:')).toBe(true)
    expect(existsSync(join(box.work, '.claude/skills/deepdock/references/cli.md'))).toBe(true)
    expect(existsSync(join(box.work, 'AGENTS.md'))).toBe(false)
    expect(JSON.parse(outcome.stdout).data.agents).toEqual(['claude'])
  })

  it('writes a marked section into AGENTS.md for codex and replaces it on a second run', async () => {
    writeFileSync(join(box.work, 'AGENTS.md'), '# Project rules\n\nBe kind.\n')
    await execute(box, ['skill', '--agent', 'codex'])
    await execute(box, ['skill', '--agent', 'codex'])
    const agents = readFileSync(join(box.work, 'AGENTS.md'), 'utf8')
    expect(agents.startsWith('# Project rules\n\nBe kind.\n')).toBe(true)
    expect(agents.match(/deepdock-skill:start/g)).toHaveLength(1)
    expect(agents).toContain('# Deepdock integration')
    expect(agents).not.toContain('name: deepdock-integration')
    expect(agents).toContain('](.deepdock/references/cli.md)')
    expect(existsSync(join(box.work, '.deepdock/references/cli.md'))).toBe(true)
  })

  it('writes a cursor rule with front matter', async () => {
    await execute(box, ['skill', '--agent', 'cursor'])
    const rule = readFileSync(join(box.work, '.cursor/rules/deepdock.mdc'), 'utf8')
    expect(rule.startsWith('---\ndescription: ')).toBe(true)
    expect(rule).toContain('alwaysApply: false')
    expect(rule).toContain('# Deepdock integration')
  })

  it('installs for all three by default', async () => {
    const outcome = await execute(box, ['skill'], { tty: true })
    expect(outcome.stdout).toContain('claude, codex, cursor')
    for (const file of [
      '.claude/skills/deepdock/SKILL.md',
      'AGENTS.md',
      '.cursor/rules/deepdock.mdc',
    ]) {
      expect(existsSync(join(box.work, file))).toBe(true)
    }
  })

  it('rejects an unknown agent with exit 1', async () => {
    const outcome = await execute(box, ['skill', '--agent', 'emacs'])
    expect(outcome.code).toBe(1)
    expect(existsSync(join(box.work, '.claude'))).toBe(false)
  })

  it('has no add subcommand: it is the normal usage error', async () => {
    const outcome = await execute(box, ['skill', 'add'])
    expect(outcome.code).toBe(1)
    expect(JSON.parse(outcome.stderr).error.code).toBe('invalid_usage')
    expect(existsSync(join(box.work, '.claude'))).toBe(false)
  })

  it('shows skill as a command without subcommands in the command tree', async () => {
    const outcome = await execute(box, ['commands', '--json'])
    const skill = JSON.parse(outcome.stdout).data.commands.find(
      (command: { name: string }) => command.name === 'skill',
    )
    expect(skill.commands).toEqual([])
    expect(skill.options.map((option: { flags: string }) => option.flags)).toContain(
      '--agent <agent>',
    )
  })
})
