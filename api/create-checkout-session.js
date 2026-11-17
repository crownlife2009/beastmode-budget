// POST /api/create-checkout-session
// Body: { "plan": "beastmode-business", "trial": true|false }
// Header: Authorization: Bearer <supabase access token>
// Returns: { url: "https://checkout.stripe.com/..." } — redirect the browser there.
//
// This is the ONLY place your Stripe secret key is used. It never touches the browser.
//
// PRICING MODEL
//   - Beastmode (personal budgeting) is FREE. It never goes through Stripe — see
//     select-free-plan.js, which records the choice.
//   - Beastmode Business is the only paid plan ($9.99/mo, STRIPE_PRICE_BEASTMODE_BUSINESS).
//   - The 30-day free trial is a Stripe trial on the Business price. NO card is collected
//     to start it (payment_method_collection: 'if_required'). If the person hasn't added
//     a card by the end of the 30 days, Stripe cancels the subscription instead of
//     charging anyone, the webhook records that, and the app asks them to either
//     subscribe to Beastmode Business or continue with free Beastmode.
//   - A person can add a card (keep Business) before the trial ends: that creates a new
//     checkout whose first charge is delayed until the original trial_end, and the
//     webhook cancels the old trial subscription once the new one is saved.

const Stripe = require('stripe');
const { verifyUser, supabaseAdmin } = require('./_lib/verifyUser');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Create ONE recurring $9.99/month price in the Stripe Dashboard for Beastmode Business
// and put its "price_..." id in the STRIPE_PRICE_BEASTMODE_BUSINESS environment variable.
const BUSINESS_PRICE_ID = process.env.STRIPE_PRICE_BEASTMODE_BUSINESS;
const TRIAL_DAYS = 30;

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const user = await verifyUser(req);

    const { plan, trial } = req.body || {};
    if (plan === 'beastmode') {
      res.status(400).json({ error: 'Beastmode is free — no checkout needed.' });
      return;
    }
    if (plan !== 'beastmode-business' || !BUSINESS_PRICE_ID) {
      res.status(400).json({ error: `Unknown plan "${plan}".` });
      return;
    }

    // Reuse an existing Stripe customer for this user if we already have one on file,
    // so someone switching plans (or resubscribing) doesn't end up as duplicate customers.
    const { data: existingRow } = await supabaseAdmin
      .from('subscriptions')
      .select('stripe_customer_id, stripe_subscription_id, plan, status')
      .eq('user_id', user.id)
      .maybeSingle();

    const hadStripeSubscription = !!(existingRow && existingRow.stripe_subscription_id);

    // A person only gets one free trial, ever. Enforced here, not just by hiding the
    // button, because client-side checks can always be bypassed. (Choosing the free
    // Beastmode plan creates no Stripe subscription, so it does NOT use up the trial.)
    if (trial && hadStripeSubscription) {
      res.status(400).json({ error: "Looks like you've already used your free trial — choose Beastmode Business ($9.99/mo) or continue with free Beastmode." });
      return;
    }

    // Already paying for Business? Nothing to buy — point them to the billing portal.
    if (!trial && existingRow && existingRow.plan === 'beastmode-business' && existingRow.status === 'active') {
      res.status(400).json({ error: "You're already on Beastmode Business. Use \"Manage my plan\" to change your billing." });
      return;
    }

    let customerId = existingRow && existingRow.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: { supabase_user_id: user.id },
      });
      customerId = customer.id;
    }

    // Prefer the PUBLIC_SITE_URL env var; fall back to the known production domain
    // (NOT req.headers.host — that reflects whatever URL the browser happened to be
    // on, e.g. the *.vercel.app preview domain, which is how this redirect bug happens).
    const siteUrl = process.env.PUBLIC_SITE_URL || 'https://www.beastmodebudget.com';

    const subscriptionData = {
      metadata: {
        supabase_user_id: user.id,
        starter_trial: trial ? 'true' : 'false',
      },
    };
    const sessionExtras = {};

    if (trial) {
      // Free 30 days of Business, no card needed. If no card is on file when the trial
      // ends, cancel (never charge, never leave a half-active subscription).
      subscriptionData.trial_period_days = TRIAL_DAYS;
      subscriptionData.trial_settings = { end_behavior: { missing_payment_method: 'cancel' } };
      sessionExtras.payment_method_collection = 'if_required';
    } else if (existingRow && existingRow.stripe_subscription_id && existingRow.status === 'trialing') {
      // Keeping Business while the trial is still running: collect a card now, but keep
      // the original trial end date so they don't lose any free days.
      try {
        const oldSub = await stripe.subscriptions.retrieve(existingRow.stripe_subscription_id);
        if (oldSub.status === 'trialing' && oldSub.trial_end && oldSub.trial_end * 1000 > Date.now() + 60 * 60 * 1000) {
          subscriptionData.trial_end = oldSub.trial_end;
          subscriptionData.metadata.upgrade_from = oldSub.id;
          subscriptionData.metadata.starter_trial = 'true';
        }
      } catch (e) {
        console.warn('Could not read the existing trial subscription; charging from today.', e.message);
      }
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      client_reference_id: user.id,
      line_items: [{ price: BUSINESS_PRICE_ID, quantity: 1 }],
      success_url: `${siteUrl}/?checkout=success`,
      cancel_url: `${siteUrl}/?checkout=canceled`,
      subscription_data: subscriptionData,
      allow_promotion_codes: true,
      ...sessionExtras,
    });

    res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('create-checkout-session error:', err);
    res.status(err.statusCode || 500).json({ error: err.message || 'Something went wrong.' });
  }
};
