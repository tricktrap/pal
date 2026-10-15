import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { envApiKeyAuth, type Api, type ApiKeyAuth, type CreateProviderOptions, type ProviderAuth, type Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import { createModels, createProvider } from "@earendil-works/pi-ai/models"
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";

const DEFAULT_LM_STUDIO_URL = "http://127.0.0.1:1234";
const PROVIDER_PREFIX = "lmstudio";

interface LMStudioLoadedInstance {
  id: string;
  config: {
    context_length: number;
    eval_batch_size: number;
    flash_attention: boolean;
    num_experts: number;
    offload_kv_cache_to_gpu: boolean;
  }
}

interface LMStudioModel {
  type: string;
  publisher: string;
  key: string;
  display_name: string;
  architecture?: string;
  quantization?: { name: string; bits_per_weight: number };
  size_bytes: number;
  params_string: string | null;
  loaded_instances: LMStudioLoadedInstance[];
  max_context_length: number;
  format: string;
  capabilities?: {
    vision?: boolean;
    trained_for_tool_use?: boolean;
    reasoning?: { allowed_options: string[]; default: string };
  };
  description?: string | null;
  variants: string[];
  selected_variant: string;
}

interface LMStudioResponse {
  models: LMStudioModel[];
}

function mapModel(model: LMStudioModel, providerName: string, url: string): Model<"openai-completions"> {
  return {
    id: model.key,
    name: model.display_name,
    reasoning: model.capabilities?.reasoning !== undefined,
    provider: providerName,
    input: model.capabilities?.vision ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: model.loaded_instances[0]?.config.context_length ?? model.max_context_length,
    maxTokens: model.max_context_length,
    api: "openai-completions",
    baseUrl: `${url}/v1/`
  }
}

async function fetchModels(url: string, token?: string): Promise<Model<"openai-completions">[]> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5_000);

  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `bearer ${token}`;

  try {
    const response = await fetch(`${url}/api/v1/models`, { signal: controller.signal, headers });
    if (!response.ok) throw new Error(`LM Studio HTTP status: ${response.status}`);

    const data: LMStudioResponse = await response.json();
    return (data.models || [])
      .filter(m => m.type == "llm").map(m => mapModel(m, PROVIDER_PREFIX, url));
  } catch (error: any) {
    if (error.name === 'AbortError') throw new Error("LM Studio request timed out");
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

const provider = createProvider({
  id: PROVIDER_PREFIX,
  auth: {
    apiKey: { name: "LM Studio", resolve: async () => ({ auth: {} }) }
  },
  models: await fetchModels(DEFAULT_LM_STUDIO_URL, "bleh"),
  api: openAICompletionsApi(),
});


const context = BACKGROUND_CONTEXT; // every call takes a context for cancellation
const models = createModels();

models.setProvider(provider);

const registry = createRegistry();
registry.install(CodingTools); // read, write, edit, bash

const env = ({ cwd }: { cwd?: string }) =>
  new NodeExecutionEnv({ cwd: cwd ?? process.cwd() });

const harness = await Harness.open(
  await openNodeSqliteStorage("./agent.sqlite"),
  { models, registry, env },
  context,
);

for (const model of models.getAllModels()) {
  console.log(`Model: ${model.id}`);
}


// The root conversation: created on first use, and the same one after every
// restart.
const root = await harness.root(context, {
  agent: {
    model: { provider: PROVIDER_PREFIX, modelId: "meta/muse-glimmer" },
    cwd: import.meta.dirname,
  }
});

const job = {
  type: "input",
  content: "Determine the language this project is written in",
  requestId: "job-1"
} as const;

await root.submit(job, context);
