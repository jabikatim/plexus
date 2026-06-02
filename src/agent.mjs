// PlexusAgent — adapts a "brain" (a function from shared context -> a reply)
// into a Room member that watches the transcript and contributes when relevant.
//
// The brain is pluggable. Today it's a stub so the demo runs with zero API keys
// and zero network. To make it a real Claude teammate, pass `brain: claudeBrain`
// (see claudeBrain below) — that is the single seam between this reference impl
// and the Claude Agent SDK. Everything else is unchanged.

import { Event, Role } from './protocol.mjs';
import { PlexusClient } from './client.mjs';

export class PlexusAgent {
  /**
   * @param {object} opts
   * @param {string} opts.name
   * @param {(ctx:{event,transcript,client}) => Promise<string|object|null>} opts.brain
   *        Return content to post, or null to stay silent. `ctx.transcript` is
   *        the full shared context store (the whole point of Plexus).
   * @param {(event) => boolean} [opts.wakesOn]  Filter for which events stir the agent.
   */
  constructor({ name, brain, wakesOn = defaultWakesOn, capabilities = [] }) {
    this.name = name;
    this.brain = brain;
    this.wakesOn = wakesOn;
    this.capabilities = capabilities;
    this.client = null;
    this._sub = null;
  }

  async join(base, roomId) {
    this.client = await PlexusClient.join(base, roomId, {
      name: this.name, role: Role.NATIVE, capabilities: this.capabilities,
    });
    this._sub = this.client.subscribe(async (evt) => {
      // Never react to our own turns; avoid agent echo loops.
      if (evt.payload?.memberId === this.client.memberId) return;
      if (!this.wakesOn(evt)) return;
      const transcript = await this.client.transcript();
      const reply = await this.brain({ event: evt, transcript, client: this.client });
      if (reply != null) await this.client.post(reply);
    });
    return this;
  }

  leave() { this._sub?.abort(); }
}

// React to new human/agent turns and to external wakeups; ignore memory/system noise.
function defaultWakesOn(evt) {
  return evt.type === Event.MESSAGE_POSTED || evt.type === Event.WAKEUP;
}

// --- The Claude Agent SDK seam --------------------------------------------
//
// Drop-in real brain. Requires `npm i @anthropic-ai/claude-agent-sdk` and an
// ANTHROPIC_API_KEY. Kept lazily-imported so the stub demo needs neither.
//
//   import { claudeBrain } from './agent.mjs';
//   new PlexusAgent({ name: 'triage', brain: claudeBrain({
//     system: 'You triage incidents. Be terse. One action per turn.',
//     model: 'claude-sonnet-4-6',
//   })});
//
// The key idea: we render the *shared* transcript into the prompt, so the Claude
// subagent reasons over the whole room — not its own isolated session thread.
export function claudeBrain({ system, model = 'claude-sonnet-4-6', allowedTools = [] }) {
  return async ({ transcript }) => {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    const convo = transcript
      .filter((m) => m.role !== Role.SYSTEM)
      .map((m) => `${m.name}: ${renderContent(m.content)}`)
      .join('\n');
    let out = '';
    for await (const msg of query({
      prompt: `Shared room transcript so far:\n${convo}\n\nYour turn. Reply with one concise contribution, or "(pass)" to stay silent.`,
      options: { systemPrompt: system, model, allowedTools },
    })) {
      if (msg.type === 'assistant') {
        for (const block of msg.message.content) if (block.type === 'text') out += block.text;
      }
    }
    out = out.trim();
    return out && out !== '(pass)' ? out : null;
  };
}

const renderContent = (c) => (typeof c === 'string' ? c : JSON.stringify(c));
