const DATE_ONLY_RE = /^\d{4}-(\d{2})-(\d{2})$/;
const DATE_TIME_RE = /^\d{4}-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))?$/;

interface StrictIsoDateInspection {
  matchesShape: boolean;
  valid: boolean;
  failureReason?: string;
}

function inspectStrictIsoDate(value: string): StrictIsoDateInspection {
  const trimmed = value.trim();
  const match = DATE_ONLY_RE.exec(trimmed) ?? DATE_TIME_RE.exec(trimmed);
  if (!match) return { matchesShape: false, valid: false };

  const month = Number(match[1]);
  const day = Number(match[2]);
  if (month < 1 || month > 12) {
    return {
      matchesShape: true,
      valid: false,
      failureReason: `Impossible date (month ${month}): "${value}"`,
    };
  }

  const parsed = new Date(`${trimmed.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) {
    return { matchesShape: true, valid: false, failureReason: `Invalid date: "${value}"` };
  }
  if (parsed.getUTCMonth() + 1 !== month || parsed.getUTCDate() !== day) {
    return {
      matchesShape: true,
      valid: false,
      failureReason: `Impossible date (day ${day}): "${value}"`,
    };
  }

  if (match[3] !== undefined) {
    const hour = Number(match[3]);
    const minute = Number(match[4]);
    const second = match[5] === undefined ? null : Number(match[5]);
    if (hour > 23) return impossibleTime(value, `hour ${hour}`);
    if (minute > 59) return impossibleTime(value, `minute ${minute}`);
    if (second !== null && second > 59) return impossibleTime(value, `second ${second}`);

    if (match[6] !== undefined) {
      const offsetHour = Number(match[7]);
      const offsetMinute = Number(match[8]);
      if (offsetHour > 23 || offsetMinute > 59) {
        return impossibleTime(value, `offset ${match[6]}${match[7]}:${match[8]}`);
      }
    }
  }
  return { matchesShape: true, valid: true };
}

function impossibleTime(value: string, component: string): StrictIsoDateInspection {
  return {
    matchesShape: true,
    valid: false,
    failureReason: `Impossible time (${component}): "${value}"`,
  };
}

/** Return whether a value has a valid Engine-supported ISO date shape and calendar date. */
export function isStrictIsoDateString(value: string): boolean {
  return inspectStrictIsoDate(value).valid;
}

/** Return the legacy coercion failure for a malformed ISO-shaped date, if applicable. */
export function strictIsoDateFailureReason(value: string): string | null {
  const inspection = inspectStrictIsoDate(value);
  return inspection.matchesShape && !inspection.valid
    ? inspection.failureReason ?? null
    : null;
}
