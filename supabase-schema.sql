-- Run this once in your Supabase project: Dashboard → SQL Editor → New Query → paste → Run.
-- Creates the table that tracks each user's Stripe subscription status.

create table if not exists public.subscriptions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  stripe_customer_id text,
  stripe_subscription_id text,
  plan text,                 -- 'beastmode' | 'beastmode-business' | null
  status text,                -- Stripe's status: 'active', 'trialing', 'past_due', 'canceled', etc.
  current_period_end timestamptz,
  updated_at timestamptz not null default now()
);

-- Row Level Security: users may READ their own row, but can never write to it directly.
-- Only the webhook (using the service role key, which bypasses RLS) is allowed to write.
-- This is what makes it safe — a user editing client-side JS cannot grant themselves access.
alter table public.subscriptions enable row level security;

create policy "Users can read their own subscription"
  on public.subscriptions
  for select
  using (auth.uid() = user_id);

-- Helpful index for the webhook to look rows up by Stripe's subscription id quickly.
create index if not exists subscriptions_stripe_subscription_id_idx
  on public.subscriptions (stripe_subscription_id);

create index if not exists subscriptions_stripe_customer_id_idx
  on public.subscriptions (stripe_customer_id);
