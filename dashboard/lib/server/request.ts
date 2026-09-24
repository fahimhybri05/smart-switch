import { NextResponse, type NextRequest } from 'next/server';

const MAX_BODY_BYTES = 64 * 1024;

export class BodyError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Reads the request body as text (bounded). Returns '' for an empty body. */
export async function readBodyText(req: NextRequest): Promise<string> {
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (declared > MAX_BODY_BYTES) throw new BodyError('payload too large', 413);
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) throw new BodyError('payload too large', 413);
  if (text) {
    try {
      JSON.parse(text);
    } catch {
      throw new BodyError('invalid JSON body', 400);
    }
  }
  return text;
}

/** Reads and parses a JSON object body; returns {} when empty. */
export async function readJsonBody(req: NextRequest): Promise<Record<string, unknown>> {
  const text = await readBodyText(req);
  if (!text) return {};
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new BodyError('expected a JSON object', 400);
  }
  return parsed as Record<string, unknown>;
}

export function bodyErrorResponse(err: unknown): NextResponse | null {
  if (err instanceof BodyError) return NextResponse.json({ error: err.message }, { status: err.status });
  return null;
}
