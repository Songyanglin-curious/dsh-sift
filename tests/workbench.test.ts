import { describe, expect, it } from 'vitest';
import { hasRunningProjectSession } from '../src/client/workbench.js';

describe('project workbench session lock', () => {
  it('locks the note while any linked project session is running, not only the active one', () => {
    const project = { sessionIds: ['active', 'history'] };
    const sessions = {
      byId: {
        active: { id: 'active', displayTitle: '当前讨论', running: false },
        history: { id: 'history', displayTitle: '历史讨论', running: true },
      },
    };
    expect(hasRunningProjectSession(project, sessions)).toBe(true);
    sessions.byId.history.running = false;
    expect(hasRunningProjectSession(project, sessions)).toBe(false);
  });
});
