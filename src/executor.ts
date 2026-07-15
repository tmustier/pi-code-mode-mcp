import { createRequire } from "node:module";
import { dirname } from "node:path";
import { inspect } from "node:util";
import vm from "node:vm";
import type { CallToolResult, Progress } from "@modelcontextprotocol/sdk/types.js";
import { buildCatalog, describeTool, publicCatalog, searchCatalog } from "./catalog.ts";
import { buildToolResult, createOutputCollector } from "./output.ts";
import { SessionStore } from "./session-store.ts";
import type { LoadedCodeModeConfig } from "./types.ts";
import { UpstreamManager } from "./upstream-manager.ts";

export interface ExecuteRequest {
  code: string;
  sessionId: string;
  timeoutMs?: number;
  maxOutputChars?: number;
  signal: AbortSignal;
  onProgress?: (progress: Progress) => void;
}

export class CodeExecutor {
  private readonly sessions = new SessionStore();
  private readonly config: LoadedCodeModeConfig;
  private readonly upstream: UpstreamManager;

  constructor(config: LoadedCodeModeConfig, upstream: UpstreamManager) {
    this.config = config;
    this.upstream = upstream;
  }

  async execute(request: ExecuteRequest): Promise<CallToolResult> {
    if (!request.code.trim()) throw new Error("code must contain JavaScript source");
    if (request.signal.aborted) throw abortReason(request.signal);
    await this.upstream.loadAll(request.signal);

    const catalog = buildCatalog(this.upstream.getCatalogEntries());
    const publicTools = Object.freeze(publicCatalog(catalog).map(tool => Object.freeze(tool)));
    const statuses = Object.freeze(this.upstream.getStatuses().map(status => Object.freeze(status)));
    const collector = createOutputCollector();
    const logs: string[] = [];
    const trackedTimers = new Set<NodeJS.Timeout | NodeJS.Immediate>();
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort(abortReason(request.signal));
    request.signal.addEventListener("abort", abortFromCaller, { once: true });
    const timeoutMs = request.timeoutMs ?? this.config.settings.executionTimeoutMs;
    const timeout = setTimeout(() => controller.abort(new ExecutionTimeoutError(timeoutMs)), timeoutMs);
    timeout.unref?.();

    const call = async (name: string, args: unknown = {}): Promise<CallToolResult> => {
      const tool = describeTool(catalog, name);
      return await this.upstream.call(tool.server, tool.tool, args, {
        signal: controller.signal,
        ...(request.onProgress ? { onProgress: request.onProgress } : {}),
      });
    };
    const tools = Object.freeze(Object.fromEntries(catalog.map(tool => [
      tool.name,
      async (args: unknown = {}) => await call(tool.name, args),
    ])));
    const consoleObject = createCapturedConsole(logs);
    const timerGlobals = createTimerGlobals(trackedTimers);
    const require = createRequire(import.meta.url);
    const context = vm.createContext({
      tools,
      ALL_TOOLS: publicTools,
      ALL_SERVERS: statuses,
      search: (query: string, options: { server?: string; limit?: number } = {}) =>
        Object.freeze(searchCatalog(catalog, query, options).map(result => Object.freeze(result))),
      describe: (name: string) => describeTool(catalog, name),
      call,
      text: collector.text,
      image: collector.image,
      emit: collector.emit,
      store: (key: string, value: unknown) => this.sessions.store(request.sessionId, key, value),
      load: (key: string) => this.sessions.load(request.sessionId, key),
      clearStore: (key?: string) => this.sessions.clear(request.sessionId, key),
      signal: controller.signal,
      console: consoleObject,
      process,
      Buffer,
      fetch,
      Request,
      Response,
      Headers,
      FormData,
      Blob,
      URL,
      URLSearchParams,
      TextEncoder,
      TextDecoder,
      AbortController,
      AbortSignal,
      structuredClone,
      crypto: globalThis.crypto,
      require,
      __filename: import.meta.filename,
      __dirname: dirname(import.meta.filename),
      ...timerGlobals,
    }, {
      name: `code-mode-${request.sessionId}`,
      codeGeneration: { strings: true, wasm: true },
    });

    const source = `(async () => {\n${request.code}\n})()`;
    const script = new vm.Script(source, {
      filename: "code-mode-exec.js",
      importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
    });

    try {
      const execution = Promise.resolve(script.runInContext(context, {
        timeout: Math.min(timeoutMs, 2_147_483_647),
        breakOnSigint: true,
      }));
      const returned = await raceAbort(execution, controller.signal);
      return buildToolResult(
        returned,
        collector.content,
        logs,
        request.maxOutputChars ?? this.config.settings.maxOutputChars,
        this.config.settings.maxConsoleChars,
      );
    } finally {
      clearTimeout(timeout);
      request.signal.removeEventListener("abort", abortFromCaller);
      for (const timer of trackedTimers) {
        clearTimeout(timer as NodeJS.Timeout);
        clearInterval(timer as NodeJS.Timeout);
        clearImmediate(timer as NodeJS.Immediate);
      }
    }
  }
}

class ExecutionTimeoutError extends Error {
  override name = "ExecutionTimeoutError";
  constructor(timeoutMs: number) {
    super(`JavaScript execution exceeded ${timeoutMs} ms`);
  }
}

function createCapturedConsole(logs: string[]): Console {
  const append = (...values: unknown[]) => logs.push(values.map(value => typeof value === "string" ? value : inspect(value, { depth: 5, breakLength: 100 })).join(" "));
  return {
    log: append,
    info: append,
    debug: append,
    warn: append,
    error: append,
    dir: append,
    trace: append,
    assert(condition?: boolean, ...data: unknown[]) { if (!condition) append("Assertion failed", ...data); },
    clear() {},
    count: append,
    countReset() {},
    dirxml: append,
    group: append,
    groupCollapsed: append,
    groupEnd() {},
    table: append,
    time() {},
    timeEnd: append,
    timeLog: append,
    timeStamp() {},
    profile() {},
    profileEnd() {},
    Console: console.Console,
  } as Console;
}

function createTimerGlobals(tracked: Set<NodeJS.Timeout | NodeJS.Immediate>) {
  return {
    setTimeout(callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) {
      const timer = setTimeout(() => {
        tracked.delete(timer);
        callback(...args);
      }, delay);
      tracked.add(timer);
      return timer;
    },
    clearTimeout(timer?: NodeJS.Timeout) {
      if (timer) tracked.delete(timer);
      clearTimeout(timer);
    },
    setInterval(callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) {
      const timer = setInterval(callback, delay, ...args);
      tracked.add(timer);
      return timer;
    },
    clearInterval(timer?: NodeJS.Timeout) {
      if (timer) tracked.delete(timer);
      clearInterval(timer);
    },
    setImmediate(callback: (...args: unknown[]) => void, ...args: unknown[]) {
      const timer = setImmediate(() => {
        tracked.delete(timer);
        callback(...args);
      });
      tracked.add(timer);
      return timer;
    },
    clearImmediate(timer?: NodeJS.Immediate) {
      if (timer) tracked.delete(timer);
      clearImmediate(timer);
    },
    queueMicrotask,
  };
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortReason(signal));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError");
}
