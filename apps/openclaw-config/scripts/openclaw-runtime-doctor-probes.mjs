// Round-7: the doctor CLI's three PURE readers, split out of
// openclaw-runtime-doctor.mjs so they can be tested.
//
// The CLI itself is a script - importing it runs a whole health check against
// this machine - so anything left inside it is verifiable only by running the
// real thing on a real box. Three of round 6's findings lived in exactly that
// blind spot: the cron envelope was unwrapped without looking at `hasMore` or
// `enabled`, the failure reason was `stderr[0]` on a CLI that prints a
// `Config warnings:` banner to stderr, and the delivery state was ranked by a
// timestamp the one interesting outcome never carries.
//
// Everything here is a pure function of data the CLI collected. No I/O, no
// process, no clock.

/**
 * `openclaw cron list --json`'s envelope -> what the analyzer needs.
 *
 * Shapes handled, in the order the CLI has actually returned them across
 * versions: a bare array, `{jobs}` (the current one, measured on the deploy
 * target 2026-07-29: `{jobs, total, offset, limit, hasMore, nextOffset,
 * deliveryPreviews}`), and `{data}`.
 *
 * `truncated` is the paging flag carried through instead of being dropped:
 * this gateway also serves the operator's personal 186-agent fleet, and "not in
 * the page I was handed" is not "not installed".
 */
export function parseOpenClawCronList(parsed) {
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.jobs)
      ? parsed.jobs
      : Array.isArray(parsed?.data)
        ? parsed.data
        : [];
  const nameOf = (job) => String(job?.name ?? job?.id ?? "");
  return {
    ok: true,
    // `enabled === false` only: a job from an older CLI that reports no
    // `enabled` field at all is counted as installed, not as disabled.
    names: list.filter((job) => job?.enabled !== false).map(nameOf).filter(Boolean),
    disabledNames: list.filter((job) => job?.enabled === false).map(nameOf).filter(Boolean),
    total: Number.isFinite(Number(parsed?.total)) ? Number(parsed.total) : null,
    truncated: parsed?.hasMore === true
  };
}

/**
 * The reason an `openclaw` invocation failed, as a human would name it.
 *
 * `stderr.split(/\r?\n/)[0]` was wrong because this CLI prints a
 * `Config warnings:` banner (and its indented bullets) to stderr on success as
 * well as failure - so the doctor would have reported the cause of
 * `openclaw-cron.unreadable` as "Config warnings:". Banner lines are dropped;
 * if nothing is left, the last stderr line is used, and failing that the
 * process error itself - never a blank.
 */
export function describeOpenClawCliFailure(error) {
  const lines = String(error?.stderr ?? "")
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0);
  const meaningful = lines.filter((line) => (
    !/^\s*(config warnings?|warnings?)\s*:/iu.test(line) && !/^[\s>·•*-]/u.test(line)
  ));
  return meaningful[0]?.trim() ?? lines.at(-1)?.trim() ?? String(error?.message ?? error);
}

/**
 * report-delivery-state.json -> the routing facts the analyzer judges.
 *
 * Ranked by `deliveredAt ?? deliveryFailedAt`. Ranking by `deliveredAt` alone
 * (what this did before) hid the ONE outcome the check exists for: after J2 a
 * circle-public report with no group chat is refused by the delivery layer, so
 * it is recorded with `sent: false` + `groupFallback: true` +
 * `deliveryFailedAt`, and never gets a `deliveredAt` at all.
 */
export function judgeReportDeliveryState(state) {
  const empty = {
    lastDeliveryGroupFallback: false,
    lastDeliveryLabel: null,
    lastDeliveryAt: null,
    lastDeliveryReason: null,
    lastDeliverySent: null
  };
  const stampOf = (entry) => String(entry?.deliveredAt ?? entry?.deliveryFailedAt ?? "");
  const newest = Object.entries(state && typeof state === "object" ? state : {})
    .filter(([, entry]) => entry && typeof entry === "object" && stampOf(entry))
    .sort(([, left], [, right]) => stampOf(right).localeCompare(stampOf(left)))
    .at(0);
  if (!newest) {
    return empty;
  }
  const [key, entry] = newest;
  return {
    lastDeliveryGroupFallback: entry.groupFallback === true,
    lastDeliveryLabel: key,
    lastDeliveryAt: stampOf(entry),
    lastDeliveryReason: entry.groupFallbackReason
      ? String(entry.groupFallbackReason)
      : (entry.deliveryFailureReason ? String(entry.deliveryFailureReason) : null),
    lastDeliverySent: Boolean(entry.deliveredAt)
  };
}
