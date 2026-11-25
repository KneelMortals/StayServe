import * as functions from 'firebase-functions/v1';
import { callableHttps } from './appCheck';
import * as firestore from 'firebase-admin/firestore';
import * as firebaseAuth from 'firebase-admin/auth';
import * as crypto from 'crypto';

// Creates the default Firebase app before this module opens Firestore —
// see the comment in `./firebase.ts`.
import './firebase';

import {
  canClaimRegistrationRole,
  canCompleteRegistration,
  hasClaimedRegistrationRole,
  resolveRegistrationRole,
  RegistrationProfileState,
  RegistrationRole,
} from './registrationAccess';
import {
  enqueueRoleClaimPublication,
  publishLatestRoleClaims,
  roleRevisionOf,
} from './roleClaims';
import {
  firebaseIdentityFromAuthUser,
  type FirebaseAuthIdentity,
  hasVerifiedRegistrationContact,
  legacyEmailProofMatches,
  LEGACY_EMAIL_PROOF_SOURCE,
} from './authIdentity';

const db = firestore.getFirestore();

/**
 * Durable rollback requests for an incomplete sign-up.
 *
 * The registration transactions read this server-only marker. It makes a
 * rollback and a successful registration mutually exclusive even though
 * Firebase Auth and Firestore cannot be committed in one transaction.
 */
export const REGISTRATION_ROLLBACK_OPERATIONS =
  'registrationRollbackOperations';

/**
 * Reads the current identity of an account from Firebase Auth.
 *
 * Registration must not trust the phone or email claims in an old ID token:
 * the token can remain valid for a short time after a provider is unlinked.
 * A failed lookup fails closed so a transient Auth error can never turn into
 * an unverified registration.
 */
async function liveFirebaseIdentity(
  uid: string,
): Promise<FirebaseAuthIdentity> {
  try {
    const user = await firebaseAuth.getAuth().getUser(uid);
    return firebaseIdentityFromAuthUser(user);
  } catch (error) {
    const code = String((error as { code?: unknown })?.code || '').trim();
    console.error('Could not read the live Firebase Auth identity:', error);
    throw new functions.https.HttpsError(
      code === 'auth/user-not-found' ? 'failed-precondition' : 'internal',
      code === 'auth/user-not-found'
        ? 'Your authentication account no longer exists.'
        : 'The account state could not be verified. Please try again.',
    );
  }
}

/**
 * Resolves the server-owned contact fields for a registration write.
 *
 * The live Firebase Auth record is authoritative for both the address and
 * its verification flag. A one-time StayServe email proof may authorise the
 * registration, but it is retained under a separate legacy-proof marker so
 * it cannot preserve a stale verified address after Auth changes. The phone
 * is never inherited from the profile for the same reason.
 */
function resolveRegistrationContact(
  identity: FirebaseAuthIdentity,
  profile: Record<string, any>,
  emailChallengeVerified = false,
): {
  email: string;
  emailVerified: boolean;
  legacyEmailProofVerified: boolean;
  phone: string | null;
  phoneVerified: boolean;
} {
  const legacyProofVerified =
    legacyEmailProofMatches(profile, identity.email) ||
    (emailChallengeVerified && identity.email !== '');

  return {
    email: identity.email,
    emailVerified: identity.emailVerified,
    legacyEmailProofVerified: legacyProofVerified,
    phone: identity.phoneVerified ? identity.phone : null,
    phoneVerified: identity.phoneVerified,
  };
}

/** The server-owned profile fields derived from a registration contact. */
function registrationContactFields(contact: {
  email: string;
  emailVerified: boolean;
  legacyEmailProofVerified: boolean;
}): Record<string, unknown> {
  return {
    email: contact.email,
    emailVerified: contact.emailVerified,
    legacyEmailProofSource: contact.legacyEmailProofVerified
      ? LEGACY_EMAIL_PROOF_SOURCE
      : null,
    legacyEmailProofEmail: contact.legacyEmailProofVerified
      ? contact.email
      : null,
  };
}

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
const CHALLENGE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const RESEND_COOLDOWN_MS = 30 * 1000; // 30 seconds between sends
const MAX_SENDS_PER_HOUR = 5;
/**
 * How many codes one **source** (an IP address or an account) may start per
 * hour — no matter how many different addresses it targets.
 */
const MAX_SENDS_PER_HOUR_PER_SOURCE = 20;
const MAX_VERIFY_ATTEMPTS = 5;

