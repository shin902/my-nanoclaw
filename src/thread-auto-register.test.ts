import crypto from 'crypto';
import { describe, it, expect, vi } from 'vitest';

import {
  _autoRegisterThreadFromParent,
  _persistSessionForChat,
} from './index.js';
import type { InboundMessage, RegisteredGroup } from './types.js';

function makeInbound(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    id: 'm-1',
    chat_jid: 'dc:thread-1',
    sender: 'u-1',
    sender_name: 'Alice',
    content: 'hello',
    timestamp: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('thread auto-registration', () => {
  it('registers child when parent exists', () => {
    const groups: Record<string, RegisteredGroup> = {
      'dc:parent-1': {
        name: 'Parent',
        folder: 'dc_parent',
        trigger: '@Andy',
        added_at: '2026-01-01T00:00:00.000Z',
        containerConfig: { timeout: 1234 },
        requiresTrigger: false,
        type: 'chat',
      },
    };
    const register = vi.fn((jid: string, group: RegisteredGroup) => {
      groups[jid] = group;
    });

    const ok = _autoRegisterThreadFromParent(
      'dc:thread-1',
      makeInbound({ parent_jid: 'dc:parent-1', sender_name: 'Bob' }),
      groups,
      register,
      () => '2026-01-02T03:04:05.000Z',
    );

    expect(ok).toBe(true);
    expect(register).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith(
      'dc:thread-1',
      expect.objectContaining({
        name: 'Thread (Bob)',
        trigger: '@Andy',
        added_at: '2026-01-02T03:04:05.000Z',
        containerConfig: { timeout: 1234 },
        requiresTrigger: false,
        type: 'thread',
      }),
    );

    const [, registeredChild] = register.mock.calls[0] as [
      string,
      RegisteredGroup,
    ];
    const expectedFolder = `dc_parent_${crypto.createHash('sha1').update('dc:thread-1').digest('hex').slice(0, 8)}`;
    expect(registeredChild.folder).toBe(expectedFolder);
    expect(registeredChild.folder).toContain(groups['dc:parent-1'].folder);
    expect(registeredChild.folder).not.toBe(groups['dc:parent-1'].folder);

    expect(groups['dc:thread-1']).toEqual(
      expect.objectContaining({
        type: 'thread',
        folder: registeredChild.folder,
      }),
    );
  });

  it('does not register when parent missing', () => {
    const groups: Record<string, RegisteredGroup> = {};
    const register = vi.fn();

    const ok = _autoRegisterThreadFromParent(
      'dc:thread-2',
      makeInbound({ parent_jid: 'dc:missing-parent' }),
      groups,
      register,
    );

    expect(ok).toBe(false);
    expect(register).not.toHaveBeenCalled();
    expect(groups['dc:thread-2']).toBeUndefined();
  });
});

describe('session keying', () => {
  it('stores sessions keyed by chat_jid (not folder)', () => {
    const state: Record<string, string> = {};
    const persist = vi.fn();

    _persistSessionForChat(state, 'dc:chat-123', 'session-xyz', persist);

    expect(state).toEqual({ 'dc:chat-123': 'session-xyz' });
    expect(state['dc_folder_like_key']).toBeUndefined();
    expect(persist).toHaveBeenCalledWith('dc:chat-123', 'session-xyz');
  });
});
