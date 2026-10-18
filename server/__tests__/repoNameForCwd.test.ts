import { describe, expect, it } from 'vitest';

import { repoNameForCwd } from '../src/transcriptCwd.js';

/**
 * Helper agents run in git worktrees kept inside the repo. Their labels,
 * tasks and tokens belong to the repo, not to a "repo" named after the
 * worktree (`agent-a02c…`, `phase-g`).
 */
describe('repoNameForCwd', () => {
  it('is the basename of an ordinary directory', () => {
    expect(repoNameForCwd(String.raw`D:\Projects\pixel-agents`)).toBe('pixel-agents');
    expect(repoNameForCwd('/home/me/hobbyfi-blog-automation/')).toBe('hobbyfi-blog-automation');
  });

  it("folds Claude Code's agent worktrees into their repo", () => {
    expect(
      repoNameForCwd(
        String.raw`D:\Projects\hobbyfi-blog-automation\.claude\worktrees\agent-a02c5c5ab`,
      ),
    ).toBe('hobbyfi-blog-automation');
    expect(repoNameForCwd('/repo/x/.claude/worktrees/m-ui-tasks-board/webview-ui')).toBe('x');
  });

  it('folds a .worktrees/<name> checkout, at any depth below, into its repo', () => {
    expect(repoNameForCwd(String.raw`D:\Projects\pixel-agents\.worktrees\phase-g`)).toBe(
      'pixel-agents',
    );
    expect(repoNameForCwd('D:/Projects/pixel-agents/.worktrees/phase-g/server')).toBe(
      'pixel-agents',
    );
  });

  it('leaves a directory that only looks like one alone', () => {
    expect(repoNameForCwd('/srv/worktrees/app')).toBe('app');
    expect(repoNameForCwd('/home/me/.claude')).toBe('.claude');
  });
});
