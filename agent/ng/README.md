# Plus Nigeria voice agent

A second ElevenLabs agent, **Plus Nigeria**, for users whose market pack is `ng` (Funmi).
`voice-session` picks it by market: `ELEVENLABS_AGENT_ID_NG` for Nigeria, `ELEVENLABS_AGENT_ID`
for India. Same `agent-tools` function, same secret header, same `plus_session` token; `agent-tools`
sends Nigeria users to the Nigeria tools by their `market_id`, so the URLs are the same as India's.

- System prompt: [`prompt.md`](prompt.md) (Pidgin by default, Yoruba if she speaks it, naira,
  read back then "check your screen and tap Yes", never a PIN out loud, patient with pauses).
- Set up or update by API: `pnpm agents:sync` (see [`../tools/README.md`](../tools/README.md)).
- Tools: [`tools/`](tools), 24 webhook and 5 client tool bodies (`POST /v1/convai/tools`).

| Tool | What it does | Body (besides identity) |
| ---- | ------------ | ----------------------- |
| `get_user` | Who she is; cash-ins waiting for her Yes first | none |
| `get_balance` | Wallet balance in naira, free to spend | none |
| `what_arrived` | Money in, cash-ins first | none |
| `prepare_pay` | Prepares a payment to a saved payee, or to anyone by phone (Plus user: wallet to wallet; not on Plus: a cash code by text) | `payee` or `phone` (+ `name`), `amount` (naira) |
| `save_payee` | Saves someone she paid by phone | `name`, `phone` |
| `bank_details` | Her account number for bank transfers in (Partner bank, simulated) | none |
| `loan_status` | Her loan picture: progress ("week 4 of 6") and an estimate before unlock; the offer, why, and the ladder after; or what's left on an open loan | none |
| `prepare_loan` | Prepares accepting the offer (receive, cost, total); always the PIN on screen | `amount` (naira, optional: less than the offer) |
| `prepare_loan_repay` | Prepares a repayment from her wallet, up to what she owes | `amount` (naira, optional: all) |
| `loan_more_time` | "I need more time": next payment moves 2 weeks, no cost, once; new borrowing pauses | none |
| `loan_restructure` | After a missed payment: smaller minimum, no cost, once | none |
| `prepare_cashout` | Prepares a cash-out; the 6-digit code shows on her screen only | `amount` (naira) |
| `cash_outs` | Open cash-outs and when they expire | none |
| `confirm_action` | Confirms by voice up to the PIN threshold (₦5,000); "sending", then the tick | `action_id` |
| `reject_action` | Cancels, or says No to a cash-in | `action_id` |
| `my_record` | Money in and out, cash-ins, entries on Stellar, link | none |

**Screen tools.** Everything on her screen is also by voice. `help` is a webhook (works on a call
too). The rest are **client tools** (`type: client`): they run in her browser with her own login
(`apps/web/src/plus/screen.ts`), so they only work in the app. The app also sends the agent a
contextual update ("On her screen now: …") whenever the screen changes. The PIN is the exception:
she sets and types it on the screen only.

| Tool | Type | What it does | Body |
| ---- | ---- | ------------ | ---- |
| `help` | webhook | What she can do (each also by voice), the voice-yes limit, what is waiting | none |
| `navigate` | client | Opens a screen | `screen` |
| `what_is_on_screen` | client | What her screen shows now, in words | none |
| `sign_out` | client | Signs her out (only when she clearly asks) | none |
| `new_cashout_code` | client | A fresh code for a waiting cash-out, on her screen only | `amount` (optional) |
| `simulate_bank_transfer` | client | Demo: a bank transfer arrives at her account number | `amount` |

Sign-up (the app passes `onboarding_token` to `voice-session`, which gives the agent a
`plus_session` for that sign-up only). The PIN, the photo and the NIN are screen-only: the tools
refuse them from voice.

