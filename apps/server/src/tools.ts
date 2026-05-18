export async function fetchUrl(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "boost-agent/1.0" },
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    return text.length > 10_000 ? text.slice(0, 10_000) + "\n[truncated]" : text;
  } catch (err) {
    return `Error fetching URL: ${(err as Error).message}`;
  }
}

export async function readWebpage(url: string): Promise<string> {
  try {
    const jinaUrl = `https://r.jina.ai/${url}`;
    const headers: Record<string, string> = { Accept: "text/plain", "X-Return-Format": "markdown" };
    if (process.env.JINA_API_KEY) headers["Authorization"] = `Bearer ${process.env.JINA_API_KEY}`;
    const res = await fetch(jinaUrl, { headers, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`Jina Reader returned ${res.status}`);
    const text = await res.text();
    return text.length > 15_000 ? text.slice(0, 15_000) + "\n[truncated]" : text;
  } catch (err) {
    return `Error reading webpage: ${(err as Error).message}`;
  }
}

export async function httpRequest(url: string, method: string, body?: unknown): Promise<string> {
  try {
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json", "User-Agent": "boost-agent/1.0" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    return text.length > 10_000 ? text.slice(0, 10_000) + "\n[truncated]" : text;
  } catch (err) {
    return `Error making request: ${(err as Error).message}`;
  }
}
