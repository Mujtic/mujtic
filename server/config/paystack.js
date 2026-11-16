// config/paystack.js
const required = ['PAYSTACK_SECRET_KEY'];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  throw new Error(
    `Paystack configuration missing: ${missing.join(', ')}. ` +
    `Set these in the Render dashboard → Environment.`
  );
}

const paystack = require('paystack-api')(process.env.PAYSTACK_SECRET_KEY);

module.exports = paystack;
