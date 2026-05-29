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

export async function searchImage(query: string): Promise<string> {
  try {
    // Step 1: find the best matching Wikipedia article
    const searchRes = await fetch(
      `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=3&origin=*`,
      { headers: { "User-Agent": "boost-agent/1.0" }, signal: AbortSignal.timeout(10_000) }
    );
    const searchData = await searchRes.json() as { query?: { search?: Array<{ title: string }> } };
    const titles = searchData.query?.search?.map((r) => r.title) ?? [];
    if (!titles.length) return `No Wikipedia article found for "${query}". Try searching the web instead.`;

    // Step 2: get thumbnail from the first article that has one
    for (const title of titles) {
      const imgRes = await fetch(
        `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(title)}&prop=pageimages&format=json&pithumbsize=800&origin=*`,
        { headers: { "User-Agent": "boost-agent/1.0" }, signal: AbortSignal.timeout(10_000) }
      );
      const imgData = await imgRes.json() as { query?: { pages?: Record<string, { thumbnail?: { source?: string } }> } };
      const imageUrl = Object.values(imgData.query?.pages ?? {})[0]?.thumbnail?.source;
      if (imageUrl) return `![${title}](${imageUrl})`;
    }
    return `Wikipedia has articles about "${query}" but none include an image. Try a more specific term.`;
  } catch (err) {
    return `Image search failed: ${(err as Error).message}`;
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

export async function httpRequest(url: string, method: string, body?: unknown, extraHeaders?: Record<string, string>): Promise<string> {
  try {
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json", "User-Agent": "boost-agent/1.0", ...extraHeaders },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    return text.length > 10_000 ? text.slice(0, 10_000) + "\n[truncated]" : text;
  } catch (err) {
    return `Error making request: ${(err as Error).message}`;
  }
}