type VerifyOtpResult =
  | { kind: 'not-found' }
  | { kind: 'expired' }
  | { kind: 'too-many-attempts'; attempts: number }
  | { kind: 'incorrect'; attempts: number }
  | { kind: 'already-verified'; challenge: string }
  | { kind: 'verified'; challenge: string };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
/** The maximum length of an email address accepted by Auth and Firestore. */
const MAX_EMAIL_LENGTH = 320;
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
 * The deterministic Firestore id of an email OTP record.
 *
 * The account-linking callable has to address exactly the same document as
 * [sendOtp] and [verifyOtp]. Keeping the construction in this module avoids
 * two subtly different identifier rules.
 */
export function emailOtpDocumentId(identifier: string): string {
  return documentId('email', identifier.trim().toLowerCase());
}

/**
 * The keys of every **source** of an OTP request.
 *
 * The IP address is always counted. A signed-in account is counted as well.
 * Only hashes are stored — the raw IP address is personal data and does not
 * belong in the database.
 *
 * Counting only the account would let an attacker create many accounts from
 * one IP and use each fresh quota. Counting only the IP would let one
 * account rotate through many addresses. Both limits are therefore applied
 * together in the same transaction.
 */
function sourceKeys(context: functions.https.CallableContext): string[] {
  const ip = context.rawRequest?.ip || 'unknown';
  const keys = [`ip_${hash(String(ip))}`];
  const uid = context.auth?.uid;
  if (uid) keys.push(`uid_${hash(uid)}`);
  return keys;
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

/** Reads a Firestore timestamp without trusting an arbitrary document shape. */
function timestampMillis(value: unknown): number | null {
  if (
    !value ||
    typeof value !== 'object' ||
    typeof (value as { toMillis?: unknown }).toMillis !== 'function'
  ) {
    return null;
  }
  const millis = Number((value as { toMillis: () => unknown }).toMillis());
  return Number.isFinite(millis) ? millis : null;
}

/** Reads a non-negative integer counter from an untrusted Firestore value. */
function counterValue(value: unknown): number {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : 0;
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
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
    if (value.length > MAX_EMAIL_LENGTH || !EMAIL_RE.test(value)) {
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
export const sendOtp = callableHttps.onCall(async (data, context) => {
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
  // The sources are therefore limited as well: the IP of the caller and,
  // when it is signed in, the account may each start only a limited number
  // of sends per hour.
  // ---------------------------------------------------------------------
  const sourceKeysForRequest = sourceKeys(context);
  const sourceRefs = sourceKeysForRequest.map((source) =>
    db.collection('otpSendQuota').doc(source),
  );

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
    const [existingSnapshot, ...sourceSnapshots] = await Promise.all([
      transaction.get(ref),
      ...sourceRefs.map((sourceRef) => transaction.get(sourceRef)),
    ]);

    const previous = existingSnapshot.data() as Record<string, any> | undefined;

    // Cooldown between sends. A malformed legacy timestamp is ignored so the
    // caller can request a fresh code instead of crashing the transaction.
    const lastSentAt = timestampMillis(previous?.lastSentAt);
    if (lastSentAt !== null) {
      const elapsed = now - lastSentAt;
      if (elapsed < RESEND_COOLDOWN_MS) {
        const waitSeconds = Math.ceil((RESEND_COOLDOWN_MS - elapsed) / 1000);
        throw new functions.https.HttpsError(
          'resource-exhausted',
          `Please wait ${waitSeconds} seconds before requesting another code`,
        );
      }
    }

    // Hourly quota of the address.
    const windowStart = timestampMillis(previous?.windowStart) ?? 0;
    const sendsInWindow =
      now - windowStart < 60 * 60 * 1000
        ? counterValue(previous?.sendCount)
        : 0;
    if (sendsInWindow >= MAX_SENDS_PER_HOUR) {
      throw new functions.https.HttpsError(
        'resource-exhausted',
        'Too many codes requested. Please try again later.',
      );
    }

    // Hourly quotas of every source: always the IP and, for a signed-in
    // caller, the account as well. Both counters are checked before either
    // one is incremented.
    const sourceCounts = sourceSnapshots.map((sourceSnapshot) => {
      const sourceData = sourceSnapshot.data() as
        | Record<string, any>
        | undefined;
      const sourceStart = timestampMillis(sourceData?.windowStart) ?? 0;
      const sourceSends =
        now - sourceStart < 60 * 60 * 1000
          ? counterValue(sourceData?.sendCount)
          : 0;
      if (sourceSends >= MAX_SENDS_PER_HOUR_PER_SOURCE) {
        throw new functions.https.HttpsError(
          'resource-exhausted',
          'Too many codes requested from this device. Please try again later.',
        );
      }
      return { sourceStart, sourceSends };
    });

    const payload: Record<string, any> = {
      channel,
      identifierHash: hash(identifier.toLowerCase()),
      codeHash: hash(`${otp}:${salt}`),
      salt,
      attempts: 0,
      verified: false,
      createdAt: firestore.FieldValue.serverTimestamp(),
      lastSentAt: firestore.FieldValue.serverTimestamp(),
      expiresAt: firestore.Timestamp.fromMillis(now + OTP_TTL_MS),
      windowStart:
        sendsInWindow === 0
          ? firestore.FieldValue.serverTimestamp()
          : firestore.Timestamp.fromMillis(windowStart),
      sendCount: sendsInWindow + 1,
      verifiedByUid: null,
      challengeUsed: false,
    };

    transaction.set(ref, payload, { merge: true });

    sourceRefs.forEach((sourceRef, index) => {
      const sourceCount = sourceCounts[index];
      transaction.set(
        sourceRef,
        {
          windowStart:
            sourceCount.sourceSends === 0
              ? firestore.FieldValue.serverTimestamp()
              : firestore.Timestamp.fromMillis(sourceCount.sourceStart),
          sendCount: sourceCount.sourceSends + 1,
          updatedAt: firestore.FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    });
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
export const verifyOtp = callableHttps.onCall(async (data, context) => {
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

  // The record is read and the attempt is counted in one transaction. A
  // plain read followed by a write lets parallel guesses all observe the
  // same attempt count, so every one of them can be treated as the first
  // attempt and the five-attempt limit can be bypassed.
  const result = await db.runTransaction(
    async (transaction): Promise<VerifyOtpResult> => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) {
        return { kind: 'not-found' };
      }

      const record = snapshot.data() as Record<string, any>;

      if (record.verified) {
        // -----------------------------------------------------------------
        // The address was verified before.
        //
        // The challenge is **not** handed out again: it belongs to the client
        // that really entered the code, and nobody else may pick it up.
        //
        // The one exception is the client that verified the address itself
        // (the verification was done while it was signed in). It may ask for
        // a fresh challenge only after it proves possession of the currently
        // active OTP again. Without this second check, any signed-in client
        // which knew the uid could renew a consumed challenge indefinitely.
        // -----------------------------------------------------------------
        const verifiedBy = String(record.verifiedByUid || '');
        if (context.auth && verifiedBy && verifiedBy === context.auth.uid) {
          const expiresAt = timestampMillis(record.expiresAt);
          if (expiresAt === null || expiresAt < Date.now()) {
            return { kind: 'expired' };
          }

          const attempts = counterValue(record.attempts);
          if (attempts > MAX_VERIFY_ATTEMPTS) {
            return { kind: 'too-many-attempts', attempts };
          }

          const salt = typeof record.salt === 'string' ? record.salt : '';
          const codeHash = typeof record.codeHash === 'string' ? record.codeHash : '';
          if (!salt || !codeHash) {
            return { kind: 'expired' };
          }
          const expected = hash(`${code}:${salt}`);
          if (!constantTimeEquals(expected, codeHash)) {
            const nextAttempts = attempts + 1;
            transaction.set(
              ref,
              { attempts: nextAttempts, verified: true },
              { merge: true },
            );
            return {
              kind: nextAttempts > MAX_VERIFY_ATTEMPTS ? 'too-many-attempts' : 'incorrect',
              attempts: nextAttempts,
            };
          }

          const challenge = newChallenge();
          transaction.set(
            ref,
            {
              challengeHash: hash(challenge),
              challengeUsed: false,
              challengeIssuedAt: firestore.FieldValue.serverTimestamp(),
              challengeExpiresAt: newChallengeExpiry(),
              lastVerifiedAt: firestore.FieldValue.serverTimestamp(),
            },
            { merge: true },
          );
          return { kind: 'already-verified', challenge };
        }

        return { kind: 'already-verified', challenge: '' };
      }

      const expiresAt = timestampMillis(record.expiresAt);
      if (expiresAt === null || expiresAt < Date.now()) {
        return { kind: 'expired' };
      }

      const attempts = counterValue(record.attempts) + 1;
      if (attempts > MAX_VERIFY_ATTEMPTS) {
        transaction.set(
          ref,
          { attempts, verified: false },
          { merge: true },
        );
        return { kind: 'too-many-attempts', attempts };
      }

      const salt = typeof record.salt === 'string' ? record.salt : '';
      const codeHash = typeof record.codeHash === 'string' ? record.codeHash : '';
      if (!salt || !codeHash) {
        return { kind: 'expired' };
      }
      const expected = hash(`${code}:${salt}`);
      if (!constantTimeEquals(expected, codeHash)) {
        transaction.set(ref, { attempts }, { merge: true });
        return { kind: 'incorrect', attempts };
      }

      // The code was correct — the client gets a one-time challenge that proves
      // that *it* verified the address. The challenge is what the registration
      // needs; the "verified" flag alone is not enough any more.
      const challenge = newChallenge();
      transaction.set(
        ref,
        {
          attempts,
          verified: true,
          verifiedAt: firestore.FieldValue.serverTimestamp(),
          verifiedByUid: context.auth?.uid ?? null,
          challengeHash: hash(challenge),
          challengeUsed: false,
          challengeIssuedAt: firestore.FieldValue.serverTimestamp(),
          challengeExpiresAt: newChallengeExpiry(),
        },
        { merge: true },
      );
      return { kind: 'verified', challenge };
    },
  );

  if (result.kind === 'not-found') {
    throw new functions.https.HttpsError('not-found', 'No code was requested for this contact');
  }

  if (result.kind === 'expired') {
    throw new functions.https.HttpsError('deadline-exceeded', 'This code has expired. Request a new one.');
  }

  if (result.kind === 'too-many-attempts') {
    throw new functions.https.HttpsError(
      'resource-exhausted',
      'Too many incorrect attempts. Request a new code.',
    );
  }

  if (result.kind === 'incorrect') {
    const remaining = Math.max(0, MAX_VERIFY_ATTEMPTS - result.attempts);
    throw new functions.https.HttpsError(
      'invalid-argument',
      `Incorrect code. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`,
    );
  }

  if (result.kind === 'already-verified') {
    return {
      success: true,
      verified: true,
      alreadyVerified: true,
      channel,
      challenge: result.challenge,
    };
  }

  return { success: true, verified: true, channel, challenge: result.challenge };
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

/** The explicit expiry written with every newly issued challenge. */
function newChallengeExpiry(): firestore.Timestamp {
  return firestore.Timestamp.fromMillis(Date.now() + CHALLENGE_TTL_MS);
}

/**
 * Throws unless a code was successfully verified and its one-time challenge
 * matches [challenge].
 *
 * This helper only validates a snapshot. The challenge is marked as consumed
 * in the same transaction that writes the registration profile, so a failed
 * profile write cannot burn the proof.
 */
export function assertOtpChallenge(
  snapshot: firestore.DocumentSnapshot,
  channel: OtpChannel,
  challenge: string,
  requiredUid?: string,
  allowUnboundRequiredUid = false,
): void {
  if (!snapshot.exists || snapshot.get('verified') !== true) {
    throw new functions.https.HttpsError(
      'failed-precondition',
      channel === 'email'
        ? 'Verify your email address before creating your account'
        : 'Verify your mobile number before creating your account',
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

  const verifiedBy = String(snapshot.get('verifiedByUid') || '').trim();
  // A challenge verified while signed in is bound to that account and may
  // not be spent by another one. A challenge verified before the Firebase
  // account existed is intentionally unbound; registration callables may
  // accept that one, while the later email-linking callable keeps the strict
  // exact-uid requirement.
  const belongsToAnotherAccount =
    requiredUid &&
    verifiedBy !== requiredUid &&
    !(allowUnboundRequiredUid && !verifiedBy);
  if (belongsToAnotherAccount) {
    throw new functions.https.HttpsError(
      'failed-precondition',
      channel === 'email'
        ? 'Verify your email address again before continuing'
        : 'Verify your mobile number again before continuing',
    );
  }

  const explicitExpiry = timestampMillis(snapshot.get('challengeExpiresAt'));
  const issuedAt = timestampMillis(snapshot.get('challengeIssuedAt'));
  const challengeExpiresAt =
    explicitExpiry === null
      ? issuedAt === null
        ? null
        : issuedAt + CHALLENGE_TTL_MS
      : explicitExpiry;
  if (challengeExpiresAt === null || challengeExpiresAt <= Date.now()) {
    throw new functions.https.HttpsError(
      'failed-precondition',
      channel === 'email'
        ? 'Your email verification has expired — please verify it again'
        : 'Your mobile number verification has expired — please verify it again',
    );
  }

  const expected = snapshot.get('challengeHash');
  if (
    typeof expected !== 'string' ||
    !expected ||
    !challenge ||
    !constantTimeEquals(hash(challenge), expected)
  ) {
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
}

/**
 * Refuses a registration call for a profile which is already complete.
 *
 * The check is made inside the same transaction as the profile write, so two
 * concurrent calls cannot both finish the registration. It is the final
 * server-side boundary which prevents a completed owner from changing their
 * live role to `student` and then booking a room.
 */
function registrationProfileState(
  snapshot: firestore.DocumentSnapshot,
): RegistrationProfileState {
  return {
    exists: snapshot.exists,
    registrationCompleted: snapshot.get('registrationCompleted'),
    isActive: snapshot.get('isActive'),
    roleClaimed: snapshot.get('roleClaimed'),
    role: snapshot.get('role'),
  };
}

function assertRegistrationMayBeCompleted(
  snapshot: firestore.DocumentSnapshot,
): RegistrationProfileState {
  const state = registrationProfileState(snapshot);

  if (canCompleteRegistration(state)) return state;

  if (state.registrationCompleted === true) {
    throw new functions.https.HttpsError(
      'failed-precondition',
      'This account has already been registered.',
    );
  }

  if (state.isActive === false) {
    throw new functions.https.HttpsError(
      'permission-denied',
      'This account has been disabled. Please contact support.',
    );
  }

  throw new functions.https.HttpsError(
    'failed-precondition',
    'This account can no longer be registered.',
  );
}

/**
 * Completes a sign-up.
 *
 * A Firebase phone account may register without an email address. Google
 * accounts use Firebase's verified OIDC email fact. Email/password accounts
 * keep the existing StayServe email-OTP proof for backwards compatibility.
 * In every case the server copies the live Auth and verification facts into
 * the profile itself; the client cannot forge them.
 *
 * A verified phone is not a prerequisite for *registration* — it is a
 * prerequisite for using the booking services. The phone-verification screen
 * links and verifies it, and [syncAuthProfile] then copies the live Firebase
 * Auth phone into the server-owned profile field.
 */
export const completeRegistration = callableHttps.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'You must be signed in');
  }

  const uid = context.auth.uid;
  const identity = await liveFirebaseIdentity(uid);
  const name = String(data?.name || '').trim();
  const role = String(data?.role || 'student');
  const pincode = data?.pincode ? String(data.pincode).trim() : null;
  const challenge = String(data?.challenge || '').trim();

  // The contact facts come only from the live Firebase Auth record. A client
  // supplied `phone` value is deliberately ignored, and an old ID token can
  // neither preserve nor grant a verified phone after a provider was unlinked.
  const liveEmail = identity.email;

  const userRef = db.collection('users').doc(uid);
  const rollbackRef = db
    .collection(REGISTRATION_ROLLBACK_OPERATIONS)
    .doc(uid);
  const emailRef = liveEmail
    ? db.collection('otpCodes').doc(documentId('email', liveEmail))
    : null;

  let registeredRole: RegistrationRole = 'student';
  let registeredPhone: string | null = null;
  let registeredEmail = '';
  let registeredEmailVerified = false;
  let registeredPhoneVerified = false;
  let registeredRoleRevision = 0;

  // The OTP challenges and the profile are committed in one Firestore
  // transaction. A failed profile write therefore cannot consume a valid
  // challenge, and two registrations cannot use the same proof.
  await db.runTransaction(async (transaction) => {
    const [snapshot, rollbackSnapshot] = await Promise.all([
      transaction.get(userRef),
      transaction.get(rollbackRef),
    ]);
    if (
      rollbackSnapshot.exists &&
      String(rollbackSnapshot.get('status') || '') === 'rollbackRequested'
    ) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'This registration was rolled back. Please sign up again.',
      );
    }
    const state = registrationProfileState(snapshot);

    // A profile may already be complete when the previous call committed
    // Firestore but the Auth claim write failed. Reconcile that one
    // remaining step idempotently instead of requiring a fresh OTP.
    if (snapshot.exists && state.registrationCompleted === true) {
      if (state.isActive !== true) {
        throw new functions.https.HttpsError(
          'permission-denied',
          'This account has been disabled. Please contact support.',
        );
      }
      const storedRole = String(state.role || '').trim().toLowerCase();
      if (storedRole !== 'student' && storedRole !== 'owner') {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'This account has already been registered.',
        );
      }
      registeredRole = storedRole;
      registeredRoleRevision = roleRevisionOf(snapshot);
      enqueueRoleClaimPublication(
        transaction,
        uid,
        storedRole,
        registeredRoleRevision,
        false,
      );
      const profile = snapshot.data() as Record<string, any>;
      const contact = resolveRegistrationContact(identity, profile);
      registeredEmail = contact.email;
      registeredEmailVerified = contact.emailVerified;
      registeredPhone = contact.phone;
      registeredPhoneVerified = contact.phoneVerified;

      // Reconcile the cached contact facts as part of the idempotent retry.
      // This makes a phone unlink effective immediately instead of allowing an
      // old profile value to survive merely because the Auth role-claim
      // publication had to be retried. The live Auth email likewise replaces
      // a stale profile address; the legacy one-time proof remains separate.
      transaction.set(
        userRef,
        {
          ...registrationContactFields(contact),
          phone: registeredPhone,
          phoneVerified: registeredPhoneVerified,
          authProviders: identity.providers,
          updatedAt: firestore.FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      return;
    }

    const resolvedState = assertRegistrationMayBeCompleted(snapshot);

    if (!name) {
      throw new functions.https.HttpsError('invalid-argument', 'Name is required');
    }
    if (role !== 'student' && role !== 'owner') {
      throw new functions.https.HttpsError('invalid-argument', 'Invalid role');
    }
    if (!identity.emailVerified && !identity.phoneVerified && !challenge) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'Verify your phone number or email address before completing registration.',
      );
    }
    if (challenge && !liveEmail) {
      throw new functions.https.HttpsError(
        'invalid-argument',
        'The email verification does not match this account.',
      );
    }

    const resolvedRole = resolveRegistrationRole(resolvedState, role);
    if (!resolvedRole) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'The selected role is invalid. Please contact support.',
      );
    }
    registeredRole = resolvedRole;
    const currentRole = String(resolvedState.role || '')
      .trim()
      .toLowerCase();
    const currentRevision = roleRevisionOf(snapshot);
    registeredRoleRevision =
      currentRole && currentRole !== resolvedRole
        ? currentRevision + 1
        : currentRole
          ? currentRevision
          : currentRevision + 1;

    let emailSnapshot: firestore.DocumentSnapshot | null = null;
    if (challenge) {
      if (!emailRef) {
        throw new functions.https.HttpsError(
          'invalid-argument',
          'The email verification does not match this account.',
        );
      }
      emailSnapshot = await transaction.get(emailRef);
      assertOtpChallenge(emailSnapshot, 'email', challenge, uid, true);
    }

    const emailChallengeVerified = emailSnapshot !== null;
    const contact = resolveRegistrationContact(
      identity,
      (snapshot.data() || {}) as Record<string, any>,
      emailChallengeVerified,
    );
    registeredEmail = contact.email;
    registeredEmailVerified = contact.emailVerified;
    registeredPhone = contact.phone;
    registeredPhoneVerified = contact.phoneVerified;
    if (
      !hasVerifiedRegistrationContact(identity, emailChallengeVerified)
    ) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'Verify your phone number or email address before completing registration.',
      );
    }

    const profile: Record<string, any> = {
      uid,
      name,
      // An empty string means that the account deliberately has no email
      // address yet. A phone-only account may add one later. The legacy OTP
      // proof is recorded separately and never impersonates Firebase Auth's
      // live `emailVerified` fact.
      ...registrationContactFields({
        email: registeredEmail,
        emailVerified: registeredEmailVerified,
        legacyEmailProofVerified: contact.legacyEmailProofVerified,
      }),
      // Stored as null (not "") when no number was supplied, so the app can
      // tell "not provided" apart from "empty".
      phone: registeredPhone,
      phoneVerified: registeredPhoneVerified,
      authProviders: identity.providers,
      // This is the server-owned proof that the registration challenge was
      // completed. Clients and the Auth trigger may not set it themselves.
      registrationCompleted: true,
      // The marker makes the role claim one-time. It is written even for a
      // legacy profile whose role was already `owner`, so a later call can
      // never reinterpret that profile as an unclaimed student account.
      roleClaimed: true,
      roleRevision: registeredRoleRevision,
      pincode,
      updatedAt: firestore.FieldValue.serverTimestamp(),
    };

    // A role which was already claimed is preserved. Only an unclaimed role
    // may be selected by this call.
    if (!hasClaimedRegistrationRole(resolvedState)) {
      profile.role = resolvedRole;
    }

    // A trigger-created profile already has these fields. They are added
    // only when the trigger and the registration really raced and no profile
    // existed yet; an existing profile keeps its creation time, saved rooms,
    // activation state and already-selected role.
    if (!snapshot.exists) {
      profile.role = resolvedRole;
      profile.isActive = true;
      profile.createdAt = firestore.FieldValue.serverTimestamp();
      profile.savedRooms = [];
    }

    transaction.set(userRef, profile, { merge: true });
    enqueueRoleClaimPublication(
      transaction,
      uid,
      resolvedRole,
      registeredRoleRevision,
      false,
    );
    if (challenge && emailRef && emailSnapshot) {
      transaction.set(
        emailRef,
        {
          challengeUsed: true,
          challengeConsumedAt: firestore.FieldValue.serverTimestamp(),
          // Bind the consumed contact record to the account which used the
          // challenge. An account-deletion cleanup can then find and erase the
          // identifier hash deterministically.
          verifiedByUid: uid,
        },
        { merge: true },
      );
    }
  });

  const published = await publishLatestRoleClaims(uid);

  return {
    success: true,
    role: published.role || registeredRole,
    email: registeredEmail,
    emailVerified: registeredEmailVerified,
    phone: registeredPhone,
    phoneVerified: registeredPhoneVerified,
  };
});

