/**
 * dsh-plugin-autoresearch browser half: the three keyed toolviews, the live
 * dashboard on the shell.overlay seat (the guaranteed additive carrier), and
 * an optional dsh-better-sidebar tab that carries the dashboard when that
 * plugin provides its `betterSidebar` service.
 */

// Type-only: pulls the 'shell.overlay' SlotMap merge into scope (erased at runtime).
import type {} from "@deepseek-ai/dsh-client-ui-layout/client";
import type { ClientContext } from "@deepseek-ai/dsh-client-runtime/client";
import type { ToolCallViewProps } from "@deepseek-ai/dsh-client-ui-tool/client";
import { type ReactNode, createElement } from "react";
import "./ar.nomodule.css";
import { AutoresearchClientStore, type EventSourceLike } from "./store";
import { DashboardEntry, InitToolView, LogToolView, RunToolView, SidebarTabView } from "./views";

/** Required services: the slot registry (toolviews + overlay seat). */
export const inject = ["slots"];

// ---------------------------------------------------------------------------
// better-sidebar discovery
// ---------------------------------------------------------------------------

/** Structural slice of the dsh-better-sidebar service we consume. */
interface BetterSidebarLike {
  registerTab(descriptor: {
    id: string;
    title: string | (() => string);
    icon?: ReactNode | ((size: number) => ReactNode);
    single?: boolean;
    badge?: (ctx: unknown, scope: { sessionId: string }, state: unknown) => string | number | null | undefined;
    component: (props: { scope: { sessionId: string }; visible: boolean }) => ReactNode;
  }): () => void;
  openTab(seed: { type: string; path?: string }): void;
  getSnapshot?(): { sessionId?: string; panelOpen?: boolean } | undefined;
  subscribeState?(listener: () => void): () => void;
  isTabEnabled?(id: string): boolean;
}

/** Sidebar tab descriptor id (also the OpenTabSeed `type`). */
const TAB_ID = "autoresearch:dashboard";

/**
 * External store for the carrier flag: while the better-sidebar fiber is
 * alive the tab carries the dashboard and the floating capsule hides itself.
 * The overlay reads it through useSyncExternalStore and flips without a
 * remount when the sidebar plugin (un)loads.
 */
const sidebarModeStore = {
  active: false,
  listeners: new Set<() => void>(),
  getSnapshot(): boolean {
    return this.active;
  },
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  },
  set(next: boolean): void {
    if (this.active === next) return;
    this.active = next;
    for (const listener of [...this.listeners]) listener();
  },
};

/** Flask icon for the sidebar tab strip. */
function TabIcon(props: { size: number }): ReactNode {
  return createElement(
    "svg",
    {
      width: props.size,
      height: props.size,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 1.8,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": true,
    },
    createElement("path", { d: "M10 3v5.5L5.6 17.8A2 2 0 0 0 7.4 21h9.2a2 2 0 0 0 1.8-3.2L14 8.5V3" }),
    createElement("path", { d: "M8.5 3h7" }),
    createElement("path", { d: "M7 14h10" }),
  );
}

/** Parse the logged call arguments (streaming may expose truncated JSON). */
function argsOf(block: ToolCallViewProps["block"]): Record<string, unknown> | null {
  const argsRaw = "kind" in block ? block.call?.argsRaw : block.argsRaw;
  if (typeof argsRaw !== "string" || argsRaw === "") return null;
  try {
    const parsed = JSON.parse(argsRaw) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Truncated streaming JSON: fall back to null.
  }
  return null;
}

/** First text content block of a settled call (the tool's rendered text). */
function resultTextOf(block: ToolCallViewProps["block"]): string | null {
  if (!("kind" in block)) return null;
  const content: readonly { type: string; text?: string }[] = block.content;
  const textBlock = content.find((item) => item.type === "text");
  return textBlock !== undefined && typeof textBlock.text === "string" ? textBlock.text : null;
}

/** Cheap tab badge: run count while anything exists; null hides the pill. */
function tabBadge(): number | null {
  if (storeRef === null) return null;
  const view = storeRef.getSnapshot();
  const session = view.sessions[0];
  if (session === undefined) return null;
  return session.snapshot.runs.length > 0 ? session.snapshot.runs.length : null;
}

/** Module-level store reference (set once in apply) for the badge callback. */
let storeRef: AutoresearchClientStore | null = null;

/**
 * Client plugin body: register the three keyed toolviews, the dashboard
 * overlay, and (when present) the better-sidebar tab. @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const store = new AutoresearchClientStore({
    fetchFn: (url, init) => fetch(url, init),
    eventSourceFactory: (url) => new EventSource(url) as unknown as EventSourceLike,
  });
  storeRef = store;

  ctx.slots.inject("tool.call.toolview", () =>
    ctx.slots.register({ name: "tool.call.toolview", key: "init_experiment" }, (props: ToolCallViewProps) =>
      createElement(InitToolView, { text: resultTextOf(props.block) ?? "", args: argsOf(props.block) }),
    ),
  );
  ctx.slots.inject("tool.call.toolview", () =>
    ctx.slots.register({ name: "tool.call.toolview", key: "run_experiment" }, (props: ToolCallViewProps) => {
      const settled = "kind" in props.block;
      const text = resultTextOf(props.block);
      const args = argsOf(props.block);
      const command = args !== null && typeof args.command === "string" ? args.command : null;
      return createElement(RunToolView, {
        text: text ?? "",
        running: !settled,
        command,
      });
    }),
  );
  ctx.slots.inject("tool.call.toolview", () =>
    ctx.slots.register({ name: "tool.call.toolview", key: "log_experiment" }, (props: ToolCallViewProps) =>
      createElement(LogToolView, { text: resultTextOf(props.block) ?? "" }),
    ),
  );

  ctx.slots.inject("shell.overlay", () =>
    ctx.slots.register({ name: "shell.overlay", id: "autoresearch-dashboard" }, () =>
      createElement(DashboardEntry, { store, sidebarMode: sidebarModeStore }),
    ),
  );

  // Optional carrier: dsh-better-sidebar publishes `betterSidebar`; when the
  // plugin is absent this fiber never runs and the overlay stays the carrier.
  ctx.inject(["betterSidebar"], (injected: ClientContext) => {
    const service = (injected as unknown as { betterSidebar?: BetterSidebarLike }).betterSidebar;
    if (service === undefined) return;
    sidebarModeStore.set(true);
    store.hold();
    const disposeTab = service.registerTab({
      id: TAB_ID,
      title: "Autoresearch",
      icon: (size: number) => createElement(TabIcon, { size }),
      single: true,
      badge: () => tabBadge(),
      component: (tabProps: { scope: { sessionId: string }; visible: boolean }) =>
        createElement(SidebarTabView, { store, scopeId: tabProps.scope.sessionId }),
    });
    // Auto-open once when the active conversation gains an experiment session.
    let previousVisible = false;
    const evaluate = (): void => {
      const state = service.getSnapshot?.();
      const activeId = state?.sessionId;
      if (activeId === undefined) return;
      const visible = store.getSnapshot().sessions.some((item) => item.snapshot.sessionId === activeId);
      if (visible && !previousVisible && (service.isTabEnabled?.(TAB_ID) ?? true)) {
        service.openTab({ type: TAB_ID });
      }
      previousVisible = visible;
    };
    evaluate();
    const unsubscribeStore = store.subscribe(evaluate);
    const unsubscribeState = service.subscribeState?.(evaluate) ?? null;
    return () => {
      unsubscribeStore();
      unsubscribeState?.();
      disposeTab();
      store.releaseAll();
      sidebarModeStore.set(false);
    };
  });
}
