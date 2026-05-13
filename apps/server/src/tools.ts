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
