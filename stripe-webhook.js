// POST /api/stripe-webhook
// Called by Stripe itself (not your frontend) whenever a payment or subscription event
// happens. This is the ONLY place that writes "plan"/"status" into the database — never
// trust the browser to tell you someone paid.
//
// Register this URL in the Stripe Dashboard: Developers → Webhooks → Add endpoint
//   https://yoursite.vercel.app/api/stripe-webhook
// Events to send: checkout.session.completed, customer.subscription.updated,
//                 customer.subscription.deleted

const Stripe = require('stripe');
const { supabaseAdmin } = require('./_lib/verifyUser');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Stripe requires the RAW, unparsed request body to verify a webhook's signature —
// if Vercel parses it into JSON first, the signature check will fail. This turns
// off Vercel's automatic body parsing for this route only.
module.exports.config = {
  api: { bodyParser: false },
};

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// EDIT: reverse-lookup from a Stripe Price ID back to your internal plan name, so we
// know whether a subscription is "beastmode" or "beastmode-business". Keep this in
// sync with the PRICE_IDS map in create-checkout-session.js.
function planFromPriceId(priceId) {
  if (priceId === process.env.STRIPE_PRICE_BEASTMODE) return 'beastmode';
  if (priceId === process.env.STRIPE_PRICE_BEASTMODE_BUSINESS) return 'beastmode-business';
  return null;
}

async function upsertFromSubscription(subscription) {
  const priceId = subscription.items.data[0] && subscription.items.data[0].price.id;
  const userId = subscription.metadata && subscription.metadata.supabase_user_id;

  if (!userId) {
    console.warn('Webhook: subscription has no supabase_user_id metadata, skipping.', subscription.id);
    return;
  }

  const { error } = await supabaseAdmin.from('subscriptions').upsert({
    user_id: userId,
    stripe_customer_id: subscription.customer,
    stripe_subscription_id: subscription.id,
    plan: planFromPriceId(priceId),
    status: subscription.status, // 'active' | 'trialing' | 'past_due' | 'canceled' | ...
    current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  });

  if (error) console.error('Webhook: failed to upsert subscription row:', error);
}

// When a Starter free trial (always on the Beastmode Business price) ends, Stripe
// flips its status from 'trialing' to 'active' but leaves it on the Business price —
// Stripe has no built-in "downgrade after trial" behavior. This detects that exact
// transition and swaps the subscription onto the cheaper Beastmode price so billing
// matches what the person was told: free trial → auto-converts to Beastmode.
async function maybeDowngradeExpiredTrial(subscription, previousAttributes) {
  const wasTrialing = previousAttributes && previousAttributes.status === 'trialing';
  const isNowActive = subscription.status === 'active';
  const isStarterTrial = subscription.metadata && subscription.metadata.starter_trial === 'true';

  if (!(wasTrialing && isNowActive && isStarterTrial)) return false;

  const itemId = subscription.items.data[0] && subscription.items.data[0].id;
  await stripe.subscriptions.update(subscription.id, {
    items: [{ id: itemId, price: process.env.STRIPE_PRICE_BEASTMODE }],
    proration_behavior: 'none',
    metadata: { ...subscription.metadata, starter_trial: 'false' },
  });
  // The update above triggers a fresh customer.subscription.updated event with the
  // new price, which upsertFromSubscription will then save as plan: 'beastmode'.
  return true;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).send('Method not allowed');
    return;
  }

  let event;
  try {
    const rawBody = await readRawBody(req);
    const signature = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    res.status(400).send(`Webhook Error: ${err.message}`);
    return;
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        if (session.mode === 'subscription' && session.subscription) {
          const subscription = await stripe.subscriptions.retrieve(session.subscription);
          // Fall back to client_reference_id if metadata wasn't copied through yet.
          if (!subscription.metadata || !subscription.metadata.supabase_user_id) {
            subscription.metadata = { ...subscription.metadata, supabase_user_id: session.client_reference_id };
          }
          await upsertFromSubscription(subscription);
        }
        break;
      }

      case 'customer.subscription.updated':
      case 'customer.subscription.created': {
        const subscription = event.data.object;
        const previousAttributes = event.data.previous_attributes;
        const downgraded = await maybeDowngradeExpiredTrial(subscription, previousAttributes);
        if (!downgraded) await upsertFromSubscription(subscription);
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        const userId = subscription.metadata && subscription.metadata.supabase_user_id;
        if (userId) {
          await supabaseAdmin.from('subscriptions').update({
            plan: null,
            status: 'canceled',
            updated_at: new Date().toISOString(),
          }).eq('user_id', userId);
        }
        break;
      }

      default:
        // Ignore anything we don't handle — Stripe sends many event types.
        break;
    }

    res.status(200).json({ received: true });
  } catch (err) {
    console.error('Webhook handler error:', err);
    // Return 500 so Stripe retries — this event may not have been saved.
    res.status(500).json({ error: 'Webhook handler failed.' });
  }
};
