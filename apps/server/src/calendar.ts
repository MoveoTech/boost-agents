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
  if (res.status === 204) return {};
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
  location?: string,
  attendees?: string[]
): Promise<string> {
  const created = await calendarFetch(accessToken, "/calendars/primary/events?sendUpdates=all", {
    method: "POST",
    body: JSON.stringify({
      summary: title,
      description,
      location,
      start: { dateTime: startDateTime, timeZone: "UTC" },
      end: { dateTime: endDateTime, timeZone: "UTC" },
      attendees: attendees?.map((email) => ({ email })),
    }),
  }) as { id: string; summary: string; htmlLink: string };

  const attendeeList = attendees?.length ? `\nAttendees: ${attendees.join(", ")}` : "";
  return `Event created: "${created.summary}"\nID: ${created.id}${attendeeList}\nLink: ${created.htmlLink}`;
}

export async function calendarCheckAvailability(
  accessToken: string,
  emails: string[],
  timeMin: string,
  timeMax: string
): Promise<string> {
  const data = await calendarFetch(accessToken, "/freeBusy", {
    method: "POST",
    body: JSON.stringify({
      timeMin,
      timeMax,
      items: emails.map((email) => ({ id: email })),
    }),
  }) as { calendars: Record<string, { busy: { start: string; end: string }[] }> };

  const lines = emails.map((email) => {
    const busy = data.calendars[email]?.busy ?? [];
    if (!busy.length) return `${email}: fully available`;
    const slots = busy.map((b) => `  busy ${b.start} → ${b.end}`).join("\n");
    return `${email}:\n${slots}`;
  });

  return `Free/busy between ${timeMin} and ${timeMax}:\n\n${lines.join("\n\n")}`;
}

export async function calendarRsvp(accessToken: string, eventId: string, responseStatus: "accepted" | "declined" | "tentative"): Promise<string> {
  const me = await calendarFetch(accessToken, "/calendars/primary") as { id: string };
  await calendarFetch(accessToken, `/calendars/primary/events/${eventId}?sendUpdates=all`, {
    method: "PATCH",
    body: JSON.stringify({
      attendees: [{ email: me.id, responseStatus }],
    }),
  });
  return `RSVP updated: you have ${responseStatus} the event.`;
}

export async function calendarUpdateEvent(
  accessToken: string,
  eventId: string,
  updates: { title?: string; startDateTime?: string; endDateTime?: string; description?: string; location?: string; attendees?: string[] }
): Promise<string> {
  const body: Record<string, unknown> = {};
  if (updates.title !== undefined)         body.summary     = updates.title;
  if (updates.description !== undefined)   body.description = updates.description;
  if (updates.location !== undefined)      body.location    = updates.location;
  if (updates.startDateTime !== undefined) body.start       = { dateTime: updates.startDateTime, timeZone: "UTC" };
  if (updates.endDateTime !== undefined)   body.end         = { dateTime: updates.endDateTime,   timeZone: "UTC" };
  if (updates.attendees !== undefined)     body.attendees   = updates.attendees.map((email) => ({ email }));
  const updated = await calendarFetch(accessToken, `/calendars/primary/events/${eventId}?sendUpdates=all`, {
    method: "PATCH",
    body: JSON.stringify(body),
  }) as { summary: string; htmlLink: string };
  return `Event updated: "${updated.summary}"\nLink: ${updated.htmlLink}`;
}

export async function calendarDeleteEvent(accessToken: string, eventId: string): Promise<string> {
  await calendarFetch(accessToken, `/calendars/primary/events/${eventId}?sendUpdates=all`, { method: "DELETE" });
  return "Event deleted successfully.";
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
