// Plexus Room service — the Shared Context Store runtime: one transcript +
// scoped memory + an event bus, shared by humans and agents. Zero dependencies
// (node:http only).
//
// This is intentionally an in-memory single-process reference implementation:
// small enough to read in one sitting, faithful enough to demonstrate the model.
// Swap the Maps for Postgres/Redis to make it durable; the protocol is unchanged.

import { createServer } from 'node:http';
import {
  Event, Role, Scope, newId, isRole, visibleScopes,
} from './protocol.mjs';

const hubMemory = new Map(); // `${hubId}:${key}` -> value  (broadest scope, spans rooms)
const rooms = new Map(); // roomId -> Room

function createRoom(hubId, title) {
  const room = {
    id: newId('room'),
    hubId,
    title,
    createdTs: Date.now(),
    members: new Map(),
    transcript: [],
    memory: { room: new Map(), member: new Map(), user: new Map() },
    subscribers: new Set(),
    seq: 0,
  };
  rooms.set(room.id, room);
  return room;
}

// --- event bus -------------------------------------------------------------

function emit(room, type, payload) {
  const evt = { seq: ++room.seq, type, payload, ts: Date.now() };
  const frame = `id: ${evt.seq}\nevent: ${type}\ndata: ${JSON.stringify(evt)}\n\n`;
  for (const res of room.subscribers) res.write(frame);
  return evt;
}

// --- core operations -------------------------------------------------------

function join(room, { name, role, userId = null, capabilities = [] }) {
  if (!isRole(role)) throw httpError(400, `unknown role: ${role}`);
  const member = {
    id: newId('mem'), name, role, userId,
    capabilities, // grant-based access control (mcp / a2a / skill / event_source)
    token: newId('tok'),
    joinedTs: Date.now(),
  };
  room.members.set(member.id, member);
  emit(room, Event.MEMBER_JOINED, { id: member.id, name, role, userId });
  return member;
}

function post(room, { memberId, content, replyTo = null, meta = {} }) {
  const member = room.members.get(memberId);
  if (!member) throw httpError(404, 'member not in room');
  const msg = {
    id: newId('msg'), memberId, role: member.role, name: member.name,
    content, replyTo, meta, ts: Date.now(),
  };
  room.transcript.push(msg);
  emit(room, Event.MESSAGE_POSTED, msg);
  return msg;
}

// Memory: the scoped write->manage->read loop.
function memKey(room, scope, { memberId, userId }) {
  switch (scope) {
    case Scope.HUB: return { store: hubMemory, prefix: `${room.hubId}:` };
    case Scope.ROOM: return { store: room.memory.room, prefix: '' };
    case Scope.MEMBER: return { store: room.memory.member, prefix: `${memberId}:` };
    case Scope.USER: return { store: room.memory.user, prefix: `${userId}:` };
    default: throw httpError(400, `unknown scope: ${scope}`);
  }
}

function writeMemory(room, { scope, key, value, memberId, userId }) {
  const { store, prefix } = memKey(room, scope, { memberId, userId });
  store.set(prefix + key, value);
  emit(room, Event.MEMORY_WRITTEN, { scope, key }); // value not broadcast; readers pull with their grants
}

// Read resolves narrow->broad: a member sees its own keys, then room, then hub.
// Mirrors visibility precedence so an agent's private note shadows a room default.
function readMemory(room, { scope, key, memberId, userId }) {
  for (const s of [...visibleScopes(scope)].reverse()) {
    const { store, prefix } = memKey(room, s, { memberId, userId });
    if (store.has(prefix + key)) return { scope: s, key, value: store.get(prefix + key) };
  }
  return null;
}

// Wakeup: an external event (webhook/cron) wakes the room, expressed as a
// first-class bus event plus a system transcript line.
function wakeup(room, { source, payload }) {
  emit(room, Event.WAKEUP, { source, payload });
  return post(room, {
    memberId: ensureSystem(room),
    content: { kind: 'wakeup', source, payload },
    meta: { source },
  });
}

// A2A-style hand-off recorded in the shared transcript (horizontal coordination).
function delegate(room, { fromMemberId, toMemberId, brief }) {
  const taskId = newId('task');
  emit(room, Event.TASK_DELEGATED, { taskId, fromMemberId, toMemberId, brief });
  post(room, { memberId: fromMemberId, content: { kind: 'delegate', taskId, to: toMemberId, brief } });
  return { taskId };
}

