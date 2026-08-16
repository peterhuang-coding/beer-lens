import Link from "next/link";

/**
 * Shared top-tab nav for the Beer Lens app.
 *
 * Renders the same tab strip on every page. Each page passes the id of its
 * current tab via `active` so the matching link gets the `active` class
 * (yellow). Keeping this in one place means adding/renaming a tab is a
 * one-file change.
 */
export type NavTabId = "home" | "chat" | "harness" | "beers" | "test-runner" | "debug";

interface NavProps {
  active: NavTabId;
  /** Optional right-side label (e.g. "LLM · Ark · doubao-seed-evolving"). */
  rightLabel?: string;
}

interface Tab {
  id: NavTabId;
  href: string;
  label: string;
}

const TABS: ReadonlyArray<Tab> = [
  { id: "home", href: "/", label: "/home" },
  { id: "chat", href: "/chat", label: "/chat" },
  { id: "harness", href: "/harness", label: "/harness" },
  { id: "beers", href: "/beers", label: "/beers" },
  { id: "test-runner", href: "/test-runner", label: "/test-runner" },
  { id: "debug", href: "/debug", label: "/debug" },
];

export default function Nav({ active, rightLabel }: NavProps) {
  return (
    <nav className="top-nav">
      <span className="nav-head">🍺 Beer Lens</span>
      {TABS.map((t) => (
        <Link key={t.id} href={t.href} className={t.id === active ? "active" : undefined}>
          {t.label}
        </Link>
      ))}
      <span className="nav-spacer" />
      {rightLabel ? <span className="nav-head">{rightLabel}</span> : null}
      <style>{`
        .top-nav { padding:14px 40px; background:#1f232c; border-bottom:1px solid #2a2f3a;
          display:flex; gap:14px; align-items:center; }
        .top-nav a { color:#4cb3ff; text-decoration:none; font-size:13px; font-weight:500;
          padding:4px 10px; border-radius:6px; }
        .top-nav a:hover { background:#2a2f3a; }
        .top-nav a.active { background:#2a2f3a; color:#f5a524; }
        .top-nav .nav-spacer { flex:1; }
        .top-nav .nav-head { font-family:ui-monospace, "SF Mono", Menlo, monospace;
          font-size:11px; color:#9aa3b2; }
      `}</style>
    </nav>
  );
}