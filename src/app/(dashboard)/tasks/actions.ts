"use server";

import { revalidatePath } from "next/cache";
import { getCurrentOrg } from "@/lib/organizations";
import { createClient } from "@/lib/supabase/server";

export async function createTask(formData: FormData) {
  const title = String(formData.get("title") ?? "").trim();
  if (!title) return;

  const dueAt = String(formData.get("dueAt") ?? "");
  const currentOrg = await getCurrentOrg();
  if (!currentOrg) return;

  const supabase = await createClient();
  await supabase.from("tasks").insert({
    organization_id: currentOrg.organizationId,
    title,
    due_at: dueAt || null,
  });

  revalidatePath("/tasks");
}

export async function completeTask(taskId: string) {
  const currentOrg = await getCurrentOrg();
  if (!currentOrg) return;

  const supabase = await createClient();
  // Explicit org scoping alongside RLS — never trust the row-level policy
  // alone to be every organization's only defense against a stray or
  // future-loosened rule.
  await supabase.from("tasks").update({ status: "completed" }).eq("id", taskId).eq("organization_id", currentOrg.organizationId);
  revalidatePath("/tasks");
}
