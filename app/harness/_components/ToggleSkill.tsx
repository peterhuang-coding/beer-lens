"use client";

/**
 * Client island for the skill-card toggle button.
 *
 * Renders a single button that:
 *   - shows the NEXT action (enabled ? "禁用" : "启用")
 *   - POSTs to /api/skills/<id>/toggle on click
 *   - reflects the new state optimistically while the request is in flight
 *   - on failure, logs and reverts to keep the server as the source of truth
 *
 * The page is `force-dynamic`, so the next SSR pass will re-read the
 * manifest and emit the fresh `enabled` flag — no client cache invalidation
 * needed.
 */

import { useState } from "react";

type Props = {
  id: string;
  initialEnabled: boolean;
};

export default function ToggleSkill({ id, initialEnabled }: Props) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [pending, setPending] = useState(false);

  async function onClick() {
    if (pending) return;
    setPending(true);
    const previous = enabled;
    // optimistic flip
    setEnabled(!previous);
    try {
      const res = await fetch(`/api/skills/${encodeURIComponent(id)}/toggle`, {
        method: "POST",
      });
      if (!res.ok) {
        // revert + surface for debugging
        setEnabled(previous);
        let body: unknown = null;
        try {
          body = await res.json();
        } catch {
          /* ignore json parse failure */
        }
        console.error("[ToggleSkill] toggle failed", id, res.status, body);
        return;
      }
      const data = (await res.json()) as { id: string; enabled: boolean };
      // confirm server's view matches our optimistic value
      if (data.id !== id) {
        console.warn("[ToggleSkill] id mismatch", id, data);
      }
      setEnabled(data.enabled);
    } catch (err) {
      // network error: revert
      setEnabled(previous);
      console.error("[ToggleSkill] toggle error", id, err);
    } finally {
      setPending(false);
    }
  }

  const label = enabled ? "禁用" : "启用";
  const cls = enabled ? "skill-toggle on" : "skill-toggle off";

  return (
    <button
      type="button"
      className={cls}
      onClick={onClick}
      disabled={pending}
      aria-label={`${enabled ? "禁用" : "启用"} skill ${id}`}
      data-skill-id={id}
    >
      {pending ? "..." : label}
    </button>
  );
}
