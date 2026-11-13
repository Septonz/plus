# ElevenLabs tools

Webhook tools for the Plus voice agent. Each JSON file is a `POST /v1/convai/tools` request body
(`tool_config` of type `webhook`) pointing at the deployed `agent-tools` Edge Function:
`https://qoqmnjzfjhpemwleipth.supabase.co/functions/v1/agent-tools/<tool name>`.

| Tool | What it does | Body (besides identity) |
| ---- | ------------ | ----------------------- |
| `get_user` | Who she is; waiting cash-ins first | none |
| `get_balance` | To spend and saved | none |
| `what_arrived` | Money in, cash-ins first | none |
| `set_auto_save` | Prepares an auto-save change (0–30%) | `percent` |
| `prepare_pay` | Prepares a payment; Tamil/English payee matching | `payee`, `amount` (rupees) |
| `confirm_action` | Confirms by voice, only up to the PIN threshold (₹500) | `action_id` |
| `reject_action` | Cancels, or says No to a cash-in | `action_id` |
| `my_record` | Totals, count confirmed on Stellar, link | none |
| `advance_status` | Eligibility, limit, cost in rupees | none |

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
| `set_language` | client | The app's language, Tamil or English | `language` |
| `update_trusted_contact` | client | Her trusted person's mobile number | `phone` |
| `simulate_money_in` | client | Demo: the state transfer or wages arrive | `kind`, `amount` |

## How a tool call proves who she is

Every tool sends the `x-plus-secret` header (an ElevenLabs workspace secret; the files only hold
the placeholder `<ELEVENLABS_SECRET_ID_FOR_PLUS_AGENT_SECRET>`) and two identity properties that
ElevenLabs fills in, never the LLM:

- `plus_session`, bound to the dynamic variable `plus_session`. The app's mic button calls the
  `voice-session` function, which checks her Supabase login and returns a signed URL plus a
  15-minute HMAC token. The app starts the conversation with `dynamicVariables: { plus_session }`.
  `agent-tools` verifies it; invalid or expired → `401`. This is the path for the app.
- `caller_id`, bound to `system__caller_id`, for phone and WhatsApp later. Used only when there is
  no session token (the placeholder value `none`).

The PIN never goes through the agent. Amounts above the PIN threshold (₹500 for India, ₦5,000 for Nigeria) can only
be confirmed on the app's screen; `confirm_action` by voice answers `pin_required_on_screen`.
A `pin` sent by voice is refused.

## Set up both agents: `pnpm agents:sync`

`pnpm agents:sync` (scripts/agents-sync.ts) does everything below for both agents, by API, and is
safe to re-run after any change to a prompt or a tool file: it creates the workspace secret
`PLUS_AGENT_SECRET` from `AGENT_SHARED_SECRET` (once; `--rotate-secret` to overwrite), adds the
Nigerian English voice, sets each agent's prompt and first message, turns authentication on, adds
the `plus_session` dynamic variable and a 10-second silence timeout, turns on language detection
(Tamil/English, Pidgin/English/Yoruba), and creates, updates or removes the webhook tools by name.
A new Nigeria agent's id is saved as `ELEVENLABS_AGENT_ID_NG` in `.env.local` and the Supabase
secrets. `--dry-run` shows what would change.

## The same steps by hand in ElevenLabs

You need: the agent from `ELEVENLABS_AGENT_ID`, and `AGENT_SHARED_SECRET` from the root
`.env.local` (gitignored; don't paste it into chats or commit it).

1. **Make the agent private.** Agents → your agent → **Security** → turn on **Enable
   authentication**. Now the agent only starts from a signed URL, which only `voice-session`
   can get (it holds `ELEVENLABS_API_KEY` as a Supabase secret). API equivalent:
   `platform_settings.auth.enable_auth = true`.
2. **Add the `plus_session` dynamic variable.** Agent → **Agent** tab → system prompt section →
   **Dynamic variables** → add `plus_session` with placeholder value `none`. (API:
   `conversation_config.agent.dynamic_variables.dynamic_variable_placeholders = { "plus_session": "none" }`.)
   The placeholder is what phone or WhatsApp calls send; the app overrides it per conversation.
3. **Store the secret.** Agent → **Secrets** (workspace settings) → **Add secret** → name
   `PLUS_AGENT_SECRET`, value = `AGENT_SHARED_SECRET`.
4. **Create each tool** (all eleven in the table). Agent → **Tools** → **Add tool** → **Webhook**:
   - Name and description: copy `name` and `description` from the JSON file.
   - Method `POST`; URL = `https://qoqmnjzfjhpemwleipth.supabase.co/functions/v1/agent-tools/<name>`.
   - Response timeout `10` seconds.
   - **Headers** → `x-plus-secret`, type **Secret** → `PLUS_AGENT_SECRET`.
   - **Body parameters**:
     - `plus_session`, string, value type **Dynamic variable** → `plus_session`. Not required.
     - `caller_id`, string, value type **Dynamic variable** → `system__caller_id`. Not required.
     - The tool's own properties from the JSON file (for example `payee` and `amount`), value type
       **LLM prompt**, with the descriptions from the file; mark them required as in the file.
5. **System prompt and first message.** Paste `agent/in/prompt.md` as the system prompt and set
   the first message to `Vanakkam! Naan Plus. Ungalukku enna udhavi venum?`. Language: Tamil.
6. **Try it.** `pnpm --filter web dev`, open `http://localhost:5173/app`, tap **Continue as
   Selvi**, then the big mic **பேசுங்க**. Say "poo kadaikku munnooru anuppu". The confirm screen
   opens by itself; tap ஆமா / Yes. Every call appears in `tool_calls` with its channel and latency.

### Or with the API

```sh
# 1. Create the workspace secret once and note its secret_id.
# 2. Replace the placeholder in each file with that secret_id locally (don't commit), then:
for f in agent/tools/*.json; do
  curl -s https://api.elevenlabs.io/v1/convai/tools \
    -H "xi-api-key: $ELEVENLABS_API_KEY" -H "content-type: application/json" -d @"$f"
done
# 3. Attach the returned tool ids: PATCH /v1/convai/agents/$ELEVENLABS_AGENT_ID with
#    conversation_config.agent.prompt.tool_ids, the dynamic variable placeholder from step 2,
#    and platform_settings.auth.enable_auth = true.
```

ElevenLabs sources:

- [Agent authentication and signed URLs](https://elevenlabs.io/docs/eleven-agents/customization/authentication)
- [Dynamic variables](https://elevenlabs.io/docs/eleven-agents/customization/personalization/dynamic-variables)
- [Server tools: headers and secrets](https://elevenlabs.io/docs/eleven-agents/customization/tools/server-tools)
- [Create tool API](https://elevenlabs.io/docs/eleven-agents/api-reference/tools/create)
- [React SDK](https://elevenlabs.io/docs/eleven-agents/libraries/react)
