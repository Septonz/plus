# Plus Nigeria voice agent

A second ElevenLabs agent, **Plus Nigeria**, for users whose market pack is `ng` (Funmi).
`voice-session` picks it by market: `ELEVENLABS_AGENT_ID_NG` for Nigeria, `ELEVENLABS_AGENT_ID`
for India. Same `agent-tools` function, same secret header, same `plus_session` token; `agent-tools`
sends Nigeria users to the Nigeria tools by their `market_id`, so the URLs are the same as India's.

- System prompt: [`prompt.md`](prompt.md) (Pidgin by default, Yoruba if she speaks it, naira,
  read back then "check your screen and tap Yes", never a PIN out loud, patient with pauses).
- Set up or update by API: `pnpm agents:sync` (see [`../tools/README.md`](../tools/README.md)).
- Tools: [`tools/`](tools), 22 webhook tool bodies (`POST /v1/convai/tools`).

| Tool | What it does | Body (besides identity) |
| ---- | ------------ | ----------------------- |
| `get_user` | Who she is; cash-ins waiting for her Yes first | none |
| `get_balance` | Wallet balance in naira, free to spend | none |
| `what_arrived` | Money in, cash-ins first | none |
| `prepare_pay` | Prepares a payment to a saved payee, or to anyone by phone (Plus user: wallet to wallet; not on Plus: a cash code by text) | `payee` or `phone` (+ `name`), `amount` (naira) |
| `save_payee` | Saves someone she paid by phone | `name`, `phone` |
| `bank_details` | Her account number for bank transfers in (Partner bank, simulated) | none |
| `group_status` | Ajo: who paid, whose turn, read from the contract | none |
| `prepare_ajo_contribution` | Prepares her ajo part for this round | none |
| `advance_status` | Limit, fee in naira, or what's left to repay | none |
| `prepare_advance` | Prepares an advance: one fee, no interest, no late fees, 10% of each cash-in | `amount` (naira) |
| `prepare_cashout` | Prepares a cash-out; the 6-digit code shows on her screen only | `amount` (naira) |
| `cash_outs` | Open cash-outs and when they expire | none |
| `confirm_action` | Confirms by voice below the PIN threshold (₦20,000); "sending", then the tick | `action_id` |
| `reject_action` | Cancels, or says No to a cash-in | `action_id` |
| `my_record` | Money in and out, cash-ins, entries on Stellar, link | none |

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
