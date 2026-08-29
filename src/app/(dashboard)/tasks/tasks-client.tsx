"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { completeTask, createTask } from "@/app/(dashboard)/tasks/actions";
import { PageHeader } from "@/components/layout/page-header";
import { DashButton } from "@/components/dashboard-ui/button";
import { DarkCard } from "@/components/dashboard-ui/card";
import { DarkEmptyState } from "@/components/dashboard-ui/empty-state";
import { CheckIcon, TasksIcon } from "@/components/ui/icons";
import { formatDate } from "@/lib/format";

type Task = {
  id: string;
  title: string;
  status: string;
  due_at: string | null;
  related_entity_type: string | null;
  related_entity_id: string | null;
  created_at: string;
};

const RELATED_ENTITY_ROUTE: Record<string, string> = { lead: "/leads", conversation: "/conversations", deal: "/deals" };
const RELATED_ENTITY_LABEL: Record<string, string> = { lead: "Lead", conversation: "Conversation", deal: "Deal" };

/** A task's own related_entity_type/id — set by quickCreateTaskForLead and runFollowUpAction — was never surfaced here before; this is the only place in the app that reads it back. */
function RelatedEntityLink({ type, id }: { type: string | null; id: string | null }) {
  if (!type || !id || !RELATED_ENTITY_ROUTE[type]) return null;
  return (
    <Link
      href={`${RELATED_ENTITY_ROUTE[type]}/${id}`}
      onClick={(e) => e.stopPropagation()}
      className="text-xs text-bb-indigo-2 hover:underline"
    >
      {RELATED_ENTITY_LABEL[type]} →
    </Link>
  );
}

export function TasksClient({ tasks }: { tasks: Task[] }) {
  const [creating, setCreating] = useState(false);
  const [, startTransition] = useTransition();

  // A cancelled or failed task is finished with, not outstanding work — it
  // belongs out of the to-do list and out of the open count.
  const todo = tasks.filter((t) => t.status === "pending" || t.status === "in_progress");
  const done = tasks.filter((t) => t.status !== "pending" && t.status !== "in_progress");

  return (
    <div className="bb-animate-fade-in flex flex-1 flex-col gap-5 p-4 sm:p-6">
      <PageHeader
        title="Tasks"
        description={`${todo.length} open · ${done.length} closed`}
        action={
          <DashButton variant="gradient" onClick={() => setCreating((v) => !v)}>
            + Create Task
          </DashButton>
        }
      />

      {creating ? (
        <DarkCard className="bb-animate-scale-in origin-top border-bb-indigo/30 p-5">
          <h4 className="mb-4 text-sm font-semibold text-bb-text">New Task</h4>
          <form
            action={(formData) => {
              createTask(formData);
              setCreating(false);
            }}
            className="space-y-3"
          >
            <input
              name="title"
              required
              placeholder="Task title"
              className="w-full rounded-lg border border-bb-border bg-bb-navy px-4 py-2.5 text-sm text-bb-text outline-none placeholder:text-bb-text-3 focus:border-bb-indigo"
            />
            <input
              type="date"
              name="dueAt"
              className="rounded-lg border border-bb-border bg-bb-navy px-4 py-2.5 text-sm text-bb-text outline-none focus:border-bb-indigo"
            />
            <div className="flex gap-3">
              <DashButton type="submit" variant="gradient">
                Create Task
              </DashButton>
              <DashButton type="button" variant="ghost" onClick={() => setCreating(false)}>
                Cancel
              </DashButton>
            </div>
          </form>
        </DarkCard>
      ) : null}

      {tasks.length === 0 ? (
        <DarkEmptyState icon={TasksIcon} title="No tasks yet" description="Tasks you create or that follow from your leads and deals will show up here." />
      ) : (
        <div className="bb-stagger space-y-2">
          {todo.map((task) => (
            <div
              key={task.id}
              className="bb-stagger-item bb-lift flex items-center gap-4 rounded-xl border border-bb-border bg-bb-navy-2 px-5 py-4 transition-colors hover:border-bb-indigo/30"
            >
              <button
                onClick={() => startTransition(() => completeTask(task.id))}
                aria-label="Mark complete"
                className="bb-press h-5 w-5 shrink-0 rounded-full border-2 border-bb-border transition-all hover:scale-110 hover:border-bb-indigo"
              />
              <div className="min-w-0 flex-1">
                <div className="mb-0.5 truncate text-sm font-medium text-bb-text">{task.title}</div>
                <div className="flex items-center gap-2 text-xs text-bb-text-3">
                  <span>Due {formatDate(task.due_at)}</span>
                  <RelatedEntityLink type={task.related_entity_type} id={task.related_entity_id} />
                </div>
              </div>
            </div>
          ))}

          {done.length > 0 ? (
            <>
              <div className="pt-2 text-xs font-medium text-bb-text-3">CLOSED</div>
              {done.map((task) => (
                <div
                  key={task.id}
                  className="bb-animate-fade-in flex items-center gap-4 rounded-xl border border-bb-border bg-bb-navy-2 px-5 py-4 opacity-50"
                >
                  {task.status === "completed" ? (
                    <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 border-bb-emerald bg-bb-emerald">
                      <CheckIcon className="h-3 w-3 text-white" />
                    </div>
                  ) : (
                    <div className="h-5 w-5 shrink-0 rounded-full border-2 border-bb-border" title={task.status} />
                  )}
                  <div className="min-w-0 flex-1 truncate text-sm text-bb-text-3 line-through">{task.title}</div>
                  <RelatedEntityLink type={task.related_entity_type} id={task.related_entity_id} />
                </div>
              ))}
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}
