-- scheduler every minute: expire unanswered actions, refresh Nigeria wallet balances from Horizon,
-- queue due ajo payouts and return unredeemed cash-outs. Uses the same Vault secrets as chain-worker
-- (plus_functions_url, plus_cron_secret); without them it does nothing and says so in the log.
select cron.schedule('plus-scheduler', '* * * * *', $$ select public.invoke_plus_function('scheduler') $$);