let _systemMember = new WeakMap();
function ensureSystem(room) {
  if (!_systemMember.has(room)) {
    const m = join(room, { name: 'plexus', role: Role.SYSTEM });
    _systemMember.set(room, m.id);
  }
  return _systemMember.get(room);
}

// --- HTTP plumbing ---------------------------------------------------------

function httpError(status, message) {
  const e = new Error(message); e.status = status; return e;
}
const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw httpError(400, 'invalid JSON body'); }
}

function requireRoom(id) {
  const room = rooms.get(id);
  if (!room) throw httpError(404, 'room not found');
  return room;
}

export function start(port = 7771) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const parts = url.pathname.split('/').filter(Boolean);
      const m = req.method;

      // GET /health
      if (m === 'GET' && url.pathname === '/health') {
        return send(res, 200, { ok: true, rooms: rooms.size });
      }

      // POST /hubs/:hub/rooms
      if (m === 'POST' && parts[0] === 'hubs' && parts[2] === 'rooms') {
        const { title = 'untitled' } = await readJson(req);
        const room = createRoom(parts[1], title);
        return send(res, 201, { id: room.id, hubId: room.hubId, title });
      }

      if (parts[0] === 'rooms') {
        const room = requireRoom(parts[1]);

        // POST /rooms/:id/members
        if (m === 'POST' && parts[2] === 'members' && parts.length === 3) {
          const body = await readJson(req);
          const member = join(room, body);
          return send(res, 201, { memberId: member.id, token: member.token, role: member.role });
        }

        // POST /rooms/:id/messages   (bearer token authorizes the member)
        if (m === 'POST' && parts[2] === 'messages') {
          const body = await readJson(req);
          authorize(room, body.memberId, req);
          return send(res, 201, post(room, body));
        }

        // GET /rooms/:id/transcript
        if (m === 'GET' && parts[2] === 'transcript') {
          return send(res, 200, { messages: room.transcript });
        }

        // GET /rooms/:id/stream  (SSE; ?since=seq to resume)
        if (m === 'GET' && parts[2] === 'stream') {
          return openStream(room, url, res);
        }

        // GET/PUT /rooms/:id/memory
        if (parts[2] === 'memory') {
          if (m === 'PUT') {
            const body = await readJson(req);
            writeMemory(room, body);
            return send(res, 200, { ok: true });
          }
          if (m === 'GET') {
            const q = Object.fromEntries(url.searchParams);
            return send(res, 200, { entry: readMemory(room, { scope: q.scope || Scope.ROOM, ...q }) });
          }
        }

        // POST /rooms/:id/wakeups
        if (m === 'POST' && parts[2] === 'wakeups') {
          return send(res, 201, wakeup(room, await readJson(req)));
        }

        // POST /rooms/:id/delegate
        if (m === 'POST' && parts[2] === 'delegate') {
          const body = await readJson(req);
          authorize(room, body.fromMemberId, req);
          return send(res, 201, delegate(room, body));
        }
      }

      throw httpError(404, `no route for ${m} ${url.pathname}`);
    } catch (e) {
      send(res, e.status || 500, { error: e.message });
    }
  });

  server.listen(port, () => console.log(`[plexus] room service on http://localhost:${port}`));
  return server;
}

function authorize(room, memberId, req) {
  const member = room.members.get(memberId);
  if (!member) throw httpError(404, 'member not in room');
  const tok = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (member.token !== tok) throw httpError(403, 'bad or missing member token');
}

function openStream(room, url, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  res.write('retry: 2000\n\n');
  // Replay missed events from the transcript if the client gives a cursor.
  const since = Number(url.searchParams.get('since') || 0);
  if (since < room.seq) {
    for (const msg of room.transcript) {
      res.write(`event: ${Event.MESSAGE_POSTED}\ndata: ${JSON.stringify({ type: Event.MESSAGE_POSTED, payload: msg })}\n\n`);
    }
  }
  room.subscribers.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  res.on('close', () => { clearInterval(ping); room.subscribers.delete(res); });
}

// Allow `node src/room-server.mjs` to boot the service directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  start(Number(process.env.PLEXUS_PORT) || 7771);
}
