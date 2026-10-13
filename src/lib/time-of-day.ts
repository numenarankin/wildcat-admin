/**
 * Times of day as `HH:MM` strings, the form every form field and every
 * `*_time` column in this app already speaks.
 *
 * Pure and UI-free so the picker's behaviour can be tested without rendering
 * it: what someone typed, what they see back, and how long two times are
 * apart are all decided here.
 */

/** Minutes between the times a picker offers. */
export const STEP_MINUTES = 15;

/** Last time in a day, at the step above: 23:45. */
export const LAST_MINUTE_OF_DAY = 24 * 60 - STEP_MINUTES;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** `HH:MM` -> minutes since midnight. Null for blank or malformed input. */
export function toMinutes(value: string | null | undefined): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value?.trim() ?? "");
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** Minutes since midnight -> `HH:MM`. */
export function toHHMM(minutes: number): string {
  const clamped = Math.max(0, Math.min(24 * 60 - 1, Math.round(minutes)));
  return `${pad(Math.floor(clamped / 60))}:${pad(clamped % 60)}`;
}

/** Minutes since midnight -> "9:30 AM". */
export function clockLabel(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const hour12 = hours % 12 === 0 ? 12 : hours % 12;
  return `${hour12}:${pad(minutes % 60)} ${hours < 12 ? "AM" : "PM"}`;
}

/** A span in minutes -> "45 min", "1 hr", "1 hr 30 min". */
export function durationLabel(minutes: number): string {
  if (minutes <= 0) return "";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} min`;
  const hoursPart = hours === 1 ? "1 hr" : `${hours} hrs`;
  return rest === 0 ? hoursPart : `${hoursPart} ${rest} min`;
}

/**
 * Punctuate a time as it is being typed, so nobody has to type punctuation.
 *
 * Keystrokes go in bare — `8`, `83`, `830`, `830p` — and come back out as
 * `8`, `8:3`, `8:30`, `8:30 PM`. The colon and the meridiem are the field's job,
 * not the user's: on a tablet they cost a shift and a symbol keyboard, and a
 * box that demands them is a box that rejects what people naturally type.
 *
 * Where the colon lands is decided by how many digits are in so far, which is
 * how everyone types a time:
 *
 *   - `8`      -> `8`          one digit is an hour
 *   - `83`     -> `8:3`        83 is no hour, so the 8 was the hour
 *   - `23`     -> `23`         still a legal 24-hour hour; wait for more
 *   - `830`    -> `8:30`       three digits: h:mm
 *   - `2300`   -> `23:00`      four digits: hh:mm
 *
 * A keystroke that cannot belong to any time is DROPPED, leaving the field as
 * it was — `8` then `7` stays `8`, because no clock reads 8:7x, and a fifth
 * digit after `8:30` stays `8:30`. The alternative is worse than ignoring it:
 * re-splitting the digits would turn a typo into `83:01`, quietly rewriting an
 * hour the user had already entered correctly.
 *
 * `a`/`p` anywhere sets the meridiem, last one typed winning, so a mistyped `p`
 * is corrected by pressing `a` rather than by clearing the field.
 */
export function maskTimeTyping(raw: string): string {
  const lower = raw.toLowerCase();
  // One more than a time can hold: the surplus digit is what gets rejected.
  let digits = lower.replace(/\D/g, "").slice(0, 6);

  let body = "";
  while (digits.length) {
    const punctuated = punctuate(digits);
    if (punctuated !== null) {
      body = punctuated;
      break;
    }
    digits = digits.slice(0, -1);
  }
  if (!body) return "";

  const meridiems = lower.replace(/[^ap]/g, "");
  if (!meridiems) return body;
  return `${body} ${meridiems.at(-1) === "p" ? "PM" : "AM"}`;
}

/**
 * Place the colon in a run of digits, or null if they cannot start a time.
 *
 * Null is what makes a keystroke bounce: {@link maskTimeTyping} drops digits
 * off the end until this accepts what is left.
 */
function punctuate(digits: string): string | null {
  const hour = digits.slice(0, 2);
  switch (digits.length) {
    case 1:
      return digits;
    case 2:
      // Either a two-digit hour, or an hour and the tens of its minutes —
      // and minutes have no tens above 5.
      if (Number(hour) <= 23) return hour;
      return Number(digits[1]) <= 5 ? `${digits[0]}:${digits[1]}` : null;
    case 3:
      return Number(digits.slice(1)) <= 59 ? `${digits[0]}:${digits.slice(1)}` : null;
    case 4:
      return Number(hour) <= 23 && Number(digits.slice(2)) <= 59
        ? `${hour}:${digits.slice(2)}`
        : null;
    default:
      return null;
  }
}

/**
 * What someone typed into the time box, as `HH:MM`. Null when it isn't a time.
 *
 * Nobody types "14:30". They type "230p", "2:30 pm", "1430", "8a" — and on a
 * tablet in a truck they type as little as they can get away with. Every one of
 * those means something unambiguous, so all of them are accepted:
 *
 *   - a meridiem makes it 12-hour: `2p`, `2:30pm`, `230 P` -> 14:00 / 14:30
 *   - without one, 3 and 4 digit forms are 24-hour: `1430` -> 14:30
 *   - a bare hour fills the minutes in: `8` -> 08:00
 *
 * Deliberately NOT guessed at: a bare `2`. It stays 02:00 rather than becoming
 * the afternoon, because the picker shows both and lets the reader choose.
 */
export function parseTimeInput(raw: string): string | null {
  const text = raw.trim().toLowerCase().replace(/[\s.]/g, "");
  const match = /^(\d{1,2})(?::?(\d{2}))?(am|pm|a|p)?$/.exec(text);
  if (!match) return null;

  let hours = Number(match[1]);
  const minutes = match[2] ? Number(match[2]) : 0;
  const meridiem = match[3]?.[0];
  if (minutes > 59) return null;

  if (meridiem) {
    if (hours < 1 || hours > 12) return null;
    hours = (hours % 12) + (meridiem === "p" ? 12 : 0);
  } else if (hours > 23) {
    return null;
  }
  return `${pad(hours)}:${pad(minutes)}`;
}
