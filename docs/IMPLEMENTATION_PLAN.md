# Implementation plan

## Completed locally

- [x] Foundation: project, Git, schema, entities, fictional seed data, role enforcement foundation.
- [x] Complaint workflow: simulator, deterministic routing, duplicate/follow-up behavior, simulated acknowledgment, detail and timeline.
- [x] Manager workflow: notification, explicit acknowledgment, investigation, contact, findings, corrective action, resolution.
- [x] Ownership/escalation: three independent recipients, idempotent missed-deadline alerts, closure, dashboard and live metrics.
- [x] Family pilot controls: four modes, global kill switch, fictional recipient controls, provider boundary, manager suppression.
- [x] Unit tests, browser workflow specifications, CI, documentation, and production build configuration.

## Persistence and family pilot milestone

- [x] Replace browser authority with typed Worker API and D1 repository.
- [x] Persist complaints, events, notifications, actions, contacts, and rollout configuration.
- [x] Map authenticated Cloudflare Access identities to D1 roles.
- [x] Enforce owner, view-only, and manager-store authorization server-side.
- [x] Implement Twilio send, provider IDs, signed status callbacks, and callback idempotency.
- [x] Enforce FAMILY_PILOT and the global kill switch immediately before Twilio.
- [x] Add secure masked ownership configuration and a confirmed, rate-limited, single-recipient test UI.
- [x] Add migration, deployment, Access, Twilio, and first-test runbooks.

## Remaining external operations

- [ ] Provision the Cloudflare D1 database and replace the placeholder binding ID.
- [ ] Deploy and protect the Worker with Cloudflare Access.
- [ ] Configure Twilio secrets and one real owner in D1.
- [ ] Complete one-phone live SMS delivery validation.
- [ ] Test Father, Uncle, and Grandfather individually.
- [ ] Connect Gmail only after family SMS validation succeeds.
