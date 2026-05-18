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

export interface ImageAttachment {
  data: string;    // base64
  mimeType: string;
}

type Executor = (name: string, args: Record<string, unknown>) => Promise<string>;

export interface StreamCallbacks {
  onToken: (token: string) => void;
  onToolStart: (name: string, input: string) => void;
  onToolComplete: (name: string, output: string) => void;
}

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

async function chatGemini(modelId: string, systemPrompt: string, history: Content[], message: string, tools: ToolDecl[], execute: Executor, nativeSearch?: boolean, image?: ImageAttachment): Promise<ChatResult> {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
  const funcTool = tools.length ? [{
    functionDeclarations: tools.map((t) => ({
      name: t.name, description: t.description,
      parameters: {
        type: SchemaType.OBJECT,
        properties: Object.fromEntries(Object.entries(t.parameters.properties).map(([k, v]) => [k, toGeminiSchema(v)])),
        required: t.parameters.required,
      },
    })),
  }] : [];
  // Gemini doesn't allow googleSearch + functionDeclarations in the same request
  const geminiTools = funcTool.length > 0 ? funcTool : (nativeSearch ? [{ googleSearch: {} }] : []);

  const model = genAI.getGenerativeModel({ model: modelId, tools: geminiTools as never, systemInstruction: systemPrompt });
  const session = model.startChat({ history });
  const toolUses: ToolUse[] = [];
  const firstMsg: Part[] = image
    ? [{ text: message }, { inlineData: { mimeType: image.mimeType, data: image.data } }]
    : [{ text: message }];
  let result = await session.sendMessage(firstMsg);

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

async function chatClaude(modelId: string, systemPrompt: string, history: Content[], message: string, tools: ToolDecl[], execute: Executor, nativeSearch?: boolean, image?: ImageAttachment): Promise<ChatResult> {
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
  const allClaudeTools = nativeSearch
    ? [...claudeTools, { type: "web_search_20250305", name: "web_search" }]
    : claudeTools;

  const firstUserContent: Anthropic.MessageParam["content"] = image
    ? [{ type: "image", source: { type: "base64", media_type: image.mimeType as never, data: image.data } }, { type: "text", text: message }]
    : message;

  const msgs: Anthropic.MessageParam[] = [
    ...history
      .map((h) => ({ role: h.role === "model" ? "assistant" : "user" as "user" | "assistant", content: h.parts.map((p: { text?: string }) => p.text ?? "").join("") }))
      .filter((m) => m.content),
    { role: "user", content: firstUserContent },
  ];

  const reqOpts = nativeSearch ? { headers: { "anthropic-beta": "web-search-2025-03-05" } } : undefined;

  while (true) {
    const response = await client.messages.create({
      model: modelId, max_tokens: 8192, system: systemPrompt,
      tools: allClaudeTools.length ? (allClaudeTools as never) : undefined,
      messages: msgs,
    }, reqOpts);

    if (response.stop_reason === "tool_use") {
      const useBlocks = response.content.filter((b) => b.type === "tool_use" && (b as Anthropic.ToolUseBlock).name !== "web_search") as Anthropic.ToolUseBlock[];
      if (!useBlocks.length) {
        const text = response.content.filter((b) => b.type === "text").map((b) => (b as Anthropic.TextBlock).text).join("");
        return { reply: text, toolUses };
      }
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

async function chatOpenAI(modelId: string, systemPrompt: string, history: Content[], message: string, tools: ToolDecl[], execute: Executor, image?: ImageAttachment): Promise<ChatResult> {
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

  const firstUserContent: OpenAI.ChatCompletionUserMessageParam["content"] = image
    ? [{ type: "image_url", image_url: { url: `data:${image.mimeType};base64,${image.data}` } }, { type: "text", text: message }]
    : message;

  const msgs: OpenAI.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    ...history
      .map((h) => ({ role: h.role === "model" ? "assistant" : "user" as "user" | "assistant", content: h.parts.map((p: { text?: string }) => p.text ?? "").join("") }))
      .filter((m) => m.content),
    { role: "user", content: firstUserContent },
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
      for (const call of choice.message.tool_calls as OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall[]) {
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

// ── Streaming implementations ────────────────────────────────────────────────

async function chatGeminiStream(modelId: string, systemPrompt: string, history: Content[], message: string, tools: ToolDecl[], execute: Executor, cb: StreamCallbacks, nativeSearch?: boolean, image?: ImageAttachment): Promise<ToolUse[]> {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
  const funcTool = tools.length ? [{
    functionDeclarations: tools.map((t) => ({
      name: t.name, description: t.description,
      parameters: {
        type: SchemaType.OBJECT,
        properties: Object.fromEntries(Object.entries(t.parameters.properties).map(([k, v]) => [k, toGeminiSchema(v)])),
        required: t.parameters.required,
      },
    })),
  }] : [];
  const geminiTools = funcTool.length > 0 ? funcTool : (nativeSearch ? [{ googleSearch: {} }] : []);

  const model = genAI.getGenerativeModel({ model: modelId, tools: geminiTools as never, systemInstruction: systemPrompt });
  const session = model.startChat({ history });
  const toolUses: ToolUse[] = [];
  const firstMsg: Part[] = image
    ? [{ text: message }, { inlineData: { mimeType: image.mimeType, data: image.data } }]
    : [{ text: message }];

  const streamRound = async (msg: Part[] | Part[]): Promise<void> => {
    const result = await session.sendMessageStream(msg as any);
    for await (const chunk of result.stream) {
      const text = chunk.text();
      if (text) cb.onToken(text);
    }
    const response = await result.response;
    const calls = response.functionCalls();
    if (calls?.length) {
      const responses: Part[] = await Promise.all(calls.map(async (call) => {
        cb.onToolStart(call.name, JSON.stringify(call.args));
        const output = await execute(call.name, call.args as Record<string, unknown>);
        cb.onToolComplete(call.name, output);
        toolUses.push({ name: call.name, input: JSON.stringify(call.args), output: output.slice(0, 500) });
        return { functionResponse: { name: call.name, response: { result: output } } } as Part;
      }));
      await streamRound(responses);
    }
  };

  await streamRound(firstMsg);
  return toolUses;
}

async function chatClaudeStream(modelId: string, systemPrompt: string, history: Content[], message: string, tools: ToolDecl[], execute: Executor, cb: StreamCallbacks, nativeSearch?: boolean, image?: ImageAttachment): Promise<ToolUse[]> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const toolUses: ToolUse[] = [];

  const claudeTools = tools.map((t) => ({
    name: t.name, description: t.description,
    input_schema: {
      type: "object" as const,
      properties: Object.fromEntries(Object.entries(t.parameters.properties).map(([k, v]) => [k, { type: v.type, description: v.description, ...(v.items ? { items: v.items } : {}) }])),
      required: t.parameters.required,
    },
  }));
  const allClaudeTools = nativeSearch
    ? [...claudeTools, { type: "web_search_20250305", name: "web_search" }]
    : claudeTools;

  const firstUserContent: Anthropic.MessageParam["content"] = image
    ? [{ type: "image", source: { type: "base64", media_type: image.mimeType as never, data: image.data } }, { type: "text", text: message }]
    : message;

  const msgs: Anthropic.MessageParam[] = [
    ...history.map((h) => ({ role: h.role === "model" ? "assistant" : "user" as "user" | "assistant", content: h.parts.map((p: { text?: string }) => p.text ?? "").join("") })).filter((m) => m.content),
    { role: "user", content: firstUserContent },
  ];

  const reqOpts = nativeSearch ? { headers: { "anthropic-beta": "web-search-2025-03-05" } } : undefined;

  while (true) {
    const stream = client.messages.stream({
      model: modelId, max_tokens: 8192, system: systemPrompt,
      tools: allClaudeTools.length ? (allClaudeTools as never) : undefined,
      messages: msgs,
    }, reqOpts);

    stream.on("text", (text) => cb.onToken(text));
    const response = await stream.finalMessage();

    if (response.stop_reason === "tool_use") {
      const useBlocks = response.content.filter((b) => b.type === "tool_use" && (b as Anthropic.ToolUseBlock).name !== "web_search") as Anthropic.ToolUseBlock[];
      if (!useBlocks.length) break;
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const block of useBlocks) {
        cb.onToolStart(block.name, JSON.stringify(block.input));
        const output = await execute(block.name, block.input as Record<string, unknown>);
        cb.onToolComplete(block.name, output);
        toolUses.push({ name: block.name, input: JSON.stringify(block.input), output: output.slice(0, 500) });
        results.push({ type: "tool_result", tool_use_id: block.id, content: output });
      }
      msgs.push({ role: "assistant", content: response.content });
      msgs.push({ role: "user", content: results });
    } else {
      break;
    }
  }
  return toolUses;
}

async function chatOpenAIStream(modelId: string, systemPrompt: string, history: Content[], message: string, tools: ToolDecl[], execute: Executor, cb: StreamCallbacks, image?: ImageAttachment): Promise<ToolUse[]> {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const toolUses: ToolUse[] = [];

  const openAITools: OpenAI.ChatCompletionTool[] = tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: { type: "object", properties: Object.fromEntries(Object.entries(t.parameters.properties).map(([k, v]) => [k, { type: v.type, description: v.description, ...(v.items ? { items: v.items } : {}) }])), required: t.parameters.required } },
  }));

  const firstUserContent: OpenAI.ChatCompletionUserMessageParam["content"] = image
    ? [{ type: "image_url", image_url: { url: `data:${image.mimeType};base64,${image.data}` } }, { type: "text", text: message }]
    : message;

  const msgs: OpenAI.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    ...history.map((h) => ({ role: h.role === "model" ? "assistant" : "user" as "user" | "assistant", content: h.parts.map((p: { text?: string }) => p.text ?? "").join("") })).filter((m) => m.content),
    { role: "user", content: firstUserContent },
  ];

  while (true) {
    const stream = client.chat.completions.stream({ model: modelId, tools: openAITools.length ? openAITools : undefined, messages: msgs });
    for await (const chunk of stream) {
      const text = chunk.choices[0]?.delta?.content ?? "";
      if (text) cb.onToken(text);
    }
    const final = await stream.finalChatCompletion();
    const choice = final.choices[0];

    if (choice.finish_reason === "tool_calls" && choice.message.tool_calls) {
      msgs.push(choice.message);
      for (const call of choice.message.tool_calls as OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall[]) {
        const args = JSON.parse(call.function.arguments) as Record<string, unknown>;
        cb.onToolStart(call.function.name, call.function.arguments);
        const output = await execute(call.function.name, args);
        cb.onToolComplete(call.function.name, output);
        toolUses.push({ name: call.function.name, input: call.function.arguments, output: output.slice(0, 500) });
        msgs.push({ role: "tool", tool_call_id: call.id, content: output });
      }
    } else {
      break;
    }
  }
  return toolUses;
}

