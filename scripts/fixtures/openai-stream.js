// HTTP fixture only: unit and browser tests never call the external AI service.
export function openAiStreamResponse(body, { gate = null, delayMs = 0 } = {}) {
  const text = (body.output || [])
    .filter((item) => item.type === 'message')
    .flatMap((item) => item.content || [])
    .filter((part) => part.type === 'output_text')
    .map((part) => part.text)
    .join('');
  const middle = Math.floor(text.length / 2);
  const initial = [
    { type: 'response.created', response: { status: 'in_progress' } },
    ...(text ? [{ type: 'response.output_text.delta', delta: text.slice(0, middle) }] : []),
  ];
  const final = [
    ...(text ? [{ type: 'response.output_text.delta', delta: text.slice(middle) }] : []),
    {
      type: body.status === 'incomplete' ? 'response.incomplete' : 'response.completed',
      response: body,
    },
  ];
  const encode = (events) =>
    new TextEncoder().encode(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''));
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encode(initial));
      void (async () => {
        if (gate) await gate;
        if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
        if (cancelled) return;
        controller.enqueue(encode(final));
        controller.close();
      })().catch((error) => {
        if (!cancelled) controller.error(error);
      });
    },
    cancel() {
      cancelled = true;
    },
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
}
