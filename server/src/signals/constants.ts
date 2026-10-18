/**
 * Thresholds and timings of the useful signals (docs/office/DESIGN.md, phase D).
 * Kept beside the modules that use them rather than in server/src/constants.ts,
 * so the signals stay one self-contained folder.
 */

// ── Trouble ──────────────────────────────────────────────────

/** Failed tools in a row that turn the desk fire into the alarm lamp. */
export const TROUBLE_ALARM_FAILURES = 3;

// ── Loop detector ────────────────────────────────────────────

/** The same tool with the same input this many times... */
export const LOOP_REPEAT_COUNT = 4;
/** ...within this window reads as going in circles. */
export const LOOP_REPEAT_WINDOW_MS = 10 * 60_000;
/** Active time with no new file edited and no phase change that reads as stuck. */
export const LOOP_STALL_ACTIVE_MS = 15 * 60_000;
/** How often the stall check runs between tool starts. */
export const LOOP_CHECK_INTERVAL_MS = 60_000;
/** Input fields that change between otherwise identical calls (descriptions,
 *  timeouts), left out of the repeat key. */
export const LOOP_IGNORED_INPUT_KEYS: ReadonlySet<string> = new Set([
  'description',
  'timeout',
  'run_in_background',
  'dangerouslyDisableSandbox',
]);

// ── Timeline ─────────────────────────────────────────────────

/** Actions kept per agent. */
export const TIMELINE_MAX_ENTRIES = 20;
/** Longest entry text (the activity label), in characters. */
export const TIMELINE_TEXT_MAX_CHARS = 80;

// ── Token meter ──────────────────────────────────────────────

/** ~/.pixel-agents/<dir>/<YYYY-MM-DD>.json: today's per-message usage. A folder
 *  of its own, so readers of the daily/ totals never meet a different shape. */
export const TOKENS_DIR_NAME = 'tokens';
/** Writes at most this often (not a sliding debounce: a busy office never stops). */
export const TOKENS_SAVE_DEBOUNCE_MS = 5_000;

// ── Notice board ─────────────────────────────────────────────

/** How often `gh` is asked for open PRs and issues. */
export const NOTICE_BOARD_POLL_MS = 10 * 60_000;
/** One `gh` call's time limit. */
export const NOTICE_BOARD_GH_TIMEOUT_MS = 30_000;
/** Results asked of each search. */
export const NOTICE_BOARD_SEARCH_LIMIT = 30;
/** Items sent to the board. */
export const NOTICE_BOARD_MAX_ITEMS = 20;
/** Longest title sent, in characters. */
export const NOTICE_BOARD_TITLE_MAX_CHARS = 120;
