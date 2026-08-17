"use client";

import { useState, useTransition } from "react";
import { completeTask, createTask } from "@/app/(dashboard)/tasks/actions";
import { PageHeader } from "@/components/layout/page-header";
import { DashButton } from "@/components/dashboard-ui/button";
import { DarkCard } from "@/components/dashboard-ui/card";
import { DarkEmptyState } from "@/components/dashboard-ui/empty-state";
import { CheckIcon, TasksIcon } from "@/components/ui/icons";
import { formatDate } from "@/lib/format";

type Task = { id: string; title: string; status: string; due_at: string | null; created_at: string };

export function TasksClient({ tasks }: { tasks: Task[] }) {
  const [creating, setCreating] = useState(false);
  const [, startTransition] = useTransition();

  const todo = tasks.filter((t) => t.status !== "completed");
  const done = tasks.filter((t) => t.status === "completed");

  return (
    <div className="bb-animate-fade-in flex flex-1 flex-col gap-5 p-4 sm:p-6">
      <PageHeader
        title="Tasks"
        description={`${todo.length} open · ${done.length} completed`}
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
                <div className="text-xs text-bb-text-3">Due {formatDate(task.due_at)}</div>
              </div>
            </div>
          ))}

          {done.length > 0 ? (
            <>
              <div className="pt-2 text-xs font-medium text-bb-text-3">COMPLETED</div>
              {done.map((task) => (
                <div
                  key={task.id}
                  className="bb-animate-fade-in flex items-center gap-4 rounded-xl border border-bb-border bg-bb-navy-2 px-5 py-4 opacity-50"
                >
                  <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 border-bb-emerald bg-bb-emerald">
                    <CheckIcon className="h-3 w-3 text-white" />
                  </div>
                  <div className="min-w-0 flex-1 truncate text-sm text-bb-text-3 line-through">{task.title}</div>
                </div>
              ))}
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}
