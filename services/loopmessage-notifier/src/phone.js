// Phone normalization to E.164.
//
// client_team_members.phone is free text — the rows we have in production
// look like "9733966766" and "631-425-5731". LoopMessage rejects anything
// without a country code, so every number has to be normalized here; there
// is no upstream cleanup step.
//
// Returning a reason on failure (rather than just null) matters: a dropped
// team member is silent otherwise, and "which agent didn't get texted" is
// the first question asked when someone doesn't reply to a lead.

// NANP: area code and exchange code both start 2-9.
const NANP_10 = /^[2-9]\d{2}[2-9]\d{6}$/;

// Trailing extensions ("x12", "ext. 400") would otherwise be swallowed into
// the digit run and silently corrupt the number into a valid-looking one.
const EXTENSION = /\s*(?:x|ext\.?|extension)\s*\d+\s*$/i;

/**
 * @param {unknown} raw
 * @param {{ defaultCountryCode?: string }} [opts]
 * @returns {{ ok: true, e164: string } | { ok: false, reason: string }}
 */
export function normalizePhone(raw, opts = {}) {
  const defaultCountryCode = opts.defaultCountryCode ?? "1";

  if (raw === null || raw === undefined) return { ok: false, reason: "empty" };

  const trimmed = String(raw).trim();
  if (!trimmed) return { ok: false, reason: "empty" };

  const withoutExt = trimmed.replace(EXTENSION, "");
  const hadExtension = withoutExt !== trimmed;

  const isInternational = withoutExt.startsWith("+");
  let digits = withoutExt.replace(/\D/g, "");

  if (!digits) return { ok: false, reason: "no_digits" };

  // Already international — trust the caller's country code, only sanity
  // check the length against the E.164 bounds.
  if (isInternational) {
    if (digits.length < 8 || digits.length > 15) {
      return { ok: false, reason: `international_length_${digits.length}` };
    }
    return { ok: true, e164: `+${digits}` };
  }

  // US/Canada default. Only applied to bare local-looking numbers.
  if (defaultCountryCode === "1") {
    if (digits.length === 11 && digits.startsWith("1")) {
      digits = digits.slice(1);
    }
    if (digits.length === 10) {
      if (!NANP_10.test(digits)) {
        return { ok: false, reason: "not_a_valid_nanp_number" };
      }
      return { ok: true, e164: `+1${digits}` };
    }
    // Long enough to already carry a country code, just missing the plus.
    if (digits.length >= 11 && digits.length <= 15) {
      return { ok: true, e164: `+${digits}` };
    }
    return {
      ok: false,
      reason: hadExtension
        ? `too_short_after_stripping_extension_${digits.length}`
        : `unexpected_length_${digits.length}`,
    };
  }

  // Non-NANP default country: prepend unless it already looks international.
  if (digits.length >= 8 && digits.length <= 15) {
    if (digits.startsWith(defaultCountryCode)) return { ok: true, e164: `+${digits}` };
    const combined = `${defaultCountryCode}${digits}`;
    if (combined.length > 15) return { ok: false, reason: "too_long_with_country_code" };
    return { ok: true, e164: `+${combined}` };
  }

  return { ok: false, reason: `unexpected_length_${digits.length}` };
}
