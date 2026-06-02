// Demo: a GitHub-style incident room.
//
// Run:  node examples/incident-room.mjs
// No API key, no npm install — the agent "brains" are deterministic stubs so the
// collaboration mechanics (shared transcript, scoped memory, wakeup, A2A hand-off)
// are visible without any LLM in the loop. Swap a stub for `claudeBrain(...)` to
// make a member a real Claude teammate; nothing else changes.

import { start } from '../src/room-server.mjs';
import { PlexusClient } from '../src/client.mjs';
import { PlexusAgent } from '../src/agent.mjs';
import { Event, Role, Scope } from '../src/protocol.mjs';

const BASE = 'http://localhost:7771';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ids = {}; // member ids, filled in as members join

// --- boot the room service in-process --------------------------------------
const server = start(7771);
await sleep(150);

// --- a console "spectator" prints the shared transcript live ----------------
const { id: roomId } = await PlexusClient.createRoom(BASE, 'acme-eng', 'incident-#1421');
const spectator = await PlexusClient.join(BASE, roomId, { name: 'console', role: Role.HUMAN, userId: 'u_obs' });
spectator.subscribe((evt) => {
  if (evt.type === Event.MESSAGE_POSTED) {
    const m = evt.payload;
    if (m.role === Role.SYSTEM) console.log(`  ⚡ [${m.content.source}] wakeup: ${JSON.stringify(m.content.payload)}`);
    else console.log(`  ${tag(m.role)} ${m.name}: ${render(m.content)}`);
  }
});

// --- agent #1: triage (native). Summarizes the alert, records a hypothesis. -
const triage = await new PlexusAgent({
  name: 'triage',
  capabilities: [{ kind: 'mcp', ref: 'github', scope: Scope.ROOM }],
  brain: async ({ event, client }) => {
    if (event.type !== Event.WAKEUP) return null;
    const { service, error } = event.payload.payload;
    // Write a room-scoped hypothesis into the Shared Context Store.
    await client.remember('root_cause_hypothesis', `deploy regression in ${service}`, { scope: Scope.ROOM });
    return { kind: 'summary', text: `${service} is failing: "${error}". Last deploy looks suspect.`, suspect: 'last-deploy' };
  },
}).join(BASE, roomId);
ids.triage = triage.client.memberId;

// --- agent #2: fixer (native). Reacts to triage, proposes + delegates a fix. -
const fixer = await new PlexusAgent({
  name: 'fixer',
  capabilities: [{ kind: 'a2a', ref: 'laptop-runner', scope: Scope.ROOM }],
  brain: async ({ event, client }) => {
    if (event.type !== Event.MESSAGE_POSTED) return null;
    if (event.payload.content?.kind !== 'summary') return null;
    // Read what triage stored — knowledge transfer via the SCS, not re-derivation.
    const h = await client.recall('root_cause_hypothesis', { scope: Scope.ROOM });
    await client.post({ kind: 'proposal', action: 'rollback last deploy', because: h?.value });
    // A2A hand-off to the machine-side runner to actually execute.
    await client.delegate(ids.laptop, 'Run: deploy rollback --to previous');
    return null;
  },
}).join(BASE, roomId);
ids.fixer = fixer.client.memberId;

// --- a bridged agent: the laptop runner. Connected the "remote/A2A" way: a raw
//     client that listens for delegations addressed to it and reports results. --
const laptop = await PlexusClient.join(BASE, roomId, {
  name: 'laptop-runner', role: Role.BRIDGED, capabilities: [{ kind: 'mcp', ref: 'shell', scope: Scope.MEMBER }],
});
ids.laptop = laptop.memberId;
laptop.subscribe(async (evt) => {
  if (evt.type === Event.TASK_DELEGATED && evt.payload.toMemberId === laptop.memberId) {
    await sleep(120); // pretend the command runs on the real machine
    await laptop.post({ kind: 'result', text: `executed "${evt.payload.brief}" — service healthy ✅` });
  }
});

// --- a human joins and asks a question mid-incident -------------------------
const human = await PlexusClient.join(BASE, roomId, { name: 'pjab', role: Role.HUMAN, userId: 'u_pjab' });

console.log(`\n=== incident-#1421 — shared room (every line below is one transcript) ===\n`);

// --- the trigger: a webhook wakes the room (an external event source) --------
await human.wakeup('github', { service: 'checkout-api', error: 'HTTP 500 after deploy d4f1a' });
await sleep(250);
await human.post('what broke?');
await sleep(300);

// --- after resolution: promote the lesson from room scope to hub scope so the
//     NEXT incident room starts smarter (cross-room memory handoff). ----------
const lesson = await human.recall('root_cause_hypothesis', { scope: Scope.ROOM });
await human.remember('incident-1421-lesson', lesson?.value, { scope: Scope.HUB });
await sleep(150);

console.log(`\n=== memory handoff ===`);
console.log(`  room-scope hypothesis : ${lesson?.value}`);
const hubView = await human.recall('incident-1421-lesson', { scope: Scope.HUB });
console.log(`  promoted to hub-scope : ${hubView?.value}  (visible to future rooms in acme-eng)`);

await sleep(100);
console.log(`\nDone. ${'-'.repeat(40)}\nSwap any stub brain for claudeBrain({...}) to make that member a real Claude teammate.`);
server.close();
process.exit(0);

// --- formatting helpers -----------------------------------------------------
function tag(role) {
  return { human: '👤', native: '🤖', bridged: '💻', system: '⚙️' }[role] || '•';
}
function render(c) {
  if (typeof c === 'string') return c;
  if (c.kind === 'summary') return `[summary] ${c.text}`;
  if (c.kind === 'proposal') return `[proposal] ${c.action} (because: ${c.because})`;
  if (c.kind === 'result') return `[result] ${c.text}`;
  if (c.kind === 'delegate') return `[delegate→] ${c.brief}`;
  return JSON.stringify(c);
}
