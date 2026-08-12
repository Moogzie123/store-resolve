# Implementation plan

## Completed locally

- [x] Foundation: project, Git, schema, entities, fictional seed data, role enforcement foundation.
- [x] Complaint workflow: simulator, deterministic routing, duplicate/follow-up behavior, simulated acknowledgment, detail and timeline.
- [x] Manager workflow: notification, explicit acknowledgment, investigation, contact, findings, corrective action, resolution.
- [x] Ownership/escalation: three independent recipients, idempotent missed-deadline alerts, closure, dashboard and live metrics.
- [x] Family pilot controls: four modes, global kill switch, fictional recipient controls, provider boundary, manager suppression.
- [x] Unit tests, browser workflow specifications, CI, documentation, and production build configuration.

## Remaining production hardening

- [ ] Replace browser memory adapter with authenticated Worker API and D1 repository implementation.
- [ ] Configure production identity provider/session validation.
- [ ] Provision D1 and Cloudflare deployment bindings.
- [ ] Add Twilio credentials only through Cloudflare secrets; implement delivery-status webhook validation.
- [ ] Install and run Playwright browsers in the deployment environment.
- [ ] Complete family SMS pilot before Gmail or manager messaging activation.
