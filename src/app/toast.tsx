// Toasts: every error in the app shows up here, in the same place, instead of inline. Errors stay a little longer and are announced
// to screen readers as alerts. Saying the same thing twice in a row shows it once.
import { useSyncExternalStore } from "react";

type Kind = "error" | "info";
type Toast = { id: number; kind: Kind; text: string };
const EMPTY: Toast[] = [];
let toasts: Toast[] = [];
let next = 1;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());
const subscribe = (f: () => void) => (subs.add(f), () => void subs.delete(f));

export function dismiss(id: number) {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

export function toast(text: string, kind: Kind = "error") {
  if (!text) return;
  if (toasts.some((t) => t.text === text)) return;
  const t = { id: next++, kind, text };
  toasts = [...toasts.slice(-3), t];
  emit();
  setTimeout(() => dismiss(t.id), kind === "error" ? 9000 : 4500);
}

export function Toaster() {
  const list = useSyncExternalStore(subscribe, () => toasts, () => EMPTY);
  return (
    <div className="toasts" role="region" aria-label="Notifications">
      {list.map((t) => (
        <div key={t.id} className={"toast " + t.kind} role={t.kind === "error" ? "alert" : "status"}>
          <span>{t.text}</span>
          <button type="button" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
