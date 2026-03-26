import {
  ChatInputCommandInteraction,
  Client,
  Events,
  GatewayIntentBits,
  Message,
  TextChannel,
} from 'discord.js';

import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { Channel, NewMessage, StoredGroupConfig } from '../types.js';

export interface DiscordChannelOpts {
  onMessage: (
    chatJid: string,
    message: NewMessage,
    config: StoredGroupConfig,
  ) => void;
  getGroupConfig: (chatJid: string) => StoredGroupConfig | undefined;
  resetSession: (chatJid: string) => void;
  updateModel: (chatJid: string, model: string) => void;
  compact: (chatJid: string) => Promise<void>;
}

export class DiscordChannel implements Channel {
  name = 'discord';

  private client: Client | null = null;

  constructor(
    private readonly botToken: string,
    private readonly opts: DiscordChannelOpts,
  ) {}

  private async handleInteraction(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    const chatJid = `dc:${interaction.channelId}`;
    const config = this.opts.getGroupConfig(chatJid);
    if (!config) {
      await interaction.reply({
        content: 'This channel is not registered.',
        ephemeral: true,
      });
      return;
    }

    if (interaction.commandName === 'new') {
      this.opts.resetSession(chatJid);
      await interaction.reply('Session reset.');
      return;
    }

    if (interaction.commandName === 'model') {
      const model = interaction.options.getString('model', true);
      this.opts.updateModel(chatJid, model);
      await interaction.reply(`Model updated to ${model}.`);
      return;
    }

    if (interaction.commandName === 'compact') {
      await this.opts.compact(chatJid);
      await interaction.reply('Conversation compacted.');
    }
  }

  async connect(): Promise<void> {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
    });

    this.client.on(Events.MessageCreate, async (message: Message) => {
      if (message.author.bot) return;

      const chatJid = `dc:${message.channelId}`;
      const config = this.opts.getGroupConfig(chatJid);
      if (!config) return;

      let content = message.content;
      const attachments = [...message.attachments.values()].map((att) =>
        att.contentType?.startsWith('image/')
          ? `[Image: ${att.name || 'image'}]`
          : `[File: ${att.name || 'file'}]`,
      );
      if (attachments.length > 0) {
        content = [content, ...attachments].filter(Boolean).join('\n');
      }

      if (message.reference?.messageId) {
        try {
          const repliedTo = await message.channel.messages.fetch(
            message.reference.messageId,
          );
          const replyAuthor =
            repliedTo.member?.displayName ||
            repliedTo.author.displayName ||
            repliedTo.author.username;
          content = `[Reply to ${replyAuthor}] ${content}`;
        } catch {
          // Ignore deleted references.
        }
      }

      this.opts.onMessage(
        chatJid,
        {
          id: message.id,
          chat_jid: chatJid,
          sender: message.author.id,
          sender_name:
            message.member?.displayName ||
            message.author.displayName ||
            message.author.username,
          content,
          timestamp: message.createdAt.toISOString(),
          is_from_me: false,
        },
        config,
      );
    });

    this.client.on(Events.InteractionCreate, async (interaction) => {
      if (!interaction.isChatInputCommand()) return;
      await this.handleInteraction(interaction);
    });

    this.client.on(Events.ClientReady, async (readyClient) => {
      logger.info(
        { username: readyClient.user.tag, id: readyClient.user.id },
        'Discord bot connected',
      );
      try {
        await readyClient.application.commands.set([
          { name: 'new', description: 'Reset the session for this channel' },
          {
            name: 'model',
            description: 'Update the model for this channel',
            options: [
              {
                name: 'model',
                description: 'Model name',
                type: 3,
                required: true,
              },
            ],
          },
          { name: 'compact', description: 'Compact recent conversation state' },
        ]);
      } catch (err) {
        logger.warn({ err }, 'Failed to register Discord slash commands');
      }
    });

    this.client.on(Events.Error, (err) => {
      logger.error({ err: err.message }, 'Discord client error');
    });

    await this.client.login(this.botToken);
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.client) return;

    const channel = await this.client.channels.fetch(jid.replace(/^dc:/, ''));
    if (!channel || !('send' in channel)) return;

    const textChannel = channel as TextChannel;
    const maxLength = 2000;
    for (let index = 0; index < text.length; index += maxLength) {
      await textChannel.send(text.slice(index, index + maxLength));
    }
  }

  isConnected(): boolean {
    return this.client !== null && this.client.isReady();
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('dc:');
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      this.client.destroy();
      this.client = null;
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.client || !isTyping) return;

    try {
      const channel = await this.client.channels.fetch(jid.replace(/^dc:/, ''));
      if (channel && 'sendTyping' in channel) {
        await (channel as TextChannel).sendTyping();
      }
    } catch (error) {
      logger.debug({ jid, error }, 'Discord: failed to send typing indicator');
    }
  }
}

export function createDiscordChannel(
  opts: DiscordChannelOpts,
): DiscordChannel | null {
  const envVars = readEnvFile(['DISCORD_BOT_TOKEN']);
  const token =
    process.env.DISCORD_BOT_TOKEN || envVars.DISCORD_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Discord: DISCORD_BOT_TOKEN not set');
    return null;
  }
  return new DiscordChannel(token, opts);
}
