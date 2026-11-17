// POST /api/stripe-webhook
// Called by Stripe itself (not your frontend) whenever a payment or subscription event
// happens. This is the ONLY place that writes "plan"/"status" into the database — never
// trust the browser to tell you someone paid.
//
// Register this URL in the Stripe Dashboard: Developers → Webhooks → Add endpoint
//   https://yoursite.vercel.app/api/stripe-webhook
// Events to send: checkout.session.completed, customer.subscription.created,
//                 customer.subscription.updated, customer.subscription.deleted

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

// Reverse-lookup from a Stripe Price ID back to the internal plan name. Beastmode Business
// is the only paid plan now. (The old $9.99 "Beastmode" price is still recognised, if its
// env var is set, so anyone who subscribed under the old pricing keeps working.)
function planFromPriceId(priceId) {
  if (priceId === process.env.STRIPE_PRICE_BEASTMODE_BUSINESS) return 'beastmode-business';
  if (process.env.STRIPE_PRICE_BEASTMODE && priceId === process.env.STRIPE_PRICE_BEASTMODE) return 'beastmode';
  return null;
}

const TERMINAL_STATUSES = ['canceled', 'incomplete_expired'];

async function upsertFromSubscription(subscription) {
  const priceId = subscription.items.data[0] && subscription.items.data[0].price.id;
  const userId = subscription.metadata && subscription.metadata.supabase_user_id;

  if (!userId) {
    console.warn('Webhook: subscription has no supabase_user_id metadata, skipping.', subscription.id);
    return;
  }

  // When someone adds a card during their trial we start a NEW subscription and cancel the
  // old trial one. The old one's "canceled" events must never overwrite the new record.
  if (TERMINAL_STATUSES.includes(subscription.status)) {
    const { data: row } = await supabaseAdmin
      .from('subscriptions').select('stripe_subscription_id').eq('user_id', userId).maybeSingle();
    if (row && row.stripe_subscription_id && row.stripe_subscription_id !== subscription.id) return;
  }

  const periodEnd = subscription.status === 'trialing' && subscription.trial_end
    ? subscription.trial_end
    : subscription.current_period_end;

  const { error } = await supabaseAdmin.from('subscriptions').upsert({
    user_id: userId,
    stripe_customer_id: subscription.customer,
    stripe_subscription_id: subscription.id,
    plan: planFromPriceId(priceId),
    status: subscription.status, // 'active' | 'trialing' | 'past_due' | 'canceled' | ...
    current_period_end: new Date(periodEnd * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  });

  if (error) console.error('Webhook: failed to upsert subscription row:', error);
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
          // Keeping Business during a trial = a new subscription replacing the trial one.
          // Save the new one first (above), then retire the old trial subscription.
          const oldId = subscription.metadata && subscription.metadata.upgrade_from;
          if (oldId && oldId !== subscription.id) {
            try { await stripe.subscriptions.cancel(oldId); }
            catch (e) { console.warn('Could not cancel the old trial subscription', oldId, e.message); }
          }
        }
        break;
      }

      case 'customer.subscription.updated':
      case 'customer.subscription.created': {
        await upsertFromSubscription(event.data.object);
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        const userId = subscription.metadata && subscription.metadata.supabase_user_id;
        if (userId) {
          // Only the person's CURRENT subscription ending matters (an old trial that was
          // replaced by a newer subscription must not wipe the new record). The app then
          // asks them to choose Beastmode Business or continue with free Beastmode.
          await supabaseAdmin.from('subscriptions').update({
            plan: null,
            status: 'canceled',
            updated_at: new Date().toISOString(),
          }).eq('user_id', userId).eq('stripe_subscription_id', subscription.id);
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
