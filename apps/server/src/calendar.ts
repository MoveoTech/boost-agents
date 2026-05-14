async function calendarFetch(accessToken: string, path: string, options?: RequestInit): Promise<unknown> {
  const res = await fetch(`https://www.googleapis.com/calendar/v3${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(options?.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`Calendar API error ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function calendarListEvents(accessToken: string, maxResults = 10): Promise<string> {
  const now = new Date().toISOString();
  const data = await calendarFetch(
    accessToken,
    `/calendars/primary/events?timeMin=${encodeURIComponent(now)}&maxResults=${maxResults}&singleEvents=true&orderBy=startTime`
  ) as { items?: { id: string; summary?: string; start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string }; location?: string }[] };

  if (!data.items?.length) return "No upcoming events found.";

  const events = data.items.map((e) => {
    const start = e.start?.dateTime ?? e.start?.date ?? "Unknown";
    const end = e.end?.dateTime ?? e.end?.date ?? "Unknown";
    return `ID: ${e.id}\nTitle: ${e.summary ?? "No title"}\nStart: ${start}\nEnd: ${end}\nLocation: ${e.location ?? "N/A"}`;
  });

  return `Upcoming events (${data.items.length}):\n\n${events.join("\n\n---\n\n")}`;
}

export async function calendarCreateEvent(
  accessToken: string,
  title: string,
  startDateTime: string,
  endDateTime: string,
  description?: string,
  location?: string
): Promise<string> {
  const created = await calendarFetch(accessToken, "/calendars/primary/events", {
    method: "POST",
    body: JSON.stringify({
      summary: title,
      description,
      location,
      start: { dateTime: startDateTime, timeZone: "UTC" },
      end: { dateTime: endDateTime, timeZone: "UTC" },
    }),
  }) as { id: string; summary: string; htmlLink: string };

  return `Event created: "${created.summary}"\nID: ${created.id}\nLink: ${created.htmlLink}`;
}

export async function calendarGetEvent(accessToken: string, eventId: string): Promise<string> {
  const e = await calendarFetch(accessToken, `/calendars/primary/events/${eventId}`) as {
    summary?: string;
    start?: { dateTime?: string; date?: string };
    end?: { dateTime?: string; date?: string };
    location?: string;
    description?: string;
    attendees?: { email: string; responseStatus: string }[];
  };

  return [
    `Title: ${e.summary ?? "No title"}`,
    `Start: ${e.start?.dateTime ?? e.start?.date ?? "Unknown"}`,
    `End: ${e.end?.dateTime ?? e.end?.date ?? "Unknown"}`,
    `Location: ${e.location ?? "N/A"}`,
    `Description: ${e.description ?? "N/A"}`,
    `Attendees: ${e.attendees?.map((a) => `${a.email} (${a.responseStatus})`).join(", ") ?? "None"}`,
  ].join("\n");
}