| Tool | What it does | Body (besides identity) |
| ---- | ------------ | ----------------------- |
| `start_onboarding` | Where her sign-up is: the six steps, what's done, what to ask next | none |
| `onboarding_status` | Same, after she does something on her screen | none |
| `set_profile` | Her name and language | `name`, `language` |
| `send_phone_code` | Sends a 6-digit code (shown on screen in the demo) | `phone` |
| `verify_phone_code` | Checks the code (10 minutes, 5 tries) | `code` |
| `verify_identity` | Says what to do on the screen next (photo, then NIN); never takes a NIN | none |
| `set_trusted_contact` | Someone who can help her back in | `name`, `phone` |
| `create_wallet` | Opens her wallet on Stellar after she says yes | none |

## Exact steps in ElevenLabs

You need the `PLUS_AGENT_SECRET` workspace secret from the India setup
([`../tools/README.md`](../tools/README.md), step 3). It is shared by both agents.

1. **Create the agent.** Agents → **New agent** → Blank → name it **Plus Nigeria**.
2. **Language and voice.** Agent tab → Language **English**; add **Yoruba** as an additional
   language if your plan offers it. Pick a warm Nigerian English voice from the voice library
   (search "Nigerian"). Turn on language detection so a Yoruba speaker gets Yoruba.
3. **Prompt and first message.** Paste [`prompt.md`](prompt.md) as the system prompt. First
   message: `Ẹ n lẹ́ o! Na Plus be dis. Wetin I fit do for you today?`
4. **Patience.** Advanced → turn timeout (silence before the agent speaks again) **10 s** or more,
   and interruptions on, so she can pause to serve a customer.
5. **Make it private.** Security → turn on **Enable authentication**
   (`platform_settings.auth.enable_auth = true`).
6. **Dynamic variable.** Agent tab → Dynamic variables → add `plus_session`, placeholder `none`.
7. **Tools.** Tools → Add tool → **Webhook**, once for each file in `tools/` (13). For each:
   name and description from the file, `POST`, URL
   `https://qoqmnjzfjhpemwleipth.supabase.co/functions/v1/agent-tools/<name>`, timeout 10 s,
   header `x-plus-secret` of type **Secret** → `PLUS_AGENT_SECRET`, body params `plus_session`
   (dynamic variable `plus_session`) and `caller_id` (dynamic variable `system__caller_id`), both
   not required, plus the file's own properties as **LLM prompt** with its descriptions and
   required flags. Tools you already created for India with the same name (`get_user`,
   `get_balance`, …) can't be reused as is: their descriptions talk about rupees. Create the
   Nigeria ones separately.
8. **Tell Plus the agent id.** Copy the agent id (Agent → ⋯ → Copy ID) and set it as a Supabase
   secret yourself:
   `npx supabase secrets set ELEVENLABS_AGENT_ID_NG=<agent id> --project-ref qoqmnjzfjhpemwleipth`
9. **Try it.** `pnpm --filter web dev`, open `http://localhost:5173/app`, tap **Continue as
   Funmi**, then the mic **Talk to Plus · Sọ̀rọ̀**. Say "How much I get?" then "Pay Iya Tunde two
   thousand". The confirm sheet opens by itself; tap Yes and watch the tick.

### Or with the API

```sh
# Replace the secret placeholder in each file locally with the secret_id (don't commit), then:
for f in agent/ng/tools/*.json; do
  curl -s https://api.elevenlabs.io/v1/convai/tools \
    -H "xi-api-key: $ELEVENLABS_API_KEY" -H "content-type: application/json" -d @"$f"
done
# Attach the returned tool ids to the Plus Nigeria agent:
# PATCH /v1/convai/agents/$ELEVENLABS_AGENT_ID_NG with conversation_config.agent.prompt.tool_ids,
# conversation_config.agent.prompt.prompt = contents of agent/ng/prompt.md,
# conversation_config.agent.first_message, dynamic_variable_placeholders { plus_session: "none" },
# and platform_settings.auth.enable_auth = true.
```
