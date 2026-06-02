// PlexusClient — how a participant (human shell, native agent, or bridged agent)
// talks to a Room. Thin wrapper over the HTTP API + SSE stream. Zero deps.
//
// Uses global fetch + a hand-rolled SSE reader (Node 20 has fetch; it lacks a
// browser EventSource, so we parse the text/event-stream ourselves).

import { Scope } from './protocol.mjs';

export class PlexusClient {
  constructor({ base = 'http://localhost:7771', roomId, memberId, token } = {}) {
    this.base = base;
    this.roomId = roomId;
    this.memberId = memberId;
    this.token = token;
  }

  static async createRoom(base, hubId, title) {
    const r = await fetch(`${base}/hubs/${hubId}/rooms`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title }),
    });
    return r.json(); // { id, hubId, title }
  }

  /** Join a room; returns a ready-to-use client bound to the new member. */
  static async join(base, roomId, { name, role, userId, capabilities } = {}) {
    const r = await fetch(`${base}/rooms/${roomId}/members`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, role, userId, capabilities }),
    });
    if (!r.ok) throw new Error(`join failed: ${(await r.json()).error}`);
    const { memberId, token } = await r.json();
    return new PlexusClient({ base, roomId, memberId, token });
  }

  async post(content, { replyTo = null, meta = {} } = {}) {
    const r = await fetch(`${this.base}/rooms/${this.roomId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}` },
      body: JSON.stringify({ memberId: this.memberId, content, replyTo, meta }),
    });
    if (!r.ok) throw new Error(`post failed: ${(await r.json()).error}`);
    return r.json();
  }

  async delegate(toMemberId, brief) {
    const r = await fetch(`${this.base}/rooms/${this.roomId}/delegate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}` },
      body: JSON.stringify({ fromMemberId: this.memberId, toMemberId, brief }),
    });
    return r.json();
  }

  async remember(key, value, { scope = Scope.ROOM } = {}) {
    await fetch(`${this.base}/rooms/${this.roomId}/memory`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope, key, value, memberId: this.memberId, userId: this.userId }),
    });
  }

  async recall(key, { scope = Scope.MEMBER } = {}) {
    const q = new URLSearchParams({ scope, key, memberId: this.memberId, userId: this.userId || '' });
    const r = await fetch(`${this.base}/rooms/${this.roomId}/memory?${q}`);
    return (await r.json()).entry; // { scope, key, value } | null
  }

  async transcript() {
    const r = await fetch(`${this.base}/rooms/${this.roomId}/transcript`);
    return (await r.json()).messages;
  }

  /** Fire an external wakeup into the room (webhook/cron simulation). */
  async wakeup(source, payload) {
    const r = await fetch(`${this.base}/rooms/${this.roomId}/wakeups`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source, payload }),
    });
    return r.json();
  }

  /**
   * Subscribe to the room's event stream. Calls onEvent({type, payload, seq})
   * for every event. Returns an AbortController — call .abort() to disconnect.
   */
  subscribe(onEvent, { since = 0 } = {}) {
    const ac = new AbortController();
    (async () => {
      const res = await fetch(`${this.base}/rooms/${this.roomId}/stream?since=${since}`, {
        headers: { accept: 'text/event-stream' }, signal: ac.signal,
      });
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) !== -1) {
            const frame = buf.slice(0, i); buf = buf.slice(i + 2);
            const data = frame.split('\n').find((l) => l.startsWith('data:'));
            if (data) { try { onEvent(JSON.parse(data.slice(5).trim())); } catch {} }
          }
        }
      } catch (e) {
        if (e.name !== 'AbortError') throw e;
      }
    })();
    return ac;
  }
}
