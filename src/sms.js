'use strict';
// SMS delivery boundary. Stage two runs in SIMULATED mode: the message lands in the user's in-app notifications
// (and the server log in development) so the one-time-code flow can be exercised end to end without a provider.
// Production: set SMS_MODE=provider and implement `deliver` for your SMS gateway; the simulated path is then disabled.
const { notify } = require('./common');

async function send(c, user, text) {
  const mode = process.env.SMS_MODE || 'simulated';
  if (mode === 'simulated') {
    await notify(c, user.id, 'OTP', 'Your verification code (simulated SMS)', text);
    if (process.env.NODE_ENV !== 'test' && !process.env.QUIET_SMS) console.log(`[sms:simulated] to ${user.phone}: ${text}`);
    return { delivered: 'simulated' };
  }
  throw new Error('SMS provider not configured: implement deliver() in src/sms.js and set SMS_MODE=provider');
}
module.exports = { send };
