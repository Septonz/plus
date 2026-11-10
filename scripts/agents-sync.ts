// pnpm agents:sync: create or update both ElevenLabs voice agents from this repo. Idempotent: run
// it after every change to agent/*/prompt.md or agent/*/tools/*.json.
//
//   Plus India    ELEVENLABS_AGENT_ID     agent/in/prompt.md + agent/tools/*.json (Tamil, English)
//   Plus Nigeria  ELEVENLABS_AGENT_ID_NG  agent/ng/prompt.md + agent/ng/tools/*.json (Nigerian English
//                                         voice, Pidgin by default, Yoruba when she speaks it)
//
// For each agent: system prompt and first message from prompt.md; authentication on (signed URLs
// only, which only voice-session can get); the plus_session dynamic variable; a 10-second silence
// timeout before the agent speaks again; every webhook tool in its folder, with the x-plus-secret
// header bound to the workspace secret PLUS_AGENT_SECRET (created from AGENT_SHARED_SECRET).
// Tools are matched by name among the ones already attached to that agent: updated in place,
// created when new, deleted when their file is gone.
//
// When the Nigeria agent is new, ELEVENLABS_AGENT_ID_NG is written to .env.local and to the
// Supabase secrets (dev project). Secrets are never printed.
//   --rotate-secret  overwrite PLUS_AGENT_SECRET with the current AGENT_SHARED_SECRET
//   --dry-run        print what would change, change nothing
import { execSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEV_PROJECT_REF, loadLocalEnv, ROOT } from "./lib/supabase-admin.ts";

loadLocalEnv();
const API = "https://api.elevenlabs.io";
const KEY = process.env.ELEVENLABS_API_KEY ?? "";
const DRY = process.argv.includes("--dry-run");
const ROTATE = process.argv.includes("--rotate-secret");
const SECRET_NAME = "PLUS_AGENT_SECRET";
const SECRET_PLACEHOLDER = "<ELEVENLABS_SECRET_ID_FOR_PLUS_AGENT_SECRET>";
const SILENCE_SECS = 10;
/** A warm, young, conversational Nigerian English voice from the ElevenLabs voice library. */
const NG_VOICE = { name: "Patience Blooms - Friendly", voiceId: "YHEouMKSiM7WzRONGZ4w" };

type Json = Record<string, unknown>;
type Tool = { id: string; tool_config: Json & { name: string } };

