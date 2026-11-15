import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import * as crypto from 'crypto';

// Creates the default Firebase app before this module opens Firestore —
// see the comment in `./firebase.ts`.
import './firebase';

const db = admin.firestore();

/**
 * OTP verification for email addresses and mobile numbers.
 *
 * The implementation is deliberately dependency free: it only relies on
 * `firebase-functions`, `firebase-admin` and the global `fetch` available in
 * Node 18+, so no extra npm packages are required.
 *
 * Delivery providers are configured through environment variables:
 *
 *   Email   SENDGRID_API_KEY | RESEND_API_KEY | SMTP_HOST/SMTP_PORT/...
 *   Mobile  TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_FROM_NUMBER
 *           FAST2SMS_API_KEY | MSG91_AUTH_KEY + MSG91_TEMPLATE_ID
 *
 * When no provider is configured the OTP is written to the function logs,
 * which keeps the flow testable in development.
 */

export type OtpChannel = 'email' | 'mobile';

const OTP_LENGTH = 6;
const OTP_TTL_MS = 5 * 60 * 1000; // 5 minutes
const RESEND_COOLDOWN_MS = 30 * 1000; // 30 seconds between sends
const MAX_SENDS_PER_HOUR = 5;
/**
 * How many codes one **source** (an IP address or an account) may start per
 * hour — no matter how many different addresses it targets.
 */
const MAX_SENDS_PER_HOUR_PER_SOURCE = 20;
const MAX_VERIFY_ATTEMPTS = 5;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
// Accepts 10-digit Indian numbers as well as international numbers with an
// optional country code (stored in E.164-ish form, e.g. +919876543210).
const PHONE_RE = /^\+?[1-9]\d{7,14}$/;

function hash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function documentId(channel: OtpChannel, identifier: string): string {
  return `${channel}_${hash(identifier.toLowerCase())}`;
}

/**
 * The key of the **source** of an OTP request.
 *
 * It is the account of the caller when it is signed in, and the IP address
 * of the caller otherwise. Only the hash is stored — the raw IP address is
 * personal data and does not belong in the database.
 *
 * The source is what limits the number of codes one device may start: the
 * quota of the address alone can be bypassed by simply using a different
 * address every time — and every SMS costs money.
 */
function sourceKey(context: functions.https.CallableContext): string {
  const uid = context.auth?.uid;
  if (uid) return `uid_${hash(uid)}`;

  const ip = context.rawRequest?.ip || 'unknown';
  return `ip_${hash(String(ip))}`;
}

/**
 * Normalises a user-entered mobile number into E.164-ish form.
 *
 * Indian users almost always type a bare 10-digit number (`9876543210`).
 * Without a country code the SMS provider cannot route it at all, so
 * 10-digit numbers starting with 6-9 are prefixed with the default
 * country code (`91`, overridable via `DEFAULT_COUNTRY_CODE`).
 *
 * `9876543210`   -> `+919876543210`
 * `+91 98765 43210` -> `+919876543210`
 * `919876543210` -> `+919876543210` (already has the country code)
 */
function normalisePhone(phone: string): string {
  const cleaned = phone.replace(/[\s()-]/g, '');
  if (cleaned.startsWith('+')) return cleaned;

  const defaultCountryCode = (process.env.DEFAULT_COUNTRY_CODE || '91').replace(/\D/g, '');
  // A bare 10-digit Indian mobile number.
  if (/^[6-9]\d{9}$/.test(cleaned)) return `+${defaultCountryCode}${cleaned}`;

  return `+${cleaned}`;
}

/**
 * A six digit one time code.
 *
 * The code is a **secret**: anybody who knows it can take over the account
 * it belongs to. `Math.random()` is not a cryptographically secure random
 * number generator — its output can be predicted — so the code is drawn from
 * the CSPRNG of Node instead (`crypto.randomInt`).
 *
 * `crypto.randomInt` is unbiased: it rejects values that would make the
 * digits more likely than others, which a simple modulo of a random number
 * would not.
 */
