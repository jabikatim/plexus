# Plexus — architecture diagrams

All diagrams are Mermaid and render directly on GitHub.

---

## 1. System architecture

How participants, the client SDK, the Room service, and the capability layer fit
together.

```mermaid
flowchart TB
  subgraph PART["Participants — Members"]
    direction LR
    H["👤 Human<br/>CLI / web / IM"]
    N["🤖 Native agent<br/>PlexusAgent + brain"]
    B["💻 Bridged agent<br/>external, joined over A2A"]
  end

  subgraph BRAIN["Brain seam — agent.mjs"]
    STUB["stub brain<br/>deterministic, no key"]
    CLAUDE["claudeBrain → Claude Agent SDK query"]
  end
  N --- BRAIN

  subgraph SDK["Client SDK — client.mjs"]
    PC["PlexusClient<br/>join · post · delegate<br/>remember · recall · subscribe"]
  end

  H --> PC
  N --> PC
  B --> PC

  subgraph ROOM["Room Service — room-server.mjs"]
    API["HTTP API + Router"]
    AUTH["Auth — per-member bearer token"]
    TR["Transcript — single shared log + seq"]
    BUS["Event Bus — SSE fan-out, resumable"]
    subgraph MEM["Scoped Memory — write, manage, read"]
      direction LR
      HUBM["hub"]
      ROOMM["room"]
      MEMM["member"]
      USERM["user"]
    end
  end

  PC -->|HTTP /messages /memory /delegate /wakeups| API
  PC -->|SSE /stream| BUS
  API --> AUTH
  API --> TR
  API --> MEM
  TR --> BUS
  MEM --> BUS

  subgraph CAP["Capability grants — access control"]
    direction LR
    MCP["MCP servers — tools · L1"]
    A2APEER["A2A peers — agents · L2"]
    SK["Skills"]
    ES["Event sources — webhook / cron"]
  end

  N -.->|grant mcp| MCP
  N -.->|grant a2a| A2APEER
  B -.->|joins via| A2APEER
  ES ==>|wakeup| API

  classDef store fill:#eef,stroke:#88a;
  class HUBM,ROOMM,MEMM,USERM store;
```

---

## 2. The three-layer thesis

Two layers already have standards; Plexus contributes the third.

```mermaid
flowchart TB
  L3["L3 — SHARED CONTEXT  ← Plexus adds this<br/>one transcript · scoped memory · event bus · governance"]
  L2["L2 — AGENT to AGENT  ← A2A<br/>delegation, Agent Cards, cross-vendor coordination"]
  L1["L1 — AGENT to TOOL  ← MCP<br/>agent-to-tool connectivity"]
  L3 --- L2 --- L1
  classDef new fill:#dff5df,stroke:#3a3;
  classDef have fill:#f5f5f5,stroke:#999;
  class L3 new;
  class L2,L1 have;
```

---

## 3. Memory scope lattice

A write pins a key to one scope. A read resolves **narrow → broad**, so a private
note *shadows* a room default.

```mermaid
flowchart TD
  hub["hub<br/>shared across all rooms in a hub — org knowledge"]
  room["room<br/>shared by everyone in this room — the SCS proper"]
  member["member<br/>private to one agent across rooms"]
  user["user<br/>private to one human identity"]
  hub --> room --> member --> user

  read["read at scope = member"]
  read -.->|step 1 member| member
  read -.->|step 2 else room| room
  read -.->|step 3 else hub| hub
  classDef sc fill:#eef,stroke:#88a;
  class hub,room,member,user sc;
```

---

## 4. Runtime sequence — the incident room

End-to-end flow of `examples/incident-room.mjs`: every arrow into `R` is one
entry in the single shared transcript.

```mermaid
sequenceDiagram
  autonumber
  participant W as Webhook github
  participant R as Room Service
  participant T as Triage native
  participant F as Fixer native
  participant L as Laptop-runner bridged
  participant H as Human

  W->>R: POST /wakeups {service, error}
  R-->>T: SSE wakeup
  R-->>F: SSE wakeup
  Note over T: writes hypothesis<br/>remember(root_cause, scope=room)
  T->>R: post summary
  R-->>F: SSE message.posted summary
  Note over F: reads the SCS<br/>recall(root_cause, scope=room)
  F->>R: post proposal rollback
  F->>R: POST /delegate to Laptop-runner
  R-->>L: SSE task.delegated
  Note over L: runs the command<br/>on the real machine
  L->>R: post result service healthy
  H->>R: remember(lesson, scope=hub)
  Note over R: room-scope lesson promoted to hub-scope<br/>next incident room inherits it
```

---

## 5. Member lifecycle

```mermaid
stateDiagram-v2
  [*] --> Joined: POST /members returns memberId + token
  Joined --> Subscribed: GET /stream?since=
  Subscribed --> Reacting: bus event passes wakesOn
  Reacting --> Posting: brain returns content
  Posting --> Subscribed: post appends to transcript
  Reacting --> Subscribed: brain returns null, pass
  Subscribed --> [*]: leave or disconnect
```
