# ElevenLabs tools

Webhook tools for the Plus voice agent. Each JSON file is a `POST /v1/convai/tools` request body
(`tool_config` of type `webhook`) pointing at the deployed `agent-tools` Edge Function:

| Tool | URL |
| ---- | --- |
| `get_user` | `https://qoqmnjzfjhpemwleipth.supabase.co/functions/v1/agent-tools/get_user` |
| `get_balance` | `https://qoqmnjzfjhpemwleipth.supabase.co/functions/v1/agent-tools/get_balance` |
| `what_arrived` | `https://qoqmnjzfjhpemwleipth.supabase.co/functions/v1/agent-tools/what_arrived` |

How they work:

- **Auth:** every call carries the `x-plus-secret` header. Its value is an ElevenLabs workspace
  secret. The files only hold the placeholder `<ELEVENLABS_SECRET_ID_FOR_PLUS_AGENT_SECRET>`, never
  the secret itself.
- **Who is calling:** the body has one property, `caller_id`, bound to the system dynamic variable
  `system__caller_id`. ElevenLabs fills it in, not the LLM:
  - on a phone call it is the caller's number (`+14155552671`);
  - on WhatsApp it is the WhatsApp user ID (the number without `+`).
  
  `agent-tools` accepts both forms. If Meta sends a Business-Scoped User ID instead of a phone
  number, the user is treated as unknown.
- **Responses:** every response is `{ text, ...fields, latency_ms }`. `text` is short English the
  agent says in the caller's language. Amounts are already formatted (`₹2,350`, `₦50,000`).

## Add them to your agent (dashboard)

1. **Get the secret value.** The agent secret is in the root `.env.local` (gitignored) as
   `AGENT_SHARED_SECRET`. It was rotated on 2026-11-09, so the old value no longer works. Copy it
   from the file. Don't paste it into chats or commit it.
2. **Store it in ElevenLabs.** Go to ElevenLabs → **Agents** → your agent. Under the agent's tool
   or workspace settings, open **Secrets**, then **Add secret**. Name it `PLUS_AGENT_SECRET` and
   paste the value.
3. **Create `get_user`.** In your agent → **Tools** → **Add tool** → **Webhook**, set:
   - Name: `get_user`
   - Description: copy `description` from `get_user.json`
   - Method `POST`, URL from the table above
   - Response timeout: `10` seconds
   - **Headers** → Add header → name `x-plus-secret`, type **Secret** → choose `PLUS_AGENT_SECRET`
   - **Body parameters** → Add property → name `caller_id`, type `string`, value type
     **Dynamic variable** → `system__caller_id`. Mark it required.
4. **Repeat step 3** for `get_balance` and `what_arrived`.
5. **Tell the agent when to use them.** In the system prompt (`agent/in/prompt.md`) add: "At the
   start of every conversation call `get_user`. Never ask the caller for their phone number. Read
   tool `text` fields aloud in the caller's language, keeping the amounts exactly as given."
6. **Make yourself Selvi.** Put your WhatsApp number in `.env.local` as
   `DEMO_SELVI_PHONE=+91…` (international format) and run `pnpm seed:db`. Re-running is safe: it
   only moves Selvi to your number and applies no money twice.
7. **Test on a real channel.** `system__caller_id` is empty in the browser test widget, so test by
   WhatsApp message or phone call. Ask "How much money do I have?" You should hear ₹2,350 to spend
   and ₹1,415 saved. Every call appears in the `tool_calls` table with its latency.

### Or with the API

```sh
# 1. Create the workspace secret once, and note the returned secret_id.
# 2. Replace the placeholder in each file with that secret_id (locally, don't commit), then:
curl -s https://api.elevenlabs.io/v1/convai/tools \
  -H "xi-api-key: $ELEVENLABS_API_KEY" -H "content-type: application/json" \
  -d @agent/tools/get_user.json
# 3. Attach the returned tool ids to the agent (conversation_config.agent.prompt.tool_ids).
```

ElevenLabs sources:

- [WhatsApp: personalization and caller variables](https://elevenlabs.io/docs/eleven-agents/whatsapp)
- [Dynamic variables (system__caller_id)](https://elevenlabs.io/docs/eleven-agents/customization/personalization/dynamic-variables)
- [Server tools: headers and secrets](https://elevenlabs.io/docs/eleven-agents/customization/tools/server-tools)
- [Create tool API (`api_schema`, `dynamic_variable`, `secret_id`)](https://elevenlabs.io/docs/eleven-agents/api-reference/tools/create)
