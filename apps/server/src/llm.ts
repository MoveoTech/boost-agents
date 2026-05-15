import { GoogleGenerativeAI, type Content, SchemaType, type Part } from "@google/generative-ai";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { ToolUse, ChatResult } from "./agent";

export interface ModelConfig {
  provider: "gemini" | "claude" | "openai";
  modelId: string;
}

export interface ToolParam {
  type: "string" | "number" | "boolean" | "array" | "object";
  description: string;
  items?: { type: string };
}

export interface ToolDecl {
  name: string;
  description: string;
  parameters: {
    properties: Record<string, ToolParam>;
    required: string[];
  };
}

type Executor = (name: string, args: Record<string, unknown>) => Promise<string>;

// ── Gemini ──────────────────────────────────────────────────────────────────

function toGeminiSchema(p: ToolParam): Record<string, unknown> {
  const typeMap: Record<string, SchemaType> = {
    string: SchemaType.STRING, number: SchemaType.NUMBER,
    boolean: SchemaType.BOOLEAN, array: SchemaType.ARRAY, object: SchemaType.OBJECT,
  };
  return {
    type: typeMap[p.type] ?? SchemaType.STRING,
    description: p.description,
    ...(p.items ? { items: { type: typeMap[p.items.type] ?? SchemaType.STRING } } : {}),
  };
}

async function chatGemini(modelId: string, systemPrompt: string, history: Content[], message: string, tools: ToolDecl[], execute: Executor): Promise<ChatResult> {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
  const geminiTools = tools.length ? [{
    functionDeclarations: tools.map((t) => ({
      name: t.name, description: t.description,
      parameters: {
        type: SchemaType.OBJECT,
        properties: Object.fromEntries(Object.entries(t.parameters.properties).map(([k, v]) => [k, toGeminiSchema(v)])),
        required: t.parameters.required,
      },
    })),
  }] : [];

  const model = genAI.getGenerativeModel({ model: modelId, tools: geminiTools as never, systemInstruction: systemPrompt });
  const session = model.startChat({ history });
  const toolUses: ToolUse[] = [];
  let result = await session.sendMessage(message);

  while (result.response.functionCalls()?.length) {
    const calls = result.response.functionCalls()!;
    const responses: Part[] = await Promise.all(calls.map(async (call) => {
      const output = await execute(call.name, call.args as Record<string, unknown>);
      toolUses.push({ name: call.name, input: JSON.stringify(call.args), output: output.slice(0, 500) });
      return { functionResponse: { name: call.name, response: { result: output } } } as Part;
    }));
    result = await session.sendMessage(responses);
  }
  return { reply: result.response.text(), toolUses };
}

// ── Claude ──────────────────────────────────────────────────────────────────

async function chatClaude(modelId: string, systemPrompt: string, history: Content[], message: string, tools: ToolDecl[], execute: Executor): Promise<ChatResult> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const toolUses: ToolUse[] = [];

  const claudeTools = tools.map((t) => ({
    name: t.name, description: t.description,
    input_schema: {
      type: "object" as const,
      properties: Object.fromEntries(Object.entries(t.parameters.properties).map(([k, v]) => [k, {
        type: v.type, description: v.description, ...(v.items ? { items: v.items } : {}),
      }])),
      required: t.parameters.required,
    },
  }));

  const msgs: Anthropic.MessageParam[] = [
    ...history
      .map((h) => ({ role: h.role === "model" ? "assistant" : "user" as "user" | "assistant", content: h.parts.map((p: { text?: string }) => p.text ?? "").join("") }))
      .filter((m) => m.content),
    { role: "user", content: message },
  ];

  while (true) {
    const response = await client.messages.create({
      model: modelId, max_tokens: 8192, system: systemPrompt,
      tools: claudeTools.length ? claudeTools : undefined,
      messages: msgs,
    });

    if (response.stop_reason === "tool_use") {
      const useBlocks = response.content.filter((b) => b.type === "tool_use") as Anthropic.ToolUseBlock[];
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const block of useBlocks) {
        const output = await execute(block.name, block.input as Record<string, unknown>);
        toolUses.push({ name: block.name, input: JSON.stringify(block.input), output: output.slice(0, 500) });
        results.push({ type: "tool_result", tool_use_id: block.id, content: output });
      }
      msgs.push({ role: "assistant", content: response.content });
      msgs.push({ role: "user", content: results });
    } else {
      const text = response.content.filter((b) => b.type === "text").map((b) => (b as Anthropic.TextBlock).text).join("");
      return { reply: text, toolUses };
    }
  }
}

// ── OpenAI ───────────────────────────────────────────────────────────────────

async function chatOpenAI(modelId: string, systemPrompt: string, history: Content[], message: string, tools: ToolDecl[], execute: Executor): Promise<ChatResult> {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const toolUses: ToolUse[] = [];

  const openAITools: OpenAI.ChatCompletionTool[] = tools.map((t) => ({
    type: "function",
    function: {
      name: t.name, description: t.description,
      parameters: {
        type: "object",
        properties: Object.fromEntries(Object.entries(t.parameters.properties).map(([k, v]) => [k, {
          type: v.type, description: v.description, ...(v.items ? { items: v.items } : {}),
        }])),
        required: t.parameters.required,
      },
    },
  }));

  const msgs: OpenAI.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    ...history
      .map((h) => ({ role: h.role === "model" ? "assistant" : "user" as "user" | "assistant", content: h.parts.map((p: { text?: string }) => p.text ?? "").join("") }))
      .filter((m) => m.content),
    { role: "user", content: message },
  ];

  while (true) {
    const response = await client.chat.completions.create({
      model: modelId,
      tools: openAITools.length ? openAITools : undefined,
      messages: msgs,
    });

    const choice = response.choices[0];
    if (choice.finish_reason === "tool_calls" && choice.message.tool_calls) {
      msgs.push(choice.message);
      for (const call of choice.message.tool_calls) {
        const args = JSON.parse(call.function.arguments) as Record<string, unknown>;
        const output = await execute(call.function.name, args);
        toolUses.push({ name: call.function.name, input: call.function.arguments, output: output.slice(0, 500) });
        msgs.push({ role: "tool", tool_call_id: call.id, content: output });
      }
    } else {
      return { reply: choice.message.content ?? "", toolUses };
    }
  }
}

// ── Router ───────────────────────────────────────────────────────────────────

export async function chatWithModel(
  model: ModelConfig,
  systemPrompt: string,
  history: Content[],
  message: string,
  tools: ToolDecl[],
  execute: Executor
): Promise<ChatResult> {
  switch (model.provider) {
    case "gemini":  return chatGemini(model.modelId, systemPrompt, history, message, tools, execute);
    case "claude":  return chatClaude(model.modelId, systemPrompt, history, message, tools, execute);
    case "openai":  return chatOpenAI(model.modelId, systemPrompt, history, message, tools, execute);
    default: throw new Error(`Unknown provider: ${model.provider}`);
  }
}
