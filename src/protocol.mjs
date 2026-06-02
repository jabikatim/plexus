// Plexus protocol — the shared vocabulary for the collaboration layer.
//
// Design:
//  - Two-layer interop stack: MCP (vertical, agent<->tool) + A2A (horizontal,
//    agent<->agent).
//  - A Room is a Shared Context Store (SCS): one transcript + scoped memory that
//    every participant reads/writes, instead of N context-isolated threads.
//  - Memory is a scoped write->manage->read loop.
//
// Pure data + helpers. No I/O here. Zero dependencies by design.

import { randomUUID } from 'node:crypto';

/** A participant is one of these roles. */
export const Role = Object.freeze({
  HUMAN: 'human', // a person, via CLI/web/IM
  NATIVE: 'native', // an agent Plexus runs itself (Claude Agent SDK subagent)
  BRIDGED: 'bridged', // an external agent connected over A2A
  SYSTEM: 'system', // the Room itself (wakeups, joins, system notices)
});

/**
 * Memory scopes — the visibility lattice for the write->manage->read loop.
 * A read at scope S sees keys written at S and at every broader scope.
 * Broadest -> narrowest:  hub > room > member > turn-private(user).
 */
export const Scope = Object.freeze({
  HUB: 'hub', // shared across every room in a hub (org knowledge)
  ROOM: 'room', // shared by everyone in this room (the SCS proper)
  MEMBER: 'member', // private to one agent/human across rooms
  USER: 'user', // private to one human identity
});

/** Visibility precedence used when resolving a scoped read. */
export const SCOPE_ORDER = [Scope.HUB, Scope.ROOM, Scope.MEMBER, Scope.USER];

/** Event types emitted on a Room's bus (delivered over SSE). */
export const Event = Object.freeze({
  MEMBER_JOINED: 'member.joined',
  MEMBER_LEFT: 'member.left',
  MESSAGE_POSTED: 'message.posted',
  MEMORY_WRITTEN: 'memory.written',
  WAKEUP: 'wakeup', // external trigger woke the room (webhook/cron)
  TASK_DELEGATED: 'task.delegated', // A2A-style hand-off between members
  TASK_COMPLETED: 'task.completed',
});

export const newId = (prefix) => `${prefix}_${randomUUID().slice(0, 8)}`;

/**
 * Build a transcript message. `content` is plain text or a structured block.
 * `replyTo` threads a turn under another. `meta` carries A2A/MCP provenance.
 */
export function message({ memberId, role, content, replyTo = null, meta = {} }) {
  return {
    id: newId('msg'),
    memberId,
    role,
    content,
    replyTo,
    meta,
    ts: null, // stamped by the server on append (clients have no clock authority)
  };
}

/**
 * A capability grant: what a member is allowed to reach. Mirrors the 2026
 * two-layer stack — `kind:'mcp'` for tools, `kind:'a2a'` for peer agents,
 * plus room-local 'skill'/'event_source'. Access control is grant-based.
 */
export function capability({ kind, ref, scope = Scope.ROOM }) {
  return { kind, ref, scope }; // kind: 'mcp' | 'a2a' | 'skill' | 'event_source'
}

/** Resolve which scopes a read at `scope` may see (broadest..self). */
export function visibleScopes(scope) {
  const idx = SCOPE_ORDER.indexOf(scope);
  if (idx === -1) return [Scope.ROOM];
  return SCOPE_ORDER.slice(0, idx + 1);
}

/** Validate a role string. */
export const isRole = (r) => Object.values(Role).includes(r);
