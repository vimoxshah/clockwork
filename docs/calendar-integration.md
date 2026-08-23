# Calendar Integration

## Human + agent calendars (H1)

Clockwork's calendar overlays **agent time** (runs, recurring bookings, approvals)
with **human time** (your meetings and focus blocks). Human events render in blue
with a left accent bar; agent events use the state colors.

## Supported integration: ICS subscription (read-only)

Settings → Calendars accepts an HTTPS iCalendar feed URL. This works with:

- Google Calendar → Settings → "Secret address in iCal format"
- Apple Calendar published/shared calendars
- Fastmail, Nextcloud, and any RFC 5545 provider

Design properties:
- **Read-only by design.** Clockwork never writes to your personal calendar.
- HTTPS-only URLs; 15s timeout; 5MB size cap; one bad feed never breaks the calendar.
- Events are fetched when the calendar view loads; sources stored at
  `~/.clockwork/ics-sources.json` (mode 0600).

### Documented limitation
Recurring ICS events (`RRULE`) are shown as a single base occurrence labeled
`(recurring)` rather than expanded to every occurrence. Full RRULE expansion for
external feeds is planned after the schedule engine is generalized beyond task
schedules. All-day events, timed events with `TZID`, UTC, and floating times are
fully supported.

## Why not EventKit/Google OAuth in H1?

EventKit would tie Clockwork to macOS calendar permissions and require a signed
app sandbox entitlement path; Google Calendar API requires OAuth consent-screen
review. The ICS subscription path delivers the same *awareness* value (conflict
visibility between meetings and scheduled agent runs) with zero credential
surface — consistent with the local-first, no-account product thesis. Native
integrations remain candidates for H2.
