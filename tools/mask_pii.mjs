// Masks personally identifiable information in diagnostic output.
//
// The live probes print errors and hints to the terminal and into CI logs.
// A phone number, a Firebase API key or an identity token must never end up
// in one of those logs, so every diagnostic message is passed through the
// helpers of this file before it is printed.

/** Masks one phone number and keeps its last two digits. */
export function maskPhoneNumber(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 4) return '*'.repeat(Math.max(digits.length, 1));
  return `${'*'.repeat(digits.length - 2)}${digits.slice(-2)}`;
}

/**
 * Masks every phone number inside an arbitrary text.
 *
 * The pattern accepts the usual separators, so `+91 98765 43210` and
 * `+919876543210` are both redacted.
 */
export function maskPhoneNumbersInText(value) {
  const text = String(value ?? '');
  return text.replace(/\+?\d[\d\s().-]{6,}\d/g, (match) =>
    maskPhoneNumber(match),
  );
}

/**
 * Masks the secrets inside an arbitrary text.
 *
 * The Firebase web API key, an identity token and a phone number are all
 * replaced before the text reaches a terminal or a log file.
 */
export function maskSensitiveText(value) {
  let text = String(value ?? '');
  // The Firebase web configuration key.
  text = text.replace(/AIza[0-9A-Za-z_-]{10,}/g, 'AIza***');
  // A JWT (an identity token or a signed custom-token response).
  text = text.replace(
    /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g,
    'eyJ***.<redacted>',
  );
  return maskPhoneNumbersInText(text);
}

/**
 * The safe text of an unknown error.
 *
 * Only the message is printed. The stack and the attached properties of a
 * Firebase error can contain the request which carried the phone number or
 * the API key.
 */
export function safeErrorText(error) {
  if (error == null) return 'Unknown error';
  const message = typeof error === 'string' ? error : error?.message;
  const raw = String(message ?? error ?? 'Unknown error');
  return maskSensitiveText(raw);
}