function generateOtp(): string {
  const max = Math.pow(10, OTP_LENGTH);
  return String(crypto.randomInt(0, max)).padStart(OTP_LENGTH, '0');
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  if (bufferA.length !== bufferB.length) return false;
  return crypto.timingSafeEqual(bufferA, bufferB);
}

function assertValid(channel: OtpChannel, identifier: string): string {
  const value = identifier.trim();
  if (!value) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      channel === 'email' ? 'Email is required' : 'Mobile number is required',
    );
  }

  if (channel === 'email') {
    if (!EMAIL_RE.test(value)) {
      throw new functions.https.HttpsError('invalid-argument', 'Enter a valid email address');
    }
    return value.toLowerCase();
  }

  const phone = normalisePhone(value);
  if (!PHONE_RE.test(phone)) {
    throw new functions.https.HttpsError('invalid-argument', 'Enter a valid mobile number');
  }
  return phone;
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

/**
 * Extracts the bare address out of a sender value.
 *
 * Accepts both `user@example.com` and the RFC 5322 form
 * `Stay Serve <user@example.com>`.
 */
function extractEmail(value: string | undefined): string {
  const trimmed = (value || '').trim();
  const match = trimmed.match(/<([^>]+)>/);
  return (match ? match[1] : trimmed).trim();
}

/**
 * Extracts the display name out of a sender value.
 *
 * `Stay Serve <user@example.com>` -> `Stay Serve`; a bare address -> `''`.
 */
function extractName(value: string | undefined): string {
  const trimmed = (value || '').trim();
  const match = trimmed.match(/^(.*?)\s*<[^>]+>$/);
  return match ? match[1].trim() : '';
}

async function sendEmail(identifier: string, otp: string): Promise<boolean> {
  const sendgridKey = process.env.SENDGRID_API_KEY;
  const resendKey = process.env.RESEND_API_KEY;
  const brevoKey = process.env.BREVO_API_KEY;
  const subject = 'Your StayServe verification code';
  const body = `${otp} is your StayServe verification code. It expires in ${Math.floor(OTP_TTL_MS / 60000)} minutes. Do not share it with anyone.`;

  if (sendgridKey) {
    const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${sendgridKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: identifier }] }],
        from: {
          email: process.env.OTP_FROM_EMAIL || 'no-reply@stayserve.app',
          name: process.env.OTP_FROM_NAME || 'StayServe',
        },
        subject,
        content: [{ type: 'text/plain', value: body }],
      }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      console.error(
        `SendGrid rejected the OTP email (HTTP ${response.status}): ${detail.slice(0, 400)}`,
      );
    }
    return response.ok;
  }

  if (resendKey) {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resendKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: process.env.OTP_FROM_EMAIL || 'StayServe <no-reply@stayserve.app>',
        to: [identifier],
        subject,
        text: body,
      }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      console.error(
        `Resend rejected the OTP email (HTTP ${response.status}): ${detail.slice(0, 400)}`,
      );
    }
    return response.ok;
  }

  // Brevo — the sender only has to be a verified *email address*; no domain
  // and no DNS records are required, and mail can be sent to any recipient.
  if (brevoKey) {
    const fromValue = process.env.BREVO_FROM_EMAIL || process.env.OTP_FROM_EMAIL;
    const fromName =
      process.env.OTP_FROM_NAME || extractName(fromValue) || 'StayServe';

    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': brevoKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sender: { email: extractEmail(fromValue), name: fromName },
        to: [{ email: identifier }],
        subject,
        textContent: body,
      }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      console.error(
        `Brevo rejected the OTP email (HTTP ${response.status}): ${detail.slice(0, 400)}`,
      );
    }
    return response.ok;
  }

  return false;
}

