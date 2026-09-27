/**
 * checkout.js — example Stripe integration for the GroundTruth Guard demo.
 */

const Stripe = require("stripe");

const stripe = Stripe(process.env.STRIPE_SECRET_KEY ?? "sk_test_placeholder");

/**
 * Create a PaymentIntent for the given amount and customer.
 *
 * @param {number} amountInCents  Amount in the smallest currency unit (e.g. 1000 = $10.00 USD).
 * @param {string} customerId     Stripe customer ID (e.g. "cus_…").
 * @returns {Promise<import("stripe").Stripe.PaymentIntent>}
 */
async function createPayment(amountInCents, customerId) {
  const paymentIntent = await stripe.paymentIntents.create({
    amount: amountInCents,
    currency: "usd",
    customer: customerId,
    automatic_payment_methods: { enabled: true },
  });

  return paymentIntent;
}

/**
 * Refund a previously created charge.
 *
 * @param {string} chargeId  Stripe charge ID (e.g. "ch_…").
 * @returns {Promise<import("stripe").Stripe.Refund>}
 */
async function refundPayment(chargeId) {
  const refund = await stripe.refunds.create({ charge: chargeId });
  return refund;
}

module.exports = { createPayment, refundPayment };