/**
 * Lets a signed-in user claim their role during sign-up.
 *
 * Only `student` and `owner` can be self-assigned — `admin` has to be
 * granted by an existing admin. A Firebase-verified phone or Google email is
 * sufficient by itself. An email/password account keeps the legacy
 * StayServe email-OTP proof.
 */
export const registerUserRole = callableHttps.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'You must be signed in');
  }

  const uid = context.auth.uid;
  const role = String(data?.role || '');
  const challenge = String(data?.challenge || '').trim();
  if (role !== 'student' && role !== 'owner') {
    throw new functions.https.HttpsError('invalid-argument', 'Invalid role');
  }

  const identity = await liveFirebaseIdentity(uid);
  const liveEmail = identity.email;
  const emailRef = liveEmail
    ? db.collection('otpCodes').doc(documentId('email', liveEmail))
    : null;
  const userRef = db.collection('users').doc(uid);
  const rollbackRef = db
    .collection(REGISTRATION_ROLLBACK_OPERATIONS)
    .doc(uid);

  let claimedEmail = '';
  let claimedEmailVerified = false;
  let claimedPhone: string | null = null;
  let claimedPhoneVerified = false;

  await db.runTransaction(async (transaction) => {
    // The profile and the one-time proof are read in the same transaction as
    // the role claim. A concurrent send which resets `verified=false`, or a
    // second role claim which consumes the challenge, therefore wins or
    // loses as one serialized operation.
    const [snapshot, rollbackSnapshot] = await Promise.all([
      transaction.get(userRef),
      transaction.get(rollbackRef),
    ]);
    if (
      rollbackSnapshot.exists &&
      String(rollbackSnapshot.get('status') || '') === 'rollbackRequested'
    ) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'This registration was rolled back. Please sign up again.',
      );
    }
    const state = registrationProfileState(snapshot);
    const currentRole = String(state.role || '')
      .trim()
      .toLowerCase();

    // The matching-role branch is an idempotent retry of an already
    // committed role transition. It does not need the consumed challenge;
    // it only republishes the missing Auth role claim and reconciles the
    // contact facts with the live Firebase Auth record.
    if (hasClaimedRegistrationRole(state) && currentRole === role) {
      if (state.isActive !== true) {
        throw new functions.https.HttpsError(
          'permission-denied',
          'This account has been disabled. Please contact support.',
        );
      }

      const profile = snapshot.data() as Record<string, any>;
      const contact = resolveRegistrationContact(identity, profile);
      claimedEmail = contact.email;
      claimedEmailVerified = contact.emailVerified;
      claimedPhone = contact.phone;
      claimedPhoneVerified = contact.phoneVerified;

      // A matching role can be a retry of a committed claim. If the profile
      // is still marked incomplete, it may only be completed when Firebase
      // Auth contains a verified contact or the profile still carries the
      // matching legacy one-time email proof. This prevents an arbitrary role
      // claim from turning an incomplete profile into a usable tenant
      // account.
      const registrationCompleted = state.registrationCompleted === true;
      if (
        !registrationCompleted &&
        !claimedEmailVerified &&
        !claimedPhoneVerified &&
        !contact.legacyEmailProofVerified
      ) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'Verify your phone number or email address before continuing',
        );
      }

      transaction.set(
        userRef,
        {
          registrationCompleted: true,
          ...registrationContactFields(contact),
          phone: claimedPhone,
          phoneVerified: claimedPhoneVerified,
          authProviders: identity.providers,
          updatedAt: firestore.FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      enqueueRoleClaimPublication(
        transaction,
        uid,
        currentRole,
        roleRevisionOf(snapshot),
        false,
      );
      return;
    }

    let emailSnapshot: firestore.DocumentSnapshot | null = null;
    if (challenge) {
      if (!emailRef) {
        throw new functions.https.HttpsError(
          'invalid-argument',
          'The email verification does not match this account.',
        );
      }
      emailSnapshot = await transaction.get(emailRef);
      assertOtpChallenge(emailSnapshot, 'email', challenge, uid, true);
    } else if (!identity.emailVerified && !identity.phoneVerified) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'Verify your phone number or email address before continuing',
      );
    }

    const emailChallengeVerified = emailSnapshot !== null;
    if (!hasVerifiedRegistrationContact(identity, emailChallengeVerified)) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'Verify your phone number or email address before continuing',
      );
    }

    assertRegistrationMayBeCompleted(snapshot);
    if (!canClaimRegistrationRole(state)) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'The role for this account has already been selected.',
      );
    }

    const currentRevision = roleRevisionOf(snapshot);
    const claimedRoleRevision =
      currentRole && currentRole !== role
        ? currentRevision + 1
        : currentRole
          ? currentRevision
          : currentRevision + 1;

    const profileData = (snapshot.data() || {}) as Record<string, any>;
    const contact = resolveRegistrationContact(
      identity,
      profileData,
      emailChallengeVerified,
    );
    claimedEmail = contact.email;
    claimedEmailVerified = contact.emailVerified;
    claimedPhone = contact.phone;
    claimedPhoneVerified = contact.phoneVerified;

    const profile: Record<string, any> = {
      role,
      // The marker is the one-time proof that this role was selected.
      roleClaimed: true,
      roleRevision: claimedRoleRevision,
      // Claiming the role and completing the registration are one server
      // operation. A phone-only or Google account therefore needs no second
      // call before it can reach the role-specific service area.
      registrationCompleted: true,
      ...registrationContactFields({
        email: claimedEmail,
        emailVerified: claimedEmailVerified,
        legacyEmailProofVerified: contact.legacyEmailProofVerified,
      }),
      phone: claimedPhone,
      phoneVerified: claimedPhoneVerified,
      authProviders: identity.providers,
      updatedAt: firestore.FieldValue.serverTimestamp(),
    };

    if (!snapshot.exists) {
      profile.uid = uid;
      profile.isActive = true;
      profile.createdAt = firestore.FieldValue.serverTimestamp();
      profile.savedRooms = [];
    }

    transaction.set(userRef, profile, { merge: true });
    enqueueRoleClaimPublication(
      transaction,
      uid,
      role,
      claimedRoleRevision,
      false,
    );
    if (challenge && emailRef && emailSnapshot) {
      transaction.set(
        emailRef,
        {
          challengeUsed: true,
          challengeConsumedAt: firestore.FieldValue.serverTimestamp(),
          verifiedByUid: uid,
        },
        { merge: true },
      );
    }
  });

  const published = await publishLatestRoleClaims(uid);

  return {
    success: true,
    role: published.role || role,
    email: claimedEmail,
    emailVerified: claimedEmailVerified,
    phone: claimedPhone,
    phoneVerified: claimedPhoneVerified,
  };
});
