async function gmailFetch(accessToken: string, path: string, options?: RequestInit): Promise<unknown> {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(options?.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`Gmail API error ${res.status}: ${await res.text()}`);
  return res.json();
}

function encodeMime(to: string, subject: string, body: string): string {
  const mime = [`To: ${to}`, `Subject: ${subject}`, `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=utf-8`, ``, body].join("\r\n");
  return Buffer.from(mime).toString("base64url");
}

export async function gmailSend(accessToken: string, to: string, subject: string, body: string): Promise<string> {
  await gmailFetch(accessToken, "/messages/send", {
    method: "POST",
    body: JSON.stringify({ raw: encodeMime(to, subject, body) }),
  });
  return `Email sent to ${to} with subject "${subject}"`;
}

export async function gmailSearch(accessToken: string, query: string, maxResults = 10): Promise<string> {
  const data = await gmailFetch(accessToken, `/messages?q=${encodeURIComponent(query)}&maxResults=${maxResults}`) as { messages?: { id: string }[] };
  if (!data.messages?.length) return "No emails found matching that query.";

  const previews = await Promise.all(
    data.messages.slice(0, 5).map(async ({ id }) => {
      const msg = await gmailFetch(accessToken, `/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`) as {
        id: string;
        payload: { headers: { name: string; value: string }[] };
        snippet: string;
      };
      const headers = Object.fromEntries(msg.payload.headers.map((h) => [h.name, h.value]));
      return `ID: ${msg.id}\nFrom: ${headers.From}\nDate: ${headers.Date}\nSubject: ${headers.Subject}\nSnippet: ${msg.snippet}`;
    })
  );

  return `Found ${data.messages.length} email(s). Showing first ${previews.length}:\n\n${previews.join("\n\n---\n\n")}`;
}

export async function gmailRead(accessToken: string, messageId: string): Promise<string> {
  const msg = await gmailFetch(accessToken, `/messages/${messageId}?format=full`) as {
    payload: {
      headers: { name: string; value: string }[];
      parts?: { mimeType: string; body: { data?: string } }[];
      body?: { data?: string };
    };
    snippet: string;
  };

  const headers = Object.fromEntries(msg.payload.headers.map((h) => [h.name, h.value]));
  const bodyData = msg.payload.parts?.find((p) => p.mimeType === "text/plain")?.body?.data
    ?? msg.payload.body?.data ?? "";
  const body = bodyData ? Buffer.from(bodyData, "base64").toString("utf-8") : msg.snippet;

  return `From: ${headers.From}\nDate: ${headers.Date}\nSubject: ${headers.Subject}\n\n${body}`.slice(0, 8000);
}
