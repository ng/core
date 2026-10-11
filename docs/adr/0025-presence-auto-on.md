# ADR 0025: Presence auto-on and person-vs-pet occupancy classification

**Status:** Accepted, shipped as experimental
**Date:** 2026-10-11

## Context

Auto-off has existed since `autoOffWatcher` (per-side `autoOffEnabled` /
`autoOffMinutes`): once the shared virtual occupancy sensor
(`src/lib/occupancy.ts`) reads a side as reliably empty for the timeout, the
side is powered off. The mirror feature was missing: a sleeper who gets into a
cold bed before their schedule starts has to reach for the app.

Both directions share one failure mode. The occupancy sensor ORs a movement
window with a calibrated capSense2 level signal, and the level signal is the
sum of three zone deviations (head, torso, legs) over one threshold. A cat on
the pillow deviates one zone hard enough to clear the sum, so it reads as
"in bed": it would hold auto-off open indefinitely today, and would trip any
naive auto-on.

The question was whether auto-on belongs in Settings (a toggle), in the
automation engine (a rule), or both.

## Decision

1. **Classify in the sensor, not in the consumers.** `getOccupancy()` gains
   `level.zoneDeviations`, `level.zones` (zones whose deviation exceeds a third
   of the calibrated threshold), `vitals` (latest piezo HR/BR within 5 min,
   with a resting-human-range verdict) and `classification`:
   - `person`: occupied and ≥ 2 zones lit, or human-range vitals, or movement
     only with no level signal to say otherwise.
   - `light`: occupied, level signal evaluable, single-zone load, no human
     vitals. A pet or an object.
   - `none`: not occupied.

   Vitals only ever upgrade to `person`. They drop out whenever the sleeper
   moves, so a missing or odd reading must never demote a person.
   `occupied` and `available` keep their meaning for HomeKit and the API.

2. **Auto-off treats `light` as empty** when the level signal is evaluable.
   Movement-only occupancy with an unsensable level still counts as occupied,
   as before.

3. **Auto-on is a per-side setting, shipped experimental**, implemented in
   `src/services/autoOnWatcher.ts` beside the auto-off watcher rather than as
   an automation rule. It has to coordinate with away mode, run-once
   sessions, the pump-stall guard, the alarm's held power-off and the
   controller's baseline selection; the scheduler's power-on paths already
   have that plumbing and an automation rule would re-implement it badly.
   Guardrails:
   - fires only on `classification === 'person'`, sustained for
     `autoOnMinutes` (default 5);
   - only inside `autoOnStart`..`autoOnEnd` local time (default 20:00–08:00,
     wraps midnight, equal times = any time) so a nap does not fire unless
     the user widens it;
   - a side turned off while a person is still in it (manual, scheduled, or
     the global cap) suppresses auto-on until the bed has read non-person for
     the dwell, so the bed cannot bounce straight back on;
   - unsensable presence resets the dwell and never fires.

   There is no separate "auto-on temperature". `powerOnLocked` resolves the
   setpoint from the controller baseline (an active or upcoming schedule),
   then the last target the watcher saw while powered, then 75 °F. Auto-on is
   an early schedule start, not another preference to keep in sync.

4. **Expose presence to the automation engine as well.** `{side}.presence`
   (1/0, `undefined` while unsensable) and `{side}.presence.zones` join the
   signal catalog and the builder, live-only. Power users can build "when
   presence changes, set power on at 72 °F" rules; the toggle remains the
   default UX.

## Alternatives considered

- **A pet preference ("I have a pet").** Rejected: it would still need the
  zone/vitals evidence to act on, and the classification is useful without
  it (auto-off, the Presence card, HomeKit consumers).
- **Automation rule only.** Rejected for the coordination reasons above, and
  because the engine deliberately handles numeric signals with no notion of
  suppression after an intentional off.
- **Ask for an auto-on temperature.** Rejected: duplicates the schedule's
  setpoint and drifts from it.

## Consequences

- Classification thresholds (`PERSON_MIN_ZONES = 2`, zone share = threshold/3,
  HR 40–110, BR 8–22) are first guesses tuned against Pod 5 capSense2 frames.
  A large dog spanning two zones will read as a person. The Presence card
  shows "light load" so users can see what the sensor decided.
- Pod 3 (legacy scalar capSense) has no level signal, so `zones` is null and
  movement-only occupancy classifies as `person`; auto-on stands down there
  because presence is unsensable.
- Auto-off behaviour changes for pets: a cat left on the bed no longer keeps
  it on.

## References

- `src/lib/occupancy.ts`, `src/services/autoOnWatcher.ts`,
  `src/services/autoOffWatcher.ts`, `src/automation/signals.biometrics.ts`
- ADR 0023 (automation signal catalog)
