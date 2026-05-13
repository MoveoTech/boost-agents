import {
  GoogleGenerativeAI,
  Content,
  Part,
  SchemaType,
  Tool,
} from "@google/generative-ai";
import { fetchUrl } from "./tools";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

const TOOLS: Tool[] = [
  {
    functionDeclarations: [
      {
        name: "fetch_url",
        description:
          "Fetch the content of a URL and return it as text. Use for reading web pages, documentation, or calling REST APIs.",
        parameters: {
          type: SchemaType.OBJECT,
          properties: {
            url: {
              type: SchemaType.STRING,
              description: "The full URL to fetch (must start with http:// or https://)",
            },
          },
          required: ["url"],
        },
      },
    ],
  },
  // googleSearch and codeExecution are handled internally by Gemini
  { codeExecution: {} },
  // @ts-ignore — googleSearch is supported by Gemini 2.0 but not yet in SDK types
  { googleSearch: {} },
];

export interface ToolUse {
  name: string;
  input?: string;
  output?: string;
}

export interface ChatResult {
  reply: string;
  toolUses: ToolUse[];
}

export async function chat(message: string, history: Content[]): Promise<ChatResult> {
  const model = genAI.getGenerativeModel({
    model: "gemini-2.0-flash",
    tools: TOOLS,
  });

  const session = model.startChat({ history });
  const toolUses: ToolUse[] = [];

  let result = await session.sendMessage(message);

  // Agentic loop: handle fetch_url function calls until the model produces a final response
  while (result.response.functionCalls()?.length) {
    const calls = result.response.functionCalls()!;

    const responses: Part[] = await Promise.all(
      calls.map(async (call) => {
        let output = "Tool not implemented";

        if (call.name === "fetch_url") {
          const url = (call.args as { url: string }).url;
          output = await fetchUrl(url);
          toolUses.push({ name: "fetch_url", input: url, output: output.slice(0, 500) });
        }

        return {
          functionResponse: { name: call.name, response: { result: output } },
        } as Part;
      })
    );

    result = await session.sendMessage(responses);
  }

  // Extract code execution tool uses from response parts
  const parts = result.response.candidates?.[0]?.content?.parts ?? [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] as Part & {
      executableCode?: { code: string };
      codeExecutionResult?: { output: string };
    };
    if (part.executableCode) {
      toolUses.push({
        name: "code_execution",
        input: part.executableCode.code,
        output: (parts[i + 1] as typeof part)?.codeExecutionResult?.output,
      });
    }
  }

  // Extract Google Search queries from grounding metadata
  const groundingMeta = result.response.candidates?.[0]?.groundingMetadata as
    | { webSearchQueries?: string[] }
    | undefined;
  if (groundingMeta?.webSearchQueries?.length) {
    toolUses.push({
      name: "google_search",
      input: groundingMeta.webSearchQueries.join("; "),
    });
  }

  return { reply: result.response.text(), toolUses };
}
