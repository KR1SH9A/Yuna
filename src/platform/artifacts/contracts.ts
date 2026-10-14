/**
 * Planned component: Artifact contracts
 * Kind: Plain bounded-storage and authorized-access boundary types
 * Owner: Platform / Artifacts
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility:
 * Describe opaque artifact references and the owner-supplied conditions for access.
 *
 * Planned methods:
 * None. Future types describe bounded storage input, artifact metadata, authorized read scope and
 * expiry/deletion outcome. Capability-specific inference payloads stay with their own contracts.
 *
 * Planned fields:
 * Opaque artifact/storage reference; trusted guild/owner; task or feature provenance; content
 * hash; media type; size; duration/codec metadata where relevant; purpose and audience;
 * retention/expiry; authorization/revision binding; cleanup progress.
 *
 * Boundaries/invariants:
 * References are not proof of authorization and cannot be arbitrary user-selected filesystem paths
 * or external resource destinations. Use owner-validated bindings. Queue payloads carry references
 * rather than large media content. Physical removal and eligibility revocation are different
 * lifecycle operations.
 */
