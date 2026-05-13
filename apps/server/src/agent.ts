import {
  GoogleGenerativeAI,
  Content,
  Part,
  SchemaType,
  Tool,
} from "@google/generative-ai";
import { fetchUrl, httpRequest } from "./tools";

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
      {
        name: "http_request",
        description:
          "Make an HTTP request with a custom method and optional JSON body. Use for REST APIs that require POST, PUT, or PATCH with a JSON body.",
        parameters: {
          type: SchemaType.OBJECT,
          properties: {
            url: {
              type: SchemaType.STRING,
              description: "The full URL (must start with http:// or https://)",
            },
            method: {
              type: SchemaType.STRING,
              description: "HTTP method: GET, POST, PUT, PATCH, or DELETE",
            },
            body: {
              type: SchemaType.OBJECT,
              description: "JSON body to send with the request (optional)",
            },
          },
          required: ["url", "method"],
        },
      },
    ],
  },
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
    model: "gemini-2.5-flash",
    tools: TOOLS,
  });

  const session = model.startChat({ history });
  const toolUses: ToolUse[] = [];

  let result = await session.sendMessage(message);

  // Agentic loop: handle fetch_url calls until the model produces a final text response
  while (result.response.functionCalls()?.length) {
    const calls = result.response.functionCalls()!;

    const responses: Part[] = await Promise.all(
      calls.map(async (call) => {
        let output = "Tool not implemented";

        if (call.name === "fetch_url") {
          const url = (call.args as { url: string }).url;
          output = await fetchUrl(url);
          toolUses.push({ name: "fetch_url", input: url, output: output.slice(0, 500) });
        } else if (call.name === "http_request") {
          const { url, method, body } = call.args as { url: string; method: string; body?: unknown };
          output = await httpRequest(url, method, body);
          toolUses.push({ name: "http_request", input: `${method} ${url}`, output: output.slice(0, 500) });
        }

        return {
          functionResponse: { name: call.name, response: { result: output } },
        } as Part;
      })
    );

    result = await session.sendMessage(responses);
  }

  return { reply: result.response.text(), toolUses };
}