async function el<T = Json>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(API + path, {
    method,
    headers: { "xi-api-key": KEY, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 400)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

function firstMessage(prompt: string): string {
  const m = prompt.match(/^First message: "(.+)"\s*$/m);
  if (!m) throw new Error("prompt.md has no `First message: \"…\"` line");
  return m[1];
}

/** The workspace secret the tools send as x-plus-secret. Created once; never read back. */
async function secretId(): Promise<string> {
  const value = process.env.AGENT_SHARED_SECRET;
  const { secrets } = await el<{ secrets: { secret_id: string; name: string }[] }>("GET", "/v1/convai/secrets");
  const found = secrets.find((s) => s.name === SECRET_NAME);
  if (found && !ROTATE) return found.secret_id;
  if (!value) throw new Error("AGENT_SHARED_SECRET is not in .env.local");
  if (DRY) return found?.secret_id ?? "(new secret)";
  if (found) {
    await el("PATCH", `/v1/convai/secrets/${found.secret_id}`, { type: "update", name: SECRET_NAME, value });
    console.log(`  secret ${SECRET_NAME} rotated`);
    return found.secret_id;
  }
  const made = await el<{ secret_id: string }>("POST", "/v1/convai/secrets", { type: "new", name: SECRET_NAME, value });
  console.log(`  secret ${SECRET_NAME} created`);
  return made.secret_id;
}

/** The Nigerian voice in this workspace's library (added from the shared library once). */
async function ngVoiceId(): Promise<string> {
  const { voices } = await el<{ voices: { voice_id: string; name: string; sharing?: { original_voice_id?: string } }[] }>(
    "GET", "/v1/voices",
  );
  const have = voices.find((v) => v.voice_id === NG_VOICE.voiceId || v.sharing?.original_voice_id === NG_VOICE.voiceId);
  if (have) return have.voice_id;
  const shared = await el<{ voices: { voice_id: string; public_owner_id: string }[] }>(
    "GET", `/v1/shared-voices?page_size=20&language=en&accent=nigerian&search=${encodeURIComponent("Patience")}`,
  );
  const v = shared.voices.find((x) => x.voice_id === NG_VOICE.voiceId);
  if (!v) throw new Error(`shared voice ${NG_VOICE.name} not found`);
  if (DRY) return v.voice_id;
  const added = await el<{ voice_id: string }>("POST", `/v1/voices/add/${v.public_owner_id}/${v.voice_id}`, { new_name: "Plus Nigeria" });
  console.log("  voice added to the library");
  return added.voice_id;
}

function toolFiles(dir: string, sid: string): Json[] {
  return readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => {
    const raw = readFileSync(join(dir, f), "utf8").replaceAll(SECRET_PLACEHOLDER, sid);
    return JSON.parse(raw) as Json;
  });
}

/** Update the agent's tools in place by name, create new ones, delete ones whose file is gone. */
async function syncTools(attached: string[], files: Json[]): Promise<string[]> {
  const current: Tool[] = [];
  for (const id of attached) {
    try {
      current.push(await el<Tool>("GET", `/v1/convai/tools/${id}`));
    } catch { /* deleted elsewhere: forget it */ }
  }
  const byName = new Map(current.map((t) => [t.tool_config.name, t]));
  const ids: string[] = [];
  let created = 0, updated = 0;
  for (const body of files) {
    const name = (body.tool_config as { name: string }).name;
    const have = byName.get(name);
    byName.delete(name);
    if (DRY) { ids.push(have?.id ?? `(new ${name})`); have ? updated++ : created++; continue; }
    if (have) {
      await el("PATCH", `/v1/convai/tools/${have.id}`, body);
      ids.push(have.id);
      updated++;
    } else {
      const t = await el<{ id: string }>("POST", "/v1/convai/tools", body);
      ids.push(t.id);
      created++;
    }
  }
  for (const stale of byName.values()) {
    if (!DRY) await el("DELETE", `/v1/convai/tools/${stale.id}`).catch(() => undefined);
    console.log(`  tool ${stale.tool_config.name} removed (no file)`);
  }
  console.log(`  tools: ${files.length} (${created} new, ${updated} updated)`);
  return ids;
}

type Spec = {
  label: string;
  name: string;
  envVar: "ELEVENLABS_AGENT_ID" | "ELEVENLABS_AGENT_ID_NG";
  promptFile: string;
  toolsDir: string;
  language: string;
  voiceId?: string;
  /** Other languages she may speak; the agent switches with the language_detection tool. */
  presets: Record<string, string>;
};

async function syncAgent(spec: Spec, sid: string): Promise<string> {
  console.log(`${spec.label}`);
  const prompt = readFileSync(join(ROOT, spec.promptFile), "utf8");
  let id = process.env[spec.envVar] ?? "";
  if (!id) {
    const { agents } = await el<{ agents: { agent_id: string; name: string }[] }>("GET", `/v1/convai/agents?page_size=100&search=${encodeURIComponent(spec.name)}`);
    id = agents.find((a) => a.name === spec.name)?.agent_id ?? "";
    if (id) console.log("  found by name");
  }
  if (!id) {
    if (DRY) { console.log("  would create the agent"); return "(new)"; }
    id = (await el<{ agent_id: string }>("POST", "/v1/convai/agents/create", { name: spec.name, conversation_config: {} })).agent_id;
    console.log("  agent created");
  }
  const agent = await el<{ conversation_config: { agent: { prompt: { tool_ids?: string[] } } } }>("GET", `/v1/convai/agents/${id}`);
  const toolIds = await syncTools(agent.conversation_config.agent.prompt.tool_ids ?? [], toolFiles(join(ROOT, spec.toolsDir), sid));
  const patch = {
    name: spec.name,
    conversation_config: {
      agent: {
        first_message: firstMessage(prompt),
        language: spec.language,
        dynamic_variables: { dynamic_variable_placeholders: { plus_session: "none" } },
        prompt: {
          prompt,
          tool_ids: toolIds,
          built_in_tools: {
            language_detection: Object.keys(spec.presets).length
              ? { type: "system", name: "language_detection", description: "", params: { system_tool_type: "language_detection" } }
              : null,
          },
        },
      },
      turn: { turn_timeout: SILENCE_SECS },
      ...(spec.voiceId ? { tts: { voice_id: spec.voiceId, model_id: "eleven_v4_turbo" } } : {}),
      language_presets: Object.fromEntries(
        Object.entries(spec.presets).map(([lang, first]) => [lang, { overrides: { agent: { language: lang, first_message: first } } }]),
      ),
    },
    platform_settings: { auth: { enable_auth: true } },
  };
  if (DRY) console.log("  would update: prompt, first message, tools, plus_session, auth on, silence 10 s");
  else {
    await el("PATCH", `/v1/convai/agents/${id}`, patch);
    console.log(`  updated: prompt, first message, ${toolIds.length} tools, plus_session, auth on, silence ${SILENCE_SECS} s`);
  }
  return id;
}

function saveEnv(name: string, value: string) {
  const file = join(ROOT, ".env.local");
  const s = readFileSync(file, "utf8");
  const line = `${name}=${value}`;
  const next = new RegExp(`^${name}=.*$`, "m").test(s) ? s.replace(new RegExp(`^${name}=.*$`, "m"), line) : `${s.replace(/\s*$/, "")}\n${line}\n`;
  if (next !== s) writeFileSync(file, next);
}

async function main() {
  if (!KEY) throw new Error("ELEVENLABS_API_KEY is not in .env.local");
  const sid = await secretId();
  const ngVoice = await ngVoiceId();
  const india = await syncAgent({
    label: "Plus India", name: "Plus", envVar: "ELEVENLABS_AGENT_ID", promptFile: "agent/in/prompt.md", toolsDir: "agent/tools",
    language: "ta", presets: { en: "Hello! I'm Plus. How can I help you?" },
  }, sid);
  const hadNg = Boolean(process.env.ELEVENLABS_AGENT_ID_NG);
  const ng = await syncAgent({
    label: "Plus Nigeria", name: "Plus Nigeria", envVar: "ELEVENLABS_AGENT_ID_NG", promptFile: "agent/ng/prompt.md", toolsDir: "agent/ng/tools",
    language: "en", voiceId: ngVoice, presets: { yo: "Ẹ n lẹ́ o! Plus ni mi. Kí ni mo lè ṣe fún yín lónìí?" },
  }, sid);
  if (DRY) return;
  if (!process.env.ELEVENLABS_AGENT_ID) saveEnv("ELEVENLABS_AGENT_ID", india);
  if (!hadNg) {
    saveEnv("ELEVENLABS_AGENT_ID_NG", ng);
    // On Windows npx is a .cmd and needs a shell; the agent id is [A-Za-z0-9_].
    if (!/^[A-Za-z0-9_]+$/.test(ng)) throw new Error("unexpected agent id");
    execSync(`npx supabase secrets set ELEVENLABS_AGENT_ID_NG=${ng} --project-ref ${DEV_PROJECT_REF} --yes`, { stdio: "ignore" });
    console.log("ELEVENLABS_AGENT_ID_NG saved to .env.local and the Supabase secrets");
  }
  console.log("done");
}

main().catch((err) => {
  console.error(`agents:sync failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
