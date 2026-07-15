export class SessionStore {
  private readonly sessions = new Map<string, Map<string, unknown>>();

  load(sessionId: string, key: string): unknown {
    return cloneSerializable(this.sessions.get(sessionId)?.get(key));
  }

  store(sessionId: string, key: string, value: unknown): void {
    if (typeof key !== "string" || !key) throw new Error("store key must be a non-empty string");
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = new Map();
      this.sessions.set(sessionId, session);
    }
    session.set(key, cloneSerializable(value));
  }

  clear(sessionId: string, key?: string): void {
    if (key === undefined) {
      this.sessions.delete(sessionId);
      return;
    }
    this.sessions.get(sessionId)?.delete(key);
  }
}

function cloneSerializable(value: unknown): unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (error) {
    throw new Error("Session values must be JSON-serializable", { cause: error });
  }
}
