import { ForbiddenException } from '@nestjs/common';
import { ChatGateway } from './chat.gateway';

function fakeClient(
  data: Record<string, unknown> = { userId: 'u1', roles: ['engineer'] },
) {
  const emitted: { room: string; event: string; payload: unknown }[] = [];
  const rooms = new Set<string>();
  const client = {
    data: { ready: Promise.resolve(), ...data },
    rooms,
    join: jest.fn(async (room: string) => {
      rooms.add(room);
    }),
    leave: jest.fn(async (room: string) => {
      rooms.delete(room);
    }),
    to: (room: string) => ({
      emit: (event: string, payload: unknown) =>
        emitted.push({ room, event, payload }),
    }),
  };
  return { client, emitted };
}

function build() {
  const chatService = {
    resolveChannel: jest.fn(),
    getUserName: jest.fn().mockResolvedValue('Njeri Kamau'),
  };
  const gateway = new ChatGateway(chatService as never);
  return { gateway, chatService };
}

describe('ChatGateway', () => {
  it('refuses to join when the socket never authenticated', async () => {
    const { gateway, chatService } = build();
    const { client } = fakeClient({});
    const ack = await gateway.join(client as never, { type: 'site', id: 's1' });
    expect(ack).toEqual({ ok: false, error: 'Not authenticated' });
    expect(chatService.resolveChannel).not.toHaveBeenCalled();
  });

  it('does not join a room the access check rejected', async () => {
    const { gateway, chatService } = build();
    chatService.resolveChannel.mockRejectedValue(
      new ForbiddenException('You are not part of this project'),
    );
    const { client } = fakeClient();
    const ack = await gateway.join(client as never, { type: 'site', id: 's1' });
    expect(ack).toEqual({
      ok: false,
      error: 'You are not part of this project',
    });
    expect(client.join).not.toHaveBeenCalled();
  });

  it('joins the resolved room and announces presence to it', async () => {
    const { gateway, chatService } = build();
    chatService.resolveChannel.mockResolvedValue({
      room: 'chat:inspection:i1',
    });
    const { client, emitted } = fakeClient();
    const ack = await gateway.join(client as never, {
      type: 'inspection',
      id: 'i1',
    });
    expect(ack).toEqual({ ok: true });
    expect(client.rooms.has('chat:inspection:i1')).toBe(true);
    expect(emitted).toContainEqual({
      room: 'chat:inspection:i1',
      event: 'presence:update',
      payload: { userId: 'u1', online: true },
    });
  });

  it('ignores typing from a socket that has not joined the conversation', async () => {
    const { gateway } = build();
    const { client, emitted } = fakeClient();
    const ack = await gateway.typing(client as never, {
      type: 'site',
      id: 's1',
      typing: true,
    });
    expect(ack.ok).toBe(false);
    expect(emitted).toHaveLength(0);
  });

  it('relays typing to the other participants with the typist name', async () => {
    const { gateway, chatService } = build();
    chatService.resolveChannel.mockResolvedValue({ room: 'chat:site:s1' });
    const { client, emitted } = fakeClient();
    await gateway.join(client as never, { type: 'site', id: 's1' });
    emitted.length = 0;

    await gateway.typing(client as never, {
      type: 'site',
      id: 's1',
      typing: true,
    });

    expect(emitted).toEqual([
      {
        room: 'chat:site:s1',
        event: 'chat:typing',
        payload: {
          channelType: 'site',
          channelId: 's1',
          userId: 'u1',
          name: 'Njeri Kamau',
          typing: true,
        },
      },
    ]);
  });

  it('rejects malformed payloads', async () => {
    const { gateway } = build();
    const { client } = fakeClient();
    expect(
      (await gateway.join(client as never, { type: 5, id: null })).ok,
    ).toBe(false);
    expect(
      (
        await gateway.typing(client as never, {
          type: 'site',
          id: 's1',
          typing: 'yes',
        })
      ).ok,
    ).toBe(false);
  });
});
