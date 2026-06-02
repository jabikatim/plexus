# Plexus architecture

## Thesis

Three layers make an agent system. Two have standards; one doesn't.

```
  ┌──────────────────────────────────────────────────────────────┐
  │  L3  SHARED CONTEXT   ← Plexus adds this (the Room)            │
  │      one transcript · scoped memory · event bus · governance  │
  ├──────────────────────────────────────────────────────────────┤
  │  L2  AGENT ↔ AGENT    ← A2A (Linux Foundation): delegation     │
  ├──────────────────────────────────────────────────────────────┤
  │  L1  AGENT ↔ TOOL     ← MCP (Anthropic): 200+ servers          │
  └──────────────────────────────────────────────────────────────┘
```

Without L3, every Claude Agent SDK subagent runs in its own context-isolated
session thread. They can hand off tasks (L2) and call tools (L1) but cannot
*see the same conversation* or *share governed memory*. Plexus is L3.

## The Room (Shared Context Store)

A Room is the runtime boundary for: participant set, transcript visibility, the
event bus, and memory handoff. One process, one Room object:

```
Room {
  id, hubId, title
  members:   Map<memberId, {role, capabilities[], token, userId}>
  transcript: Message[]              // the single shared log every member reads
  memory:    { room, member, user }  // per-room scoped stores
  subscribers: Set<SSE>              // live fan-out
  seq                                // monotonic cursor for resume
}
hubMemory: Map<`${hubId}:${key}`>    // process-global → spans rooms in a hub
```

Every state change emits a bus event (`member.joined`, `message.posted`,
`memory.written`, `wakeup`, `task.delegated`, `task.completed`) delivered to all
subscribers over Server-Sent Events. Each event carries `seq`; a reconnecting
client passes `?since=` to replay what it missed.

## Memory: the scoped write→manage→read loop

Following the 2026 survey (arXiv:2603.07670), memory is not a blob — it's a loop
with an explicit **scope lattice**:

```
hub      (broadest)   shared across all rooms in a hub        — org knowledge
  └ room              shared by everyone in this room          — the SCS proper
      └ member        private to one agent across rooms        — an agent's notes
          └ user      private to one human identity            — personal prefs
```

- **Write** is explicit: `remember(key, value, {scope})`.
- **Read** resolves **narrow→broad**: a `member`-scope read returns the member's
  own key if present, else falls back to `room`, else `hub`. So a private note
  *shadows* a room default — the visibility precedence in `visibleScopes()`.
- **Manage** (consolidation/forgetting — the survey's third verb) is where the
  human-inspired mechanisms (arXiv:2605.08538: sleep-phase consolidation,
  interference forgetting) would live. Out of scope for the reference impl;
  the seam is `writeMemory`/`readMemory` in `room-server.mjs`.

**Handoff** is just a write at a broader scope: the demo promotes a room-scope
hypothesis to hub-scope so the next incident room inherits it.

## Members and capabilities (access control)

A member has a role (`human` | `native` | `bridged` | `system`) and a list of
**capability grants**, each `{ kind, ref, scope }`:

| kind | meaning | layer |
| --- | --- | --- |
| `mcp` | may use this MCP tool/server | L1 |
| `a2a` | may delegate to this peer agent | L2 |
| `skill` | may invoke this room-local skill | — |
| `event_source` | may register/receive this wakeup source | — |

Posting requires the member's bearer token (`authorize()`), so identity in the
shared transcript is non-forgeable. Grants are the enforcement point you'd extend
for production (today they're recorded and available; the demo shows triage
holding an `mcp:github` grant and fixer an `a2a:laptop-runner` grant).

## Integration seams

| Seam | Reference impl | Production |
| --- | --- | --- |
| Brain | deterministic stub | `claudeBrain()` → `@anthropic-ai/claude-agent-sdk` `query()` |
| Store | in-memory `Map` | Postgres (transcript+memory) + Redis (bus) |
| Bridged member | local SSE client | A2A Agent Card + REST endpoint |
| Wakeup | `POST /wakeups` | GitHub/GitLab webhook, or Claude Code `/schedule` cron |
| Tools | capability grant record | live MCP server connection |

The protocol (`protocol.mjs`) is the contract; every row above swaps an
implementation without touching it.

## API surface

```
GET    /health
POST   /hubs/:hub/rooms                 {title}                → {id,hubId,title}
POST   /rooms/:id/members               {name,role,userId?,capabilities?} → {memberId,token}
POST   /rooms/:id/messages              {memberId,content,replyTo?,meta?}  (Bearer token)
GET    /rooms/:id/transcript            → {messages}
GET    /rooms/:id/stream?since=seq      SSE event stream (resumable)
PUT    /rooms/:id/memory                {scope,key,value,memberId?,userId?}
GET    /rooms/:id/memory?scope=&key=…   → {entry|null}   (resolves narrow→broad)
POST   /rooms/:id/wakeups               {source,payload}  → system turn + bus event
POST   /rooms/:id/delegate              {fromMemberId,toMemberId,brief} (Bearer)  → {taskId}
```

## Why single-process / in-memory is the right reference

Durability and horizontal scale are orthogonal to the *model*. The model is: one
governed shared conversation that humans and agents read and write, with a scope
lattice for memory and a grant lattice for access. A reader can verify that in
~400 lines here; the same protocol survives a Postgres/Redis swap unchanged.
