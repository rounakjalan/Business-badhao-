"use client";

import { useState, useTransition } from "react";
import { checkForRepliesAction } from "@/app/(dashboard)/conversations/actions";
import { DashButton } from "@/components/dashboard-ui/button";

export function CheckRepliesButton() {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  function run() {
    setResult(null);
    startTransition(async () => {
      const r = await checkForRepliesAction();
      if (r.ok) {
        setResult({
          ok: true,
          text: r.newReplies === 0 ? "No new replies." : `${r.newReplies} new ${r.newReplies === 1 ? "reply" : "replies"} added.`,
        });
      } else {
        setResult({ ok: false, text: r.message });
      }
    });
  }

  return (
    <div className="flex items-center gap-3">
      {result ? <span className={`text-xs ${result.ok ? "text-bb-text-3" : "text-bb-rose"}`}>{result.text}</span> : null}
      <DashButton variant="outline" disabled={pending} onClick={run}>
        {pending ? "Checking…" : "Check for Replies"}
      </DashButton>
    </div>
  );
}
