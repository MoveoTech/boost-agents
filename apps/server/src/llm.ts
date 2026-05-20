import { GoogleGenerativeAI, type Content, SchemaType, type Part } from "@google/generative-ai";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { ToolUse, ChatResult } from "./agent";

export interface ModelConfig {
  provider: "gemini" | "claude" | "openai";
  modelId: string;
  noThinking?: boolean;
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

// ── Loop guard helpers ───────────────────────────────────────────────────────

const MAX_TOOL_ROUNDS = 10;

function isToolError(output: string): boolean {
  const h = output.slice(0, 400).toLowerCase();
  return h.startsWith("error") || h.includes("cannot query") || h.includes("did you mean")
    || h.includes("unknown field") || h.includes("failed:") || h.includes("not found")
    || h.includes("unauthorized") || h.includes("bad request");
}

function guidanceNote(round: number, consecutiveErrors: number): string {
  if (consecutiveErrors >= 3) {
    return "\n\n[System note: Multiple consecutive tool errors. Stop retrying the same way. Either try a completely different approach with different parameters, use a different tool, or ask the user for the specific information you need to proceed.]";
  }
  if (round >= MAX_TOOL_ROUNDS - 1) {
    return `\n\n[System note: You have used ${round} tool call rounds. Please wrap up now — summarize what you found or clearly tell the user what specific information you still need to complete the task.]`;
  }
  return "";
}

const FINAL_MSG = "[System note: Tool call limit reached. Based on everything gathered so far, provide your best response now. If you genuinely need more information from the user to proceed, clearly explain what you need — do not make any more tool calls.]";

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

async function chatGemini(modelId: string, systemPrompt: string, history: Content[], message: string, tools: ToolDecl[], execute: Executor, nativeSearch?: boolean, image?: ImageAttachment, noThinking?: boolean): Promise<ChatResult> {
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
  const generationConfig = noThinking ? { thinkingConfig: { thinkingBudget: 0 } } as never : undefined;

  const model = genAI.getGenerativeModel({ model: modelId, tools: geminiTools as never, systemInstruction: systemPrompt, generationConfig });
  const session = model.startChat({ history });
  const toolUses: ToolUse[] = [];
  const firstMsg: Part[] = image
    ? [{ text: message }, { inlineData: { mimeType: image.mimeType, data: image.data } }]
    : [{ text: message }];
  let result = await session.sendMessage(firstMsg);

  let round = 0;
  let consecutiveErrors = 0;
  while (result.response.functionCalls()?.length) {
    if (round >= MAX_TOOL_ROUNDS) {
      result = await session.sendMessage([{ text: FINAL_MSG }]);
      break;
    }
    round++;
    const calls = result.response.functionCalls()!;
    const parts: Part[] = await Promise.all(calls.map(async (call) => {
      const output = await execute(call.name, call.args as Record<string, unknown>);
      if (isToolError(output)) consecutiveErrors++; else consecutiveErrors = 0;
      toolUses.push({ name: call.name, input: JSON.stringify(call.args), output: output.slice(0, 500) });
      return { functionResponse: { name: call.name, response: { result: output } } } as Part;
    }));
    const note = guidanceNote(round, consecutiveErrors);
    if (note) { parts.push({ text: note } as any); consecutiveErrors = 0; }
    result = await session.sendMessage(parts);
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

  let round = 0;
  let consecutiveErrors = 0;
  while (true) {
    if (round >= MAX_TOOL_ROUNDS) {
      msgs.push({ role: "user", content: FINAL_MSG });
    }
    const response = await client.messages.create({
      model: modelId, max_tokens: 8192, system: systemPrompt,
      tools: round < MAX_TOOL_ROUNDS && allClaudeTools.length ? (allClaudeTools as never) : undefined,
      messages: msgs,
    }, reqOpts);

    if (response.stop_reason === "tool_use" && round < MAX_TOOL_ROUNDS) {
      const useBlocks = response.content.filter((b) => b.type === "tool_use" && (b as Anthropic.ToolUseBlock).name !== "web_search") as Anthropic.ToolUseBlock[];
      if (!useBlocks.length) {
        const text = response.content.filter((b) => b.type === "text").map((b) => (b as Anthropic.TextBlock).text).join("");
        return { reply: text, toolUses };
      }
      round++;
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const block of useBlocks) {
        const output = await execute(block.name, block.input as Record<string, unknown>);
        if (isToolError(output)) consecutiveErrors++; else consecutiveErrors = 0;
        toolUses.push({ name: block.name, input: JSON.stringify(block.input), output: output.slice(0, 500) });
        results.push({ type: "tool_result", tool_use_id: block.id, content: output });
      }
      msgs.push({ role: "assistant", content: response.content });
      const note = guidanceNote(round, consecutiveErrors);
      if (note) { consecutiveErrors = 0; }
      const userContent: Anthropic.MessageParam["content"] = note
        ? [...results, { type: "text", text: note }]
        : results;
      msgs.push({ role: "user", content: userContent });
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

  let round = 0;
  let consecutiveErrors = 0;
  while (true) {
    const response = await client.chat.completions.create({
      model: modelId,
      tools: round < MAX_TOOL_ROUNDS && openAITools.length ? openAITools : undefined,
      messages: msgs,
    });

    const choice = response.choices[0];
    if (choice.finish_reason === "tool_calls" && choice.message.tool_calls && round < MAX_TOOL_ROUNDS) {
      round++;
      msgs.push(choice.message);
      for (const call of choice.message.tool_calls as OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall[]) {
        const args = JSON.parse(call.function.arguments) as Record<string, unknown>;
        const output = await execute(call.function.name, args);
        if (isToolError(output)) consecutiveErrors++; else consecutiveErrors = 0;
        toolUses.push({ name: call.function.name, input: call.function.arguments, output: output.slice(0, 500) });
        msgs.push({ role: "tool", tool_call_id: call.id, content: output });
      }
      const note = guidanceNote(round, consecutiveErrors);
      if (note) { msgs.push({ role: "user", content: note }); consecutiveErrors = 0; }
      if (round >= MAX_TOOL_ROUNDS) msgs.push({ role: "user", content: FINAL_MSG });
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

  let round = 0;
  let consecutiveErrors = 0;
  let currentMsg: Part[] = firstMsg;

  while (true) {
    if (round >= MAX_TOOL_ROUNDS) {
      const r = await session.sendMessageStream([{ text: FINAL_MSG }] as any);
      for await (const chunk of r.stream) { const t = chunk.text(); if (t) cb.onToken(t); }
      break;
    }
    const result = await session.sendMessageStream(currentMsg as any);
    for await (const chunk of result.stream) { const t = chunk.text(); if (t) cb.onToken(t); }
    const response = await result.response;
    const calls = response.functionCalls();
    if (!calls?.length) break;
    round++;
    const parts: Part[] = await Promise.all(calls.map(async (call) => {
      cb.onToolStart(call.name, JSON.stringify(call.args));
      const output = await execute(call.name, call.args as Record<string, unknown>);
      cb.onToolComplete(call.name, output);
      if (isToolError(output)) consecutiveErrors++; else consecutiveErrors = 0;
      toolUses.push({ name: call.name, input: JSON.stringify(call.args), output: output.slice(0, 500) });
      return { functionResponse: { name: call.name, response: { result: output } } } as Part;
    }));
    const note = guidanceNote(round, consecutiveErrors);
    if (note) { parts.push({ text: note } as any); consecutiveErrors = 0; }
    currentMsg = parts;
  }
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

  let round = 0;
  let consecutiveErrors = 0;
  while (true) {
    if (round >= MAX_TOOL_ROUNDS) { msgs.push({ role: "user", content: FINAL_MSG }); }
    const stream = client.messages.stream({
      model: modelId, max_tokens: 8192, system: systemPrompt,
      tools: round < MAX_TOOL_ROUNDS && allClaudeTools.length ? (allClaudeTools as never) : undefined,
      messages: msgs,
    }, reqOpts);

    stream.on("text", (text) => cb.onToken(text));
    const response = await stream.finalMessage();

    if (response.stop_reason === "tool_use" && round < MAX_TOOL_ROUNDS) {
      const useBlocks = response.content.filter((b) => b.type === "tool_use" && (b as Anthropic.ToolUseBlock).name !== "web_search") as Anthropic.ToolUseBlock[];
      if (!useBlocks.length) break;
      round++;
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const block of useBlocks) {
        cb.onToolStart(block.name, JSON.stringify(block.input));
        const output = await execute(block.name, block.input as Record<string, unknown>);
        cb.onToolComplete(block.name, output);
        if (isToolError(output)) consecutiveErrors++; else consecutiveErrors = 0;
        toolUses.push({ name: block.name, input: JSON.stringify(block.input), output: output.slice(0, 500) });
        results.push({ type: "tool_result", tool_use_id: block.id, content: output });
      }
      msgs.push({ role: "assistant", content: response.content });
      const note = guidanceNote(round, consecutiveErrors);
      if (note) { consecutiveErrors = 0; }
      const userContent: Anthropic.MessageParam["content"] = note
        ? [...results, { type: "text", text: note }]
        : results;
      msgs.push({ role: "user", content: userContent });
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

  let round = 0;
  let consecutiveErrors = 0;
  while (true) {
    const stream = client.chat.completions.stream({
      model: modelId,
      tools: round < MAX_TOOL_ROUNDS && openAITools.length ? openAITools : undefined,
      messages: msgs,
    });
    for await (const chunk of stream) {
      const text = chunk.choices[0]?.delta?.content ?? "";
      if (text) cb.onToken(text);
    }
    const final = await stream.finalChatCompletion();
    const choice = final.choices[0];

    if (choice.finish_reason === "tool_calls" && choice.message.tool_calls && round < MAX_TOOL_ROUNDS) {
      round++;
      msgs.push(choice.message);
      for (const call of choice.message.tool_calls as OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall[]) {
        const args = JSON.parse(call.function.arguments) as Record<string, unknown>;
        cb.onToolStart(call.function.name, call.function.arguments);
        const output = await execute(call.function.name, args);
        cb.onToolComplete(call.function.name, output);
        if (isToolError(output)) consecutiveErrors++; else consecutiveErrors = 0;
        toolUses.push({ name: call.function.name, input: call.function.arguments, output: output.slice(0, 500) });
        msgs.push({ role: "tool", tool_call_id: call.id, content: output });
      }
      const note = guidanceNote(round, consecutiveErrors);
      if (note) { msgs.push({ role: "user", content: note }); consecutiveErrors = 0; }
      if (round >= MAX_TOOL_ROUNDS) msgs.push({ role: "user", content: FINAL_MSG });
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
    case "gemini":  return chatGemini(model.modelId, systemPrompt, history, message, tools, execute, nativeSearch, image, model.noThinking);
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