// ── Router ───────────────────────────────────────────────────────────────────

export async function chatWithModel(
  model: ModelConfig,
  systemPrompt: string,
  history: Content[],
  message: string,
  tools: ToolDecl[],
  execute: Executor,
  nativeSearch?: boolean,
  image?: ImageAttachment,
): Promise<ChatResult> {
  switch (model.provider) {
    case "gemini":  return chatGemini(model.modelId, systemPrompt, history, message, tools, execute, nativeSearch, image);
    case "claude":  return chatClaude(model.modelId, systemPrompt, history, message, tools, execute, nativeSearch, image);
    case "openai":  return chatOpenAI(model.modelId, systemPrompt, history, message, tools, execute, image);
    default: throw new Error(`Unknown provider: ${model.provider}`);
  }
}

export async function chatWithModelStream(
  model: ModelConfig,
  systemPrompt: string,
  history: Content[],
  message: string,
  tools: ToolDecl[],
  execute: Executor,
  callbacks: StreamCallbacks,
  nativeSearch?: boolean,
  image?: ImageAttachment,
): Promise<ToolUse[]> {
  switch (model.provider) {
    case "gemini": return chatGeminiStream(model.modelId, systemPrompt, history, message, tools, execute, callbacks, nativeSearch, image);
    case "claude": return chatClaudeStream(model.modelId, systemPrompt, history, message, tools, execute, callbacks, nativeSearch, image);
    case "openai": return chatOpenAIStream(model.modelId, systemPrompt, history, message, tools, execute, callbacks, image);
    default: throw new Error(`Unknown provider: ${model.provider}`);
  }
}
