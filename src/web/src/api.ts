export async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw await WorkbenchRequestError.fromResponse(response);
  return response.json() as Promise<T>;
}

export async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw await WorkbenchRequestError.fromResponse(response);
  return response.json() as Promise<T>;
}

export type LiveStreamOptions = {
  firstConfirmationTimeoutMs?: number;
  onFirstConfirmation?: () => void;
  onFirstConfirmationTimeout?: () => void;
  signal?: AbortSignal;
};

export async function consumeWorkbenchLiveStream<TEvent>(
  url: string,
  body: unknown,
  onEvent: (event: TEvent) => void,
  options: LiveStreamOptions = {},
): Promise<void> {
  let confirmed = false;
  const timeout = options.firstConfirmationTimeoutMs && options.firstConfirmationTimeoutMs > 0
    ? setTimeout(() => { if (!confirmed) options.onFirstConfirmationTimeout?.(); }, options.firstConfirmationTimeoutMs)
    : undefined;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: options.signal,
  });
  try {
    if (!response.ok) throw await WorkbenchRequestError.fromResponse(response);
    if (!response.body) throw new Error("Live response did not include a readable body.");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index = buffer.indexOf("\n\n");
      while (index !== -1) {
        const frame = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const event = parseWorkbenchSseFrame<TEvent>(frame);
        if (event) {
          if (!confirmed) {
            confirmed = true;
            options.onFirstConfirmation?.();
          }
          onEvent(event);
        }
        await yieldToBrowser();
        index = buffer.indexOf("\n\n");
      }
    }
    const trailing = buffer.trim();
    if (trailing) {
      const event = parseWorkbenchSseFrame<TEvent>(trailing);
      if (event) {
        if (!confirmed) {
          confirmed = true;
          options.onFirstConfirmation?.();
        }
        onEvent(event);
      }
      await yieldToBrowser();
    }
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export class WorkbenchRequestError extends Error {
  readonly status: number;
  readonly technicalDetail: string;

  constructor(status: number, technicalDetail: string) {
    super(`Workbench request failed (${status}).`);
    this.name = "WorkbenchRequestError";
    this.status = status;
    this.technicalDetail = technicalDetail;
  }

  static async fromResponse(response: Response): Promise<WorkbenchRequestError> {
    return new WorkbenchRequestError(response.status, await response.text());
  }
}

function parseWorkbenchSseFrame<TEvent>(frame: string): TEvent | null {
  if (!frame.trim() || frame.trim().startsWith(":")) return null;
  let eventName = "";
  const dataLines: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith("event:")) eventName = line.slice("event:".length).trim();
    if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).trimStart());
  }
  if (!eventName || dataLines.length === 0) return null;
  return { event: eventName, data: JSON.parse(dataLines.join("\n")) } as TEvent;
}

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
