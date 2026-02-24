# ADR-001: Convex-first backend with Yjs CRDT

## Status

Accepted

## Context

The prior LiveSync-style setup was unreliable under concurrent edits and poor connectivity. We need deterministic markdown convergence, low-latency fanout, and a practical self-host posture.

## Decision

1. Use Yjs CRDT updates for markdown operations.
2. Use Convex self-hosted as the primary realtime/query layer in deployment topology.
3. Use Postgres for metadata and operation persistence.
4. Use MinIO/S3-compatible object storage for encrypted binary chunks.
5. Keep server-side plaintext inaccessible by default through client-side encryption.

## Consequences

Positive:

1. Deterministic merge behavior for concurrent markdown edits.
2. Fast subscription updates and cursor-based replay.
3. Strong operational portability for self-hosted environments.

Tradeoffs:

1. Higher implementation complexity than LWW-only sync.
2. CRDT state compaction and snapshot lifecycle must be actively managed.
3. Key rotation and envelope management add UX complexity.

## Rejected Alternatives

1. LWW + text diff only: simpler but weaker under real concurrency.
2. Revision-tree conflict model (Couch/Pouch): robust, but less natural for realtime markdown collaboration.
3. Full server-side merge logic: violates E2EE goals and increases merge risk.
