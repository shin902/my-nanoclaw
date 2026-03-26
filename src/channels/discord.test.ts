import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));
vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

type Handler = (...args: any[]) => any;
const clientRef = vi.hoisted(() => ({ current: null as any }));

vi.mock('discord.js', () => {
  const Events = {
    MessageCreate: 'messageCreate',
    InteractionCreate: 'interactionCreate',
    ClientReady: 'ready',
    Error: 'error',
  };

  const GatewayIntentBits = {
    Guilds: 1,
    GuildMessages: 2,
    MessageContent: 4,
    DirectMessages: 8,
  };

  class MockClient {
    eventHandlers = new Map<string, Handler[]>();
    user: any = { id: 'bot-1', tag: 'Bot#0001' };
    application = { commands: { set: vi.fn().mockResolvedValue(undefined) } };
    private _ready = false;

    constructor() {
      clientRef.current = this;
    }

    on(event: string, handler: Handler) {
      const list = this.eventHandlers.get(event) || [];
      list.push(handler);
      this.eventHandlers.set(event, list);
      return this;
    }

    async login() {
      this._ready = true;
      for (const handler of this.eventHandlers.get('ready') || []) {
        await handler(this);
      }
    }

    isReady() {
      return this._ready;
    }

    channels = {
      fetch: vi.fn().mockResolvedValue({
        send: vi.fn().mockResolvedValue(undefined),
        sendTyping: vi.fn().mockResolvedValue(undefined),
      }),
    };

    destroy() {
      this._ready = false;
    }
  }

  class TextChannel {}

  return { Client: MockClient, Events, GatewayIntentBits, TextChannel };
});

import { DiscordChannel } from './discord.js';

function currentClient() {
  return clientRef.current;
}

async function trigger(event: string, payload: any) {
  for (const handler of currentClient().eventHandlers.get(event) || []) {
    await handler(payload);
  }
}

describe('DiscordChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('forwards registered channel messages', async () => {
    const onMessage = vi.fn();
    const channel = new DiscordChannel('token', {
      onMessage,
      getGroupConfig: () => ({
        jid: 'dc:123',
        name: 'general',
        folder: 'general',
        model: 'claude-sonnet-4-6',
        provider: 'claude',
        added_at: '2026-03-20T00:00:00.000Z',
      }),
      resetSession: vi.fn(),
      updateModel: vi.fn(),
      compact: vi.fn(async () => {}),
    });

    await channel.connect();
    await trigger('messageCreate', {
      author: { bot: false, id: 'u1', username: 'alice', displayName: 'Alice' },
      member: { displayName: 'Alice' },
      channelId: '123',
      content: 'hello',
      id: 'm1',
      createdAt: new Date('2026-03-20T00:00:00.000Z'),
      attachments: new Map(),
      reference: null,
      channel: { messages: { fetch: vi.fn() } },
    });

    expect(onMessage).toHaveBeenCalledWith(
      'dc:123',
      expect.objectContaining({ content: 'hello', sender_name: 'Alice' }),
      expect.objectContaining({ folder: 'general' }),
    );
  });

  it('handles /new interactions', async () => {
    const resetSession = vi.fn();
    const channel = new DiscordChannel('token', {
      onMessage: vi.fn(),
      getGroupConfig: () => ({
        jid: 'dc:123',
        name: 'general',
        folder: 'general',
        model: 'claude-sonnet-4-6',
        provider: 'claude',
        added_at: '2026-03-20T00:00:00.000Z',
      }),
      resetSession,
      updateModel: vi.fn(),
      compact: vi.fn(async () => {}),
    });

    await channel.connect();
    const reply = vi.fn();
    await trigger('interactionCreate', {
      isChatInputCommand: () => true,
      commandName: 'new',
      channelId: '123',
      options: { getString: vi.fn() },
      reply,
    });

    expect(resetSession).toHaveBeenCalledWith('dc:123');
    expect(reply).toHaveBeenCalled();
  });
});
