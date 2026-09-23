/**
 * Timezone every scheduled job is anchored to.
 *
 * The daily jobs form a chain whose cron values were chosen as *local* times:
 * ads sync at 03:00, waste detection at 04:00, recommendations at 04:30, daily
 * summary at 08:00 — the analysis pipeline runs in the small hours and the user
 * gets the mail at breakfast.
 *
 * Only `daily-summary` used to declare a timezone, so the other three ran in the
 * server's zone — UTC on Render. The chain still happened to land in the right
 * order, but by accident: the whole pipeline was firing at midnight–01:30 local
 * rather than 03:00–04:30, and nothing in the code said so. A change of server
 * zone, or the return of DST in Brazil, would have shifted three jobs and not
 * the fourth, silently.
 *
 * Anchoring all four to one constant makes the intended local times true, and
 * makes the ordering a property of the schedule rather than a coincidence.
 */
export const SCHEDULER_TIMEZONE = 'America/Sao_Paulo';