async function sendMobile(identifier: string, otp: string): Promise<boolean> {
  const twilioSid = process.env.TWILIO_ACCOUNT_SID;
  const twilioToken = process.env.TWILIO_AUTH_TOKEN;
  const twilioFrom = process.env.TWILIO_FROM_NUMBER;
  const body = `${otp} is your StayServe verification code. It expires in ${Math.floor(OTP_TTL_MS / 60000)} minutes. Do not share it with anyone.`;

  if (twilioSid && twilioToken && twilioFrom) {
    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${twilioSid}:${twilioToken}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          To: identifier,
          From: twilioFrom,
          Body: body,
        }).toString(),
      },
    );
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      console.error(
        `Twilio rejected the OTP SMS (HTTP ${response.status}): ${detail.slice(0, 400)}`,
      );
    }
    return response.ok;
  }

  const fast2smsKey = process.env.FAST2SMS_API_KEY;
  if (fast2smsKey) {
    // Fast2SMS exposes two routes on the same endpoint:
    //
    //   'q'   Quick SMS — no DLT registration needed, works for every
    //         Indian number (DND and Non-DND), but costs more per message
    //         and every campaign is reviewed by their team before release.
    //   'dlt' DLT SMS — needs a DLT entity, sender ID and content template
    //         (entity registration costs ~INR 5,900 once at the operator
    //         portal), but is much cheaper per message.
    //
    // Default to 'q' so a brand new account can send OTPs on day one.
    const route = (process.env.FAST2SMS_ROUTE || 'q').trim();
    const payload: Record<string, unknown> = {
      route,
      message: body,
      numbers: identifier.replace('+', ''),
    };
    // A sender ID is only meaningful on the DLT route.
    if (route === 'dlt') {
      payload.sender_id = process.env.FAST2SMS_SENDER_ID || 'TXTLNS';
    }

    const response = await fetch('https://www.fast2sms.com/dev/bulkV2', {
      method: 'POST',
      headers: {
        authorization: fast2smsKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const text = await response.text().catch(() => '');
    if (!response.ok) {
      console.error(
        `Fast2SMS rejected the OTP SMS (HTTP ${response.status}, route=${route}): ${text.slice(0, 400)}`,
      );
      return false;
    }

    // Fast2SMS answers with HTTP 200 even when it refuses the message, so the
    // body has to be inspected as well.
    let parsed: any = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    if (parsed && parsed.return === false) {
      console.error(
        `Fast2SMS refused the OTP SMS (route=${route}): ${JSON.stringify(parsed).slice(0, 400)}`,
      );
      return false;
    }
    if (!parsed) {
      console.error(
        `Fast2SMS returned an unreadable response (route=${route}): ${text.slice(0, 300)}`,
      );
    }
    return true;
  }

  const msg91Key = process.env.MSG91_AUTH_KEY;
  const msg91Template = process.env.MSG91_TEMPLATE_ID;
  if (msg91Key && msg91Template) {
    const response = await fetch('https://control.msg91.com/api/v5/flow/', {
      method: 'POST',
      headers: {
        authkey: msg91Key,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        template_id: msg91Template,
        recipients: [{ mobiles: identifier.replace('+', ''), OTP: otp }],
      }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      console.error(
        `MSG91 rejected the OTP SMS (HTTP ${response.status}): ${detail.slice(0, 400)}`,
      );
    }
    return response.ok;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Callable functions
// ---------------------------------------------------------------------------

/**
 * Sends a verification code to an email address or a mobile number.
 */
export const sendOtp = functions.https.onCall(async (data, context) => {
  const channel = (data?.channel as OtpChannel) || 'email';
  if (channel !== 'email' && channel !== 'mobile') {
    throw new functions.https.HttpsError('invalid-argument', 'Unknown channel');
  }
  // While phone verification is disabled no SMS can be requested at all, so
  // there is no way to spend money on one.
  assertChannelEnabled(channel);

  const identifier = assertValid(channel, String(data?.identifier || ''));
  const ref = db.collection('otpCodes').doc(documentId(channel, identifier));
  const now = Date.now();

  // ---------------------------------------------------------------------
  // The **source** of the request.
  //
  // The quota of the address alone is not enough: an attacker can send a
  // code to a thousand different phone numbers in a minute — every one of
  // them costs money (an SMS is not free) and none of them is the attacker's
  // own number.
  //
  // The source is therefore limited as well: the IP of the caller (or the
  // account, when it is signed in) may only start a limited number of sends
  // per hour.
  // ---------------------------------------------------------------------
  const source = sourceKey(context);
  const sourceRef = db.collection('otpSendQuota').doc(source);
  const sourceWindowStart = now - 60 * 60 * 1000;

  const otp = generateOtp();
  const salt = crypto.randomBytes(16).toString('hex');

  // ---------------------------------------------------------------------
  // The quota is counted inside a **transaction**.
  //
  // The check used to be a plain read: two requests that arrived at the
  // same moment both saw the old counter, both passed the limit and both
  // sent a code — so the limit could be broken by simply sending the
  // requests in parallel.
  // ---------------------------------------------------------------------
  await db.runTransaction(async (transaction) => {
    const [existingSnapshot, sourceSnapshot] = await Promise.all([
      transaction.get(ref),
      transaction.get(sourceRef),
    ]);

    const previous = existingSnapshot.data() as Record<string, any> | undefined;

    // Cooldown between sends.
    if (previous?.lastSentAt) {
      const elapsed = now - previous.lastSentAt.toMillis();
      if (elapsed < RESEND_COOLDOWN_MS) {
        const waitSeconds = Math.ceil((RESEND_COOLDOWN_MS - elapsed) / 1000);
        throw new functions.https.HttpsError(
          'resource-exhausted',
          `Please wait ${waitSeconds} seconds before requesting another code`,
        );
      }
    }

    // Hourly quota of the address.
    const windowStart = previous?.windowStart?.toMillis?.() ?? 0;
    const sendsInWindow =
      now - windowStart < 60 * 60 * 1000 ? previous?.sendCount ?? 0 : 0;
    if (sendsInWindow >= MAX_SENDS_PER_HOUR) {
      throw new functions.https.HttpsError(
        'resource-exhausted',
        'Too many codes requested. Please try again later.',
      );
    }

    // Hourly quota of the source (the IP or the account).
    const sourceData = sourceSnapshot.data() as Record<string, any> | undefined;
    const sourceStart = sourceData?.windowStart?.toMillis?.() ?? 0;
    const sourceSends =
      now - sourceStart < 60 * 60 * 1000 ? sourceData?.sendCount ?? 0 : 0;
    if (sourceSends >= MAX_SENDS_PER_HOUR_PER_SOURCE) {
      throw new functions.https.HttpsError(
        'resource-exhausted',
        'Too many codes requested from this device. Please try again later.',
      );
    }

    const payload: Record<string, any> = {
      channel,
      identifierHash: hash(identifier.toLowerCase()),
      codeHash: hash(`${otp}:${salt}`),
      salt,
      attempts: 0,
      verified: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      lastSentAt: admin.firestore.FieldValue.serverTimestamp(),
      expiresAt: admin.firestore.Timestamp.fromMillis(now + OTP_TTL_MS),
      windowStart:
        sendsInWindow === 0
          ? admin.firestore.FieldValue.serverTimestamp()
          : admin.firestore.Timestamp.fromMillis(windowStart),
      sendCount: sendsInWindow + 1,
      verifiedByUid: null,
      challengeUsed: false,
    };

    transaction.set(ref, payload, { merge: true });

    transaction.set(
      sourceRef,
      {
        windowStart:
          sourceSends === 0
            ? admin.firestore.FieldValue.serverTimestamp()
            : admin.firestore.Timestamp.fromMillis(sourceStart),
        sendCount: sourceSends + 1,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  });

  // Never block the flow on a delivery provider hiccup: the code is already
  // stored, so the user can still receive it once the provider recovers.
  let delivered = false;
  try {
    delivered = channel === 'email'
      ? await sendEmail(identifier, otp)
      : await sendMobile(identifier, otp);
  } catch (error) {
    console.error(`Failed to deliver ${channel} OTP:`, error);
  }

  if (!delivered) {
    // The code is a **secret** — it is never written into the logs.
    //
    // The old code logged the plain code (and the full address) whenever the
    // delivery provider was not configured. Cloud Logging keeps that data
    // for weeks, and anybody with access to the log could take over the
    // account the code belongs to.
    //
    // Only the channel and the hash of the address are logged — the hash
    // can be used to find the record, but it does not reveal the address.
    console.warn(
      `[OTP] No delivery provider configured for ${channel}. ` +
        `Target ${hash(identifier.toLowerCase()).slice(0, 12)}… ` +
        `(expires in ${Math.floor(OTP_TTL_MS / 60000)} min).`,
    );
  }

  return {
    success: true,
    delivered,
    channel,
    expiresInSeconds: Math.floor(OTP_TTL_MS / 1000),
    resendAfterSeconds: Math.floor(RESEND_COOLDOWN_MS / 1000),
  };
});

/**
 * Verifies a code previously issued by [sendOtp].
 */
export const verifyOtp = functions.https.onCall(async (data, context) => {
  const channel = (data?.channel as OtpChannel) || 'email';
  if (channel !== 'email' && channel !== 'mobile') {
    throw new functions.https.HttpsError('invalid-argument', 'Unknown channel');
  }
  assertChannelEnabled(channel);

  const identifier = assertValid(channel, String(data?.identifier || ''));
  const code = String(data?.otp || '').trim();

  if (!/^\d{6}$/.test(code)) {
    throw new functions.https.HttpsError('invalid-argument', 'Enter the 6-digit code');
  }

  const ref = db.collection('otpCodes').doc(documentId(channel, identifier));
  const snapshot = await ref.get();
  if (!snapshot.exists) {
    throw new functions.https.HttpsError('not-found', 'No code was requested for this contact');
  }

  const record = snapshot.data() as Record<string, any>;

  if (record.verified) {
    // ---------------------------------------------------------------------
    // The address was verified before.
    //
    // The challenge is **not** handed out again: it belongs to the client
    // that really entered the code, and nobody else may pick it up.
    //
    // The one exception is the client that verified the address itself
    // (the verification was done while it was signed in) — it may ask for
    // a fresh challenge, because it proved that it owns the address.
    // ---------------------------------------------------------------------
    const verifiedBy = String(record.verifiedByUid || '');
    if (context.auth && verifiedBy && verifiedBy === context.auth.uid) {
      const challenge = newChallenge();
      await ref.set(
        {
          challengeHash: hash(challenge),
          challengeUsed: false,
          challengeIssuedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      return { success: true, verified: true, alreadyVerified: true, channel, challenge };
    }

    return { success: true, verified: true, alreadyVerified: true, channel, challenge: '' };
  }

  if (record.expiresAt && record.expiresAt.toMillis() < Date.now()) {
    throw new functions.https.HttpsError('deadline-exceeded', 'This code has expired. Request a new one.');
  }

  const attempts = (record.attempts ?? 0) + 1;
  if (attempts > MAX_VERIFY_ATTEMPTS) {
    await ref.set(
      { attempts, verified: false },
      { merge: true },
    );
    throw new functions.https.HttpsError(
      'resource-exhausted',
      'Too many incorrect attempts. Request a new code.',
    );
  }

  const expected = hash(`${code}:${record.salt}`);
  if (!constantTimeEquals(expected, record.codeHash)) {
    await ref.set({ attempts }, { merge: true });
    const remaining = Math.max(0, MAX_VERIFY_ATTEMPTS - attempts);
    throw new functions.https.HttpsError(
      'invalid-argument',
      `Incorrect code. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`,
    );
  }

  // The code was correct — the client gets a one-time challenge that proves
  // that *it* verified the address. The challenge is what the registration
  // needs; the "verified" flag alone is not enough any more.
  const challenge = newChallenge();

  await ref.set(
    {
      attempts,
      verified: true,
      verifiedAt: admin.firestore.FieldValue.serverTimestamp(),
      verifiedByUid: context.auth?.uid ?? null,
      challengeHash: hash(challenge),
      challengeUsed: false,
      challengeIssuedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  return { success: true, verified: true, channel, challenge };
});

/**
 * Whether phone (SMS) verification is mandatory.
 *
 * SMS costs money — roughly INR 0.25 per message on a DLT route, up to
 * INR 7 on a non-DLT route — so the whole feature is switched OFF until the
 * owner decides to pay for it. While it is off:
 *
 *   * `sendOtp` and `verifyOtp` refuse the `mobile` channel outright, so no
 *     SMS can ever leave the backend and no money can ever be spent on one;
 *   * `completeRegistration` only requires a verified email address and
 *     treats the phone number as optional contact information.
 *
 * Turning it back on is a one-line change: set `REQUIRE_PHONE_OTP=true`,
 * configure an SMS provider (`FAST2SMS_API_KEY` / `MSG91_*` / `TWILIO_*`)
 * and re-enable the phone step in the app.
 */
function phoneOtpRequired(): boolean {
  return (process.env.REQUIRE_PHONE_OTP || '').trim().toLowerCase() === 'true';
}

/**
 * Rejects the `mobile` channel while phone verification is disabled.
 *
 * This is deliberately checked before the identifier is validated so that a
 * disabled feature cannot be probed for anything.
 */
function assertChannelEnabled(channel: OtpChannel): void {
  if (channel === 'mobile' && !phoneOtpRequired()) {
    throw new functions.https.HttpsError(
      'failed-precondition',
      'Phone verification is currently disabled. Please verify your email address instead.',
    );
  }
}

/**
 * A one-time challenge that proves that **this** client really verified the
 * code.
 *
 * The verification record is stored per address (`otpCodes/{channel}_{hash}`),
 * not per account: the code is sent **before** the Firebase account exists
 * (that is the order of the sign-up), so the verification cannot be bound to
 * a uid at that moment.
 *
 * Without a challenge the record was a global flag: anybody who knew the
 * address could create an account with it and finish the registration — even
 * if the real owner had verified the code minutes before and never got
 * round to creating the account.
 *
 * The challenge closes that window: only the client that really entered the
 * code receives it, and it may be used **once** — for one registration.
 */
function newChallenge(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Throws unless a code was successfully verified for [identifier] **and**
 * the challenge of that verification is [challenge].
 *
 * The challenge is consumed when it is accepted.
 */
async function assertOtpVerified(
  channel: OtpChannel,
  identifier: string,
  challenge: string,
): Promise<void> {
  const ref = db.collection('otpCodes').doc(documentId(channel, identifier));
  const snapshot = await ref.get();
  if (!snapshot.exists || !snapshot.get('verified')) {
    throw new functions.https.HttpsError(
      'failed-precondition',
      channel === 'email'
        ? 'Verify your email address before creating your account'
        : 'Verify your mobile number before creating your account',
    );
  }

  const expected = String(snapshot.get('challengeHash') || '');
  if (!expected || !challenge || !constantTimeEquals(hash(challenge), expected)) {
    throw new functions.https.HttpsError(
      'failed-precondition',
      channel === 'email'
        ? 'Your email verification is not valid any more — please verify it again'
        : 'Your mobile number verification is not valid any more — please verify it again',
    );
  }

  if (snapshot.get('challengeUsed') === true) {
    throw new functions.https.HttpsError(
      'failed-precondition',
      channel === 'email'
        ? 'Your email verification was already used — please verify it again'
        : 'Your mobile number verification was already used — please verify it again',
    );
  }

  // The challenge is used up — it cannot be used for a second account.
  await ref.set(
    {
      challengeUsed: true,
      challengeConsumedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}

/**
 * Completes a sign-up.
 *
 * The email address always has to be verified with an OTP. The server
 * checks the `otpCodes` collection itself, so a modified client cannot skip
 * the verification, and the profile is written by the server.
 *
 * The phone number is optional contact information while phone verification
 * is disabled (see [phoneOtpRequired]); when it is enabled the number
 * becomes mandatory and has to be OTP-verified as well.
 */
export const completeRegistration = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'You must be signed in');
  }

  const uid = context.auth.uid;
  const email = String(context.auth.token.email || '').trim().toLowerCase();
  const name = String(data?.name || '').trim();
  const role = String(data?.role || 'student');
  const pincode = data?.pincode ? String(data.pincode).trim() : null;
  const challenge = String(data?.challenge || '').trim();
  const phoneChallenge = String(data?.phoneChallenge || '').trim();

  if (!email) {
    throw new functions.https.HttpsError('failed-precondition', 'No email address on this account');
  }
  if (!name) {
    throw new functions.https.HttpsError('invalid-argument', 'Name is required');
  }
  if (role !== 'student' && role !== 'owner') {
    throw new functions.https.HttpsError('invalid-argument', 'Invalid role');
  }

  const phoneRequired = phoneOtpRequired();
  const rawPhone = String(data?.phone || '').trim();
  const phone = rawPhone ? normalisePhone(rawPhone) : '';

  if (phoneRequired) {
    // The mobile number is mandatory once phone verification is switched on.
    if (!phone || !PHONE_RE.test(phone)) {
      throw new functions.https.HttpsError('invalid-argument', 'Enter a valid mobile number');
    }
  } else if (phone && !PHONE_RE.test(phone)) {
    // Still reject a malformed number when one was supplied, so the profile
    // never stores something unusable.
    throw new functions.https.HttpsError('invalid-argument', 'Enter a valid mobile number');
  }

  // The verification is bound to the client that really entered the code —
  // the challenge is the proof of it, and it may be used only once.
  await assertOtpVerified('email', email, challenge);
  if (phoneRequired) {
    await assertOtpVerified('mobile', phone, phoneChallenge);
  }

  await db.collection('users').doc(uid).set(
    {
      uid,
      name,
      email,
      // Stored as null (not "") when no number was supplied, so the app can
      // tell "not provided" apart from "empty".
      phone: phone || null,
      role,
      isActive: true,
      // This is the server-owned proof that the registration challenge was
      // completed. Clients and the Auth trigger may not set it themselves.
      registrationCompleted: true,
      pincode,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      savedRooms: [],
    },
    { merge: true },
  );

  await admin.auth().setCustomUserClaims(uid, { role, admin: false });

  return { success: true, role, phone: phone || null };
});

/**
 * Lets a signed-in user claim their role during sign-up.
 *
 * Only `student` and `owner` can be self-assigned — `admin` has to be
 * granted by an existing admin. The call is rejected unless the user's email
 * address has been verified through [verifyOtp].
 */
export const registerUserRole = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'You must be signed in');
  }

  const uid = context.auth.uid;
  const role = String(data?.role || '');
  if (role !== 'student' && role !== 'owner') {
    throw new functions.https.HttpsError('invalid-argument', 'Invalid role');
  }

  const email = context.auth.token.email;
  if (!email) {
    throw new functions.https.HttpsError('failed-precondition', 'No email address on this account');
  }

  const emailRef = db.collection('otpCodes').doc(documentId('email', email));
  const emailSnapshot = await emailRef.get();
  if (!emailSnapshot.exists || !emailSnapshot.get('verified')) {
    throw new functions.https.HttpsError(
      'failed-precondition',
      'Verify your email address before continuing',
    );
  }

  // The address must have been verified **by this account** — the call is
  // made while the user is signed in, so the verification belongs to them.
  const verifiedBy = String(emailSnapshot.get('verifiedByUid') || '');
  if (!verifiedBy || verifiedBy !== uid) {
    throw new functions.https.HttpsError(
      'failed-precondition',
      'Verify your email address again before continuing',
    );
  }

  await admin.auth().setCustomUserClaims(uid, { role, admin: false });
  await db.collection('users').doc(uid).set(
    {
      role,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  return { success: true, role };
});
